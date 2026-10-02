// The HTTP layer end to end against the in-memory store. PayPal and Bedrock are scripted; the engine, service and handler are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.js';
import { handle, __setStore, __setDeps } from '../src/handler.js';
import * as svc from '../src/service.js';
import { BedrockUnavailable } from '../src/bedrock.js';

const SID = 'test-session-1';
const jobs = [];
let current;
const __deps = () => current;
let nowMs = Date.UTC(2026, 9, 2, 10, 7);
const use = (id, name, input) => ({ toolUse: { toolUseId: id, name, input } });

function setup({ paypal = {}, model = null, verify } = {}) {
  const store = new MemoryStore();
  __setStore(store);
  jobs.length = 0;
  const calls = [];
  const deps = svc.makeDeps({
    now: () => nowMs, env: { PAYPAL_WEBHOOK_ID: 'WH-X' },
    runJob: async (j) => { jobs.push(j); },
    agent: { converseTurn: model ?? (async () => { throw new BedrockUnavailable('scripted: no model'); }) },
    verify,
    paypal: {
      readLiveDisputes: async () => ({ ok: true, count: 0, checkedAt: nowMs, api: 'https://api-m.sandbox.paypal.com', disputes: [], scopes: ['disputes/read-seller'] }),
      createRefundedInvoice: async (a) => { calls.push(['create', a]); return { invoiceId: 'INV2-LOCAL', steps: [] }; },
      getInvoice: async () => ({ status: 'MARKED_AS_REFUNDED', refunds: { transactions: [{ amount: { currency_code: 'USD', value: '1840.00' } }] } }),
      ...paypal,
    },
  });
  __setDeps(deps);
  current = deps;
  return { store, deps, calls };
}
const req = (method, fullPath, body, headers = {}) => { const [path, qs] = fullPath.split('?'); return handle({ requestContext: { http: { method, path } }, queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined, headers: { 'x-session': SID, ...headers }, body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }); };
const j = (r) => JSON.parse(r.body);

function scriptModel(turns) { let i = 0; return async () => { const t = turns[i++]; if (!t) throw new BedrockUnavailable('script ran out'); return { message: { role: 'assistant', content: t }, stopReason: 'tool_use', usage: {}, model: 'scripted' }; }; }

test('GET /api/board seeds a session, labels the fixtures, and reports the live PayPal read', async () => {
  setup();
  const r = await req('GET', '/api/board');
  assert.equal(r.statusCode, 200);
  const b = j(r);
  assert.equal(b.disputes.length, 12);
  assert.ok(b.disputes.every((d) => d.fixture === true));
  assert.equal(b.live.count, 0);
  assert.equal(b.handlers.length, 8);
  assert.ok(b.summary.open === 12);
  assert.equal((await req('GET', '/api/board', null, { 'x-session': 'x' })).statusCode, 400);
});

test('dragging a block to a valid slot reassigns it in the store; an invalid drop is refused with a reason', async () => {
  setup();
  const b = j(await req('GET', '/api/board'));
  const d = b.disputes.find((x) => x.id === 'FX-D-1004');
  const target = b.handlers.find((h) => h.id !== d.handlerId && h.skills.includes('delivery') && h.onShift);
  const opts = j(await req('GET', `/api/disputes/${d.id}/options?handler=${target.id}`));
  assert.ok(opts.starts.length > 0, 'keyboard path has options');
  const ok = await req('POST', `/api/disputes/${d.id}/assign`, { handlerId: target.id, start: opts.starts[0].start });
  assert.equal(ok.statusCode, 200);
  const after = j(ok).disputes.find((x) => x.id === d.id);
  assert.equal(after.handlerId, target.id);
  assert.equal(after.start, opts.starts[0].start);
  assert.equal(j(await req('GET', '/api/board')).disputes.find((x) => x.id === d.id).handlerId, target.id, 'persisted');
  const bad = await req('POST', `/api/disputes/FX-D-1005/assign`, { handlerId: 'h-noor', start: nowMs + 3600_000 });
  assert.equal(bad.statusCode, 422);
  assert.match(j(bad).error, /lacks the escalation skill/);
});

test('pinning stops a block from being dragged', async () => {
  setup();
  await req('GET', '/api/board');
  assert.equal(j(await req('POST', '/api/disputes/FX-D-1004/pin', { pinned: true })).disputes.find((x) => x.id === 'FX-D-1004').pinned, true);
  const r = await req('POST', '/api/disputes/FX-D-1004/assign', { handlerId: 'h-kwame', start: nowMs + 7200_000 });
  assert.equal(r.statusCode, 422);
  assert.match(j(r).error, /pinned/);
});

test('resize refuses a block shorter than its work and accepts extra time', async () => {
  setup();
  const b = j(await req('GET', '/api/board'));
  const d = b.disputes.filter((x) => x.state === 'open').filter((x) => !b.disputes.some((o) => o.id !== x.id && o.handlerId === x.handlerId && o.start >= x.end)).sort((a, c) => a.dueAt - c.dueAt)[0];
  assert.equal((await req('POST', `/api/disputes/${d.id}/resize`, { end: d.start + 15 * 60_000 })).statusCode, 422);
  const longer = await req('POST', `/api/disputes/${d.id}/resize`, { end: d.end + 15 * 60_000 });
  assert.equal(longer.statusCode, 200, longer.body);
});

test('an event stores the new facts at once, then the agent run reflows and records an explanation', async () => {
  const model = scriptModel([
    [use('a', 'read_queue', { scope: 'at_risk' }), use('b', 'assess_evidence', { dispute_id: 'FX-D-1009' })],
    [use('c', 'pick_assignee', { dispute_id: 'FX-D-1009' })],
    [use('d', 'reflow_schedule', { mode: 'commit' })],
    [{ text: 'FX-D-1009 escalated and its deadline shortened, so it was placed first.' }],
  ]);
  const { store } = setup({ model });
  await req('GET', '/api/board');
  const r = await req('POST', '/api/events', { type: 'dispute.escalated', disputeId: 'FX-D-1009' });
  assert.equal(r.statusCode, 202);
  const v = j(r);
  assert.equal(v.disputes.find((d) => d.id === 'FX-D-1009').stage, 'CHARGEBACK', 'facts applied immediately');
  assert.equal(v.running.status, 'running');
  assert.equal((await req('POST', '/api/events', { type: 'evidence.received', disputeId: 'FX-D-1002' })).statusCode, 409, 'one run at a time');
  assert.equal(jobs.length, 1);
  await svc.executeRun(store, SID, jobs[0].runId, __deps());
  const after = j(await req('GET', '/api/board'));
  assert.equal(after.running, null);
  const run = after.runs[0];
  assert.equal(run.status, 'done');
  assert.equal(run.engine, 'bedrock');
  assert.match(run.explanation, /FX-D-1009/);
  assert.equal(run.steps.length, 4);
  assert.ok(after.log.some((l) => l.kind === 'agent'));
  assert.ok(after.summary.breach === 0);
});

test('with the model unavailable the run still finishes and is labelled rule-based', async () => {
  const { store } = setup();
  await req('GET', '/api/board');
  await req('POST', '/api/events', { type: 'deadline.shortened', disputeId: 'FX-D-1003', hours: 2 });
  await svc.executeRun(store, SID, jobs[0].runId, __deps());
  const run = j(await req('GET', '/api/board')).runs[0];
  assert.equal(run.engine, 'rules');
  assert.match(run.fallbackReason, /scripted: no model/);
  assert.match(run.explanation, /^Rule-based reflow/);
});

test('an event the board cannot apply is refused without starting a run', async () => {
  setup();
  await req('GET', '/api/board');
  const r = await req('POST', '/api/events', { type: 'dispute.escalated', disputeId: 'FX-D-1011' });
  assert.equal(r.statusCode, 422);
  assert.equal(jobs.length, 0);
});

test('PayPal refund: the board waits for the signed webhook, and a replayed delivery changes nothing', async () => {
  const { store, calls } = setup({ verify: async () => ({ ok: true, via: 'test' }) });
  await req('GET', '/api/board');
  const r = await req('POST', '/api/disputes/FX-D-1001/paypal-refund', { mode: 'full' });
  assert.equal(r.statusCode, 202);
  assert.equal(calls[0][1].amount, 1840);
  assert.equal(j(r).disputes.find((d) => d.id === 'FX-D-1001').state, 'open', 'nothing moves until PayPal reports back');
  const event = { id: 'WH-EVT-1', event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: 'INV2-LOCAL' } } };
  const hdr = { 'paypal-transmission-sig': 'sig', 'paypal-transmission-id': 't1', 'paypal-transmission-time': new Date(nowMs).toISOString(), 'paypal-cert-url': 'https://api.paypal.com/c', 'paypal-auth-algo': 'SHA256withRSA' };
  const w = await req('POST', '/api/webhooks/paypal', event, hdr);
  assert.equal(w.statusCode, 200, 'answers 200 straight away');
  const job = jobs.find((x) => x.job === 'webhook');
  assert.ok(job);
  assert.equal((await handle(job)).status, 'applied');
  const b = j(await req('GET', '/api/board'));
  assert.equal(b.disputes.find((d) => d.id === 'FX-D-1001').state, 'resolved');
  assert.equal(b.running.trigger.source, 'paypal-webhook');
  // duplicate delivery with the same event id
  await req('POST', '/api/webhooks/paypal', event, hdr);
  const dup = jobs.filter((x) => x.job === 'webhook').at(-1);
  assert.equal((await handle(dup)).status, 'duplicate');
  assert.equal(jobs.filter((x) => x.job === 'agent').length, 1, 'no second agent run');
  const feed = j(await req('GET', '/api/feed')).events;
  assert.ok(feed.some((f) => f.verified === true && f.eventType === 'INVOICING.INVOICE.REFUNDED'));
  void store;
});

test('webhook: unsigned and tampered deliveries are rejected with 401 and never reach the board', async () => {
  setup({ verify: async () => ({ ok: false, reason: 'PayPal verification_status FAILURE', via: 'paypal-api' }) });
  await req('GET', '/api/board');
  const event = { id: 'WH-EVT-2', event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: 'INV2-LOCAL' } } };
  const unsigned = await req('POST', '/api/webhooks/paypal', event);
  assert.equal(unsigned.statusCode, 401);
  const tampered = await req('POST', '/api/webhooks/paypal', event, { 'paypal-transmission-sig': 'forged', 'paypal-transmission-id': 't', 'paypal-transmission-time': new Date(nowMs).toISOString(), 'paypal-cert-url': 'https://api.paypal.com/c', 'paypal-auth-algo': 'SHA256withRSA' });
  assert.equal(tampered.statusCode, 401);
  assert.equal(jobs.filter((x) => x.job === 'webhook').length, 0);
  const feed = j(await req('GET', '/api/feed')).events;
  assert.equal(feed.filter((f) => f.status === 'rejected').length, 2);
});

test('webhook events from other apps on the same PayPal account are acknowledged and ignored', async () => {
  const { store } = setup({ verify: async () => ({ ok: true, via: 'test' }) });
  await req('GET', '/api/board');
  const hdr = { 'paypal-transmission-sig': 'sig', 'paypal-transmission-id': 't1', 'paypal-transmission-time': new Date(nowMs).toISOString(), 'paypal-cert-url': 'https://api.paypal.com/c', 'paypal-auth-algo': 'SHA256withRSA' };
  const w = await req('POST', '/api/webhooks/paypal', { id: 'WH-OTHER-1', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_item_id: 'X' } }, hdr);
  assert.equal(w.statusCode, 200);
  const out = await handle(jobs.find((x) => x.job === 'webhook'));
  assert.equal(out.status, 'ignored');
  void store;
});

test('if the webhook never arrives, the board reads the invoice itself after 45 seconds and says so', async () => {
  const { store } = setup();
  await req('GET', '/api/board');
  await req('POST', '/api/disputes/FX-D-1002/paypal-refund', { mode: 'full' });
  nowMs += 50_000;
  const b = j(await req('GET', '/api/board'));
  assert.equal(b.disputes.find((d) => d.id === 'FX-D-1002').state, 'resolved');
  assert.equal(b.running.trigger.source, 'paypal-poll');
  assert.match(b.running.trigger.sourceLabel, /webhook had not arrived/);
  void store;
});

test('reset reseeds; time passing marks finished blocks as sent', async () => {
  setup();
  const b = j(await req('GET', '/api/board'));
  const first = [...b.disputes].sort((x, y) => x.end - y.end)[0];
  nowMs = first.end + 60_000;
  const later = j(await req('GET', '/api/board'));
  assert.equal(later.disputes.find((d) => d.id === first.id).state, 'submitted');
  const fresh = j(await req('POST', '/api/board/reset'));
  assert.equal(fresh.disputes.filter((d) => d.state === 'open').length, 12);
});





