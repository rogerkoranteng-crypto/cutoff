import test from 'node:test';
import assert from 'node:assert/strict';
import { seedBoard } from '../src/fixtures.js';
import { applyEvent } from '../src/events.js';
import { runAgent } from '../src/agent.js';
import { BedrockUnavailable, converseTurn } from '../src/bedrock.js';
import { assess, isOpen } from '../src/engine.js';

const NOW = Date.UTC(2026, 9, 2, 10, 7);
const use = (id, name, input) => ({ toolUse: { toolUseId: id, name, input } });

function scenario() {
  const b = seedBoard(NOW);
  const ev = applyEvent(b, { type: 'dispute.escalated', disputeId: 'FX-D-1009' }, NOW);
  return { board: ev.board, trigger: { label: ev.label, facts: ev.facts, dirty: ev.dirty } };
}

/** A scripted "model": returns canned assistant messages in order and records what the tools sent back. */
function script(turns) {
  const seen = [];
  let i = 0;
  const fn = async ({ messages }) => {
    seen.push(messages.at(-1));
    const t = turns[i++];
    if (!t) throw new Error('script ran out');
    if (t instanceof Error) throw t;
    return { message: { role: 'assistant', content: t }, stopReason: 'tool_use', usage: {}, model: 'scripted' };
  };
  fn.seen = seen;
  return fn;
}

test('the agent loops through tools, commits once, and returns the model explanation', async () => {
  const { board, trigger } = scenario();
  const steps = [];
  const turn = script([
    [use('a', 'read_queue', { scope: 'open' }), use('b', 'read_capacity', {}), use('c', 'assess_evidence', { dispute_id: 'FX-D-1009' }), use('d', 'time_remaining', { dispute_id: 'FX-D-1009' })],
    [use('e', 'pick_assignee', { dispute_id: 'FX-D-1009' })],
    [use('f', 'reflow_schedule', { mode: 'commit' })],
    [{ text: 'FX-D-1009 now has a shorter deadline, so it moved first.' }],
  ]);
  const res = await runAgent({ board, now: NOW, trigger, emit: (s) => steps.push(s), deps: { converseTurn: turn } });
  assert.equal(res.engine, 'bedrock');
  assert.match(res.explanation, /FX-D-1009/);
  assert.deepEqual(steps.map((s) => s.name), ['read_queue', 'read_capacity', 'assess_evidence', 'time_remaining', 'pick_assignee', 'reflow_schedule']);
  const d = res.disputes.find((x) => x.id === 'FX-D-1009');
  assert.ok(assess(d, NOW).slackMin >= 0);
  const toolResult = turn.seen[1].content[0].toolResult.content[0].json;
  assert.ok(toolResult.disputes.length === 12, 'tools return real queue rows');
});

test('the model can pin a dispute to a handler, and the engine refuses a handler without the skill', async () => {
  const { board, trigger } = scenario();
  const turn = script([
    [use('a', 'reflow_schedule', { mode: 'preview', assignments: [{ dispute_id: 'FX-D-1005', handler_id: 'h-noor' }] })],
    [use('b', 'reflow_schedule', { mode: 'commit', assignments: [{ dispute_id: 'FX-D-1009', handler_id: 'h-tomas' }] })],
    [{ text: 'Done.' }],
  ]);
  const seen = [];
  const res = await runAgent({ board, now: NOW, trigger, emit: (s) => seen.push(s.label), deps: { converseTurn: turn } });
  assert.match(seen[0], /failed: Noor Aziz lacks a mandatory skill/);
  assert.equal(res.disputes.find((d) => d.id === 'FX-D-1009').handlerId, 'h-tomas');
});

test('a second commit is refused', async () => {
  const { board, trigger } = scenario();
  const { makeToolRunner } = await import('../src/tools.js');
  const ctx = { board, now: NOW, dirty: trigger.dirty, committed: false };
  const run = makeToolRunner(ctx);
  assert.equal((await run('reflow_schedule', { mode: 'commit' })).committed, true);
  assert.match((await run('reflow_schedule', { mode: 'commit' })).error, /already committed/);
});

test('a throttled model falls back to the rules path and says so', async () => {
  const { board, trigger } = scenario();
  const turn = script([new BedrockUnavailable('Bedrock was rate limited and the retry budget ran out')]);
  const res = await runAgent({ board, now: NOW, trigger, emit: () => {}, deps: { converseTurn: turn } });
  assert.equal(res.engine, 'rules');
  assert.match(res.fallbackReason, /rate limited/);
  assert.match(res.explanation, /^Rule-based reflow \(Bedrock was rate limited/);
  assert.ok(res.disputes.filter(isOpen).every((d) => d.start != null));
});

test('a model that never commits is cut off after the turn budget and the rules take over', async () => {
  const { board, trigger } = scenario();
  const turn = script(Array.from({ length: 7 }, () => [use('x', 'read_queue', { scope: 'open' })]));
  const res = await runAgent({ board, now: NOW, trigger, emit: () => {}, deps: { converseTurn: turn } });
  assert.equal(res.engine, 'rules');
  assert.match(res.fallbackReason, /did not commit within 7 turns/);
});

test('a model that commits but fails to explain still yields a grounded explanation from the moves', async () => {
  const { board, trigger } = scenario();
  const turn = script([[use('a', 'reflow_schedule', { mode: 'commit' })], new BedrockUnavailable('throttled')]);
  const res = await runAgent({ board, now: NOW, trigger, emit: () => {}, deps: { converseTurn: turn } });
  assert.equal(res.engine, 'bedrock');
  assert.match(res.explanation, /Committed \d+ move/);
});

test('bedrock.converseTurn retries a throttle with backoff and then gives up inside its budget', async () => {
  let calls = 0;
  const throttle = Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });
  const t0 = Date.now();
  await assert.rejects(converseTurn({ system: 's', messages: [], tools: [], budgetMs: 2500, send: async () => { calls++; throw throttle; } }), BedrockUnavailable);
  assert.ok(calls >= 1 && Date.now() - t0 < 6000, `calls ${calls}`);
  let n = 0;
  const ok = await converseTurn({ system: 's', messages: [], tools: [], budgetMs: 20000, send: async () => { if (n++ < 1) throw throttle; return { output: { message: { content: [{ text: 'hi' }] } }, stopReason: 'end_turn', usage: {} }; } });
  assert.equal(ok.message.content[0].text, 'hi');
});
