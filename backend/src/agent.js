// The rescheduling agent. Bedrock Converse drives a bounded tool loop: read the queue and capacity, check evidence
// and time on the dispute that changed, rank assignees, preview, commit, then explain. The engine enforces shifts,
// overlaps and skills, so the model chooses among valid schedules and cannot save an invalid one.
// When Bedrock is rate limited or errors, the same engine runs without the model and the run is labelled as such.
import { converseTurn, BedrockUnavailable, MODEL } from './bedrock.js';
import { TOOLS, makeToolRunner, stepLabel } from './tools.js';
import { reflow, assess, isOpen } from './engine.js';

export const MAX_TURNS = 7;

const SYSTEM = `You are the rescheduling agent for a PayPal dispute triage board. Each row is a case handler; each dispute has one work block that must finish before its response deadline. When something changes, you decide who works what and in which order, then explain the change.

Work like this:
1. Read the situation with read_queue and read_capacity. Call independent tools together in one turn.
2. For the dispute that changed, call assess_evidence and time_remaining, then pick_assignee.
3. Use reflow_schedule with mode "preview" if you are unsure, then mode "commit" exactly once. Pass assignments only when you want a dispute on a specific handler; otherwise the engine keeps healthy blocks where they are.
4. After the commit, write the explanation and stop.

Rules:
- Use only numbers the tools returned. Never invent times, amounts or names. All times are UTC.
- Prefer the smallest change that keeps every deadline. Do not shuffle blocks that are fine.
- A dispute at pre-arbitration or arbitration needs a handler with the escalation skill. The engine refuses anything else.
- If a deadline cannot be met by anyone, say so plainly in the explanation and name the dispute.
- The explanation is plain text, at most 80 words, no markdown, no bullet points, no headings. Say what changed, who now has it, and why that choice beat the others. Write dispute ids exactly as given.
- You have at most ${MAX_TURNS} turns. Commit before your last turn.`;

export function describeMoves(moves, handlers) {
  const nm = (id) => handlers.find((h) => h.id === id)?.name ?? id;
  const t = (x) => new Date(x).toISOString().slice(11, 16) + 'Z';
  return moves.map((m) => {
    if (!m.to) return `${m.disputeId} lost its slot`;
    if (!m.from) return `${m.disputeId} placed with ${nm(m.to.handlerId)} at ${t(m.to.start)}`;
    if (m.from.handlerId !== m.to.handlerId) return `${m.disputeId} moved from ${nm(m.from.handlerId)} to ${nm(m.to.handlerId)} at ${t(m.to.start)}`;
    return `${m.disputeId} moved on ${nm(m.to.handlerId)} from ${t(m.from.start)} to ${t(m.to.start)}`;
  });
}

function rulesExplanation(trigger, moves, board, after, now, why) {
  const lines = describeMoves(moves, board.handlers);
  const risky = after.filter(isOpen).map((d) => ({ d, a: assess(d, now) })).filter((x) => x.a.risk === 'breach');
  const head = `Rule-based reflow (${why}). `;
  const body = lines.length ? `${lines.slice(0, 4).join('; ')}${lines.length > 4 ? `; and ${lines.length - 4} more` : ''}. Healthy blocks stayed where they were.` : 'No block needed to move.';
  const tail = risky.length ? ` Still at risk of breach: ${risky.map((x) => x.d.id).join(', ')}.` : ' Every open dispute now finishes before its deadline.';
  return head + body + tail;
}

/**
 * @param {{board, now, trigger:{label,facts,dirty,disputeId?}, emit:(step)=>Promise<void>|void, deps?:{converseTurn?:Function, useModel?:boolean}}} args
 */
export async function runAgent({ board, now, trigger, emit = () => {}, deps = {} }) {
  const ctx = { board, now, dirty: trigger.dirty, committed: false, result: null };
  const run = makeToolRunner(ctx);
  const turn = deps.converseTurn ?? converseTurn;
  const messages = [{ role: 'user', content: [{ text: `Event: ${trigger.label}.\n${trigger.facts}\nThe disputes whose blocks need a second look: ${trigger.dirty.length ? trigger.dirty.join(', ') : 'none directly, but check the board'}.\nNow it is ${new Date(now).toISOString()}. Decide and commit.` }] }];
  let explanation = '';
  let turns = 0;
  let model = null;
  let fallbackReason = null;

  if (deps.useModel === false) fallbackReason = deps.reason ?? 'the model was switched off for this run';
  else {
    try {
      while (turns < MAX_TURNS && !ctx.committed) {
        turns++;
        const r = await turn({ system: SYSTEM, messages, tools: TOOLS });
        model = r.model;
        messages.push(r.message);
        const uses = (r.message.content ?? []).filter((c) => c.toolUse);
        const said = (r.message.content ?? []).filter((c) => c.text).map((c) => c.text).join(' ').trim();
        if (!uses.length) {
          if (said && ctx.committed) { explanation = said; break; }
          messages.push({ role: 'user', content: [{ text: ctx.committed ? 'Write the explanation now.' : 'Use the tools and commit the reflow.' }] });
          continue;
        }
        const results = [];
        for (const u of uses) {
          const out = await run(u.toolUse.name, u.toolUse.input);
          await emit({ kind: 'tool', name: u.toolUse.name, label: stepLabel(u.toolUse.name, u.toolUse.input ?? {}, out), turn: turns });
          results.push({ toolResult: { toolUseId: u.toolUse.toolUseId, content: [{ json: out }], status: out?.ok === false ? 'error' : 'success' } });
        }
        messages.push({ role: 'user', content: results });
      }
      if (ctx.committed) {
        if (!explanation) {
          // One more call lets the model say why. If it fails the explanation is built from the moves.
          try {
            messages.push({ role: 'user', content: [{ text: 'The reflow is committed. Write the explanation now, in plain text, at most 80 words.' }] });
            const r = await turn({ system: SYSTEM, messages, tools: TOOLS, maxTokens: 400 });
            explanation = (r.message.content ?? []).filter((c) => c.text).map((c) => c.text).join(' ').trim();
          } catch (e) { if (!(e instanceof BedrockUnavailable)) throw e; }
        }
      } else fallbackReason = `the model did not commit within ${MAX_TURNS} turns`;
    } catch (e) {
      if (!(e instanceof BedrockUnavailable)) throw e;
      if (!ctx.committed) fallbackReason = e.message;
    }
  }

  if (!ctx.committed) {
    // Rule-based path: same engine, no model.
    const r = reflow(board, now, { dirty: trigger.dirty });
    await emit({ kind: 'rules', name: 'reflow_schedule', label: `Rule-based reflow: ${r.moves.length} block${r.moves.length === 1 ? '' : 's'} moved (${fallbackReason})` });
    return { engine: 'rules', fallbackReason, model: null, turns, explanation: rulesExplanation(trigger, r.moves, board, r.disputes, now, fallbackReason), disputes: r.disputes, moves: r.moves, unplaced: r.unplaced };
  }
  const moves = ctx.result.moves;
  if (!explanation) explanation = `Committed ${moves.length} move${moves.length === 1 ? '' : 's'}: ${describeMoves(moves, board.handlers).join('; ') || 'none'}. (The model did not return an explanation.)`;
  return { engine: 'bedrock', model: model ?? MODEL(), turns, explanation: explanation.replace(/\s+/g, ' ').slice(0, 700), disputes: ctx.result.disputes, moves, unplaced: ctx.result.unplaced };
}
