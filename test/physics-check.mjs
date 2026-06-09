// Deterministic physics validation (dev harness).
// Places the car in controlled situations and asserts the drift model spec:
//  1. straight-line acceleration → ~620 px/s in ~1.8 s
//  2. no steering authority at a standstill
//  3. handbrake at speed → drift entry (slip > 15°)
//  4. counter-steer catches the slide (slip recovers, no spin)
//  5. head-on wall hit scrubs speed, car stays inside the track
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
await page.evaluate(() => window.__NEON.test.start(0, 'time'));
await page.evaluate(() => window.__NEON.test.skipCountdown());
await page.waitForTimeout(100);

const car = () => page.evaluate(() => {
  const c = window.__NEON.car;
  return { x: c.x, y: c.y, speed: c.speed, vF: c.vF, slip: c.slip * 180 / Math.PI, drifting: c.drifting, heading: c.heading };
});
// Sunset bottom straight runs +x near y≈1000; place the car there
const place = (x, y, hdg, vx = 0, vy = 0) =>
  page.evaluate(([a, b, c, d, e]) => window.__NEON.test.setCar(a, b, c, d, e), [x, y, hdg, vx, vy]);
const releaseAll = async () => {
  for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']) await page.keyboard.up(k);
};

// --- 1. acceleration on a true straight
await place(-700, 995, 0);
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(1800);
let s = await car();
check('reaches ~620 px/s in ~1.8s', s.speed > 560 && s.speed < 680, `speed=${s.speed.toFixed(0)}`);
await releaseAll();

// --- 2. steering at a standstill does nothing
await place(-700, 995, 0);
await page.waitForTimeout(120);
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(600);
s = await car();
check('no turning while parked', Math.abs(s.heading) < 0.02 && s.speed < 5, `heading=${s.heading.toFixed(3)}`);
await releaseAll();

// --- 3. handbrake flick enters a drift, then the slide SUSTAINS on throttle
// (run in open space south of the track so walls can't interfere)
await place(-900, 2600, 0, 480, 0);
await page.keyboard.down('ArrowUp');
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('Space');
await page.waitForTimeout(280);            // short flick
await page.keyboard.up('Space');
s = await car();
check('handbrake+steer enters drift', s.drifting && Math.abs(s.slip) > 15,
  `slip=${s.slip.toFixed(1)}° drifting=${s.drifting}`);

// hold the slide for a second on throttle + steering
let minSlip = 999, maxSlip = -999, minSpeed = 999;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(100);
  s = await car();
  minSlip = Math.min(minSlip, Math.abs(s.slip));
  maxSlip = Math.max(maxSlip, Math.abs(s.slip));
  minSpeed = Math.min(minSpeed, s.speed);
}
check('slide sustains (15°..65°) without spinning', minSlip > 12 && maxSlip < 68 && minSpeed > 150,
  `slip ${minSlip.toFixed(0)}..${maxSlip.toFixed(0)}° minSpeed=${minSpeed.toFixed(0)}`);

// --- 4. counter-steer catches it (release once caught, like a human)
await page.keyboard.up('ArrowLeft');
await page.keyboard.down('ArrowRight');
let caught = null;
const t0 = Date.now();
while (Date.now() - t0 < 1400) {
  await page.waitForTimeout(60);
  s = await car();
  if (Math.abs(s.slip) < 10) { caught = s; break; }
}
await releaseAll();
check('counter-steer recovers the slide within 1.4s', !!caught && caught.speed > 150,
  caught ? `slip=${caught.slip.toFixed(1)}° speed=${caught.speed.toFixed(0)}` : 'never recovered');

// --- 5. head-on wall hit: speed scrubbed, no tunnel
await place(-700, 995, Math.PI / 2, 0, 600); // straight at the outer wall (y+)
await page.waitForTimeout(500);
s = await car();
check('wall kills normal velocity', s.speed < 220, `speed=${s.speed.toFixed(0)}`);
check('no tunneling through wall', s.y < 1120, `y=${s.y.toFixed(0)}`);

// --- fps sanity while driving
await place(-900, 995, 0, 200, 0);
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(2500);
const fps = await page.evaluate(() => window.__NEON.fpsAvg);
await releaseAll();
console.log(`fps(headless software rendering) = ${fps.toFixed(1)}`);

check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
