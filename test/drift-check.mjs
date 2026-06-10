// Drift Attack scoring validation (dev harness): accrue → bank → chain ×2 →
// wall forfeit resets the chain. Includes pure-node unit checks of the
// scrape-vs-hit forfeit logic (v3).
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DriftScore } from '../src/drift.js';
import { CONFIG } from '../src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// ---- pure-node unit checks: wall scrapes must not forfeit (v3 fix) ----
{
  const unitChecks = [];
  const uCheck = (name, cond, detail) => unitChecks.push({ name, cond, detail });
  const ds = new DriftScore();
  const slidingCar = { drifting: true, speed: 420, slip: 0.55 };
  const h = 1 / CONFIG.PHYSICS_HZ;

  for (let i = 0; i < 60; i++) ds.step(h, slidingCar, 0);     // 0.5 s of drift
  const pendingBefore = ds.pending;
  ds.step(h, slidingCar, CONFIG.SCORE.FORFEIT_IMPACT - 20);   // feather scrape
  uCheck('scrape below threshold keeps the chain',
    ds.active && ds.pending >= pendingBefore && ds.forfeited === 0,
    `pending=${ds.pending.toFixed(0)}`);

  ds.step(h, slidingCar, CONFIG.SCORE.FORFEIT_IMPACT + 60);   // solid hit
  uCheck('solid hit forfeits + resets', !ds.active && ds.pending === 0 && ds.mult === 1 && ds.forfeited > 0);

  ds.step(h, slidingCar, 0);                                  // drift re-engages
  ds.step(h, slidingCar, CONFIG.SCORE.FORFEIT_IMPACT + 60);   // still in grace
  uCheck('grace window blocks instant re-forfeit', ds.active && ds.forfeited === 0,
    `grace=${ds.graceTimer.toFixed(2)}`);

  let unitFails = 0;
  for (const u of unitChecks) {
    console.log(`${u.cond ? 'PASS' : 'FAIL'}  unit: ${u.name}${u.detail ? `  (${u.detail})` : ''}`);
    if (!u.cond) unitFails++;
  }
  if (unitFails) process.exit(1);
}

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
await page.keyboard.up('ArrowUp');     // stop ALL driving — uncontrolled
await page.waitForTimeout(2200);       // background drifting pollutes the totals
d = await drift();
const totalBeforeWall = d.total;
check('second bank lands', totalBeforeWall > bankedOnce, `total=${d.total}`);

// drift HEAD-ON into the outer wall → unambiguous solid hit → forfeit.
// (v3: shallow scrapes deliberately no longer forfeit — covered by unit checks.)
// Fast + close so the car reaches the wall before the handbrake scrubs it,
// but far enough that the drift outlives MIN_DRIFT_TIME: a clean end would
// BANK, so "total unchanged" can only mean the forfeit fired.
await place(-700, 960, Math.PI / 2, 130, 480); // sideways component → scoring slip
await page.keyboard.down('Space');
await page.keyboard.down('ArrowLeft');
let sawPending = 0, sawActive = false;
for (let i = 0; i < 50; i++) {
  await page.waitForTimeout(30);
  d = await drift();
  if (d.active) sawActive = true;
  if (d.pending > sawPending) sawPending = d.pending;
  if (sawActive && !d.active) break;     // drift ended (forfeit, ideally)
}
await page.keyboard.up('Space');
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(100);
d = await drift();
check('solid wall hit forfeits pending + resets mult', sawPending > 20 && d.mult === 1 && d.total === totalBeforeWall,
  `sawPending=${sawPending.toFixed(0)} mult=${d.mult} total=${d.total} (was ${totalBeforeWall})`);

check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
