// The agent's tools. Each one reads or changes a WORKING COPY of the board held in `ctx`; nothing reaches storage
// until the service commits the result. Tool output stays small and numeric so the model argues from facts.
import { assess, workMinutes, readiness, pickAssignee, teamRoom, reflow, summarise, bookedMinutes, capacityMinutes, windows,
  isOpen, isFixed, fmtSpan, requiredSkills, MIN, HOUR, DAY, STAGE_LABEL, REASON_LABEL, eligible } from './engine.js';
import { money } from './events.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });

export const TOOLS = [
  { name: 'read_queue', description: 'List open disputes with deadline, amount, stage, evidence readiness, current assignee and block, and risk. Use scope "at_risk" for only tight or breaching disputes, "handler" with handler_id for one row of the board.',
    input: obj({ scope: { type: 'string', enum: ['open', 'at_risk', 'handler'] }, handler_id: str('required when scope is handler') }, ['scope']) },
  { name: 'read_capacity', description: 'Per-handler view: skills, shift, time off, minutes booked and free in the next 24 hours, and the next free window.', input: obj() },
  { name: 'assess_evidence', description: 'Evidence checklist for one dispute: which items are ready, requested or missing, readiness percent, and the minutes of work still needed.',
    input: obj({ dispute_id: str('dispute id, for example FX-D-1001') }, ['dispute_id']) },
  { name: 'time_remaining', description: 'Time left on one dispute: minutes to the response deadline, the latest start that still finishes in time, and how many working minutes the eligible team has before the deadline versus the work already queued ahead of it.',
    input: obj({ dispute_id: str('dispute id') }, ['dispute_id']) },
  { name: 'pick_assignee', description: 'Rank handlers for one dispute if nothing else moves: earliest slot, slack against the deadline, skill gaps, load. Handlers who lack a mandatory skill are excluded. You decide; the ranking is advice.',
    input: obj({ dispute_id: str('dispute id'), exclude_handler_ids: { type: 'array', items: { type: 'string' } } }, ['dispute_id']) },
  { name: 'reflow_schedule', description: 'Reflow the board. mode "preview" shows the moves and the resulting risks without saving; mode "commit" saves them and ends the scheduling work (call it once). Healthy blocks stay put. Pass assignments to fix a dispute on a chosen handler; the engine finds the slot and displaces less urgent blocks if it must.',
    input: obj({ mode: { type: 'string', enum: ['preview', 'commit'] }, assignments: { type: 'array', items: obj({ dispute_id: str('dispute id'), handler_id: str('handler id') }, ['dispute_id', 'handler_id']) } }, ['mode']) },
];

const hhmm = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ') + 'Z';

function rowOf(d, now, handlers) {
  const a = assess(d, now);
  const h = handlers.find((x) => x.id === d.handlerId);
  return {
    id: d.id, reason: REASON_LABEL[d.reason] ?? d.reason, stage: STAGE_LABEL[d.stage], amount: money(d.amount),
    due_in: fmtSpan(a.dueInMin), work: fmtSpan(a.work), evidence_ready_pct: a.readiness,
    handler: h ? `${h.name} (${h.id})` : null, block: d.start != null ? `${hhmm(d.start)} to ${hhmm(d.end).slice(6)}` : null,
    slack: a.slackMin == null ? null : (a.slackMin < 0 ? `-${fmtSpan(-a.slackMin)}` : fmtSpan(a.slackMin)), risk: a.risk, pinned: d.pinned || undefined, in_progress: isFixed(d, now) && !d.pinned ? true : undefined,
  };
}

export function makeToolRunner(ctx) {
  const dispute = (id) => ctx.board.disputes.find((d) => d.id === id);
  const needOpen = (id) => { const d = dispute(id); if (!d) throw new Error(`No dispute ${id}.`); if (!isOpen(d)) throw new Error(`${id} is closed.`); return d; };
  const handlers = () => ctx.board.handlers;

  const impl = {
    read_queue: ({ scope, handler_id }) => {
      let rows = ctx.board.disputes.filter(isOpen);
      if (scope === 'at_risk') rows = rows.filter((d) => ['tight', 'breach'].includes(assess(d, ctx.now).risk));
      if (scope === 'handler') rows = rows.filter((d) => d.handlerId === handler_id);
      rows.sort((a, b) => a.dueAt - b.dueAt);
      return { now: hhmm(ctx.now), times: 'UTC', count: rows.length, summary: summarise(ctx.board, ctx.now), disputes: rows.map((d) => rowOf(d, ctx.now, handlers())) };
    },
    read_capacity: () => ({
      now: hhmm(ctx.now),
      handlers: handlers().map((h) => {
        const cap = capacityMinutes(h, ctx.now, ctx.now + DAY);
        const booked = Math.round(bookedMinutes(ctx.board, h.id, ctx.now, ctx.now + DAY));
        const w = windows(h, ctx.now, ctx.now + 2 * DAY)[0];
        return { id: h.id, name: h.name, team: h.team, skills: h.skills, shift_utc: `${String(Math.floor(h.shift.startMin / 60)).padStart(2, '0')}:00 for ${h.shift.lengthMin / 60}h daily`,
          off_until: h.off && h.off.until > ctx.now ? hhmm(h.off.until) : null, capacity_next_24h_min: cap, booked_next_24h_min: booked, free_next_24h_min: Math.max(0, cap - booked), next_window: w ? `${hhmm(w.start)} to ${hhmm(w.end).slice(6)}` : null };
      }),
    }),
    assess_evidence: ({ dispute_id }) => {
      const d = needOpen(dispute_id);
      return { id: d.id, readiness_pct: readiness(d), work_minutes_left: workMinutes(d), items: d.evidence.map((e) => ({ item: e.label, state: e.state, minutes_if_missing: e.effortMin })),
        can_file_now: d.evidence.every((e) => e.state === 'ready'), note: 'Work minutes include assembly and submission for the stage, plus the gathering effort for every item that is not ready (requested items count half).' };
    },
    time_remaining: ({ dispute_id }) => {
      const d = needOpen(dispute_id);
      const work = workMinutes(d);
      const room = teamRoom(ctx.board, d, ctx.now);
      return { id: d.id, deadline: hhmm(d.dueAt), minutes_to_deadline: Math.round((d.dueAt - ctx.now) / MIN), work_minutes: work, latest_start: hhmm(d.dueAt - work * MIN),
        team_capacity_before_deadline_min: room.capacityMin, work_queued_ahead_min: room.queuedAheadMin,
        verdict: room.capacityMin - room.queuedAheadMin >= work ? 'team has room' : 'team capacity is short before this deadline', required_skills: { mandatory: requiredSkills(d).hard, preferred: requiredSkills(d).soft } };
    },
    pick_assignee: ({ dispute_id, exclude_handler_ids = [] }) => {
      const d = needOpen(dispute_id);
      const c = pickAssignee(ctx.board, dispute_id, ctx.now, { exclude: exclude_handler_ids });
      return { id: d.id, required_skills: { mandatory: requiredSkills(d).hard, preferred: requiredSkills(d).soft }, candidates: c.map((x) => ({ handler_id: x.handlerId, name: x.name, slot: `${hhmm(x.start)} to ${hhmm(x.end).slice(6)}`, slack_min: x.slackMin, meets_deadline: x.meetsDeadline, missing_preferred_skills: x.missingSoftSkills, load_next_24h_pct: x.loadNext24hPct, current_assignee: x.currentAssignee })), note: c.length ? undefined : 'No eligible handler has a slot before the horizon.' };
    },
    reflow_schedule: ({ mode, assignments = [] }) => {
      if (ctx.committed) throw new Error('The schedule was already committed.');
      const prefer = {};
      for (const a of assignments) {
        const d = needOpen(a.dispute_id);
        const h = handlers().find((x) => x.id === a.handler_id);
        if (!h) throw new Error(`Unknown handler ${a.handler_id}.`);
        if (!eligible(h, d).ok) throw new Error(`${h.name} lacks a mandatory skill for ${d.id}.`);
        prefer[d.id] = h.id;
      }
      const dirty = [...new Set([...ctx.dirty, ...Object.keys(prefer)])];
      const r = reflow(ctx.board, ctx.now, { dirty, prefer });
      const after = { ...ctx.board, disputes: r.disputes };
      const risks = r.disputes.filter(isOpen).map((d) => ({ d, a: assess(d, ctx.now) })).filter((x) => x.a.risk === 'breach' || x.a.risk === 'tight');
      const out = {
        mode, moves: r.moves.map((m) => ({ id: m.disputeId, from: m.from ? `${m.from.handlerId} ${hhmm(m.from.start)}` : 'unscheduled', to: m.to ? `${m.to.handlerId} ${hhmm(m.to.start)} to ${hhmm(m.to.end).slice(6)}` : 'unscheduled' })),
        unplaced: r.unplaced, remaining_risks: risks.map((x) => ({ id: x.d.id, risk: x.a.risk, text: x.a.riskText })), summary: summarise(after, ctx.now),
      };
      if (mode === 'commit') { ctx.committed = true; ctx.result = r; out.committed = true; }
      return out;
    },
  };
  return async (name, input) => {
    if (!impl[name]) return { ok: false, error: `Unknown tool ${name}.` };
    try { return impl[name](input ?? {}); } catch (e) { return { ok: false, error: String(e.message) }; }
  };
}

/** Human line for the activity feed, per tool call. Built from the tool output, never from model text. */
export function stepLabel(name, input, out) {
  if (out?.ok === false) return `${name} failed: ${out.error}`;
  switch (name) {
    case 'read_queue': return `Read the queue: ${out.count} dispute${out.count === 1 ? '' : 's'} (${input.scope})`;
    case 'read_capacity': return `Read capacity for ${out.handlers.length} handlers`;
    case 'assess_evidence': return `Checked evidence on ${input.dispute_id}: ${out.readiness_pct}% ready, ${fmtSpan(out.work_minutes_left)} of work left`;
    case 'time_remaining': return `Checked time on ${input.dispute_id}: ${fmtSpan(out.minutes_to_deadline)} to the deadline, ${fmtSpan(out.work_minutes)} of work`;
    case 'pick_assignee': return `Ranked handlers for ${input.dispute_id}: best is ${out.candidates[0]?.name ?? 'nobody'}`;
    case 'reflow_schedule': return out.committed ? `Committed the reflow: ${out.moves.length} block${out.moves.length === 1 ? '' : 's'} moved` : `Previewed a reflow: ${out.moves.length} block${out.moves.length === 1 ? '' : 's'} would move`;
    default: return name;
  }
}
