// Board service. Everything the HTTP layer can do, written against a store and a small set of injected
// dependencies so tests can run it in memory with a scripted model.
import crypto from 'node:crypto';
import { seedBoard } from './fixtures.js';
import {
  advanceClock, assess, brokenBlocks, bookedMinutes, capacityMinutes, dropProblems, floorQ, ceilQ, fmtSpan, insideShift, isOpen,
  readiness, reflow, requiredSkills, summarise, workMinutes, eligible, inProgress, isFixed, DAY, HOUR, MIN, REASON_LABEL, STAGE_LABEL,
} from './engine.js';
import { applyEvent, money } from './events.js';
import { runAgent, describeMoves } from './agent.js';
import { ConflictError } from './store.js';
import * as pp from './paypal.js';

export const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TTL_S = 3 * 24 * 3600;
const MAX_LOG = 60;
const RESEED_AFTER = 20 * HOUR;
const MAX_EVENTS_PER_SESSION = 80;

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const pk = (sid) => `S#${sid}`;
const uid = () => crypto.randomUUID().slice(0, 8);

export function makeDeps(over = {}) {
  return { now: () => Date.now(), env: process.env, runJob: async () => {}, agent: {}, paypal: pp, ...over };
}

// ---- board persistence ------------------------------------------------------------------------------------------

async function freshItem(store, sid, deps, { keepLog = false, prev = null } = {}) {
  const now = deps.now();
  const b = seedBoard(now);
  const live = await deps.paypal.readLiveDisputes(deps.env).catch((e) => ({ ok: false, error: e.message, disputes: [], count: 0, checkedAt: now }));
  let disputes = b.disputes;
  if (live.disputes?.length) {
    const board = { handlers: b.handlers, disputes: [...disputes, ...live.disputes] };
    disputes = reflow(board, now, { dirty: live.disputes.map((d) => d.id) }).disputes;
  }
  const log = keepLog && prev ? prev.log : [];
  const item = {
    pk: pk(sid), sk: 'BOARD', version: (prev?.version ?? 0) + 1, handlers: b.handlers, disputes, seededAt: now, counter: 0, events: prev?.events ?? 0,
    live: liveInfo(live), log, ttl: Math.floor(now / 1000) + TTL_S,
  };
  addLog(item, now, 'system', 'Board seeded', `${disputes.filter((d) => d.fixture).length} fixture disputes${live.disputes?.length ? ` and ${live.disputes.length} live` : ''} scheduled against ${b.handlers.length} handlers. PayPal sandbox: ${live.disputes?.length ?? 0} live dispute${live.disputes?.length === 1 ? '' : 's'} read${live.listCount === 0 && live.disputes?.length ? ' by id (the list endpoint returned none)' : ''}${live.ok ? '' : ', the read failed'}${live.failed?.length ? `; could not fetch ${live.failed.map((f) => f.id).join(', ')}` : ''}.`);
  return item;
}

const liveInfo = (live) => ({ ok: live.ok, count: live.count, listCount: live.listCount ?? 0, checkedAt: live.checkedAt, api: live.api, error: live.error, scopes: live.scopes, failed: live.failed ?? [], imported: (live.disputes ?? []).map((d) => d.id) });

export function addLog(item, now, kind, title, detail = '', extra = {}) {
  item.log = [{ id: uid(), at: now, kind, title, detail, ...extra }, ...(item.log ?? [])].slice(0, MAX_LOG);
}

async function load(store, sid, deps) {
  let item = await store.get(pk(sid), 'BOARD');
  if (!item) { item = await freshItem(store, sid, deps); await store.put(item, { expectVersion: null }).catch((e) => { if (!(e instanceof ConflictError)) throw e; }); item = (await store.get(pk(sid), 'BOARD')) ?? item; }
  return item;
}

/** Time passes: finished blocks count as sent, and blocks that slipped into the past are re-placed by the rules. */
async function rollClock(store, item, deps) {
  const now = deps.now();
  if (now - item.seededAt > RESEED_AFTER) return { item: await reseed(store, item, deps, 'The board is more than 20 hours old, so it was reseeded.'), changed: true };
  let changed = false;
  const adv = advanceClock(item, now);
  if (adv.done.length) {
    item.disputes = adv.disputes; changed = true;
    addLog(item, now, 'system', `${adv.done.length === 1 ? 'Response sent' : adv.done.length + ' responses sent'}`, `${adv.done.join(', ')} reached the end of ${adv.done.length === 1 ? 'its' : 'their'} work block${adv.done.length === 1 ? '' : 's'}.`);
  }
  const broken = brokenBlocks(item, now);
  if (broken.length) {
    const r = reflow(item, now, { dirty: broken });
    item.disputes = r.disputes; changed = true;
    addLog(item, now, 'system', 'Blocks rolled forward', `${describeMoves(r.moves, item.handlers).join('; ') || broken.join(', ')}. Time passed their slots, so the rule-based planner re-placed them.`);
  }
  if (changed) {
    const next = { ...item, version: item.version + 1 };
    try { await store.put(next, { expectVersion: item.version }); return { item: next, changed }; }
    catch (e) { if (!(e instanceof ConflictError)) throw e; return { item: (await store.get(item.pk, 'BOARD')) ?? item, changed }; }
  }
  return { item, changed };
}

async function reseed(store, item, deps, why) {
  const sid = item.pk.slice(2);
  const next = await freshItem(store, sid, deps, { keepLog: true, prev: item });
  if (why) addLog(next, deps.now(), 'system', 'Board reset', why);
  await store.put(next);
  return next;
}

async function save(store, item, deps) {
  const next = { ...item, version: item.version + 1, ttl: Math.floor(deps.now() / 1000) + TTL_S };
  await store.put(next, { expectVersion: item.version });
  return next;
}

// ---- views -------------------------------------------------------------------------------------------------------

async function recentRuns(store, sid, limit = 8) {
  const runs = await store.query(pk(sid), 'RUN#', { limit, reverse: true });
  return runs.map(({ pk: _p, sk: _s, ...r }) => r);
}

export function viewOf(item, runs, now) {
  const handlers = item.handlers.map((h) => {
    const cap = capacityMinutes(h, now, now + DAY);
    const booked = Math.round(bookedMinutes(item, h.id, now, now + DAY));
    return { ...h, capacityMin: cap, bookedMin: booked, loadPct: cap ? Math.min(100, Math.round((booked / cap) * 100)) : null, onShift: capacityMinutes(h, now, now + 1) > 0 };
  });
  const disputes = item.disputes.map((d) => {
    const a = assess(d, now);
    const { hard, soft } = requiredSkills(d);
    return { ...d, ...a, reasonLabel: REASON_LABEL[d.reason] ?? d.reason, stageLabel: STAGE_LABEL[d.stage], needs: { hard, soft }, started: inProgress(d, now), locked: isFixed(d, now) };
  });
  const running = runs.find((r) => r.status === 'running') ?? null;
  return {
    version: item.version, now, seededAt: item.seededAt, handlers, disputes, log: item.log, runs, running,
    summary: summarise(item, now), live: item.live, bounds: { from: floorQ(now) - 2 * HOUR, to: floorQ(now) + 72 * HOUR },
  };
}

export async function getBoard(store, sid, deps) {
  let item = await load(store, sid, deps);
  ({ item } = await rollClock(store, item, deps));
  item = await reconcileRefunds(store, item, deps);
  return viewOf(item, await recentRuns(store, sid), deps.now());
}

// ---- manual changes ----------------------------------------------------------------------------------------------

function warningsFor(item, d, handler, now) {
  const w = [];
  const a = assess(d, now);
  if (a.risk === 'breach') w.push(`${d.id} now ends after its deadline.`);
  const el = eligible(handler, d);
  if (el.softMiss.length) w.push(`${handler.name} lacks the ${el.softMiss.join(', ')} skill that suits this case.`);
  return w;
}

export async function assign(store, sid, { disputeId, handlerId, start }, deps) {
  let item = await load(store, sid, deps);
  ({ item } = await rollClock(store, item, deps));
  const now = deps.now();
  if (!Number.isFinite(Number(start))) throw httpErr(400, 'start must be a timestamp');
  const problems = dropProblems(item, disputeId, handlerId, Number(start), now);
  if (problems.length) throw httpErr(422, problems[0], { problems });
  const d = item.disputes.find((x) => x.id === disputeId);
  const h = item.handlers.find((x) => x.id === handlerId);
  const s = floorQ(Number(start));
  const before = { handlerId: d.handlerId, start: d.start };
  Object.assign(d, { handlerId, start: s, end: s + workMinutes(d) * MIN });
  const warnings = warningsFor(item, d, h, now);
  const prevName = item.handlers.find((x) => x.id === before.handlerId)?.name;
  addLog(item, now, 'manual', before.handlerId === handlerId ? `${d.id} moved on ${h.name}'s row` : `${d.id} reassigned to ${h.name}`, `${prevName ? `From ${prevName}. ` : ''}Starts ${new Date(s).toISOString().slice(11, 16)}Z. ${warnings.join(' ')}`.trim());
  const next = await save(store, item, deps);
  return { ...viewOf(next, await recentRuns(store, sid), now), warnings };
}

export async function resize(store, sid, { disputeId, end }, deps) {
  let item = await load(store, sid, deps);
  ({ item } = await rollClock(store, item, deps));
  const now = deps.now();
  const d = item.disputes.find((x) => x.id === disputeId);
  if (!d || !isOpen(d) || d.start == null) throw httpErr(404, 'That dispute has no block to resize.');
  if (d.pinned) throw httpErr(422, 'This block is pinned. Unpin it first.');
  const h = item.handlers.find((x) => x.id === d.handlerId);
  const e = ceilQ(Number(end));
  if ((e - d.start) / MIN < workMinutes(d)) throw httpErr(422, `${d.id} needs at least ${fmtSpan(workMinutes(d))} of work, so the block cannot be shorter.`);
  if (!insideShift(h, d.start, e)) throw httpErr(422, `${h.name} is not on shift for that whole block.`);
  const clash = item.disputes.find((o) => o.id !== d.id && isOpen(o) && o.handlerId === d.handlerId && o.start != null && o.start < e && o.end > d.start);
  if (clash) throw httpErr(422, `That would overlap ${clash.id}.`);
  d.end = e;
  addLog(item, now, 'manual', `${d.id} given more time`, `The block now runs ${fmtSpan((e - d.start) / MIN)} for ${h.name}.`);
  const next = await save(store, item, deps);
  return viewOf(next, await recentRuns(store, sid), now);
}

export async function setPinned(store, sid, { disputeId, pinned }, deps) {
  let item = await load(store, sid, deps);
  ({ item } = await rollClock(store, item, deps));
  const d = item.disputes.find((x) => x.id === disputeId);
  if (!d || !isOpen(d)) throw httpErr(404, 'That dispute is not open.');
  d.pinned = !!pinned;
  addLog(item, deps.now(), 'manual', d.pinned ? `${d.id} pinned` : `${d.id} unpinned`, d.pinned ? 'The agent will not move this block.' : 'The agent may move this block again.');
  const next = await save(store, item, deps);
  return viewOf(next, await recentRuns(store, sid), deps.now());
}

export async function reset(store, sid, deps) {
  const prev = (await store.get(pk(sid), 'BOARD')) ?? null;
  const next = await freshItem(store, sid, deps, { keepLog: false, prev });
  await store.put(next);
  return viewOf(next, [], deps.now());
}

// ---- events and the agent ----------------------------------------------------------------------------------------

export async function submitEvent(store, sid, ev, deps, { source = 'board' } = {}) {
  let item = await load(store, sid, deps);
  ({ item } = await rollClock(store, item, deps));
  const now = deps.now();
  const runs = await recentRuns(store, sid, 3);
  if (runs.some((r) => r.status === 'running' && now - r.startedAt < 4 * 60_000)) throw httpErr(409, 'The agent is still working on the previous change. Wait for it to finish.');
  if ((item.events ?? 0) >= MAX_EVENTS_PER_SESSION) throw httpErr(429, 'This demo board has reached its event limit. Reset the board to continue.');
  const r = applyEvent(item, ev, now, { counter: item.counter });
  if (!r.ok) throw httpErr(422, r.error);
  item.handlers = r.board.handlers; item.disputes = r.board.disputes; item.counter = (item.counter ?? 0) + (ev.type === 'dispute.created' ? 1 : 0); item.events = (item.events ?? 0) + 1;
  let dirty = r.dirty;
  if (!dirty.length) dirty = item.disputes.filter((d) => isOpen(d) && ['tight', 'breach'].includes(assess(d, now).risk)).map((d) => d.id);
  const srcLabel = { 'paypal-webhook': 'PayPal webhook, signature verified', 'paypal-poll': 'PayPal API read (webhook had not arrived)', fixture: 'Fixture event', board: 'Board action' }[source] ?? source;
  addLog(item, now, source.startsWith('paypal') ? 'paypal' : 'event', r.label, `${r.facts} Source: ${srcLabel}.`);
  const run = {
    pk: pk(sid), sk: `RUN#${String(now).padStart(14, '0')}#${uid()}`, status: 'running', startedAt: now, steps: [],
    trigger: { type: ev.type, source, sourceLabel: srcLabel, label: r.label, facts: r.facts, dirty, disputeId: r.disputeId ?? null }, ttl: Math.floor(now / 1000) + TTL_S,
  };
  run.id = run.sk.slice(4);
  const next = await save(store, item, deps);
  await store.put(run);
  await deps.runJob({ job: 'agent', sid, runId: run.sk });
  return { ...viewOf(next, [stripKeys(run), ...(await recentRuns(store, sid, 7))].filter(dedupe()), now), runId: run.sk };
}
const stripKeys = ({ pk: _p, sk: _s, ...r }) => r;
const dedupe = () => { const seen = new Set(); return (r) => (seen.has(r.id) ? false : seen.add(r.id)); };

async function modelBudget(store, deps) {
  const day = new Date(deps.now()).toISOString().slice(0, 10);
  const cap = Number(deps.env.BEDROCK_DAILY_CAP ?? 250);
  const row = (await store.get('CAP', day)) ?? { pk: 'CAP', sk: day, n: 0, ttl: Math.floor(deps.now() / 1000) + 3 * 24 * 3600 };
  if (row.n >= cap) return false;
  row.n++;
  await store.put(row);
  return true;
}

export async function executeRun(store, sid, runSk, deps) {
  const run = await store.get(pk(sid), runSk);
  if (!run || run.status !== 'running') return;
  const emit = async (step) => {
    run.steps = [...run.steps, { ...step, at: deps.now() }];
    await store.patch(run.pk, run.sk, { steps: run.steps });
  };
  try {
    let item = await load(store, sid, deps);
    const now = deps.now();
    const useModel = await modelBudget(store, deps);
    const base = { board: { handlers: item.handlers, disputes: item.disputes }, now, trigger: run.trigger, emit, deps: { ...deps.agent, ...(useModel ? {} : { useModel: false, reason: 'the daily model budget for this demo is spent' }) } };
    const res = await runAgent(base);
    const baseVersion = item.version;
    let committed = false;
    for (let attempt = 0; attempt < 3 && !committed; attempt++) {
      if (attempt) item = await load(store, sid, deps);
      const disputes = item.version === baseVersion ? res.disputes : reapply(item, res, deps.now());
      const upd = { ...item, disputes };
      addLog(upd, deps.now(), res.engine === 'bedrock' ? 'agent' : 'rules', res.engine === 'bedrock' ? 'Agent reflowed the board' : 'Rule-based reflow', res.explanation,
        { runId: run.id, moves: describeMoves(res.moves, item.handlers), engine: res.engine });
      try { await save(store, upd, deps); committed = true; }
      catch (e) { if (!(e instanceof ConflictError)) throw e; }
    }
    if (!committed) throw new Error('The board kept changing while the agent worked.');
    const summary = summarise({ disputes: res.disputes }, deps.now());
    await store.patch(run.pk, run.sk, {
      status: 'done', endedAt: deps.now(), engine: res.engine, model: res.model, fallbackReason: res.fallbackReason ?? null, explanation: res.explanation, turns: res.turns,
      moves: res.moves.map((m) => ({ disputeId: m.disputeId, from: m.from, to: m.to })), unplaced: res.unplaced, summary,
    });
  } catch (e) {
    console.error('run failed', e);
    await store.patch(run.pk, run.sk, { status: 'failed', endedAt: deps.now(), error: String(e.message).slice(0, 240) });
  }
}

/** The board changed under a running agent (a person dragged something). Keep their blocks, re-apply the agent's moves where still valid. */
function reapply(item, res, now) {
  let ds = item.disputes.map((d) => ({ ...d }));
  for (const m of res.moves) {
    const d = ds.find((x) => x.id === m.disputeId);
    if (!d || !isOpen(d) || !m.to) continue;
    d.handlerId = m.to.handlerId; d.start = m.to.start; d.end = m.to.end;
  }
  const r = reflow({ handlers: item.handlers, disputes: ds }, now, { dirty: [] });
  return r.disputes;
}

// ---- PayPal ------------------------------------------------------------------------------------------------------

export async function paypalRefund(store, sid, { disputeId, mode = 'full' }, deps) {
  let item = await load(store, sid, deps);
  ({ item } = await rollClock(store, item, deps));
  const d = item.disputes.find((x) => x.id === disputeId);
  if (!d || !isOpen(d)) throw httpErr(404, 'That dispute is not open.');
  if (d.pendingRefund) throw httpErr(409, 'A PayPal refund for this dispute is already on its way.');
  const amount = mode === 'partial' ? Math.max(1, Math.round(d.amount.value * 0.4 * 100) / 100) : d.amount.value;
  const seq = (d.refundSeq ?? 0) + 1;
  const out = await deps.paypal.createRefundedInvoice({ env: deps.env, sid, disputeId, amount, currency: d.amount.currency, seq });
  const now = deps.now();
  await store.put({ pk: `INV#${out.invoiceId}`, sk: 'MAP', sid, disputeId, amount, mode, at: now, ttl: Math.floor(now / 1000) + TTL_S });
  d.refundSeq = seq; d.pendingRefund = { invoiceId: out.invoiceId, amount, mode, at: now };
  addLog(item, now, 'paypal', `PayPal refund sent for ${d.id}`, `Sandbox invoice ${out.invoiceId} was created, paid and refunded (${money({ currency: d.amount.currency, value: amount })}). The board waits for PayPal's refund event before it moves anything.`);
  let next;
  try { next = await save(store, item, deps); }
  catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    next = await store.get(pk(sid), 'BOARD'); // a second click or a poll saved first; the PayPal calls were idempotent
  }
  return { ...viewOf(next, await recentRuns(store, sid), now), invoiceId: out.invoiceId, steps: out.steps, repeat: !!out.repeat };
}

/** If PayPal's webhook has not arrived in 45 seconds, read the invoice and apply the refund from that, and say so. */
async function reconcileRefunds(store, item, deps) {
  const now = deps.now();
  const stale = item.disputes.filter((d) => d.pendingRefund && now - d.pendingRefund.at > 45_000);
  for (const d of stale) {
    try { await processInvoiceRefund(store, d.pendingRefund.invoiceId, deps, 'paypal-poll'); } catch (e) { console.warn('reconcile failed', e.message); }
  }
  return stale.length ? (await store.get(item.pk, 'BOARD')) ?? item : item;
}

export async function processInvoiceRefund(store, invoiceId, deps, source) {
  const map = await store.get(`INV#${invoiceId}`, 'MAP');
  if (!map) return { status: 'ignored', reason: 'invoice was not created by this app' };
  if (map.processedAt) return { status: 'duplicate' };
  const inv = await deps.paypal.getInvoice(invoiceId, deps.env);
  const ref = pp.refundedAmount(inv);
  if (!(ref.value > 0)) return { status: 'pending', reason: `invoice status ${ref.status}, nothing refunded yet` };
  await store.put({ ...map, processedAt: deps.now(), source }, { });
  const board = await store.get(pk(map.sid), 'BOARD');
  if (board) {
    const d = board.disputes.find((x) => x.id === map.disputeId);
    if (d) { delete d.pendingRefund; await store.put({ ...board, version: board.version + 1 }, { expectVersion: board.version }).catch(() => {}); }
  }
  try {
    await submitEvent(store, map.sid, { type: 'payment.refunded', disputeId: map.disputeId, amount: ref.value }, deps, { source });
    return { status: 'applied', sid: map.sid, disputeId: map.disputeId, amount: ref.value };
  } catch (e) {
    if (e.status === 409) { await store.put({ ...map }); return { status: 'busy', reason: e.message }; }
    throw e;
  }
}

export async function refreshLive(store, sid, deps) {
  let item = await load(store, sid, deps);
  ({ item } = await rollClock(store, item, deps));
  const live = await deps.paypal.readLiveDisputes(deps.env);
  item.live = liveInfo(live);
  const fresh = (live.disputes ?? []).filter((d) => !item.disputes.some((x) => x.id === d.id));
  // A live dispute already on the board takes PayPal's newer facts, e.g. the real response deadline once it is filled in.
  const changed = [];
  for (const l of live.disputes ?? []) {
    const d = item.disputes.find((x) => x.id === l.id);
    if (!d || d.state !== 'open') continue;
    if (d.dueAt !== l.dueAt || d.stage !== l.stage || d.amount.value !== l.amount.value) { Object.assign(d, { dueAt: l.dueAt, dueEstimated: l.dueEstimated, stage: l.stage, amount: l.amount, status: l.status, paypalState: l.paypalState }); changed.push(d.id); }
  }
  if (changed.length) item.disputes = reflow(item, deps.now(), { dirty: changed }).disputes;
  const bits = [live.ok ? `${live.disputes.length} live dispute${live.disputes.length === 1 ? '' : 's'} read` : `the read failed: ${live.error}`];
  if (live.failed?.length) bits.push(`could not fetch ${live.failed.map((f) => `${f.id} (${f.error})`).join(', ')}; the board kept its last copy`);
  if (changed.length) bits.push(`${changed.join(', ')} updated from PayPal and re-placed`);
  addLog(item, deps.now(), 'paypal', 'Checked PayPal for disputes', bits.join('; ') + '.');
  const next = await save(store, item, deps);
  if (fresh.length) return submitEvent(store, sid, { type: 'dispute.created', dispute: fresh[0] }, deps, { source: 'paypal-poll' });
  return viewOf(next, await recentRuns(store, sid), deps.now());
}

export async function getFeed(store, deps) {
  const rows = await store.query('FEED', '', { limit: 40, reverse: true });
  return rows.map(({ pk: _p, sk: _s, raw: _r, headers: _h, ...r }) => r);
}

export async function recordFeed(store, row, deps) {
  const now = deps.now();
  await store.put({ pk: 'FEED', sk: `${String(now).padStart(14, '0')}#${uid()}`, at: now, ttl: Math.floor(now / 1000) + 7 * 24 * 3600, ...row });
}

export async function ingestEvent(store, event, deps) {
  const type = event.event_type ?? '';
  const id = event.id;
  const seen = await store.get(`WHID#${id}`, 'X');
  if (seen) return { status: 'duplicate' };
  await store.put({ pk: `WHID#${id}`, sk: 'X', at: deps.now(), ttl: Math.floor(deps.now() / 1000) + 7 * 24 * 3600 });
  if (type.startsWith('INVOICING.INVOICE.')) {
    const invoiceId = event.resource?.invoice?.id ?? event.resource?.id;
    const map = invoiceId ? await store.get(`INV#${invoiceId}`, 'MAP') : null;
    if (!map) return { status: 'ignored', reason: 'not an invoice this app created', invoiceId };
    if (type === 'INVOICING.INVOICE.REFUNDED') return { ...(await processInvoiceRefund(store, invoiceId, deps, 'paypal-webhook')), invoiceId, disputeId: map.disputeId };
    return { status: 'recorded', invoiceId, disputeId: map.disputeId };
  }
  if (type.startsWith('CUSTOMER.DISPUTE.')) return { status: 'recorded', reason: 'live dispute event noted; the board reads live disputes on refresh' };
  return { status: 'ignored', reason: 'not a dispute or invoice event' };
}

export { readiness };
