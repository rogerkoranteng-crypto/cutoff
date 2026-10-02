// Scheduling engine. Pure functions, no I/O: the Lambda, the agent tools, the rule-based fallback,
// the tests and the browser's drop validation all share this one file.
//
// Model
//   handler  : a person with skills and a daily shift (minutes after UTC midnight, repeating every 24h)
//   dispute  : a PayPal dispute with a response deadline, evidence checklist and (maybe) one work block
//   block    : { handlerId, start, end } in epoch ms. One block per dispute, always inside one shift window.
// Times are epoch milliseconds in UTC. Blocks snap to 15 minutes.

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const QUARTER = 15 * MIN;
export const HORIZON = 6 * DAY;

export const ceilQ = (t) => Math.ceil(t / QUARTER) * QUARTER;
export const floorQ = (t) => Math.floor(t / QUARTER) * QUARTER;

/** Minutes of assembly and submission work that every response needs, by lifecycle stage. */
export const ASSEMBLE_MIN = { INQUIRY: 30, CHARGEBACK: 45, PRE_ARBITRATION: 60, ARBITRATION: 90 };

/** Skill a handler needs, by dispute reason. */
export const REASON_SKILL = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'delivery',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'product',
  UNAUTHORISED: 'fraud',
  CREDIT_NOT_PROCESSED: 'billing',
  DUPLICATE_TRANSACTION: 'billing',
  INCORRECT_AMOUNT: 'billing',
  PAYMENT_BY_OTHER_MEANS: 'billing',
  CANCELED_RECURRING_BILLING: 'billing',
};

export const REASON_LABEL = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorised',
  CREDIT_NOT_PROCESSED: 'Credit not processed',
  DUPLICATE_TRANSACTION: 'Duplicate charge',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid another way',
  CANCELED_RECURRING_BILLING: 'Cancelled subscription',
};

export const STAGE_LABEL = { INQUIRY: 'Inquiry', CHARGEBACK: 'Chargeback', PRE_ARBITRATION: 'Pre-arbitration', ARBITRATION: 'Arbitration' };
export const STAGE_ORDER = ['INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'];

/** Tight means less than this much slack between the end of the block and the deadline. */
export const TIGHT_SLACK_MIN = 180;

export const isOpen = (d) => d.state === 'open';

export function requiredSkills(d) {
  const hard = [];
  const soft = [];
  const s = REASON_SKILL[d.reason];
  if (s) soft.push(s);
  if (d.stage === 'PRE_ARBITRATION' || d.stage === 'ARBITRATION') hard.push('escalation');
  else if (d.stage === 'CHARGEBACK') soft.push('escalation');
  return { hard, soft };
}

export function workMinutes(d) {
  const open = d.evidence.reduce((sum, e) => sum + (e.state === 'ready' ? 0 : e.state === 'requested' ? e.effortMin * 0.5 : e.effortMin), 0);
  return Math.ceil(((ASSEMBLE_MIN[d.stage] ?? 45) + open) / 15) * 15;
}

export function readiness(d) {
  const total = d.evidence.reduce((s, e) => s + e.weight, 0) || 1;
  const got = d.evidence.reduce((s, e) => s + (e.state === 'ready' ? e.weight : e.state === 'requested' ? e.weight * 0.25 : 0), 0);
  return Math.round((got / total) * 100);
}

/** Shift windows for a handler between from and to, with any time off removed. */
export function windows(h, from, to) {
  const out = [];
  const startDay = Math.floor(from / DAY) - 1;
  const endDay = Math.floor(to / DAY) + 1;
  for (let day = startDay; day <= endDay; day++) {
    let s = day * DAY + h.shift.startMin * MIN;
    let e = s + h.shift.lengthMin * MIN;
    s = Math.max(s, from);
    e = Math.min(e, to);
    if (e <= s) continue;
    const off = h.off;
    if (off && off.until > off.from) {
      if (off.until <= s || off.from >= e) { out.push({ start: s, end: e }); continue; }
      if (off.from > s) out.push({ start: s, end: off.from });
      if (off.until < e) out.push({ start: off.until, end: e });
    } else out.push({ start: s, end: e });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function insideShift(h, start, end) {
  return windows(h, start - DAY, end + DAY).some((w) => w.start <= start && w.end >= end);
}

/** Earliest slot of `minutes` that sits inside one window and misses every busy interval. */
export function placeEarliest(h, minutes, earliest, busy, until) {
  const len = minutes * MIN;
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  for (const w of windows(h, earliest, until)) {
    let cursor = ceilQ(Math.max(w.start, earliest));
    for (let guard = 0; guard < 60; guard++) {
      if (cursor + len > w.end) break;
      const hit = sorted.find((b) => b.start < cursor + len && b.end > cursor);
      if (!hit) return { start: cursor, end: cursor + len };
      cursor = ceilQ(hit.end);
    }
  }
  return null;
}

export const blockOf = (d) => (d.handlerId && d.start != null ? { handlerId: d.handlerId, start: d.start, end: d.end } : null);

export function inProgress(d, now) { return isOpen(d) && d.start != null && d.start <= now && d.end > now; }
export function isFixed(d, now) { return d.pinned || inProgress(d, now); }

/** Derived facts about one dispute, as of `now`. */
export function assess(d, now) {
  const work = workMinutes(d);
  const dueInMin = Math.round((d.dueAt - now) / MIN);
  const placed = d.start != null;
  const slackMin = placed ? Math.round((d.dueAt - d.end) / MIN) : null;
  let risk = 'ok';
  let riskText = '';
  if (!isOpen(d)) {
    risk = 'done';
    riskText = d.state === 'resolved' ? 'Resolved' : 'Response sent';
  } else if (!placed) {
    risk = 'breach';
    riskText = 'Unscheduled: no shift has room before the deadline';
  } else if (slackMin < 0) {
    risk = 'breach';
    riskText = `Breach risk: block ends ${fmtSpan(-slackMin)} after the deadline`;
  } else if (slackMin < TIGHT_SLACK_MIN) {
    risk = 'tight';
    riskText = `Near breach: only ${fmtSpan(slackMin)} to spare`;
  } else riskText = `On track: ${fmtSpan(slackMin)} to spare`;
  return { work, readiness: readiness(d), dueInMin, slackMin, risk, riskText };
}

export function fmtSpan(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function busyFor(disputes, handlerId, ignoreIds = new Set()) {
  return disputes
    .filter((d) => isOpen(d) && d.handlerId === handlerId && d.start != null && !ignoreIds.has(d.id))
    .map((d) => ({ start: d.start, end: d.end, id: d.id }));
}

export function eligible(h, d) {
  const { hard, soft } = requiredSkills(d);
  const hasHard = hard.every((s) => h.skills.includes(s));
  const softMiss = soft.filter((s) => !h.skills.includes(s));
  return { ok: hasHard, softMiss };
}

/** Why a proposed placement is not allowed. Empty array = allowed. */
export function dropProblems(board, id, handlerId, start, now, minutes = null) {
  const d = board.disputes.find((x) => x.id === id);
  const h = board.handlers.find((x) => x.id === handlerId);
  const out = [];
  if (!d || !isOpen(d)) return ['That dispute is not open.'];
  if (!h) return ['Unknown handler.'];
  if (d.pinned) out.push('This block is pinned. Unpin it first.');
  if (inProgress(d, now)) out.push('Work on this dispute has already started.');
  const len = Math.max(minutes ?? 0, workMinutes(d));
  const s = floorQ(start);
  const e = s + len * MIN;
  if (s < ceilQ(now) - QUARTER) out.push('That start is in the past.');
  if (!eligible(h, d).ok) out.push(`${h.name} lacks the ${requiredSkills(d).hard.join(', ')} skill this stage needs.`);
  if (!insideShift(h, s, e)) out.push(`${h.name} is not on shift for the whole block.`);
  const clash = board.disputes.find((o) => o.id !== id && isOpen(o) && o.handlerId === handlerId && o.start != null && o.start < e && o.end > s);
  if (clash) out.push(`Overlaps ${clash.id} on ${h.name}'s row.`);
  return out;
}

/** Ranked places this dispute could go if nothing else moves. */
export function pickAssignee(board, id, now, { exclude = [], limit = 4 } = {}) {
  const d = board.disputes.find((x) => x.id === id);
  if (!d) return [];
  const work = workMinutes(d);
  const earliest = ceilQ(now);
  const out = [];
  for (const h of board.handlers) {
    if (exclude.includes(h.id)) continue;
    const el = eligible(h, d);
    if (!el.ok) continue;
    const slot = placeEarliest(h, work, earliest, busyFor(board.disputes, h.id, new Set([id])), now + HORIZON);
    if (!slot) continue;
    const load = bookedMinutes(board, h.id, now, now + DAY, id);
    const cap = capacityMinutes(h, now, now + DAY);
    const slack = Math.round((d.dueAt - slot.end) / MIN);
    const stay = d.handlerId === h.id ? 0 : 1;
    const score = (slot.end - now) / HOUR + el.softMiss.length * 6 + (cap ? (load / cap) * 2 : 4) + stay * 0.75 + (slack < 0 ? 100 : 0);
    out.push({
      handlerId: h.id, name: h.name, start: slot.start, end: slot.end, slackMin: slack,
      meetsDeadline: slack >= 0, missingSoftSkills: el.softMiss, loadNext24hPct: cap ? Math.round((load / cap) * 100) : null,
      currentAssignee: d.handlerId === h.id, score: Math.round(score * 100) / 100,
    });
  }
  return out.sort((a, b) => a.score - b.score).slice(0, limit);
}

export function bookedMinutes(board, handlerId, from, to, ignoreId = null) {
  let m = 0;
  for (const d of board.disputes) {
    if (!isOpen(d) || d.handlerId !== handlerId || d.start == null || d.id === ignoreId) continue;
    const s = Math.max(d.start, from);
    const e = Math.min(d.end, to);
    if (e > s) m += (e - s) / MIN;
  }
  return m;
}

export function capacityMinutes(h, from, to) {
  return windows(h, from, to).reduce((s, w) => s + (w.end - w.start) / MIN, 0);
}

/** Working minutes the whole team has before a deadline versus the work already queued ahead of it. */
export function teamRoom(board, d, now) {
  let cap = 0;
  for (const h of board.handlers) if (eligible(h, d).ok) cap += capacityMinutes(h, now, d.dueAt);
  let queued = 0;
  for (const o of board.disputes) {
    if (!isOpen(o) || o.id === d.id || o.dueAt > d.dueAt) continue;
    queued += workMinutes(o);
  }
  return { capacityMin: Math.round(cap), queuedAheadMin: queued, ownWorkMin: workMinutes(d) };
}

/** Does the existing block of every open dispute still make sense? Returns ids that need re-placing. */
export function brokenBlocks(board, now) {
  const broken = [];
  const open = board.disputes.filter(isOpen);
  for (const d of open) {
    if (isFixed(d, now)) continue;
    if (d.start == null) { broken.push(d.id); continue; }
    const h = board.handlers.find((x) => x.id === d.handlerId);
    const work = workMinutes(d);
    if (!h || d.start < now || (d.end - d.start) / MIN < work || !insideShift(h, d.start, d.end) || !eligible(h, d).ok) { broken.push(d.id); continue; }
    if (open.some((o) => o.id !== d.id && o.handlerId === d.handlerId && o.start != null && o.start < d.end && o.end > d.start && o.id < d.id)) broken.push(d.id);
  }
  return broken;
}

/**
 * Reflow. Keeps every healthy block where it is. Re-places `dirty` disputes plus any block that has gone
 * invalid, most urgent first. A dispute that cannot meet its deadline may displace blocks that have more
 * slack (each displaced block is itself re-placed). `prefer` pins the handler for named disputes.
 * Returns a new disputes array, the list of moves, and anything that still cannot be placed.
 */
export function reflow(board, now, { dirty = [], prefer = {}, allowBump = true } = {}) {
  const ds = board.disputes.map((d) => ({ ...d }));
  const byId = new Map(ds.map((d) => [d.id, d]));
  const before = new Map(ds.map((d) => [d.id, blockOf(d)]));
  const earliest = ceilQ(now);
  const until = now + HORIZON;
  const queue = new Set([...dirty, ...brokenBlocks({ ...board, disputes: ds }, now)].filter((id) => byId.has(id) && isOpen(byId.get(id)) && !isFixed(byId.get(id), now)));
  for (const id of queue) { const d = byId.get(id); d.handlerId = d.handlerId; d.start = null; d.end = null; d._was = before.get(id)?.handlerId ?? null; }
  const bumps = new Map();
  const laxity = (d) => d.dueAt - workMinutes(d) * MIN;
  const unplaced = [];

  let guard = 0;
  while (queue.size && guard++ < 200) {
    const id = [...queue].sort((a, b) => laxity(byId.get(a)) - laxity(byId.get(b)) || byId.get(b).amount.value - byId.get(a).amount.value)[0];
    queue.delete(id);
    const d = byId.get(id);
    const work = workMinutes(d);
    const candidates = [];
    const forced = prefer[id];
    for (const h of board.handlers) {
      if (forced && h.id !== forced) continue;
      const el = eligible(h, d);
      if (!el.ok) continue;
      const hardBusy = busyFor(ds, h.id, new Set([id]));
      const bumpable = (o) => allowBump && !isFixed(o, now) && o.id !== id && o.dueAt > d.dueAt && (bumps.get(o.id) ?? 0) < 2 && !queue.has(o.id);
      const fixedBusy = hardBusy.filter((b) => !bumpable(byId.get(b.id)));
      const penalty = (el.softMiss.length * 6 * HOUR) + (d._was && d._was !== h.id ? 45 * MIN : 0);
      const plain = placeEarliest(h, work, earliest, hardBusy, until);
      if (plain) candidates.push({ h, slot: plain, bumped: [], cost: plain.end + penalty, late: plain.end > d.dueAt });
      if (allowBump && hardBusy.length !== fixedBusy.length) {
        const slot = placeEarliest(h, work, earliest, fixedBusy, until);
        if (slot && (!plain || slot.end < plain.end)) {
          const hit = hardBusy.filter((b) => bumpable(byId.get(b.id)) && b.start < slot.end && b.end > slot.start).map((b) => b.id);
          if (hit.length && hit.length <= 2) candidates.push({ h, slot, bumped: hit, cost: slot.end + penalty + hit.length * 40 * MIN, late: slot.end > d.dueAt });
        }
      }
    }
    if (!candidates.length) { d.handlerId = d._was ?? null; d.start = null; d.end = null; unplaced.push(id); delete d._was; continue; }
    const onTime = candidates.filter((c) => !c.late);
    const pool = onTime.length ? onTime : candidates;
    const best = pool.sort((a, b) => a.cost - b.cost)[0];
    d.handlerId = best.h.id; d.start = best.slot.start; d.end = best.slot.end;
    delete d._was;
    for (const bid of best.bumped) {
      const o = byId.get(bid);
      o._was = o.handlerId; o.start = null; o.end = null;
      bumps.set(bid, (bumps.get(bid) ?? 0) + 1);
      queue.add(bid);
    }
  }
  for (const d of ds) delete d._was;
  const moves = [];
  for (const d of ds) {
    if (!isOpen(d)) continue;
    const a = before.get(d.id);
    const b = blockOf(d);
    const same = a && b && a.handlerId === b.handlerId && a.start === b.start && a.end === b.end;
    if (!same && (a || b)) moves.push({ disputeId: d.id, from: a, to: b });
  }
  return { disputes: ds, moves, unplaced };
}

/** Disputes that finished their block by `now` count as worked and sent. Pure. */
export function advanceClock(board, now) {
  const done = [];
  const ds = board.disputes.map((d) => {
    if (isOpen(d) && d.start != null && d.end <= now) { done.push(d.id); return { ...d, state: 'submitted', submittedAt: d.end }; }
    return d;
  });
  return { disputes: ds, done };
}

export function summarise(board, now) {
  const open = board.disputes.filter(isOpen);
  let breach = 0, tight = 0, dueSoon = 0, unassigned = 0, atRisk = 0;
  for (const d of open) {
    const a = assess(d, now);
    if (a.risk === 'breach') breach++;
    if (a.risk === 'tight') tight++;
    if (d.dueAt - now <= 8 * HOUR) dueSoon++;
    if (d.start == null) unassigned++;
    if (a.risk === 'breach' || a.risk === 'tight') atRisk += d.amount.value;
  }
  return { open: open.length, breach, tight, dueSoon, unassigned, amountAtRisk: Math.round(atRisk * 100) / 100 };
}

/** Valid start times for one dispute on one handler's row, every `step` minutes, earliest first. Powers the keyboard reassign path. */
export function validStarts(board, id, handlerId, now, { step = 30, limit = 36 } = {}) {
  const out = [];
  const h = board.handlers.find((x) => x.id === handlerId);
  const d = board.disputes.find((x) => x.id === id);
  if (!h || !d) return out;
  const len = workMinutes(d);
  for (let t = ceilQ(now); t < now + 72 * HOUR && out.length < limit; t += QUARTER) {
    if ((t / MIN) % step !== 0) continue;
    if (!dropProblems(board, id, handlerId, t, now).length) out.push({ start: t, end: t + len * MIN, slackMin: Math.round((d.dueAt - (t + len * MIN)) / MIN) });
  }
  return out;
}
