import React from 'react';
import { clock, dayName } from '../lib/format.js';

const KIND = { agent: 'Agent', rules: 'Rule-based', manual: 'You', paypal: 'PayPal', event: 'Event', system: 'Board' };

function Steps({ run }) {
  if (!run?.steps?.length) return null;
  return (
    <details className="steps">
      <summary>How it got there, {run.steps.length} step{run.steps.length === 1 ? '' : 's'}</summary>
      <ol>{run.steps.map((s, i) => <li key={i}>{s.label}</li>)}</ol>
    </details>
  );
}

export default function ActivityPanel({ board }) {
  const running = board.running;
  const byRun = new Map(board.runs.map((r) => [r.id, r]));
  return (
    <section className="panel activity" aria-labelledby="act-h">
      <h2 id="act-h">What changed and why</h2>
      <div aria-live="polite" className="live-region">
        {running && (
          <div className="working" role="status">
            <p className="working-h"><span className="spinner" aria-hidden="true" />The agent is rescheduling after: {running.trigger.label}</p>
            <ol>
              {running.steps.map((s, i) => <li key={i}>{s.label}</li>)}
              <li className="pending">Working on the next step</li>
            </ol>
          </div>
        )}
      </div>
      {!board.log.length && !running && <p className="muted">Nothing has changed yet. Pick a case and use one of the change buttons to watch the agent respond.</p>}
      <ol className="log">
        {board.log.slice(0, 14).map((e) => {
          const run = e.runId ? byRun.get(e.runId) : null;
          return (
            <li key={e.id} className={`entry k-${e.kind}`}>
              <div className="entry-head">
                <span className={`badge b-${e.kind}`}>{KIND[e.kind] ?? e.kind}</span>
                <time dateTime={new Date(e.at).toISOString()}>{dayName(e.at)} {clock(e.at)} UTC</time>
              </div>
              <h3>{e.title}</h3>
              {e.detail && <p>{e.detail}</p>}
              {e.moves?.length > 0 && (
                <ul className="moves">{e.moves.map((m, i) => <li key={i}>{m}</li>)}</ul>
              )}
              {e.engine === 'rules' && run?.fallbackReason && <p className="note">Bedrock was not used for this run: {run.fallbackReason}.</p>}
              <Steps run={run} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
