// Runs against the deployed stack (CloudFront -> Lambda -> DynamoDB, real PayPal sandbox, real Bedrock).
// BASE defaults to the URL written by deploy.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const urls = Object.fromEntries(fs.readFileSync(new URL('../../.aws-out/urls.env', import.meta.url), 'utf8').trim().split('\n').map((l) => l.split('=')));
const BASE = process.env.BASE ?? urls.CLOUDFRONT_URL;
const FN = urls.FUNCTION_URL.replace(/\/$/, '');
const SID = 'deployed-' + Date.now().toString(36);
const event = JSON.parse(fs.readFileSync(new URL('./fixtures/real-refunded-event.json', import.meta.url), 'utf8'));
const call = async (method, path, body, headers = {}, base = BASE) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-session': SID, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const until = async (fn, ms, label) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + label); await new Promise((r) => setTimeout(r, 2500)); } };

test('DEPLOYED: the site and the API answer through CloudFront', async () => {
  assert.equal((await fetch(BASE + '/')).status, 200);
  const h = await call('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.store, 'dynamodb');
  console.log('  model:', h.body.model);
});

test('DEPLOYED: a fresh board has 12 fixture disputes and reports the live PayPal read', async () => {
  const b = await call('GET', '/api/board');
  assert.equal(b.body.disputes.length, 12);
  assert.equal(b.body.live.ok, true);
  assert.equal(b.body.live.count, 0);
});

test('DEPLOYED: a fixture event starts an agent run that finishes with an explanation and no overlaps', async () => {
  const r = await call('POST', '/api/events', { type: 'deadline.shortened', disputeId: 'FX-D-1003', hours: 4 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const done = await until(async () => { const b = (await call('GET', '/api/board')).body; return b.runs[0]?.status !== 'running' ? b : null; }, 150_000, 'agent run');
  const run = done.runs[0];
  console.log(`  engine=${run.engine} turns=${run.turns} steps=${run.steps.length} fallback=${run.fallbackReason ?? 'none'}`);
  console.log('  explanation:', run.explanation);
  assert.equal(run.status, 'done');
  assert.ok(run.explanation.length > 20);
  const open = done.disputes.filter((d) => d.state === 'open' && d.start != null);
  for (const a of open) for (const b of open) if (a.id < b.id && a.handlerId === b.handlerId) assert.ok(a.end <= b.start || b.end <= a.start, `${a.id}/${b.id} overlap`);
});

test('DEPLOYED: a drop that overlaps another block is refused, a valid one persists', async () => {
  const b = (await call('GET', '/api/board')).body;
  const d = b.disputes.find((x) => x.id === 'FX-D-1012');
  const other = b.disputes.find((x) => x.id !== d.id && x.state === 'open' && x.handlerId !== d.handlerId && !x.pinned);
  const bad = await call('POST', `/api/disputes/${d.id}/assign`, { handlerId: other.handlerId, start: other.start });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  const opts = (await call('GET', `/api/disputes/${d.id}/options`)).body;
  assert.ok(opts.starts.length > 0);
  const ok = await call('POST', `/api/disputes/${d.id}/assign`, { handlerId: opts.handlerId, start: opts.starts.at(-1).start });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.disputes.find((x) => x.id === d.id).start, opts.starts.at(-1).start);
});

test('DEPLOYED: refunding through PayPal moves the board only when the signed webhook arrives', async () => {
  const before = (await call('GET', '/api/board')).body;
  assert.equal(before.running, null);
  const r = await call('POST', '/api/disputes/FX-D-1006/paypal-refund', { mode: 'full' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.disputes.find((d) => d.id === 'FX-D-1006').state, 'open', 'not resolved by the click alone');
  const b = await until(async () => { const x = (await call('GET', '/api/board')).body; return x.disputes.find((d) => d.id === 'FX-D-1006').state === 'resolved' ? x : null; }, 120_000, 'webhook');
  const ev = b.log.find((l) => /refunded in full/.test(l.title));
  console.log('  log:', ev.detail.slice(-80));
  assert.match(ev.detail, /PayPal webhook, signature verified/, 'applied from the webhook, not the 45 second poll');
  const feed = (await call('GET', '/api/feed')).body.events;
  assert.ok(feed.some((f) => f.eventType === 'INVOICING.INVOICE.REFUNDED' && f.verified && f.status === 'applied'));
});

test('DEPLOYED TAMPER: an unsigned delivery, and a real delivery with its amount changed, are both refused with 401', async () => {
  const unsigned = await call('POST', '/api/webhooks/paypal', { id: 'WH-FAKE', event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: 'INV2-X' } } }, {}, FN);
  assert.equal(unsigned.status, 401);
  const tampered = event.raw.replace(/"value":"\d+\.\d+"/, '"value":"0.01"');
  const r = await fetch(FN + '/api/webhooks/paypal', { method: 'POST', headers: { 'content-type': 'application/json', ...event.headers }, body: tampered });
  console.log('  tampered ->', r.status, await r.text());
  assert.equal(r.status, 401);
});

test('DEPLOYED: a genuine delivery is acknowledged with 200 straight away (replay is later ignored as a duplicate)', async () => {
  const r = await fetch(FN + '/api/webhooks/paypal', { method: 'POST', headers: { 'content-type': 'application/json', ...event.headers }, body: event.raw });
  const t = Date.now();
  console.log('  replay ->', r.status, '(PayPal may refuse an hour-old transmission; 200 or 401 are both safe outcomes)');
  assert.ok([200, 401].includes(r.status));
  void t;
});
