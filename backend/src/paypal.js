// PayPal REST client (sandbox unless PAYPAL_API says otherwise). Secrets come from the environment only.
import crypto from 'node:crypto';
import { ceilQ, HOUR } from './engine.js';
import { evidenceFor } from './fixtures.js';

export class PayPalError extends Error {
  constructor(status, body, where) {
    super(`PayPal ${where} -> HTTP ${status} ${body?.name ?? ''} ${body?.message ?? ''}`.trim());
    this.status = status; this.body = body; this.where = where;
  }
  get issues() { return (this.body?.details ?? []).map((d) => d.issue); }
}

let tokenCache = null;
export const cfg = (env = process.env) => ({ api: env.PAYPAL_API || 'https://api-m.sandbox.paypal.com', id: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET });
export const __resetTokenCache = () => { tokenCache = null; };

export async function getToken(env = process.env, fetchImpl = fetch) {
  const c = cfg(env);
  if (!c.id || !c.secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_SECRET are not configured');
  if (tokenCache && tokenCache.key === c.id + c.api && tokenCache.exp > Date.now() + 60_000) return tokenCache;
  const r = await fetchImpl(`${c.api}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.id}:${c.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new PayPalError(r.status, body, 'oauth2/token');
  tokenCache = { key: c.id + c.api, token: body.access_token, scopes: String(body.scope || '').split(' '), exp: Date.now() + body.expires_in * 1000 };
  return tokenCache;
}

export async function call(method, path, { env = process.env, fetchImpl = fetch, json, query, requestId } = {}) {
  const c = cfg(env);
  const t = await getToken(env, fetchImpl);
  const headers = { Authorization: `Bearer ${t.token}` };
  if (requestId && method !== 'GET') headers['PayPal-Request-Id'] = requestId;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const r = await fetchImpl(`${c.api}${path}${qs}`, { method, headers, body });
  const text = await r.text();
  let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!r.ok) throw new PayPalError(r.status, parsed, `${method} ${path}`);
  return { status: r.status, body: parsed, debugId: r.headers.get('paypal-debug-id') };
}

/** Stable request id: the same operation with the same inputs always carries the same id. */
export const requestId = (...parts) => 'cutoff-' + crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);

/**
 * A repeat of an earlier request counts as success, not as a failure. PayPal reports a repeat in different ways per API:
 * DUPLICATE_REQUEST_ID where the PayPal-Request-Id header is honoured, DUPLICATE_INVOICE_NUMBER on invoice creation
 * (Invoicing v2 ignores the header), and CANNOT_PROCESS_PAYMENTS / CANNOT_PROCESS_REFUNDS when the invoice already moved on.
 */
const REPEAT_ISSUES = ['DUPLICATE_REQUEST_ID', 'DUPLICATE_INVOICE_NUMBER', 'CANNOT_PROCESS_PAYMENTS', 'CANNOT_PROCESS_REFUNDS'];
export function isDuplicate(e) {
  return e instanceof PayPalError && (e.issues.some((i) => REPEAT_ISSUES.includes(i)) || e.body?.name === 'DUPLICATE_REQUEST_ID');
}

// ---- Disputes (live read path) ---------------------------------------------------------------------------------

/**
 * The sandbox does not index every dispute into the list endpoint (checked: the list is empty while GET by id returns the
 * dispute), so known ids from LIVE_DISPUTE_IDS are fetched directly and merged with whatever the list returns.
 * A failed fetch of one id is reported in `failed` and never stops the board from loading.
 */
export async function readLiveDisputes(env = process.env, fetchImpl = fetch, { detail = true, max = 10 } = {}) {
  const checkedAt = Date.now();
  try {
    const t = await getToken(env, fetchImpl);
    const list = (await call('GET', '/v1/customer/disputes', { env, fetchImpl, query: { page_size: String(max) } })).body;
    const items = list.items ?? [];
    const known = String(env.LIVE_DISPUTE_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const ids = [...new Set([...items.map((i) => i.dispute_id), ...known])].slice(0, max);
    const details = [];
    const failed = [];
    if (detail) for (const id of ids) {
      try { details.push((await call('GET', `/v1/customer/disputes/${encodeURIComponent(id)}`, { env, fetchImpl })).body); }
      catch (e) { failed.push({ id, error: String(e.message).slice(0, 140) }); }
    }
    return { ok: true, checkedAt, count: ids.length, listCount: items.length, api: cfg(env).api, scopes: t.scopes.filter((s) => s.includes('/disputes/')).map((s) => s.split('/services/')[1]), disputes: details.map((d) => fromPayPalDispute(d, checkedAt)).filter(Boolean), failed };
  } catch (e) {
    return { ok: false, checkedAt, count: 0, api: cfg(env).api, error: String(e.message).slice(0, 200), disputes: [], failed: [] };
  }
}

/** Map a PayPal Disputes API object onto a board dispute. Returns null if it has no usable deadline and is closed. */
export function fromPayPalDispute(p, now = Date.now()) {
  if (!p?.dispute_id) return null;
  const closed = p.status === 'RESOLVED';
  const due = Date.parse(p.seller_response_due_date ?? p.offer?.history?.[0]?.offer_time ?? '') || null;
  const stage = ['INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'].includes(p.dispute_life_cycle_stage) ? p.dispute_life_cycle_stage : 'INQUIRY';
  const reason = p.reason ?? 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
  return {
    id: p.dispute_id, fixture: false, live: true,
    buyer: p.disputed_transactions?.[0]?.buyer?.name ?? 'PayPal buyer',
    reason, stage, status: p.status ?? 'OPEN',
    amount: { value: Number(p.dispute_amount?.value ?? 0), currency: p.dispute_amount?.currency_code ?? 'USD' },
    createdAt: Date.parse(p.create_time ?? '') || now,
    dueAt: ceilQ(due ?? Date.parse(p.create_time ?? '') + 10 * 24 * HOUR),
    dueEstimated: !due,
    buyerMessage: p.messages?.[0]?.content?.slice(0, 400) ?? null,
    paypalState: p.dispute_state ?? null,
    evidence: evidenceFor(reason, []),
    state: closed ? 'resolved' : 'open', handlerId: null, start: null, end: null, pinned: false, invoiceId: null,
  };
}

// ---- Invoicing: the refund that PayPal reports back by webhook -------------------------------------------------

/**
 * Creates a sandbox invoice for the disputed amount, records the payment, then records a refund. PayPal answers with
 * signed INVOICING.INVOICE.* webhooks; the board reflows on those, not on this call.
 */
export async function createRefundedInvoice({ env = process.env, fetchImpl = fetch, sid, disputeId, amount, currency = 'USD', seq = 0 }) {
  const day = new Date().toISOString().slice(0, 10);
  const value = amount.toFixed(2);
  const steps = [];
  const rid = (op) => requestId(op, sid, disputeId, value, seq);
  // Invoicing v2 ignores PayPal-Request-Id on create (checked: three calls, three invoices), so the idempotency key is a
  // deterministic invoice number. A repeat comes back as DUPLICATE_INVOICE_NUMBER and counts as "already requested".
  const invoiceNumber = 'CUT-' + rid('invoice-number').slice(7, 19).toUpperCase();
  let invoiceId;
  let repeat = false;
  try {
    const r = await call('POST', '/v2/invoicing/invoices', {
      env, fetchImpl, requestId: rid('invoice'),
      json: {
        detail: { currency_code: currency, reference: disputeId, invoice_number: invoiceNumber, note: `Refund for disputed order ${disputeId}. Sandbox invoice created by the Cutoff triage board.`, invoice_date: day },
        primary_recipients: [{ billing_info: { name: { given_name: 'Dispute', surname: 'Buyer' }, email_address: 'buyer@example.com' } }],
        items: [{ name: `Disputed order ${disputeId}`, quantity: '1', unit_amount: { currency_code: currency, value } }],
      },
    });
    invoiceId = r.body.href.split('/').pop();
    steps.push({ step: 'create_invoice', status: r.status, invoiceId, invoiceNumber });
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    repeat = true;
    const found = await call('POST', '/v2/invoicing/search-invoices', { env, fetchImpl, json: { invoice_number: invoiceNumber }, query: { page: '1', page_size: '1' } });
    invoiceId = found.body.items?.[0]?.id;
    if (!invoiceId) throw Object.assign(new Error('That refund was already requested.'), { status: 409 });
    steps.push({ step: 'create_invoice', status: 'duplicate', invoiceId, invoiceNumber });
  }
  const out = { invoiceId, steps, repeat };
  for (const [step, path, body] of [
    ['record_payment', 'payments', { method: 'BANK_TRANSFER', payment_date: day, amount: { currency_code: currency, value } }],
    ['record_refund', 'refunds', { method: 'BANK_TRANSFER', refund_date: day, amount: { currency_code: currency, value } }],
  ]) {
    try {
      const r = await call('POST', `/v2/invoicing/invoices/${invoiceId}/${path}`, { env, fetchImpl, json: body, requestId: rid(step) });
      steps.push({ step, status: r.status, id: r.body.payment_id ?? r.body.refund_id });
    } catch (e) {
      if (!isDuplicate(e)) throw e;
      steps.push({ step, status: 'duplicate' });
    }
  }
  return out;
}

export async function getInvoice(id, env = process.env, fetchImpl = fetch) {
  return (await call('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`, { env, fetchImpl })).body;
}

/** Total refunded on an invoice, read from the invoice itself (the webhook body is only a pointer). */
export function refundedAmount(inv) {
  const tx = inv?.refunds?.transactions ?? [];
  const sum = tx.reduce((s, t) => s + Number(t.amount?.value ?? 0), 0);
  return { value: Math.round(sum * 100) / 100, currency: tx[0]?.amount?.currency_code ?? inv?.amount?.currency_code ?? 'USD', status: inv?.status };
}
