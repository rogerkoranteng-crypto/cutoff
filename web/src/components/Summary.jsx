import React from 'react';
import { money } from '../lib/format.js';

const DAY = 24 * 3600_000;

export default function Summary({ board }) {
  const s = board.summary;
  const dueToday = board.disputes.filter((d) => d.state === 'open' && d.dueAt - board.now <= DAY).length;
  const exposed = s.amountAtRisk;
  return (
    <section className="summary" aria-label="Board summary">
      <ul>
        <li className={`lead ${exposed ? 'amber' : ''}`}>
          <b>{money({ value: exposed, currency: 'USD' })}</b>
          <span>exposed: disputes near or past their cutoff{s.breach + s.unassigned ? `, ${s.breach + s.unassigned} at risk of breach` : ''}</span>
        </li>
        <li><b>{dueToday}</b><span>due in the next 24 hours</span></li>
        <li><b>{s.open}</b><span>open disputes</span></li>
      </ul>
    </section>
  );
}
