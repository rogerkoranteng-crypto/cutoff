// Board events. Each one changes the facts about a dispute (deadline, stage, evidence, amount, who is on shift)
// and names the disputes whose blocks now need a second look. Rescheduling is the agent's job, not this file's.
import { HOUR, ceilQ, STAGE_ORDER, STAGE_LABEL, fmtSpan, isOpen, inProgress } from './engine.js';
import { incomingDispute } from './fixtures.js';

/** Response window after escalation. A dispute that moves up a stage gets less time. */
export const STAGE_WINDOW_H = { CHARGEBACK: 24, PRE_ARBITRATION: 16, ARBITRATION: 12 };

export const EVENT_TYPES = ['dispute.created', 'dispute.escalated', 'deadline.shortened', 'evidence.received', 'payment.refunded', 'handler.off'];

const money = (a) => `${a.currency === 'USD' ? '$' : a.currency + ' '}${a.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export { money };

/**
 * @returns {{ ok:true, board, dirty:string[], label:string, facts:string, disputeId?:string } | { ok:false, error:string }}
 */
export function applyEvent(board, ev, now, { counter = 0 } = {}) {
  const ds = board.disputes.map((d) => ({ ...d, evidence: d.evidence.map((e) => ({ ...e })) }));
  const hs = board.handlers.map((h) => ({ ...h }));
  const find = (id) => ds.find((d) => d.id === id);
  const need = () => {
    const d = find(ev.disputeId);
    if (!d) return { error: `No dispute ${ev.disputeId} on this board.` };
    if (!isOpen(d)) return { error: `${d.id} is already closed.` };
    return { d };
  };
  switch (ev.type) {
    case 'dispute.created': {
      const d = ev.dispute ?? incomingDispute(counter, now);
      if (find(d.id)) return { ok: false, error: `${d.id} is already on the board.` };
      ds.push(d);
      return { ok: true, board: { ...board, disputes: ds, handlers: hs }, dirty: [d.id], disputeId: d.id,
        label: `${d.id} arrived`, facts: `New ${STAGE_LABEL[d.stage].toLowerCase()} dispute ${d.id}, ${money(d.amount)}, response due in ${fmtSpan((d.dueAt - now) / 60000)}.` };
    }
    case 'dispute.escalated': {
      const { d, error } = need(); if (error) return { ok: false, error };
      const i = STAGE_ORDER.indexOf(d.stage);
      if (i >= STAGE_ORDER.length - 1) return { ok: false, error: `${d.id} is already at arbitration.` };
      const was = d.stage; d.stage = STAGE_ORDER[i + 1]; d.status = 'WAITING_FOR_SELLER_RESPONSE';
      const newDue = ceilQ(now + STAGE_WINDOW_H[d.stage] * HOUR);
      const before = d.dueAt; d.dueAt = Math.min(d.dueAt, newDue);
      return { ok: true, board: { ...board, disputes: ds, handlers: hs }, dirty: [d.id], disputeId: d.id,
        label: `${d.id} escalated to ${STAGE_LABEL[d.stage].toLowerCase()}`,
        facts: `${d.id} moved from ${STAGE_LABEL[was].toLowerCase()} to ${STAGE_LABEL[d.stage].toLowerCase()}. ${d.dueAt < before ? `The response deadline shortened from ${fmtSpan((before - now) / 60000)} to ${fmtSpan((d.dueAt - now) / 60000)} away.` : 'The deadline did not change.'}` };
    }
    case 'deadline.shortened': {
      const { d, error } = need(); if (error) return { ok: false, error };
      const hours = Number(ev.hours ?? 6);
      const target = ceilQ(now + hours * HOUR);
      if (target >= d.dueAt) return { ok: false, error: `${d.id} is already due in ${fmtSpan((d.dueAt - now) / 60000)}, sooner than ${hours}h.` };
      const before = d.dueAt; d.dueAt = target;
      return { ok: true, board: { ...board, disputes: ds, handlers: hs }, dirty: [d.id], disputeId: d.id,
        label: `${d.id} deadline moved up`, facts: `PayPal shortened the response window on ${d.id} from ${fmtSpan((before - now) / 60000)} to ${fmtSpan((d.dueAt - now) / 60000)} away.` };
    }
    case 'evidence.received': {
      const { d, error } = need(); if (error) return { ok: false, error };
      const pending = d.evidence.filter((e) => e.state !== 'ready');
      if (!pending.length) return { ok: false, error: `${d.id} already has all its evidence.` };
      const requested = pending.filter((e) => e.state === 'requested');
      const got = requested.length ? requested : [pending.sort((a, b) => b.effortMin - a.effortMin)[0]];
      got.forEach((e) => { e.state = 'ready'; });
      return { ok: true, board: { ...board, disputes: ds, handlers: hs }, dirty: [d.id], disputeId: d.id,
        label: `Evidence arrived for ${d.id}`, facts: `${got.map((e) => e.label).join(' and ')} reached ${d.id}, so the remaining work on it shrinks.` };
    }
    case 'payment.refunded': {
      const { d, error } = need(); if (error) return { ok: false, error };
      const amt = Number(ev.amount ?? d.amount.value);
      if (!(amt > 0)) return { ok: false, error: 'Refund amount must be positive.' };
      if (amt >= d.amount.value - 0.004) {
        d.state = 'resolved'; d.status = 'RESOLVED'; d.start = null; d.end = null; d.handlerId = d.handlerId;
        return { ok: true, board: { ...board, disputes: ds, handlers: hs }, dirty: [], disputeId: d.id, resolved: [d.id],
          label: `${d.id} refunded in full`, facts: `The ${money(d.amount)} on ${d.id} was refunded in full, so the dispute closes and its block comes off the board.` };
      }
      const before = d.amount.value; d.amount = { ...d.amount, value: Math.round((before - amt) * 100) / 100 };
      return { ok: true, board: { ...board, disputes: ds, handlers: hs }, dirty: [d.id], disputeId: d.id,
        label: `${d.id} partly refunded`, facts: `${money({ ...d.amount, value: amt })} of ${d.id} was refunded. ${money(d.amount)} is still in dispute.` };
    }
    case 'handler.off': {
      const h = hs.find((x) => x.id === ev.handlerId);
      if (!h) return { ok: false, error: 'Unknown handler.' };
      const hours = Number(ev.hours ?? 24);
      h.off = { from: ceilQ(now), until: ceilQ(now + hours * HOUR) };
      const dirty = [];
      for (const d of ds) {
        if (!isOpen(d) || d.handlerId !== h.id || d.start == null || d.pinned) continue;
        if (d.start < h.off.until && d.end > h.off.from) {
          if (inProgress(d, now)) { d.start = null; d.end = null; }
          dirty.push(d.id);
        }
      }
      return { ok: true, board: { ...board, disputes: ds, handlers: hs }, dirty, disputeId: null, handlerId: h.id,
        label: `${h.name} off shift for ${hours}h`, facts: `${h.name} is off shift for the next ${hours} hours. ${dirty.length ? `${dirty.length} block${dirty.length > 1 ? 's' : ''} sit inside that gap: ${dirty.join(', ')}.` : 'No blocks sit inside that gap.'}` };
    }
    default:
      return { ok: false, error: `Unknown event type ${ev.type}.` };
  }
}
