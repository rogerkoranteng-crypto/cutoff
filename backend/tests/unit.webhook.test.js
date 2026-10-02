import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { crc32, signedString, verifyLocal, verifyViaApi, certUrlAllowed, missingHeaders } from '../src/webhook.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const WEBHOOK_ID = 'WH-TEST-0001';
const NOW = Date.parse('2026-10-02T10:00:00Z');

function signed(body, over = {}) {
  const raw = JSON.stringify(body);
  const h = { 'paypal-transmission-id': 'tx-1', 'paypal-transmission-time': new Date(NOW - 5000).toISOString(), 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-auth-algo': 'SHA256withRSA', ...over };
  h['paypal-transmission-sig'] = crypto.createSign('RSA-SHA256').update(signedString(h, raw, WEBHOOK_ID)).sign(privateKey, 'base64');
  return { headers: h, raw };
}
const getKey = async () => publicKey;
const body = { id: 'WH-1', event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: 'INV2-AAAA', refunds: { transactions: [{ amount: { currency_code: 'USD', value: '100.00' } }] } } } };

test('crc32 matches the standard check value', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
});

test('a correctly signed payload verifies', async () => {
  const { headers, raw } = signed(body);
  const v = await verifyLocal({ headers, rawBody: raw, webhookId: WEBHOOK_ID, getKey, now: NOW });
  assert.equal(v.ok, true);
});

test('TAMPER: changing the refund amount after signing is rejected', async () => {
  const { headers, raw } = signed(body);
  const tampered = raw.replace('100.00', '1.00');
  assert.notEqual(tampered, raw);
  const v = await verifyLocal({ headers, rawBody: tampered, webhookId: WEBHOOK_ID, getKey, now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reason, /signature does not match/);
});

test('TAMPER: the wrong webhook id is rejected (a payload signed for another webhook)', async () => {
  const { headers, raw } = signed(body);
  const v = await verifyLocal({ headers, rawBody: raw, webhookId: 'WH-OTHER', getKey, now: NOW });
  assert.equal(v.ok, false);
});

test('TAMPER: a payload signed with a different key is rejected', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { headers, raw } = signed(body);
  const v = await verifyLocal({ headers, rawBody: raw, webhookId: WEBHOOK_ID, getKey: async () => other.publicKey, now: NOW });
  assert.equal(v.ok, false);
});

test('a certificate URL off paypal.com is refused before any fetch', async () => {
  const { headers, raw } = signed(body, { 'paypal-cert-url': 'https://evil.example.com/cert.pem' });
  let fetched = false;
  const v = await verifyLocal({ headers, rawBody: raw, webhookId: WEBHOOK_ID, getKey: async () => { fetched = true; return publicKey; }, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(fetched, false);
  assert.equal(certUrlAllowed('http://api.paypal.com/x'), false);
  assert.equal(certUrlAllowed('https://paypal.com.evil.io/x'), false);
  assert.equal(certUrlAllowed('https://api.sandbox.paypal.com/x'), true);
});

test('a replayed transmission older than an hour is refused', async () => {
  const { headers, raw } = signed(body, { 'paypal-transmission-time': new Date(NOW - 3 * 3600_000).toISOString() });
  const v = await verifyLocal({ headers, rawBody: raw, webhookId: WEBHOOK_ID, getKey, now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reason, /replay/);
});

test('missing signature headers are refused', async () => {
  assert.deepEqual(missingHeaders({}).length, 5);
  const v = await verifyLocal({ headers: { 'paypal-transmission-id': 'x' }, rawBody: '{}', webhookId: WEBHOOK_ID, getKey, now: NOW });
  assert.equal(v.ok, false);
});

test('verifyViaApi treats anything but SUCCESS as a rejection', async () => {
  const { headers, raw } = signed(body);
  const mk = (status) => async (url) => (/oauth2/.test(url)
    ? { ok: true, json: async () => ({ access_token: 't', expires_in: 3000, scope: '' }) }
    : { ok: true, json: async () => ({ verification_status: status }) });
  const env = { PAYPAL_CLIENT_ID: 'a', PAYPAL_SECRET: 'b', PAYPAL_API: 'https://x.test' };
  assert.equal((await verifyViaApi({ headers, rawBody: raw, webhookId: WEBHOOK_ID, env: { ...env, PAYPAL_CLIENT_ID: 'a1' }, fetchImpl: mk('SUCCESS') })).ok, true);
  assert.equal((await verifyViaApi({ headers, rawBody: raw, webhookId: WEBHOOK_ID, env: { ...env, PAYPAL_CLIENT_ID: 'a2' }, fetchImpl: mk('FAILURE') })).ok, false);
});
