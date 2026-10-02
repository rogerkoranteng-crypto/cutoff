import React from 'react';
import { clock, dayClock, money, fmtSpan, RISK_WORD } from '../lib/format.js';

export default function QueueTable({ board, selectedId, onSelect }) {
  const rows = board.disputes.filter((d) => d.state !== 'resolved').sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || a.dueAt - b.dueAt);
  const name = (id) => board.handlers.find((h) => h.id === id)?.name ?? 'Unassigned';
  return (
    <section className="panel queue" aria-labelledby="q-h">
      <h2 id="q-h">Queue by deadline</h2>
      <p className="muted small">The same disputes as the board, as a table. Open a row to reassign it from the keyboard.</p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Queue table, scrolls sideways">
        <table>
          <thead>
            <tr><th scope="col">Case</th><th scope="col">Reason</th><th scope="col" className="num">Amount</th><th scope="col">Due (UTC)</th><th scope="col">Handler</th><th scope="col">Work block (UTC)</th><th scope="col">Status</th><th scope="col" className="num">Evidence</th><th scope="col"><span className="sr">Open</span></th></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className={`${d.id === selectedId ? 'sel' : ''} r-${d.risk}`}>
                <th scope="row">{d.id}</th>
                <td>{d.reasonLabel}<small>{d.stageLabel}</small></td>
                <td className="num">{money(d.amount)}</td>
                <td>{dayClock(d.dueAt, board.now)}<small>{d.state === 'open' ? `${fmtSpan(d.dueInMin)} left` : ''}</small></td>
                <td>{name(d.handlerId)}</td>
                <td>{d.start != null ? `${dayClock(d.start, board.now)} to ${clock(d.end)}` : 'Not scheduled'}</td>
                <td><span className={`pill p-${d.risk}`}>{RISK_WORD[d.risk]}</span><small>{d.state === 'open' ? d.riskText.replace(/^[^:]*:\s*/, '') : 'Response sent'}</small></td>
                <td className="num">{d.readiness}%</td>
                <td><button type="button" className="btn sm" onClick={() => onSelect(d.id)} aria-pressed={d.id === selectedId} aria-label={`Open ${d.id}`}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
