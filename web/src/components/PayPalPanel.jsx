import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ago, clock, dayName } from '../lib/format.js';

const OUTCOME = {
  applied: 'Applied to the board', recorded: 'Recorded', ignored: 'Ignored: not ours', duplicate: 'Duplicate delivery, ignored', rejected: 'Rejected', received: 'Received, processing', pending: 'Waiting for the refund to post', busy: 'Agent busy, will retry', error: 'Failed',
};

export default function PayPalPanel({ board, busy, onRefresh }) {
  const [feed, setFeed] = useState(null);
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => { api.feed().then((f) => live && setFeed(f.events)).catch(() => {}); api.status().then((s) => live && setStatus(s)).catch(() => {}); };
    load();
    const t = setInterval(load, 6000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const l = board.live;
  const now = Date.now();
  const mine = (feed ?? []).filter((e) => !(e.status === 'ignored'));
  const ignored = (feed ?? []).length - mine.length;
  return (
    <div className="paypal-grid">
      <section className="panel" aria-labelledby="pp1">
        <h2 id="pp1">Live disputes read</h2>
        <p>
          <code>GET /v1/customer/disputes</code> returned <b>{l.ok ? `${l.listCount ?? 0} dispute${l.listCount === 1 ? '' : 's'}` : 'an error'}</b>
          {l.ok ? '.' : `: ${l.error}`} Last read {ago(l.checkedAt, now)}.        </p>
        
        <button type="button" className="btn primary" disabled={busy} onClick={onRefresh}>Check PayPal for new disputes</button>
        {l.scopes?.length > 0 && <p className="small muted">Token scopes: {l.scopes.join(', ')}</p>}
      </section>

      <section className="panel" aria-labelledby="pp2">
        <h2 id="pp2">Webhook deliveries</h2>
        <p className="muted small">One webhook subscription for this app. Every delivery is signature-checked before it is read. Deliveries meant for other apps on the same PayPal account are acknowledged and set aside{ignored ? ` (${ignored} so far)` : ''}.</p>
        {!feed && <p className="muted">Loading</p>}
        {feed && !mine.length && <p className="muted">No deliveries yet. Refund a case through PayPal on the Board tab and the event shows up here within a few seconds.</p>}
        {mine.length > 0 && (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Webhook deliveries, scrolls sideways">
            <table>
              <thead><tr><th scope="col">Received (UTC)</th><th scope="col">Event</th><th scope="col">Signature</th><th scope="col">Outcome</th></tr></thead>
              <tbody>
                {mine.slice(0, 12).map((e, i) => (
                  <tr key={i}>
                    <td>{dayName(e.at)} {clock(e.at)}</td>
                    <td><code>{e.eventType}</code>{e.disputeId && <small>{e.disputeId}</small>}</td>
                    <td><span className={`pill ${e.verified ? 'p-ok' : 'p-breach'}`}>{e.verified ? 'Verified' : 'Rejected'}</span></td>
                    <td>{OUTCOME[e.status] ?? e.status}{e.reason && <small>{e.reason}</small>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="pp3">
          <h2 id="pp3">Agent</h2>
          <ul className="plain">
            <li><b>Agent:</b> Claude Sonnet 4.5 on Amazon Bedrock with six scheduling tools. When Bedrock is rate limited the same engine runs without it, and the run says so.</li>
          </ul>
        </section>
    </div>
  );
}
