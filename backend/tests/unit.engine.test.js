import test from 'node:test';
import assert from 'node:assert/strict';
import { seedBoard } from '../src/fixtures.js';
import { applyEvent } from '../src/events.js';
import {
  windows, placeEarliest, reflow, assess, dropProblems, brokenBlocks, validStarts, workMinutes, readiness, pickAssignee, advanceClock,
  summarise, isOpen, insideShift, HOUR, MIN, DAY, ceilQ,
} from '../src/engine.js';

const NOW = Date.UTC(2026, 9, 2, 10, 7);

function noOverlaps(board) {
  const open = board.disputes.filter((d) => isOpen(d) && d.start != null);
  for (const a of open) for (const b of open) {
    if (a.id < b.id && a.handlerId === b.handlerId) assert.ok(a.end <= b.start || b.end <= a.start, `${a.id} overlaps ${b.id}`);
  }
  for (const d of open) assert.ok(insideShift(board.handlers.find((h) => h.id === d.handlerId), d.start, d.end), `${d.id} sits outside the shift`);
}

test('shift windows repeat daily and respect time off', () => {
  const h = { shift: { startMin: 8 * 60, lengthMin: 9 * 60 }, off: null };
  const w = windows(h, Date.UTC(2026, 9, 2, 0, 0), Date.UTC(2026, 9, 4, 0, 0));
  assert.equal(w.length, 2);
  assert.equal(w[0].start, Date.UTC(2026, 9, 2, 8, 0));
  assert.equal(w[0].end, Date.UTC(2026, 9, 2, 17, 0));
  const off = { ...h, off: { from: Date.UTC(2026, 9, 2, 10, 0), until: Date.UTC(2026, 9, 2, 12, 0) } };
  const w2 = windows(off, Date.UTC(2026, 9, 2, 0, 0), Date.UTC(2026, 9, 3, 0, 0));
  assert.deepEqual(w2.map((x) => [x.start, x.end]), [[Date.UTC(2026, 9, 2, 8, 0), Date.UTC(2026, 9, 2, 10, 0)], [Date.UTC(2026, 9, 2, 12, 0), Date.UTC(2026, 9, 2, 17, 0)]]);
});

test('shift windows handle a shift that wraps past midnight', () => {
  const h = { shift: { startMin: 22 * 60, lengthMin: 9 * 60 }, off: null };
  const w = windows(h, Date.UTC(2026, 9, 3, 0, 0), Date.UTC(2026, 9, 3, 12, 0));
  assert.deepEqual([w[0].start, w[0].end], [Date.UTC(2026, 9, 3, 0, 0), Date.UTC(2026, 9, 3, 7, 0)]);
});

test('placeEarliest skips busy intervals and never straddles a window', () => {
  const h = { shift: { startMin: 8 * 60, lengthMin: 4 * 60 }, off: null };
  const day = Date.UTC(2026, 9, 2);
  const busy = [{ start: day + 8 * HOUR, end: day + 10 * HOUR }];
  const s = placeEarliest(h, 90, day + 7 * HOUR, busy, day + 3 * DAY);
  assert.equal(s.start, day + 10 * HOUR);
  const tooLong = placeEarliest(h, 150, day + 10 * HOUR, [], day + 3 * DAY);
  assert.equal(tooLong.start, day + DAY + 8 * HOUR, 'a 150 minute block cannot start at 10:00 in a window that ends at 12:00');
});

test('the seeded board is internally consistent and has one block per open dispute', () => {
  const b = seedBoard(NOW);
  assert.equal(b.disputes.length, 12);
  assert.ok(b.disputes.every((d) => d.start != null && d.handlerId));
  noOverlaps(b);
  assert.equal(brokenBlocks(b, NOW).length, 0);
});

test('every pre-arbitration or arbitration dispute is held by someone with the escalation skill', () => {
  const b = seedBoard(NOW);
  for (const d of b.disputes.filter((x) => ['PRE_ARBITRATION', 'ARBITRATION'].includes(x.stage))) {
    assert.ok(b.handlers.find((h) => h.id === d.handlerId).skills.includes('escalation'), d.id);
  }
});

test('seeding is the same shape at any time of day', () => {
  for (const hr of [0, 5, 11, 17, 23]) {
    const now = Date.UTC(2026, 9, 2, hr, 7);
    const b = seedBoard(now);
    noOverlaps(b);
    assert.equal(summarise(b, now).unassigned, 0, `hour ${hr}`);
  }
});

test('reflow with nothing dirty moves nothing', () => {
  const b = seedBoard(NOW);
  const r = reflow(b, NOW, { dirty: [] });
  assert.equal(r.moves.length, 0);
});

test('an escalation that shortens the deadline moves the dispute and keeps the board valid', () => {
  const b = seedBoard(NOW);
  const ev = applyEvent(b, { type: 'dispute.escalated', disputeId: 'FX-D-1009' }, NOW);
  assert.ok(ev.ok);
  assert.equal(ev.board.disputes.find((d) => d.id === 'FX-D-1009').stage, 'CHARGEBACK');
  const r = reflow(ev.board, NOW, { dirty: ev.dirty });
  noOverlaps({ handlers: b.handlers, disputes: r.disputes });
  const d = r.disputes.find((x) => x.id === 'FX-D-1009');
  assert.ok(assess(d, NOW).slackMin >= 0, 'finishes before its new deadline');
  assert.ok(r.moves.length <= 4, `a small change should stay small, moved ${r.moves.length}`);
});

test('a shortened deadline can displace a block with more slack', () => {
  const b = seedBoard(NOW);
  const ev = applyEvent(b, { type: 'deadline.shortened', disputeId: 'FX-D-1005', hours: 3 }, NOW);
  assert.ok(ev.ok);
  const r = reflow(ev.board, NOW, { dirty: ev.dirty });
  noOverlaps({ handlers: b.handlers, disputes: r.disputes });
  const moved = r.moves.map((m) => m.disputeId);
  assert.ok(moved.includes('FX-D-1005'));
});

test('a handler going off shift moves exactly the blocks inside the gap, onto people who are eligible', () => {
  const b = seedBoard(NOW);
  const busiest = b.handlers.find((h) => h.id === 'h-esi');
  const mine = b.disputes.filter((d) => d.handlerId === busiest.id).map((d) => d.id);
  assert.ok(mine.length >= 2);
  const ev = applyEvent(b, { type: 'handler.off', handlerId: busiest.id, hours: 24 }, NOW);
  assert.deepEqual(ev.dirty.sort(), mine.filter((id) => { const d = b.disputes.find((x) => x.id === id); return d.start < ceilQ(NOW) + 24 * HOUR; }).sort());
  const r = reflow(ev.board, NOW, { dirty: ev.dirty });
  const after = { handlers: ev.board.handlers, disputes: r.disputes };
  noOverlaps(after);
  for (const id of ev.dirty) {
    const d = r.disputes.find((x) => x.id === id);
    assert.notEqual(d.handlerId, null);
    const h = after.handlers.find((x) => x.id === d.handlerId);
    if (['PRE_ARBITRATION', 'ARBITRATION'].includes(d.stage)) assert.ok(h.skills.includes('escalation'));
    assert.ok(!(d.handlerId === busiest.id && d.start < busiest.off?.until), 'not placed inside the off window');
  }
});

test('evidence arriving shrinks the work and the readiness rises', () => {
  const b = seedBoard(NOW);
  const d0 = b.disputes.find((d) => d.id === 'FX-D-1002');
  const ev = applyEvent(b, { type: 'evidence.received', disputeId: 'FX-D-1002' }, NOW);
  const d1 = ev.board.disputes.find((d) => d.id === 'FX-D-1002');
  assert.ok(workMinutes(d1) < workMinutes(d0));
  assert.ok(readiness(d1) > readiness(d0));
});

test('a full refund closes the dispute and removes it from the open queue; a partial one lowers the amount', () => {
  const b = seedBoard(NOW);
  const full = applyEvent(b, { type: 'payment.refunded', disputeId: 'FX-D-1001', amount: 1840 }, NOW);
  assert.equal(full.board.disputes.find((d) => d.id === 'FX-D-1001').state, 'resolved');
  assert.equal(summarise(full.board, NOW).open, 11);
  const part = applyEvent(b, { type: 'payment.refunded', disputeId: 'FX-D-1001', amount: 800 }, NOW);
  assert.equal(part.board.disputes.find((d) => d.id === 'FX-D-1001').amount.value, 1040);
  assert.equal(part.board.disputes.find((d) => d.id === 'FX-D-1001').state, 'open');
});

test('invalid events are refused with a reason', () => {
  const b = seedBoard(NOW);
  assert.equal(applyEvent(b, { type: 'dispute.escalated', disputeId: 'NOPE' }, NOW).ok, false);
  assert.equal(applyEvent(b, { type: 'deadline.shortened', disputeId: 'FX-D-1001', hours: 40 }, NOW).ok, false);
  assert.equal(applyEvent(b, { type: 'dispute.escalated', disputeId: 'FX-D-1011' }, NOW).ok, false, 'arbitration is the last stage');
  assert.equal(applyEvent(b, { type: 'bogus' }, NOW).ok, false);
});

test('dropProblems refuses overlaps, off-shift starts, the past, missing skills and pinned blocks', () => {
  const b = seedBoard(NOW);
  const d = b.disputes.find((x) => x.id === 'FX-D-1005');
  const noor = 'h-noor';
  assert.ok(dropProblems(b, d.id, noor, d.start, NOW).some((m) => /lacks/.test(m)), 'noor has no escalation skill');
  const other = b.disputes.find((x) => x.id === 'FX-D-1001');
  assert.ok(dropProblems(b, 'FX-D-1002', other.handlerId, other.start, NOW).some((m) => /Overlaps|on shift/.test(m)));
  assert.ok(dropProblems(b, 'FX-D-1002', 'h-noor', NOW - 3 * HOUR, NOW).some((m) => /past/.test(m)));
  const pinned = { ...b, disputes: b.disputes.map((x) => (x.id === 'FX-D-1002' ? { ...x, pinned: true } : x)) };
  assert.ok(dropProblems(pinned, 'FX-D-1002', 'h-noor', NOW + HOUR, NOW).some((m) => /pinned/.test(m)));
});

test('validStarts only lists starts that dropProblems accepts', () => {
  const b = seedBoard(NOW);
  const starts = validStarts(b, 'FX-D-1002', 'h-kwame', NOW);
  assert.ok(starts.length > 3);
  for (const s of starts) assert.deepEqual(dropProblems(b, 'FX-D-1002', 'h-kwame', s.start, NOW), []);
});

test('pickAssignee excludes handlers without a mandatory skill and sorts by score', () => {
  const b = seedBoard(NOW);
  const c = pickAssignee(b, 'FX-D-1005', NOW, { limit: 10 });
  assert.ok(c.length >= 1);
  assert.ok(c.every((x) => ['h-esi', 'h-tomas'].includes(x.handlerId)));
  assert.deepEqual([...c].sort((a, b2) => a.score - b2.score), c);
});

test('time passing: finished blocks become sent responses', () => {
  const b = seedBoard(NOW);
  const first = [...b.disputes].sort((a, b2) => a.end - b2.end)[0];
  const r = advanceClock(b, first.end + MIN);
  assert.ok(r.done.includes(first.id));
  assert.equal(r.disputes.find((d) => d.id === first.id).state, 'submitted');
});

test('stress: 200 random events never produce an overlap or an off-shift block', () => {
  let rnd = 12345; const rand = () => (rnd = (rnd * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let b = seedBoard(NOW); let now = NOW;
  const types = ['dispute.escalated', 'deadline.shortened', 'evidence.received', 'payment.refunded', 'handler.off', 'dispute.created'];
  let applied = 0;
  for (let i = 0; i < 200; i++) {
    const open = b.disputes.filter(isOpen);
    const t = types[Math.floor(rand() * types.length)];
    const ev = { type: t, disputeId: open[Math.floor(rand() * open.length)]?.id, handlerId: b.handlers[Math.floor(rand() * b.handlers.length)].id, hours: 2 + Math.floor(rand() * 10), amount: 50 + Math.floor(rand() * 300) };
    const r = applyEvent(b, ev, now, { counter: i });
    if (!r.ok) continue;
    applied++;
    const out = reflow(r.board, now, { dirty: r.dirty });
    b = { ...r.board, disputes: out.disputes };
    noOverlaps(b);
    now += 15 * MIN;
    const adv = advanceClock(b, now); b = { ...b, disputes: adv.disputes };
    const fix = reflow(b, now, { dirty: [] }); b = { ...b, disputes: fix.disputes };
  }
  assert.ok(applied > 80, `applied ${applied}`);
});
