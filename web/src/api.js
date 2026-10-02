const KEY = 'cutoff-session';
export function sessionId() {
  try {
    let s = localStorage.getItem(KEY);
    if (!s) { s = 's' + crypto.randomUUID().replaceAll('-', '').slice(0, 20); localStorage.setItem(KEY, s); }
    return s;
  } catch { return (window.__sid ??= 's' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36)); }
}

export class ApiError extends Error {
  constructor(status, message, problems) { super(message); this.status = status; this.problems = problems; }
}

async function call(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-session': sessionId() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error || `Request failed (${r.status})`, data.problems);
  return data;
}

export const api = {
  board: () => call('GET', '/api/board'),
  reset: () => call('POST', '/api/board/reset'),
  assign: (id, handlerId, start) => call('POST', `/api/disputes/${id}/assign`, { handlerId, start }),
  resize: (id, end) => call('POST', `/api/disputes/${id}/resize`, { end }),
  pin: (id, pinned) => call('POST', `/api/disputes/${id}/pin`, { pinned }),
  options: (id, handler) => call('GET', `/api/disputes/${id}/options${handler ? `?handler=${encodeURIComponent(handler)}` : ''}`),
  event: (ev) => call('POST', '/api/events', ev),
  refund: (id, mode) => call('POST', `/api/disputes/${id}/paypal-refund`, { mode }),
  refresh: () => call('POST', '/api/paypal/refresh'),
  feed: () => call('GET', '/api/feed'),
  status: () => call('GET', '/api/paypal/status'),
};
