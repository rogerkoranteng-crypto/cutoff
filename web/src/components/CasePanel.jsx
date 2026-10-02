import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { clock, dayClock, dateLabel, money, fmtSpan, RISK_WORD } from '../lib/format.js';

const NEXT_STAGE = { INQUIRY: 'chargeback', CHARGEBACK: 'pre-arbitration', PRE_ARBITRATION: 'arbitration' };
const EV_WORD = { ready: 'Ready', requested: 'Requested', missing: 'Missing' };

export default function CasePanel({ board, id, busy, onEvent, onRefund, onAssign, onPin, onClear }) {
  const d = board.disputes.find((x) => x.id === id);
  const handler = d && board.handlers.find((h) => h.id === d.handlerId);
  const [opts, setOpts] = useState(null);
  const [hid, setHid] = useState('');
  const [start, setStart] = useState('');
  const [loadErr, setLoadErr] = useState('');
  const version = board.version;

  useEffect(() => {
    if (!d || d.state !== 'open') { setOpts(null); return; }
    let live = true;
    api.options(d.id, hid || undefined).then((o) => {
      if (!live) return;
      setOpts(o); setLoadErr('');
      if (!hid) setHid(o.handlerId);
      setStart((cur) => (o.starts.some((s) => String(s.start) === cur) ? cur : o.starts[0] ? String(o.starts[0].start) : ''));
    }).catch((e) => live && setLoadErr(e.message));
    return () => { live = false; };
  }, [d?.id, hid, version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setHid(''); setStart(''); }, [id]);

  const best = opts?.ranking?.[0];
  const startOpt = useMemo(() => opts?.starts.find((s) => String(s.start) === start), [opts, start]);

  if (!d) {
    return (
      <section className="panel case" aria-labelledby="case-h">
        <h2 id="case-h" tabIndex={-1}>Case</h2>
        <p className="muted">Pick a block on the board, or a row in the queue, to see its evidence, its deadline and the ways to change it. To move a block without a mouse, pick it, then use Reassign here.</p>
      </section>
    );
  }
  const open = d.state === 'open';
  const locked = d.locked || d.pinned;
  const off = handler && handler.off && handler.off.until > board.now;
  const nextStage = NEXT_STAGE[d.stage];
  const canShorten = open && d.dueAt - board.now > 4 * 3600_000;
  const hasPending = d.evidence.some((e) => e.state !== 'ready');

  return (
    <section className="panel case" aria-labelledby="case-h">
      <div className="case-top">
        <div>
          <h2 id="case-h" tabIndex={-1}>{d.id}</h2>
          <p className="case-sub">{d.reasonLabel}, {d.stageLabel.toLowerCase()}. {d.fixture ? 'Fixture dispute.' : `Live PayPal dispute, read from the sandbox${d.paypalState ? ` (${d.paypalState.replaceAll('_', ' ').toLowerCase()})` : ''}.`}</p>
        </div>
        <p className="amount">{money(d.amount)}</p>
        <button type="button" className="icon-btn" onClick={onClear} aria-label={`Close ${d.id}`}>Close</button>
      </div>

      <p className={`verdict v-${d.risk}`} role="status">
        <b>{RISK_WORD[d.risk]}.</b> {d.riskText.replace(/^(On track|Near breach|Breach risk|Unscheduled)[:.]?\s*/i, '')}
      </p>

      <dl className="facts">
        <div><dt>Response due</dt><dd>{dateLabel(d.dueAt)}, {clock(d.dueAt)} UTC <span className="muted">({fmtSpan(d.dueInMin)} from now{d.dueEstimated ? '; estimated, PayPal has not set a date yet' : ''})</span></dd></div>
        <div><dt>Work block</dt><dd>{d.start != null ? <>{handler?.name}, {dayClock(d.start, board.now)} to {clock(d.end)} UTC <span className="muted">({fmtSpan((d.end - d.start) / 60000)})</span></> : 'Not scheduled'}</dd></div>
        <div><dt>Work left</dt><dd>{fmtSpan(d.work)} <span className="muted">at {d.readiness}% evidence readiness</span></dd></div>
        <div><dt>Needs</dt><dd>{[...d.needs.hard.map((s) => `${s} (required)`), ...d.needs.soft].join(', ') || 'Any handler'}</dd></div>
      </dl>

      {d.buyerMessage && <blockquote className="buyer"><small>Buyer's message to PayPal</small>{d.buyerMessage}</blockquote>}
      <h3>Evidence</h3>
      <ul className="evidence">
        {d.evidence.map((e) => (
          <li key={e.key} className={`ev-${e.state}`}><span className="ev-state">{EV_WORD[e.state]}</span><span>{e.label}</span>{e.state !== 'ready' && <small>{e.effortMin} min</small>}</li>
        ))}
      </ul>

      {open && (
        <>
          <h3>Move this block</h3>
          {locked ? (
            <p className="muted">{d.pinned ? 'This block is pinned, so the agent and drag-and-drop leave it alone.' : 'Work on this case has started, so it cannot be moved.'}</p>
          ) : (
            <form className="reassign" onSubmit={(e) => { e.preventDefault(); if (hid && start) onAssign(d.id, hid, Number(start)); }}>
              <label>Handler
                <select value={hid} onChange={(e) => setHid(e.target.value)} disabled={!opts}>
                  {opts?.handlers.map((h) => <option key={h.id} value={h.id}>{h.name}{h.id === d.handlerId ? ' (current)' : ''}</option>)}
                </select>
              </label>
              <label>Start
                <select value={start} onChange={(e) => setStart(e.target.value)} disabled={!opts?.starts.length}>
                  {opts?.starts.map((s) => <option key={s.start} value={s.start}>{dayClock(s.start, board.now)} to {clock(s.end)}, {s.slackMin >= 0 ? `${fmtSpan(s.slackMin)} to spare` : `${fmtSpan(-s.slackMin)} late`}</option>)}
                  {opts && !opts.starts.length && <option value="">No open slot for this handler</option>}
                </select>
              </label>
              <div className="row">
                <button type="submit" className="btn primary" disabled={busy || !start}>Reassign{hid ? ` to ${opts?.handlers.find((h) => h.id === hid)?.name.split(' ')[0] ?? ''}` : ''}</button>
                {best && best.handlerId !== hid && <button type="button" className="btn" onClick={() => { setHid(best.handlerId); }}>Use best fit: {best.name.split(' ')[0]}</button>}
              </div>
              {startOpt && startOpt.slackMin < 0 && <p className="warn-text" role="alert">That start finishes {fmtSpan(-startOpt.slackMin)} after the deadline.</p>}
              {loadErr && <p className="warn-text" role="alert">{loadErr}</p>}
            </form>
          )}
          <div className="row">
            <button type="button" className="btn" onClick={() => onPin(d.id, !d.pinned)} disabled={busy || d.locked && !d.pinned}>{d.pinned ? 'Unpin this block' : 'Pin this block'}</button>
          </div>

          {d.fixture ? (
            <>
          <h3>Change this case <span className="tag">fixture events</span></h3>
          <p className="muted small">PayPal's sandbox cannot create disputes, so these events are staged. They go through the same path a webhook would.</p>
          <div className="actions">
            {nextStage && <button type="button" className="btn" disabled={busy} onClick={() => onEvent({ type: 'dispute.escalated', disputeId: d.id })}>Escalate to {nextStage}</button>}
            {canShorten && <button type="button" className="btn" disabled={busy} onClick={() => onEvent({ type: 'deadline.shortened', disputeId: d.id, hours: 4 })}>Pull the deadline in to 4 hours</button>}
            {hasPending && <button type="button" className="btn" disabled={busy} onClick={() => onEvent({ type: 'evidence.received', disputeId: d.id })}>Evidence arrives</button>}
            {handler && <button type="button" className="btn" disabled={busy || off} onClick={() => onEvent({ type: 'handler.off', handlerId: handler.id, hours: 24 })}>Take {handler.name.split(' ')[0]} off shift for 24 hours</button>}
          </div>

          <h3>Refund through PayPal <span className="tag real">sandbox, signed webhook</span></h3>
          <p className="muted small">Creates a sandbox invoice, records the payment and the refund. The board only moves once PayPal's refund event arrives.</p>
          <div className="actions">
            <button type="button" className="btn" disabled={busy || !!d.pendingRefund} onClick={() => onRefund(d.id, 'full')}>Refund {money(d.amount)} in full</button>
            <button type="button" className="btn" disabled={busy || !!d.pendingRefund} onClick={() => onRefund(d.id, 'partial')}>Refund 40 percent</button>
          </div>
          {d.pendingRefund && <p className="note" role="status">Refund sent to PayPal as invoice {d.pendingRefund.invoiceId}. Waiting for its event.</p>}
            </>
          ) : (
            <p className="note">This is a real sandbox dispute. The change and refund buttons are for fixture cases, so they are not offered here. PayPal's own events update it when you refresh from the PayPal tab.</p>
          )}
        </>
      )}
    </section>
  );
}
