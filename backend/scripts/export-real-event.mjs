// Saves the newest verified INVOICING.INVOICE.REFUNDED delivery (raw body + PayPal headers) as a test fixture.
import { DynamoStore } from '../src/store.js';
import fs from 'node:fs';
process.env.TABLE_NAME ??= 'cutoff-triage';
const st = new DynamoStore();
const rows = await st.query('FEED', '', { limit: 80, reverse: true });
const hit = rows.find((r) => r.eventType === 'INVOICING.INVOICE.REFUNDED' && r.verified && r.raw);
if (!hit) throw new Error('no verified REFUNDED delivery stored yet');
const out = new URL('../tests/fixtures/real-refunded-event.json', import.meta.url);
fs.writeFileSync(out, JSON.stringify({ capturedAt: new Date(hit.at).toISOString(), webhookId: process.env.PAYPAL_WEBHOOK_ID ?? null, headers: hit.headers, raw: hit.raw }, null, 2));
console.log('saved', hit.eventType, new Date(hit.at).toISOString(), 'body bytes', hit.raw.length);
