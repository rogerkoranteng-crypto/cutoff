// Registers (or finds) this app's PayPal sandbox webhook. Prints the webhook id. Uses one of the account's webhook slots.
import fs from 'node:fs';
for (const l of fs.readFileSync(new URL('../../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const { PAYPAL_CLIENT_ID: id, PAYPAL_SECRET: sec, PAYPAL_API: api } = process.env;
const url = process.argv[2].replace(/\/?$/, '/') + 'api/webhooks/paypal';
const tok = (await (await fetch(`${api}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json()).access_token;
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const EVENTS = ['INVOICING.INVOICE.CREATED', 'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.REFUNDED', 'INVOICING.INVOICE.UPDATED', 'INVOICING.INVOICE.CANCELLED', 'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'];
const list = await (await fetch(`${api}/v1/notifications/webhooks`, { headers: H })).json();
let hook = list.webhooks?.find((w) => w.url === url);
if (!hook) {
  const r = await fetch(`${api}/v1/notifications/webhooks`, { method: 'POST', headers: H, body: JSON.stringify({ url, event_types: EVENTS.map((name) => ({ name })) }) });
  hook = await r.json();
  if (!r.ok) throw new Error('webhook create failed: ' + JSON.stringify(hook));
}
console.log(hook.id);
