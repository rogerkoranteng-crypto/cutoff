import test from 'node:test';
import assert from 'node:assert/strict';
import { fromPayPalDispute, requestId, isDuplicate, PayPalError, refundedAmount, createRefundedInvoice, __resetTokenCache } from '../src/paypal.js';

test('a PayPal Disputes API object maps onto a board dispute', () => {
  const d = fromPayPalDispute({
    dispute_id: 'PP-D-27803', reason: 'UNAUTHORISED', status: 'WAITING_FOR_SELLER_RESPONSE', dispute_life_cycle_stage: 'CHARGEBACK',
    dispute_amount: { currency_code: 'USD', value: '210.50' }, create_time: '2026-10-01T09:00:00.000Z', seller_response_due_date: '2026-10-05T09:00:00.000Z',
    disputed_transactions: [{ buyer: { name: 'A. Buyer' } }],
  });
  assert.equal(d.id, 'PP-D-27803');
  assert.equal(d.fixture, false);
  assert.equal(d.live, true);
  assert.equal(d.amount.value, 210.5);
  assert.equal(d.stage, 'CHARGEBACK');
  assert.equal(d.dueAt, Date.parse('2026-10-05T09:00:00Z'));
  assert.ok(d.evidence.length >= 3);
  assert.equal(fromPayPalDispute({}), null);
});

test('request ids are stable for the same operation and differ when anything changes', () => {
  assert.equal(requestId('invoice', 's1', 'D1', '10.00', 1), requestId('invoice', 's1', 'D1', '10.00', 1));
  assert.notEqual(requestId('invoice', 's1', 'D1', '10.00', 1), requestId('invoice', 's1', 'D1', '10.00', 2));
  assert.match(requestId('x'), /^cutoff-[0-9a-f]{40}$/);
});

test('a duplicate request id is recognised as a repeat, not a failure', () => {
  assert.equal(isDuplicate(new PayPalError(422, { name: 'DUPLICATE_REQUEST_ID' }, 'x')), true);
  assert.equal(isDuplicate(new PayPalError(422, { details: [{ issue: 'DUPLICATE_REQUEST_ID' }] }, 'x')), true);
  assert.equal(isDuplicate(new PayPalError(500, {}, 'x')), false);
});

test('refundedAmount sums the refund transactions on an invoice', () => {
  assert.deepEqual(refundedAmount({ status: 'MARKED_AS_REFUNDED', refunds: { transactions: [{ amount: { currency_code: 'USD', value: '4.00' } }, { amount: { currency_code: 'USD', value: '6.50' } }] } }), { value: 10.5, currency: 'USD', status: 'MARKED_AS_REFUNDED' });
  assert.equal(refundedAmount({ status: 'PAID' }).value, 0);
});

test('createRefundedInvoice sends the PayPal-Request-Id on create, then records payment and refund in order', async () => {
  __resetTokenCache();
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, rid: opts.headers?.['PayPal-Request-Id'], body: opts.body });
    if (/oauth2/.test(url)) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ access_token: 't', expires_in: 3000, scope: '' }) };
    if (/invoices$/.test(url)) return { ok: true, status: 201, headers: new Map(), text: async () => JSON.stringify({ href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-TEST' }) };
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ refund_id: 'EXTR-1' }) };
  };
  const out = await createRefundedInvoice({ env: { PAYPAL_CLIENT_ID: 'cid', PAYPAL_SECRET: 's', PAYPAL_API: 'https://pp.test' }, fetchImpl, sid: 'sess-1', disputeId: 'FX-D-1001', amount: 12.5, seq: 1 });
  assert.equal(out.invoiceId, 'INV2-TEST');
  const api = calls.filter((c) => !/oauth2/.test(c.url));
  assert.deepEqual(api.map((c) => c.url.replace('https://pp.test', '')), ['/v2/invoicing/invoices', '/v2/invoicing/invoices/INV2-TEST/payments', '/v2/invoicing/invoices/INV2-TEST/refunds']);
  assert.match(api[0].rid, /^cutoff-/);
  assert.equal(JSON.parse(api[0].body).detail.reference, 'FX-D-1001');
});

test('repeats are recognised in every shape PayPal reports them', () => {
  for (const issue of ['DUPLICATE_REQUEST_ID', 'DUPLICATE_INVOICE_NUMBER', 'CANNOT_PROCESS_PAYMENTS', 'CANNOT_PROCESS_REFUNDS']) {
    assert.equal(isDuplicate(new PayPalError(422, { details: [{ issue }] }, 'x')), true, issue);
  }
  assert.equal(isDuplicate(new PayPalError(422, { details: [{ issue: 'INVALID_ARRAY_MAX_ITEMS' }] }, 'x')), false);
});

test('a repeated refund click finds the existing invoice by its number instead of creating a second one, and treats the finished steps as done', async () => {
  __resetTokenCache();
  const seen = [];
  const dup = (issue) => ({ ok: false, status: 422, headers: new Map(), text: async () => JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue }] }) });
  const fetchImpl = async (url, opts = {}) => {
    seen.push(`${opts.method ?? 'GET'} ${url.replace('https://pp.test', '')}`);
    if (/oauth2/.test(url)) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ access_token: 't', expires_in: 3000, scope: '' }) };
    if (/invoices$/.test(url)) return dup('DUPLICATE_INVOICE_NUMBER');
    if (/search-invoices/.test(url)) return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ items: [{ id: 'INV2-EXISTING' }] }) };
    if (/payments$/.test(url)) return dup('CANNOT_PROCESS_PAYMENTS');
    return dup('CANNOT_PROCESS_REFUNDS');
  };
  const out = await createRefundedInvoice({ env: { PAYPAL_CLIENT_ID: 'cid2', PAYPAL_SECRET: 's', PAYPAL_API: 'https://pp.test' }, fetchImpl, sid: 's', disputeId: 'D', amount: 1 });
  assert.equal(out.invoiceId, 'INV2-EXISTING');
  assert.equal(out.repeat, true);
  assert.ok(out.steps.every((x) => x.status === 'duplicate'));
  assert.ok(seen.some((x) => /search-invoices/.test(x)));
});

test('the invoice number is deterministic per (session, dispute, amount, sequence)', async () => {
  __resetTokenCache();
  const nums = [];
  const mk = (sid, seq) => async (url, opts = {}) => {
    if (/oauth2/.test(url)) return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ access_token: 't', expires_in: 3000, scope: '' }) };
    if (/invoices$/.test(url)) { nums.push(JSON.parse(opts.body).detail.invoice_number); return { ok: true, status: 201, headers: new Map(), text: async () => JSON.stringify({ href: 'https://x/INV2-A' }) }; }
    return { ok: true, status: 200, headers: new Map(), text: async () => '{}' };
  };
  const env = { PAYPAL_CLIENT_ID: 'cid3', PAYPAL_SECRET: 's', PAYPAL_API: 'https://pp.test' };
  await createRefundedInvoice({ env, fetchImpl: mk(), sid: 's1', disputeId: 'D1', amount: 5, seq: 1 });
  await createRefundedInvoice({ env, fetchImpl: mk(), sid: 's1', disputeId: 'D1', amount: 5, seq: 1 });
  await createRefundedInvoice({ env, fetchImpl: mk(), sid: 's1', disputeId: 'D1', amount: 5, seq: 2 });
  assert.equal(nums[0], nums[1]);
  assert.notEqual(nums[0], nums[2]);
  assert.match(nums[0], /^CUT-[0-9A-F]{12}$/);
});

import { readLiveDisputes } from '../src/paypal.js';
const okTok = { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ access_token: 't', expires_in: 3000, scope: 'https://uri.paypal.com/services/disputes/read-seller' }) };
const resp = (status, body) => ({ ok: status < 300, status, headers: new Map(), text: async () => JSON.stringify(body) });
const ENV = { PAYPAL_CLIENT_ID: 'cid-live', PAYPAL_SECRET: 's', PAYPAL_API: 'https://pp.test', LIVE_DISPUTE_IDS: 'PP-R-AAA, PP-R-BAD' };

test('known dispute ids are fetched directly when the list endpoint is empty; a failed id is reported and the rest still load', async () => {
  __resetTokenCache();
  const fetchImpl = async (url) => {
    if (/oauth2/.test(url)) return okTok;
    if (/disputes\?/.test(url)) return resp(200, { items: [] });
    if (/PP-R-AAA/.test(url)) return resp(200, { dispute_id: 'PP-R-AAA', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'UNDER_REVIEW', dispute_state: 'UNDER_PAYPAL_REVIEW', dispute_life_cycle_stage: 'INQUIRY', dispute_amount: { currency_code: 'USD', value: '229.00' }, create_time: '2026-10-02T16:47:57.729Z', messages: [{ content: 'Nothing arrived' }], disputed_transactions: [{ buyer: { name: 'John Doe' } }] });
    return resp(404, { name: 'RESOURCE_NOT_FOUND' });
  };
  const r = await readLiveDisputes(ENV, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.listCount, 0);
  assert.equal(r.disputes.length, 1);
  assert.equal(r.disputes[0].id, 'PP-R-AAA');
  assert.equal(r.disputes[0].dueEstimated, true);
  assert.equal(r.disputes[0].dueAt, Date.parse('2026-10-12T16:47:57.729Z') + (15 * 60000 - (Date.parse('2026-10-12T16:47:57.729Z') % (15 * 60000))) % (15 * 60000));
  assert.deepEqual(r.failed.map((f) => f.id), ['PP-R-BAD']);
});

test('when PayPal gives a real response deadline it is used and not marked as an estimate', async () => {
  const d = fromPayPalDispute({ dispute_id: 'PP-R-Z', reason: 'UNAUTHORISED', create_time: '2026-10-02T16:47:57Z', seller_response_due_date: '2026-10-06T00:00:00Z', dispute_amount: { currency_code: 'USD', value: '5' } });
  assert.equal(d.dueEstimated, false);
  assert.equal(d.dueAt, Date.parse('2026-10-06T00:00:00Z'));
});

test('if the whole read fails, the result says so and carries no disputes (the board then runs on fixtures)', async () => {
  __resetTokenCache();
  const r = await readLiveDisputes({ ...ENV, PAYPAL_CLIENT_ID: 'cid-bad' }, async () => resp(500, { name: 'INTERNAL' }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.disputes, []);
});
