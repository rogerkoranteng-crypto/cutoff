import React, { useEffect, useMemo, useRef } from 'react';
import { BryntumCalendar } from '@bryntum/calendar-react-thin';
import '@bryntum/calendar-thin/calendar.css';
import { StringHelper, LocaleManager } from '@bryntum/core-thin';
import '@bryntum/calendar-thin/locales/calendar.locale.EnGb.js';
import { clock, dayClock, money, fmtSpan } from '../lib/format.js';

const MIN = 60000;
LocaleManager.applyLocale('EnGb');

function eventsOf(board) {
  return board.disputes.filter((d) => d.state === 'open').map((d) => {
    const handler = board.handlers.find((h) => h.id === d.handlerId);
    return {
      id: d.id, disputeId: d.id, name: `${d.id} ${money(d.amount)} due ${clock(d.dueAt)} UTC`, startDate: new Date(d.dueAt - 60 * MIN), endDate: new Date(d.dueAt),
      risk: d.risk, riskText: d.riskText, handlerName: handler?.name ?? 'Not scheduled', reasonLabel: d.reasonLabel, readiness: d.readiness, dueAt: d.dueAt, amountLabel: money(d.amount),
      draggable: false, resizable: false,
    };
  });
}

function syncStore(store, rows) {
  const keep = new Set(rows.map((r) => String(r.id)));
  const gone = store.records.filter((r) => !keep.has(String(r.id)));
  const add = [];
  for (const row of rows) {
    const rec = store.getById(row.id);
    if (!rec) { add.push(row); continue; }
    const diff = {};
    for (const [k, v] of Object.entries(row)) if (!(rec[k] instanceof Date ? rec[k].getTime() === v?.getTime?.() : rec[k] === v)) diff[k] = v;
    if (Object.keys(diff).length) rec.set(diff);
  }
  if (gone.length) store.remove(gone);
  if (add.length) store.add(add);
}

export default function DeadlineCalendar({ board, onOpen }) {
  const ref = useRef(null);
  const eventRenderer = useMemo(() => ({ eventRecord, renderData }) => {
    renderData.cls[`risk-${eventRecord.risk}`] = true;
    renderData.ariaLabel = `${eventRecord.disputeId}, ${eventRecord.reasonLabel}, ${eventRecord.amountLabel}. Response due ${clock(eventRecord.dueAt)} UTC. ${eventRecord.riskText}. Handler ${eventRecord.handlerName}.`;
    const word = { ok: '', tight: '! Near', breach: '!! Breach' }[eventRecord.risk];
    return `<span class="cal-id">${StringHelper.encodeHtml(eventRecord.disputeId.replace('FX-D-', ''))}</span> <span class="cal-amt">${StringHelper.encodeHtml(eventRecord.amountLabel)}</span> ${word ? `<span class="cal-risk">${word}</span>` : ""}`;
  }, []);
  const modes = useMemo(() => {
    const common = { eventRenderer, timeFormat: 'HH:mm' };
    return {
      week: { ...common, dayStartTime: 0, dayEndTime: 24, hourHeight: 48, weekStartDay: new Date(board.now).getUTCDay(), visibleStartTime: Math.max(0, new Date(board.now).getUTCHours() - 1) },
      day: { ...common, hourHeight: 60, visibleStartTime: Math.max(0, new Date(board.now).getUTCHours() - 1) },
      agenda: { ...common, range: '4d' },
      month: false, year: false,
    };
  }, [eventRenderer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = ref.current?.instance;
    if (!c) return;
    if (import.meta.env.DEV) window.__cal = c;
    syncStore(c.eventStore, eventsOf(board));
  }, [board]);

  return (
    <section className="panel calpanel" aria-labelledby="cal-h">
      <h2 id="cal-h">Response deadlines</h2>
      <p className="muted small">Each marker sits where a response is due, in UTC. Open one to see its block on the board. Use Week for the shape of the next days, Agenda for the order.</p>
      <div className="cal-wrap">
        <BryntumCalendar
          ref={ref}
          cls="cutoff-calendar"
          timeZone="UTC"
          date={new Date(board.now)}
          mode="week"
          modes={modes}
          events={[]}
          resources={[]}
          sidebar={false}
          tools={{}}
          dragFeature={false}
          eventEditFeature={false}
          eventMenuFeature={false}
          scheduleMenuFeature={false}
          drawFeature={false}
          eventTooltipFeature={{ template: ({ eventRecord: r }) => `<div class="tip"><b>${StringHelper.encodeHtml(r.disputeId)}</b> ${StringHelper.encodeHtml(r.reasonLabel)}<div>Due ${StringHelper.encodeHtml(dayClock(r.dueAt))} UTC (${fmtSpan((r.dueAt - Date.now()) / 60000)} from now)</div><div>${StringHelper.encodeHtml(r.handlerName)}, evidence ${r.readiness}% ready</div><div><b>${StringHelper.encodeHtml(r.riskText)}</b></div></div>` }}
          onEventClick={({ eventRecord }) => onOpen(eventRecord.disputeId)}
        />
      </div>
    </section>
  );
}
