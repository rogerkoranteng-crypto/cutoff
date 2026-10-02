import { fmtSpan } from '@engine';
export { fmtSpan };

const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const clock = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
export const dayName = (ms) => DAYS[new Date(ms).getUTCDay()];
export const dayClock = (ms, now) => {
  const d = new Date(ms);
  const sameDay = now != null && Math.floor(ms / 86400000) === Math.floor(now / 86400000);
  return sameDay ? `${clock(ms)}` : `${DAYS[d.getUTCDay()]} ${clock(ms)}`;
};
export const dateLabel = (ms) => { const d = new Date(ms); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export const money = (a) => `${a.currency === 'USD' ? '$' : a.currency + ' '}${a.value.toLocaleString('en-US', { minimumFractionDigits: a.value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const ago = (ms, now) => { const m = Math.round((now - ms) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; return `${Math.floor(m / 60)}h ${m % 60}m ago`; };

export const RISK_WORD = { ok: 'On track', tight: 'Near breach', breach: 'Breach risk', done: 'Done' };
