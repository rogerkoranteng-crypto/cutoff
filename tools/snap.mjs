// usage: node snap.mjs <url> <out.png> [width=1280] [height=900] [theme=light] [fullPage=1] [js]
import { chromium } from 'playwright-core';
const [url, out, w = '1280', h = '900', theme = 'light', full = '1', js] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: +w, height: +h }, colorScheme: theme, deviceScaleFactor: 1 });
await ctx.addInitScript((t) => { try { localStorage.setItem('cutoff-theme', t); localStorage.setItem('cutoff-session', 'previewsession01'); } catch {} }, theme);
const p = await ctx.newPage();
const logs = [];
p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
p.on('pageerror', (e) => logs.push('pageerror: ' + e.message.slice(0, 400)));
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
if (js) { await p.evaluate(js); await p.waitForTimeout(4500); }
await p.screenshot({ path: out, fullPage: full === '1' });
console.log(logs.join('\n') || 'no console errors');
await b.close();
