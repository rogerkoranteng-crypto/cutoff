// Browser end to end against a URL. usage: node e2e.mjs <baseUrl> [hostRule]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const [base, rule] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox', ...(rule ? [`--host-resolver-rules=${rule}`] : [])] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const sid = 'e2e' + Date.now().toString(36);
await ctx.addInitScript((s) => { localStorage.setItem('cutoff-session', s); localStorage.setItem('cutoff-theme', 'light'); }, sid);
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
const ok = (m) => console.log('ok  ', m);
await p.goto(base, { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
assert.ok(await p.locator('.b-sch-event').count() > 10); ok('Scheduler rendered with ' + await p.locator('.b-sch-event').count() + ' event elements');
assert.ok(await p.locator('.b-group-row').count() >= 3); ok('resource groups rendered');
// keyboard path
await p.selectOption('.pick select', 'FX-D-1004'); await p.waitForTimeout(600);
assert.equal(await p.evaluate(() => document.activeElement.id), 'case-h'); ok('Jump to case moved focus to the case panel');
const handlerSel = p.locator('.reassign select').first();
const cur = await handlerSel.inputValue();
const other = await handlerSel.locator('option').evaluateAll((o, c) => o.map((x) => x.value).find((v) => v && v !== c), cur);
await handlerSel.selectOption(other); await p.waitForTimeout(900);
await p.locator('.reassign button[type=submit]').focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
const board = await (await fetch(new URL('/api/board', base), { headers: { 'x-session': sid } }).catch(() => null))?.json?.();
if (board) { assert.equal(board.disputes.find((d) => d.id === 'FX-D-1004').handlerId, other); ok('keyboard reassign persisted on the server'); }
console.log('toast:', await p.locator('.toast').first().innerText().catch(() => '(none)'));
// drag
const blk = p.locator('.b-sch-event-wrap:has-text("1012")').first();
const bb = await blk.boundingBox();
const row = await p.locator('.b-grid-row:has-text("Dev Patel")').first().boundingBox();
await p.mouse.move(bb.x + 20, bb.y + 18); await p.mouse.down(); await p.mouse.move(bb.x + 60, bb.y + 18, { steps: 4 });
await p.mouse.move(bb.x + 40, row.y + 25, { steps: 10 }); await p.waitForTimeout(300);
const tip = (await p.locator('.b-tooltip').allInnerTexts()).join(' | ');
await p.mouse.up(); await p.waitForTimeout(1200);
console.log('drag tip:', tip.replace(/\n/g, ' '));
// tabs
for (const t of ['queue', 'deadlines', 'paypal', 'board']) { await p.click(`#tab-${t}`); await p.waitForTimeout(t === 'deadlines' ? 3000 : 600); }
ok('all tabs open');
assert.deepEqual(errors, [], errors.join('\n')); ok('no page errors');
await b.close();
