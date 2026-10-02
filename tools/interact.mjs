import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(() => { localStorage.setItem('cutoff-session', 'previewsession02'); localStorage.setItem('cutoff-theme','light'); });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('pageerror', e.message, (e.stack||'').split('\n').slice(0,8).join(' | ')));
p.on('console', (m) => { if (m.type()==='error') console.log('console.error', m.text().slice(0,200)); });
await p.goto('http://127.0.0.1:5176/', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
const out = '/tmp/claude-1000/-home-rogerkorantenng-dev-Hackathons/006fd40b-a300-45e1-b8f0-b67c3549da0d/scratchpad/';
await p.locator('.b-sch-event:has-text("1006")').first().click();
await p.waitForTimeout(800);
console.log('case heading:', await p.locator('#case-h').innerText());
// keyboard: focus an event and press keys
await p.locator('.b-sch-event:has-text("1012")').first().focus();
console.log('active after focus:', await p.evaluate(() => document.activeElement.className.slice(0,80) + ' | aria=' + document.activeElement.getAttribute('aria-label')));
await p.keyboard.press('Enter'); await p.waitForTimeout(500);
console.log('after Enter case heading:', await p.locator('#case-h').innerText(), '| popups:', await p.locator('.b-popup').count());
await p.screenshot({ path: out + 'b.png', fullPage: true });
await b.close();
