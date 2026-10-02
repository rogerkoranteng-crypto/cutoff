// Lambda entry. Function URL payload v2 (browser and PayPal) plus asynchronous self-invocations for the agent and webhooks.
import { MemoryStore, DynamoStore } from './store.js';
import * as svc from './service.js';
import * as pp from './paypal.js';
import * as wh from './webhook.js';
import { validStarts, pickAssignee, eligible, REASON_LABEL } from './engine.js';

let store;
const getStore = () => (store ??= process.env.STORE === 'memory' ? new MemoryStore() : new DynamoStore());
export const __setStore = (s) => { store = s; };
let deps;
export const __setDeps = (d) => { deps = d; };

async function selfInvoke(payload) {
  if (process.env.STORE === 'memory' || !process.env.AWS_LAMBDA_FUNCTION_NAME) { setImmediate(() => handle(payload).catch((e) => console.error('inline job failed', e))); return; }
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  await new LambdaClient({}).send(new InvokeCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }));
}
const getDeps = () => (deps ??= svc.makeDeps({ runJob: selfInvoke }));

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-session', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '600' };
const json = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS }, body: JSON.stringify(body) });

let statusCache = null;
async function paypalStatus(d) {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.v;
  const live = await pp.readLiveDisputes(d.env, fetch, { detail: false, max: 5 });
  const v = { api: live.api, mode: /sandbox/.test(live.api) ? 'sandbox' : 'LIVE', readOk: live.ok, disputeCount: live.count, checkedAt: live.checkedAt, scopes: live.scopes, error: live.error, webhookConfigured: !!d.env.PAYPAL_WEBHOOK_ID };
  statusCache = { at: Date.now(), v };
  return v;
}

export const handler = (event) => handle(event);

export async function handle(event) {
  const st = getStore();
  const d = getDeps();
  if (event?.job === 'agent') { await svc.executeRun(st, event.sid, event.runId, d); return { ok: true }; }
  if (event?.job === 'webhook') {
    const out = await svc.ingestEvent(st, JSON.parse(event.raw), d).catch((e) => ({ status: 'error', reason: String(e.message).slice(0, 200) }));
    await st.patch('FEED', event.feedSk, { status: out.status, reason: out.reason ?? null, disputeId: out.disputeId ?? null, invoiceId: out.invoiceId ?? null, processedAt: Date.now() });
    return out;
  }
  const http = event?.requestContext?.http;
  if (!http) return json(400, { error: 'unsupported event' });
  const method = http.method;
  const path = http.path.replace(/\/+$/, '') || '/';
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : '';

  try {
    if (method === 'POST' && path === '/api/webhooks/paypal') return await webhook(st, d, headers, rawBody);

    let body = {};
    if (rawBody) { try { body = JSON.parse(rawBody); } catch { return json(400, { error: 'body must be JSON' }); } }
    const sid = headers['x-session'];
    const needSid = () => { if (!sid || !svc.SID_RE.test(sid)) throw Object.assign(new Error('X-Session header required (8-64 characters of A-Z a-z 0-9 _ -)'), { status: 400 }); return sid; };

    if (method === 'GET' && path === '/api/health') return json(200, { ok: true, service: 'cutoff', now: new Date().toISOString(), model: process.env.BEDROCK_MODEL ?? null, store: process.env.STORE ?? 'dynamodb' });
    if (method === 'GET' && path === '/api/paypal/status') return json(200, await paypalStatus(d));
    if (method === 'GET' && path === '/api/feed') return json(200, { events: await svc.getFeed(st, d) });
    if (method === 'GET' && path === '/api/board') return json(200, await svc.getBoard(st, needSid(), d));
    if (method === 'POST' && path === '/api/board/reset') return json(200, await svc.reset(st, needSid(), d));
    if (method === 'POST' && path === '/api/events') return json(202, await svc.submitEvent(st, needSid(), body, d, { source: 'fixture' }));
    if (method === 'POST' && path === '/api/paypal/refresh') return json(200, await svc.refreshLive(st, needSid(), d));

    let m = path.match(/^\/api\/disputes\/([A-Za-z0-9_-]+)\/(assign|resize|pin|paypal-refund|options)$/);
    if (m) {
      const [, id, op] = m; const s = needSid();
      if (op === 'options' && method === 'GET') return json(200, await options(st, s, id, event.queryStringParameters?.handler, d));
      if (method !== 'POST') return json(405, { error: 'POST required' });
      if (op === 'assign') return json(200, await svc.assign(st, s, { disputeId: id, handlerId: body.handlerId, start: body.start }, d));
      if (op === 'resize') return json(200, await svc.resize(st, s, { disputeId: id, end: body.end }, d));
      if (op === 'pin') return json(200, await svc.setPinned(st, s, { disputeId: id, pinned: body.pinned }, d));
      if (op === 'paypal-refund') return json(202, await svc.paypalRefund(st, s, { disputeId: id, mode: body.mode }, d));
    }
    return json(404, { error: `no route for ${method} ${path}` });
  } catch (e) {
    const status = e.status ?? (e instanceof pp.PayPalError ? 502 : 500);
    if (status >= 500) console.error('handler error', e);
    return json(status, { error: status >= 500 ? (e instanceof pp.PayPalError ? `PayPal refused the request: ${e.body?.message ?? e.message}` : 'internal error') : e.message, ...(e.problems ? { problems: e.problems } : {}) });
  }
}

async function options(st, sid, id, handlerId, d) {
  const view = await svc.getBoard(st, sid, d);
  const board = { handlers: view.handlers, disputes: view.disputes };
  const disp = view.disputes.find((x) => x.id === id);
  if (!disp) { const e = new Error('No such dispute.'); e.status = 404; throw e; }
  const now = d.now();
  const handlers = view.handlers.filter((h) => eligible(h, disp).ok).map((h) => ({ id: h.id, name: h.name, team: h.team }));
  const hid = handlerId && handlers.some((h) => h.id === handlerId) ? handlerId : (disp.handlerId ?? handlers[0]?.id);
  return { disputeId: id, reason: REASON_LABEL[disp.reason], handlers, handlerId: hid, starts: hid ? validStarts(board, id, hid, now) : [], ranking: pickAssignee(board, id, now) };
}

async function webhook(st, d, headers, raw) {
  const now = Date.now();
  let event; try { event = JSON.parse(raw); } catch { return json(400, { error: 'body is not JSON' }); }
  if (!headers['paypal-transmission-sig']) {
    await svc.recordFeed(st, { eventId: event?.id ?? null, eventType: event?.event_type ?? 'unknown', verified: false, status: 'rejected', reason: 'missing PayPal signature headers' }, d);
    return json(401, { error: 'webhook rejected: unsigned' });
  }
  let v;
  try { v = await (d.verify ?? wh.verifyViaApi)({ headers, rawBody: raw, webhookId: d.env.PAYPAL_WEBHOOK_ID, env: d.env }); }
  catch (e) { v = await wh.verifyLocal({ headers, rawBody: raw, webhookId: d.env.PAYPAL_WEBHOOK_ID }); if (v.ok) v.via = 'local (API check unavailable)'; }
  if (!v.ok) {
    console.warn(JSON.stringify({ webhook_rejected: v.reason }));
    await svc.recordFeed(st, { eventId: event?.id ?? null, eventType: event?.event_type ?? 'unknown', verified: false, status: 'rejected', reason: v.reason }, d);
    return json(401, { error: `webhook rejected: ${v.reason}` });
  }
  const feedSk = `${String(now).padStart(14, '0')}#${event.id}`;
  await st.put({ pk: 'FEED', sk: feedSk, at: now, ttl: Math.floor(now / 1000) + 7 * 24 * 3600, eventId: event.id, eventType: event.event_type, verified: true, via: v.via, status: 'received', summary: event.summary ?? '', raw, headers: { 'paypal-transmission-id': headers['paypal-transmission-id'], 'paypal-transmission-time': headers['paypal-transmission-time'], 'paypal-transmission-sig': headers['paypal-transmission-sig'], 'paypal-cert-url': headers['paypal-cert-url'], 'paypal-auth-algo': headers['paypal-auth-algo'] } });
  await d.runJob({ job: 'webhook', raw, feedSk });
  return json(200, { received: true });
}
