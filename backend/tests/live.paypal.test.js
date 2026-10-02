// Runs against the real PayPal sandbox (reads ../../.env). Creates a few sandbox invoices; no real money.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readLiveDisputes, createRefundedInvoice, getInvoice, refundedAmount, getToken } from '../src/paypal.js';
import { verifyLocal, verifyViaApi } from '../src/webhook.js';

for (const l of fs.readFileSync(new URL('../../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const event = JSON.parse(fs.readFileSync(new URL('./fixtures/real-refunded-event.json', import.meta.url), 'utf8'));
const WEBHOOK_ID = event.webhookId;

test('LIVE: OAuth works and the token carries the disputes and invoicing scopes', async () => {
  const t = await getToken();
  assert.ok(t.scopes.some((s) => s.endsWith('/disputes/read-seller')));
  assert.ok(t.scopes.some((s) => s.endsWith('/services/invoicing')));
});

test('LIVE: GET /v1/customer/disputes answers 200 (the sandbox holds none) and the read path reports it', async () => {
  const r = await readLiveDisputes();
  assert.equal(r.ok, true, r.error);
  assert.equal(typeof r.count, 'number');
  console.log(`  sandbox disputes: ${r.count}`);
});

test('LIVE: a repeated refund request reuses the same sandbox invoice (deterministic invoice number)', async () => {
  const args = { sid: 'live-test-' + Date.now(), disputeId: 'FX-D-LIVE', amount: 3.5, seq: 1 };
  const first = await createRefundedInvoice(args);
  assert.equal(first.repeat, false);
  assert.deepEqual(first.steps.map((s) => s.step), ['create_invoice', 'record_payment', 'record_refund']);
  const second = await createRefundedInvoice(args);
  assert.equal(second.repeat, true);
  assert.equal(second.invoiceId, first.invoiceId);
  assert.ok(second.steps.every((s) => s.status === 'duplicate'), JSON.stringify(second.steps));
  const inv = await getInvoice(first.invoiceId);
  assert.equal(inv.status, 'MARKED_AS_REFUNDED');
  assert.equal(refundedAmount(inv).value, 3.5, 'refunded exactly once');
});

test('LIVE: the captured PayPal delivery verifies locally against the real certificate', async () => {
  const when = Date.parse(event.headers['paypal-transmission-time']);
  const v = await verifyLocal({ headers: event.headers, rawBody: event.raw, webhookId: WEBHOOK_ID, now: when });
  assert.equal(v.ok, true, v.reason);
});

test('LIVE TAMPER: the same delivery with the refund amount changed fails local verification', async () => {
  const when = Date.parse(event.headers['paypal-transmission-time']);
  const tampered = event.raw.replace(/"value":"\d+\.\d+"/, '"value":"0.01"');
  assert.notEqual(tampered, event.raw);
  const v = await verifyLocal({ headers: event.headers, rawBody: tampered, webhookId: WEBHOOK_ID, now: when });
  assert.equal(v.ok, false);
  assert.match(v.reason, /signature does not match/);
});

test('LIVE: PayPal\'s own verify-webhook-signature accepts the delivery and rejects the tampered copy', async () => {
  const good = await verifyViaApi({ headers: event.headers, rawBody: event.raw, webhookId: WEBHOOK_ID });
  console.log('  untouched ->', good.ok ? 'SUCCESS' : good.reason);
  const tampered = event.raw.replace(/"value":"\d+\.\d+"/, '"value":"0.01"');
  const bad = await verifyViaApi({ headers: event.headers, rawBody: tampered, webhookId: WEBHOOK_ID });
  console.log('  tampered  ->', bad.ok ? 'SUCCESS' : bad.reason);
  assert.equal(bad.ok, false);
  assert.equal(good.ok, true, good.reason);
});

test('LIVE: the real sandbox dispute is reachable by id even though the list is empty, and maps onto a board case', async () => {
  const r = await readLiveDisputes({ ...process.env, LIVE_DISPUTE_IDS: 'PP-R-IQQ-10190238' });
  console.log(`  list returned ${r.listCount}, by-id read returned ${r.disputes.length}`);
  assert.equal(r.ok, true);
  const d = r.disputes.find((x) => x.id === 'PP-R-IQQ-10190238');
  assert.ok(d, 'dispute fetched by id');
  assert.equal(d.live, true);
  assert.equal(d.amount.value, 229);
  assert.equal(d.reason, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
  console.log(`  due ${new Date(d.dueAt).toISOString()} estimated=${d.dueEstimated}`);
});
