// usage: node shoot.mjs <baseUrl> <outDir> [session] ; shoots Board/Queue/Deadlines/PayPal at 360/768/1280/1920 in light and dark
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [base, outDir, sid = 'shotsession01'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ executablePath: '/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const sizes = [[360, 800], [768, 1024], [1280, 900], [1920, 1080]];
const tabs = (process.env.TABS ?? 'board,queue,deadlines,paypal').split(',');
const themes = (process.env.THEMES ?? 'light,dark').split(',');
const only = process.env.WIDTHS ? process.env.WIDTHS.split(',').map(Number) : null;
const issues = [];
for (const theme of themes) for (const [w, h] of sizes) {
  if (only && !only.includes(w)) continue;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
  await ctx.addInitScript(([t, s]) => { localStorage.setItem('cutoff-theme', t); localStorage.setItem('cutoff-session', s); }, [theme, sid]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => issues.push(`${theme}/${w} pageerror ${e.message.slice(0, 120)}`));
  await p.goto(base, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1800);
  for (const tab of tabs) {
    await p.click(`#tab-${tab}`);
    await p.waitForTimeout(tab === 'deadlines' ? 3500 : 900);
    if (tab === 'board' || tab === 'queue') {
      const target = process.env.CASE ?? 'FX-D-1009';
      if (tab === 'board') await p.selectOption('.pick select', target).catch(() => {});
      else await p.click(`button[aria-label="Open ${target}"]`).catch(() => {});
      await p.waitForTimeout(700);
    }
    await p.screenshot({ path: `${outDir}/${tab}-${w}-${theme}.png`, fullPage: true });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) issues.push(`${theme}/${w}/${tab}: horizontal page overflow ${overflow}px`);
  }
  await ctx.close();
}
await b.close();
console.log(issues.join('\n') || 'shots done, no page overflow, no page errors');
