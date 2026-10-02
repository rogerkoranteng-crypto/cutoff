import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(() => { localStorage.setItem('cutoff-session', 'previewsession05'); localStorage.setItem('cutoff-theme','light'); });
const p = await ctx.newPage();
await p.goto(process.argv[2] ?? 'http://127.0.0.1:5176/', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
const active = () => p.evaluate(() => { const a = document.activeElement; return (a.getAttribute('aria-label') || a.textContent || a.tagName).slice(0, 90) + ' [' + a.className.toString().slice(0,40) + ']'; });
await p.locator('.b-sch-event-wrap:has-text("1006")').first().click();
console.log('after click on event', await active(), '| case:', await p.locator('#case-h').innerText());
for (const k of ['ArrowRight','ArrowRight','ArrowDown','ArrowLeft','Enter',' ']) { await p.keyboard.press(k); await p.waitForTimeout(250); console.log(JSON.stringify(k), '->', (await active()).slice(0,70), '| case:', await p.locator('#case-h').innerText()); }
console.log('tabindex values:', await p.evaluate(() => [...document.querySelectorAll('.b-sch-event-wrap')].slice(0,4).map(e=>e.getAttribute('tabindex'))));
await b.close();
