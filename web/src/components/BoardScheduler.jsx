import React, { useEffect, useMemo, useRef } from 'react';
import { BryntumScheduler } from '@bryntum/scheduler-react-thin';
import { StringHelper } from '@bryntum/core-thin';
import { dropProblems, windows, HOUR } from '@engine';
import { clock, dayClock, money, RISK_WORD, fmtSpan } from '../lib/format.js';
import { api } from '../api.js';

const UNASSIGNED = 'unassigned';
const PX_PER_HOUR = { compact: 52, standard: 84, roomy: 124 };

const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

/** Bring a Bryntum store in line with `rows` by updating records in place, so moved blocks animate instead of flashing. */
function syncStore(store, rows) {
  const keep = new Set(rows.map((r) => String(r.id)));
  const gone = store.records.filter((r) => !r.isSpecialRow && !keep.has(String(r.id)));
  const add = [];
  for (const row of rows) {
    const rec = store.getById(row.id);
    if (!rec) { add.push(row); continue; }
    const diff = {};
    for (const [k, v] of Object.entries(row)) if (!same(rec[k], v)) diff[k] = v;
    if (Object.keys(diff).length) rec.set(diff);
  }
  if (gone.length) store.remove(gone);
  if (add.length) store.add(add);
}

export function resourcesOf(board) {
  const rows = board.handlers.map((h) => ({
    id: h.id, name: h.name, team: h.team, initials: h.initials, loadPct: h.loadPct, onShift: h.onShift, skills: h.skills.join(', '), offUntil: h.off && h.off.until > board.now ? h.off.until : null,
  }));
  if (board.disputes.some((d) => d.state === 'open' && d.start == null)) rows.unshift({ id: UNASSIGNED, name: 'Needs a handler', team: 'Unscheduled', initials: '?', loadPct: null, onShift: false, skills: '' });
  return rows;
}

export function eventsOf(board) {
  const out = [];
  for (const d of board.disputes) {
    const open = d.state === 'open';
    if (d.state === 'resolved') continue;
    if (d.start != null) {
      const label = `${d.fixture ? '' : 'Live PayPal dispute. '}${d.id}, ${d.reasonLabel}, ${money(d.amount)}. ${d.pinned ? 'Pinned. ' : ''}${d.riskText}. Evidence ${d.readiness} percent ready. Response due ${dayClock(d.dueAt, board.now)} UTC.`;
      out.push({
        id: `w:${d.id}`, kind: 'work', disputeId: d.id, resourceId: d.handlerId, startDate: new Date(d.start), endDate: new Date(d.end), name: label,
        live: !d.fixture, risk: d.risk, readiness: d.readiness, amountLabel: money(d.amount), reasonLabel: d.reasonLabel, stageLabel: d.stageLabel, riskText: d.riskText, dueAt: d.dueAt, started: d.started, pinned: d.pinned, state: d.state,
        draggable: open && !d.locked, resizable: open && !d.locked ? 'end' : false, iconCls: '',
      });
    }
    if (open) {
      out.push({
        id: `d:${d.id}`, kind: 'deadline', disputeId: d.id, resourceId: d.start != null ? d.handlerId : UNASSIGNED, startDate: new Date(d.dueAt), endDate: new Date(d.dueAt + 1),
        name: `${d.id} response deadline ${dayClock(d.dueAt, board.now)} UTC`, risk: d.risk, draggable: false, resizable: false, dueAt: d.dueAt, amountLabel: money(d.amount), reasonLabel: d.reasonLabel, readiness: d.readiness, riskText: d.riskText, state: d.state,
      });
    }
  }
  return out;
}

/** Off-shift stretches for each handler, as resource time ranges. */
export function shiftGapsOf(board) {
  const from = board.bounds.from;
  const to = board.bounds.to;
  const out = [];
  for (const h of board.handlers) {
    const w = windows(h, from, to);
    let cursor = from;
    for (const win of w) {
      if (win.start > cursor) out.push(gap(h, cursor, win.start, board.now));
      cursor = Math.max(cursor, win.end);
    }
    if (cursor < to) out.push(gap(h, cursor, to, board.now));
  }
  return out;
}
const gap = (h, s, e, now) => ({ id: `off:${h.id}:${s}`, resourceId: h.id, startDate: new Date(s), endDate: new Date(e), name: h.off && h.off.from <= s && h.off.until >= e ? 'Off shift (time off)' : 'Off shift', cls: 'off-shift' });

const features = {
  group: 'team',
  stripe: false,
  columnLines: true,
  eventEdit: false,
  eventCopyPaste: false,
  scheduleMenu: false,
  timeAxisHeaderMenu: false,
  headerMenu: false,
  cellMenu: false,
  cellEdit: false,
  labels: false,
  resourceTimeRanges: true,
  timeRanges: { showCurrentTimeLine: true, showHeaderElements: false, enableResizing: false },
  eventTooltip: {
    hoverDelay: 250,
    template: ({ eventRecord }) => {
      const r = eventRecord;
      const e = StringHelper.encodeHtml;
      if (r.kind === 'deadline') return `<div class="tip"><b>${e(r.disputeId)} response deadline</b><div>${e(dayClock(r.dueAt))} UTC</div><div>${e(r.reasonLabel)}, ${e(r.amountLabel)}</div></div>`;
      return `<div class="tip"><b>${e(r.disputeId)}</b> <span>${e(r.reasonLabel)}, ${e(r.stageLabel)}</span>
        <div>${e(r.amountLabel)} in dispute</div><div>${e(clock(r.startDate.getTime()))} to ${e(clock(r.endDate.getTime()))} UTC</div>
        <div>Response due ${e(dayClock(r.dueAt))} UTC</div><div>Evidence ${r.readiness}% ready</div><div><b>${e(r.riskText)}</b></div>${r.pinned ? '<div>Pinned: the agent will not move it</div>' : ''}</div>`;
    },
  },
  eventMenu: false,
  summary: false,
};

export default function BoardScheduler({ board, selectedId, onSelect, onNotify, zoom, theme, schedulerRef }) {
  const boardRef = useRef(board);
  const lastDragMessage = useRef('');
  boardRef.current = board;
  const lastBoundsRef = useRef(null);
  const ref = schedulerRef;

  const eventDrag = useMemo(() => ({
    showExactDropPosition: true,
    constrainDragToTimeline: true,
    validatorFn: ({ eventRecords, newResource, startDate }) => {
      const rec = eventRecords[0];
      if (!rec || rec.kind !== 'work') return { valid: false, message: 'Only work blocks move.' };
      if (newResource.id === UNASSIGNED) return { valid: false, message: 'Drop on a handler row.' };
      const b = boardRef.current;
      const problems = dropProblems({ handlers: b.handlers, disputes: b.disputes }, rec.disputeId, newResource.id, startDate.getTime(), Date.now());
      lastDragMessage.current = problems[0] ?? '';
      return problems.length ? { valid: false, message: problems[0] } : { valid: true, message: 'Drop to reassign' };
    },
    tooltipTemplate: ({ eventRecord, newResource, startDate, endDate }) => {
      const e = StringHelper.encodeHtml;
      const b = boardRef.current;
      const problems = newResource && newResource.id !== UNASSIGNED ? dropProblems({ handlers: b.handlers, disputes: b.disputes }, eventRecord.disputeId, newResource.id, startDate.getTime(), Date.now()) : ['Drop on a handler row.'];
      const late = eventRecord.dueAt && endDate.getTime() > eventRecord.dueAt ? ` Ends ${fmtSpan((endDate.getTime() - eventRecord.dueAt) / 60000)} after the deadline.` : '';
      return `<div class="tip"><b>${e(eventRecord.disputeId)}</b> to ${e(newResource?.name ?? 'nobody')}<div>${e(clock(startDate.getTime()))} to ${e(clock(endDate.getTime()))} UTC</div><div><b>${problems.length ? 'Cannot drop: ' + e(problems[0]) : 'Drop to reassign.' + e(late)}</b></div></div>`;
    },
  }), []);

  const eventResize = useMemo(() => ({ showExactResizePosition: true }), []);
  // The React wrapper takes each feature as a <name>Feature prop.
  const featureProps = useMemo(() => Object.fromEntries(Object.entries({ ...features, eventDrag, eventResize }).map(([k, v]) => [`${k}Feature`, v])), [eventDrag, eventResize]);

  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
  const columns = useMemo(() => [{
    text: narrow ? 'Handler' : 'Case handler', field: 'name', width: narrow ? 104 : 218, minWidth: narrow ? 90 : 150, htmlEncode: false, cellCls: 'handler-cell',
    renderer: ({ record }) => {
      const e = StringHelper.encodeHtml;
      if (record.id === UNASSIGNED) return `<div class="hrow"><span class="avatar warn" aria-hidden="true">?</span><span class="htext"><b>${e(record.name)}</b><small>No shift has room</small></span></div>`;
      if (narrow && record.name) return `<div class="hrow"><span class="avatar ${record.onShift ? 'on' : ''}" aria-hidden="true">${e(record.initials)}</span><span class="htext"><b>${e(record.name.split(' ')[0])}</b><small>${record.onShift ? 'On' : 'Off'} shift</small></span></div>`;
      const state = record.offUntil ? 'Time off' : record.onShift ? 'On shift' : 'Off shift';
      return `<div class="hrow"><span class="avatar ${record.onShift ? 'on' : ''}" aria-hidden="true">${e(record.initials)}</span><span class="htext"><b>${e(record.name)}</b><small>${state}, ${record.loadPct}% booked today</small></span></div>`;
    },
  }], [narrow]);

  const eventRenderer = useMemo(() => ({ eventRecord, renderData }) => {
    const r = eventRecord;
    renderData.ariaLabel = r.name;
    if (r.kind === 'deadline') {
      renderData.cls['ev-deadline'] = true;
      renderData.cls[`risk-${r.risk}`] = true;
      renderData.wrapperCls['wrap-deadline'] = true;
      return { tag: 'span', class: 'dl-flag', 'aria-hidden': 'true', children: [{ tag: 'i', class: 'dl-diamond' }] };
    }
    renderData.cls[`risk-${r.risk}`] = true;
    if (r.started) renderData.cls['is-started'] = true;
    if (r.pinned) renderData.cls['is-pinned'] = true;
    if (r.live) renderData.cls['is-live'] = true;
    if (r.state === 'submitted') renderData.cls['is-sent'] = true;
    if (r.id === `w:${boardRef.current.selectedId}`) renderData.cls['is-picked'] = true;
    const sent = r.state === 'submitted';
    const word = sent ? 'Response sent' : r.started ? 'In progress' : RISK_WORD[r.risk];
    const short = sent ? 'Sent' : r.started ? 'Started' : { ok: 'On track', tight: 'Near', breach: 'Breach' }[r.risk];
    const mark = r.risk === 'breach' ? '!!' : r.risk === 'tight' ? '!' : sent ? '✓' : '';
    return {
      class: 'blk',
      children: [
        { class: 'blk-top', children: [r.live ? { tag: 'span', class: 'blk-live', text: 'LIVE' } : null, mark ? { tag: 'span', class: 'blk-mark', 'aria-hidden': 'true', text: mark } : null, { tag: 'b', class: 'blk-id', text: r.live ? r.disputeId.slice(-6) : r.disputeId.replace('FX-D-', '') }, { tag: 'span', class: 'blk-amt', text: r.amountLabel }, r.pinned ? { tag: 'span', class: 'blk-pin', text: 'Pinned' } : null].filter(Boolean) },
        { class: 'blk-sub', children: [
          { tag: 'span', class: 'long', text: `${word}, ${r.readiness}% ready` },
          { tag: 'span', class: 'short', text: short },
        ].filter(Boolean) },
      ],
    };
  }, []);

  // data sync
  useEffect(() => {
    const s = ref.current?.instance;
    if (!s) return;
    boardRef.current.selectedId = selectedId;
    if (import.meta.env.DEV) window.__sched = s;
    s.project.beginBatch?.();
    syncStore(s.resourceStore, resourcesOf(board));
    syncStore(s.eventStore, eventsOf(board));
    syncStore(s.resourceTimeRangeStore, shiftGapsOf(board));
    s.project.endBatch?.();
    s.refreshWithTransition?.();
  }, [board, selectedId, ref]);

  // keep the selected block highlighted
  useEffect(() => {
    const s = ref.current?.instance;
    if (!s) return;
    const rec = s.eventStore.getById(`w:${selectedId}`);
    if (rec && !s.selectedEvents.includes(rec)) s.selectedEvents = [rec];
    if (!rec && s.selectedEvents.length) s.selectedEvents = [];
  }, [selectedId, board, ref]);

  // zoom
  useEffect(() => {
    const s = ref.current?.instance;
    if (s) s.tickSize = PX_PER_HOUR[zoom];
  }, [zoom, ref]);

  const onFinalizeDrop = ({ context }) => {
    const rec = context.eventRecord;
    context.async = true;
    const handlerId = context.newResource.id;
    const start = context.startDate.getTime();
    api.assign(rec.disputeId, handlerId, start)
      .then((view) => {
        onNotify({ view, message: `${rec.disputeId} moved to ${view.handlers.find((h) => h.id === handlerId)?.name}.${view.warnings?.length ? ' ' + view.warnings.join(' ') : ''}`, tone: view.warnings?.length ? 'warn' : 'ok' });
        context.finalize(true);
      })
      .catch((e) => { onNotify({ message: e.message, tone: 'error' }); context.finalize(false); });
  };

  const onFinalizeResize = (ev) => {
    const rec = ev.eventRecord;
    ev.async = true;
    api.resize(rec.disputeId, ev.endDate.getTime())
      .then((view) => { onNotify({ view, message: `${rec.disputeId} now has more time.`, tone: 'ok' }); ev.finalize(true); })
      .catch((e) => { onNotify({ message: e.message, tone: 'error' }); ev.finalize(false); });
  };

  const onSelection = ({ selection }) => {
    const rec = selection[0];
    if (rec?.disputeId) onSelect(rec.disputeId);
  };

  const bounds = board.bounds;
  const viewPreset = useMemo(() => ({
    base: 'hourAndDay', tickWidth: PX_PER_HOUR[zoom],
    headers: [{ unit: 'day', dateFormat: 'ddd D MMM' }, { unit: 'hour', dateFormat: 'HH:mm' }],
  }), [zoom]);
  return (
    <BryntumScheduler
      ref={ref}
      cls="cutoff-scheduler"
      startDate={new Date(bounds.from)}
      endDate={new Date(bounds.to)}
      timeZone="UTC"
      viewPreset={viewPreset}
      rowHeight={62}
      barMargin={7}
      eventLayout="none"
      eventStyle="plain"
      timeResolution={{ unit: 'minute', increment: 15 }}
      multiEventSelect={false}
      allowOverlap
      {...featureProps}
      columns={columns}
      eventRenderer={eventRenderer}
      resources={[]}
      events={[]}
      resourceTimeRanges={[]}
      onBeforeEventDropFinalize={onFinalizeDrop}
      onBeforeEventResizeFinalize={onFinalizeResize}
      onEventSelectionChange={onSelection}
      onEventDragAbort={() => { if (lastDragMessage.current) { onNotify({ message: `Not moved. ${lastDragMessage.current}`, tone: 'warn' }); lastDragMessage.current = ''; } }}
      onPaint={({ firstPaint, source }) => { if (firstPaint) { source.scrollToDate(new Date(Math.floor((Date.now() - 3600000) / 3600000) * 3600000), { block: 'start', animate: false }); } }}
      emptyText="No handlers yet"
    />
  );
}

export { UNASSIGNED, HOUR, fmtSpan };
