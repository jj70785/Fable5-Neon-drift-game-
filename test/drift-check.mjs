// Drift Attack scoring validation (dev harness): accrue → bank → chain ×2 →
// wall forfeit resets the chain.
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { server, url } = await serve(root);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

await page.goto(url);
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
await page.evaluate(() => window.__NEON.test.start(0, 'drift'));
await page.evaluate(() => window.__NEON.test.skipCountdown());

const drift = () => page.evaluate(() => {
  const d = window.__NEON.drift;
  return { total: d.total, pending: d.pending, mult: d.mult, active: d.active };
});
const place = (x, y, hdg, vx = 0, vy = 0) =>
  page.evaluate(([a, b, c, d, e]) => window.__NEON.test.setCar(a, b, c, d, e), [x, y, hdg, vx, vy]);

// slide #1 in open space
await place(-900, 2600, 0, 500, 0);
await page.keyboard.down('ArrowUp');
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('Space');
await page.waitForTimeout(280);
await page.keyboard.up('Space');
await page.waitForTimeout(700);
let d = await drift();
check('points accrue while drifting', d.active && d.pending > 100, `pending=${d.pending.toFixed(0)}`);

// straighten → bank
await page.keyboard.up('ArrowLeft');
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(700);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(400);
d = await drift();
check('points bank on clean exit', d.total > 100 && !d.active, `total=${d.total}`);
const bankedOnce = d.total;

// quick chained slide #2 → multiplier climbs
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('Space');
await page.waitForTimeout(250);
await page.keyboard.up('Space');
await page.waitForTimeout(500);
d = await drift();
check('chained drift raises multiplier', d.mult >= 2 && d.active, `mult=${d.mult}`);

// clean exit to bank slide #2
await page.keyboard.up('ArrowLeft');
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(700);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(2000); // let the chain window lapse → mult back to 1
d = await drift();
const totalBeforeWall = d.total;
check('second bank lands', totalBeforeWall > bankedOnce, `total=${d.total}`);

// new drift ON the track that slides into the inner wall → forfeit + reset
await place(-700, 1020, 0, 450, 0);
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('Space');
let sawPending = 0, sawActive = false;
for (let i = 0; i < 60; i++) {           // slide carries it into the wall
  await page.waitForTimeout(40);
  if (i === 6) await page.keyboard.up('Space');
  d = await drift();
  if (d.active) sawActive = true;
  if (d.pending > sawPending) sawPending = d.pending;
  if (sawActive && !d.active) break;     // drift ended (wall or exit)
}
await page.keyboard.up('ArrowLeft');
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(100);
d = await drift();
check('wall forfeits pending + resets mult', sawPending > 50 && d.mult === 1 && d.total === totalBeforeWall,
  `sawPending=${sawPending.toFixed(0)} mult=${d.mult} total=${d.total} (was ${totalBeforeWall})`);

check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
