import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { applyTheme, currentTheme } from './lib/theme.js';
import { api } from './api.js';
import { money, dayClock, RISK_WORD } from './lib/format.js';
import BoardScheduler from './components/BoardScheduler.jsx';
import Summary from './components/Summary.jsx';
import Legend from './components/Legend.jsx';
import CasePanel from './components/CasePanel.jsx';
import ActivityPanel from './components/ActivityPanel.jsx';
import QueueTable from './components/QueueTable.jsx';
import PayPalPanel from './components/PayPalPanel.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

const DeadlineCalendar = lazy(() => import('./components/DeadlineCalendar.jsx'));

const TABS = [
  { id: 'board', label: 'Board' },
  { id: 'queue', label: 'Queue' },
  { id: 'deadlines', label: 'Calendar' },
  { id: 'paypal', label: 'PayPal' },
];

function useWide() {
  const q = '(min-width: 641px)';
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => setWide(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return wide;
}

function useBoard() {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  const latest = useRef(0);
  const accept = useCallback((view) => {
    if (!view?.disputes) return;
    if (view.version < latest.current) return;
    latest.current = view.version;
    setBoard(view);
    setError('');
  }, []);
  const refresh = useCallback(() => api.board().then(accept).catch((e) => setError(e.message)), [accept]);
  useEffect(() => { refresh(); }, [refresh]);
  const running = !!board?.running;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) refresh(); }, running ? 1500 : 5000);
    return () => clearInterval(t);
  }, [running, refresh]);
  return { board, accept, refresh, error };
}

export default function App() {
  const { board, accept, refresh, error } = useBoard();
  const [theme, setTheme] = useState(currentTheme());
  const [tab, setTab] = useState('board');
  const [selectedId, setSelected] = useState(null);
  const [zoom, setZoom] = useState('standard');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const wide = useWide();
  const sch = useRef(null);
  const toastTimer = useRef(0);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const notify = useCallback(({ message, tone = 'ok', view }) => {
    if (view) accept(view);
    if (!message) return;
    setToast({ message, tone, key: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), tone === 'error' ? 9000 : 6000);
  }, [accept]);

  const act = useCallback(async (fn, okMessage) => {
    setBusy(true);
    try {
      const view = await fn();
      notify({ view, message: typeof okMessage === 'function' ? okMessage(view) : okMessage });
    } catch (e) {
      notify({ message: e.message, tone: 'error' });
      refresh();
    } finally { setBusy(false); }
  }, [notify, refresh]);

  const onEvent = (ev) => act(() => api.event(ev), 'Change recorded. The agent is rescheduling.');
  const onRefund = (id, mode) => act(() => api.refund(id, mode), (v) => `PayPal accepted the refund (invoice ${v.invoiceId}). Waiting for its event.`);
  const onAssign = (id, handlerId, start) => act(() => api.assign(id, handlerId, start), (v) => `${id} reassigned to ${v.handlers.find((h) => h.id === handlerId)?.name}.${v.warnings?.length ? ' ' + v.warnings.join(' ') : ''}`);
  const onPin = (id, pinned) => act(() => api.pin(id, pinned), pinned ? `${id} pinned.` : `${id} unpinned.`);
  const onReset = () => act(() => api.reset(), 'Board reset with a fresh queue.');
  const onNewDispute = () => act(() => api.event({ type: 'dispute.created' }), 'A new dispute arrived. The agent is placing it.');
  const onCheckPayPal = () => act(() => api.refresh(), (v) => `PayPal returned ${v.live.count} dispute${v.live.count === 1 ? '' : 's'}.`);

  const focusCase = () => setTimeout(() => document.getElementById('case-h')?.focus(), 60);
  const select = (id) => { setSelected(id); };
  // Keyboard and screen reader route: choose a case from a list, the block is selected and scrolled to, focus lands on the case panel.
  const pickCase = (id) => {
    if (!id) return;
    setSelected(id);
    setTimeout(() => { const rec = sch.current?.instance?.eventStore.getById(`w:${id}`); if (rec) sch.current.instance.scrollEventIntoView(rec, { animate: true, highlight: true }); }, 150);
    focusCase();
  };
  const openCase = (id) => {
    setSelected(id);
    setTab('board');
    setTimeout(() => { const rec = sch.current?.instance?.eventStore.getById(`w:${id}`); if (rec) sch.current.instance.scrollEventIntoView(rec, { animate: true, highlight: true }); }, 250);
  };

  const onTabKey = (e) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const j = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    setTab(TABS[j].id);
    requestAnimationFrame(() => document.getElementById(`tab-${TABS[j].id}`)?.focus());
  };

  if (!board) {
    return (
      <div className="boot" role="status">
        <p className="brand-name">Cutoff</p>
        <p>{error ? `Could not reach the board: ${error}` : 'Loading the board'}</p>
        {error && <button className="btn primary" onClick={refresh}>Try again</button>}
      </div>
    );
  }
  const busyAny = busy || !!board.running;
  const live = board.live;

  return (
    <>
      <a className="skip" href="#main">Skip to the board</a>
      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--brand-tile)" /><rect x="5" y="9" width="14" height="5" rx="2" fill="var(--brand-bar)" /><rect x="11" y="18" width="12" height="5" rx="2" fill="var(--brand-bar)" /><path d="M25 5v22" stroke="var(--amber)" strokeWidth="3" strokeLinecap="round" /></svg>
          <div>
            <p className="brand-name">Cutoff</p>
            <p className="brand-sub">Dispute triage board</p>
          </div>
        </div>
        <div className="top-actions">
          <button type="button" className="chip-btn" onClick={() => setTab('paypal')} aria-label="Open the PayPal tab">
            <span className={`dot ${live.ok ? 'ok' : 'bad'}`} aria-hidden="true" />
            {live.ok ? 'PayPal connected' : 'PayPal read failed'}
          </button>
          <button type="button" className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-pressed={theme === 'dark'}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
          <button type="button" className="btn primary" onClick={onNewDispute} disabled={busyAny}>Send in a new dispute</button>
          <button type="button" className="btn" onClick={onReset} disabled={busyAny}>Reset the board</button>
        </div>
      </header>

      <main id="main">
        <div className="intro">
          <h1>{(() => {
            const soon = (board.disputes || []).filter((d) => d.dueAt && (new Date(d.dueAt) - Date.now()) < 48 * 3600e3).length;
            const n = (board.disputes || []).length;
            return soon ? `${soon} of ${n} responses are due inside 48 hours.` : `${n} disputes, none due in the next 48 hours.`;
          })()}</h1>
          <p>Drag a case to hand it to someone else and the agent reflows the day. Times are UTC.</p>

        </div>

        <Summary board={board} />

        <div className="tabs" role="tablist" aria-label="Views" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        <div className="toast-region" aria-live="polite" aria-atomic="true">
          {toast && <p key={toast.key} className={`toast t-${toast.tone}`}>{toast.message}</p>}
        </div>

        <div id="panel-board" role="tabpanel" aria-labelledby="tab-board" hidden={tab !== 'board'}>
          <section className="boardcard" aria-label="Triage board">
            <details key={`ctl-${wide}`} className="fold ctl" open={wide}>
              <summary>Board controls</summary>
              <div className="toolbar">
              <div className="group" role="group" aria-label="Time scale">
                <span className="lbl">Zoom</span>
                {['compact', 'standard', 'roomy'].map((z) => <button key={z} type="button" className="btn sm" aria-pressed={zoom === z} onClick={() => setZoom(z)}>{z[0].toUpperCase() + z.slice(1)}</button>)}
              </div>
              <label className="pick">Jump to case
                <select value="" onChange={(e) => pickCase(e.target.value)}>
                  <option value="">Choose a case</option>
                  {board.disputes.filter((d) => d.state === 'open').sort((a, b) => a.dueAt - b.dueAt).map((d) => <option key={d.id} value={d.id}>{d.fixture ? '' : 'Live: '}{d.id}, {money(d.amount)}, due {dayClock(d.dueAt, board.now)}, {RISK_WORD[d.risk].toLowerCase()}</option>)}
                </select>
              </label>
              <button type="button" className="btn sm" onClick={() => sch.current?.instance?.scrollToDate(new Date(Math.floor((Date.now() - 3600000) / 3600000) * 3600000), { block: 'start', animate: true })}>Jump to now</button>
            </div>
            </details>
            <details key={`leg-${wide}`} className="fold leg" open={wide}>
              <summary>What the colours mean</summary>
              <Legend />
            </details>
            <div className="sched-wrap">
              <ErrorBoundary what="board" alternative={<p><button type="button" className="btn primary" onClick={() => setTab('queue')}>Open the queue table</button> It lists the same disputes and the Reassign form works there.</p>}>
                <BoardScheduler board={board} selectedId={selectedId} onSelect={select} onNotify={notify} zoom={zoom} theme={theme} schedulerRef={sch} />
              </ErrorBoundary>
            </div>
          </section>
        </div>

        <div id="panel-queue" role="tabpanel" aria-labelledby="tab-queue" hidden={tab !== 'queue'}>
          {tab === 'queue' && <QueueTable board={board} selectedId={selectedId} onSelect={(id) => { select(id); focusCase(); }} />}
        </div>

        <div id="panel-deadlines" role="tabpanel" aria-labelledby="tab-deadlines" hidden={tab !== 'deadlines'}>
          {tab === 'deadlines' && (
            <Suspense fallback={<p className="muted">Loading the calendar</p>}>
              <ErrorBoundary what="calendar" alternative={<p><button type="button" className="btn primary" onClick={() => setTab('queue')}>Open the queue table</button> It lists every deadline in order.</p>}>
                <DeadlineCalendar board={board} theme={theme} onOpen={openCase} />
              </ErrorBoundary>
            </Suspense>
          )}
        </div>

        <div id="panel-paypal" role="tabpanel" aria-labelledby="tab-paypal" hidden={tab !== 'paypal'}>
          {tab === 'paypal' && <PayPalPanel board={board} busy={busyAny} onRefresh={onCheckPayPal} />}
        </div>

        {(tab === 'board' || tab === 'queue') && (
          <div className="lower">
            <CasePanel board={board} id={selectedId} busy={busyAny} onEvent={onEvent} onRefund={onRefund} onAssign={onAssign} onPin={onPin} onClear={() => setSelected(null)} />
            <ActivityPanel board={board} />
          </div>
        )}
      </main>

      <footer className="foot">
        <p>Scheduler and Calendar by <a href="https://bryntum.com">Bryntum</a>, used under the Bryntum trial licence. Agent: Claude Sonnet 4.5 on Amazon Bedrock.</p>
      </footer>
    </>
  );
}
