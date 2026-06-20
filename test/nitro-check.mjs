// Nitro + faster-rivals validation: pure-node checks of the Nitro state
// machine and per-car top speed, plus an in-game check that holding nitro
// pushes the player past the base top speed and the HUD bar responds.
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Car } from '../src/physics.js';
import { Nitro } from '../src/nitro.js';
import { CONFIG } from '../src/config.js';

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const H = 1 / CONFIG.PHYSICS_HZ;

// ---- Nitro state machine (pure node) ----
{
  const n = new Nitro();
  const sliding = { drifting: true, slip: 0.5, speed: 400 };
  for (let i = 0; i < 300; i++) n.step(H, sliding, false);   // 2.5 s of drifting
  check('drifting fills the bar', n.charge > 0.5, `charge=${n.charge.toFixed(2)}`);

  const before = n.charge;
  let force = 0;
  const cruising = { drifting: false, slip: 0, speed: 400 };
  for (let i = 0; i < 30; i++) force = n.step(H, cruising, true); // hold nitro 0.25 s
  check('holding nitro drains + returns boost force',
    n.active && force > 0 && n.charge < before, `force=${force.toFixed(0)} charge=${n.charge.toFixed(2)}`);

  const empty = new Nitro();
  const f0 = empty.step(H, cruising, true);
  check('empty bar gives no boost', !empty.active && f0 === 0);

  const low = new Nitro();
  low.charge = CONFIG.NITRO.MIN_FIRE - 0.02;
  low.step(H, cruising, true);
  check('MIN_FIRE blocks dry-firing a near-empty bar', !low.active, `charge=${low.charge.toFixed(2)}`);

  const ok = new Nitro();
  ok.charge = CONFIG.NITRO.MIN_FIRE + 0.2;
  const fok = ok.step(H, cruising, true);
  check('a charged bar fires', ok.active && fok > 0, `force=${fok.toFixed(0)}`);
}

// ---- per-car top speed + nitro force (pure node) ----
function topSpeed(throttleForce, topSpeedParam, boost = 0) {
  const car = new Car();
  car.throttleForce = throttleForce; car.topSpeed = topSpeedParam;
  car.heading = 0;
  for (let i = 0; i < 720; i++) car.step(H, 0, 1, 0, false, null, boost); // 6 s flat out
  return car.speed;
}
const playerTop = topSpeed(CONFIG.CAR.THROTTLE_FORCE, CONFIG.CAR.TOP_SPEED);
const rivalTop = topSpeed(CONFIG.AI.THROTTLE_FORCE, CONFIG.AI.TOP_SPEED);
const nitroTop = topSpeed(CONFIG.CAR.THROTTLE_FORCE, CONFIG.CAR.TOP_SPEED, CONFIG.NITRO.FORCE);
check('player base top speed unchanged (~540)', playerTop > 525 && playerTop < 555, `${playerTop.toFixed(0)}`);
check('rivals top out faster than the player', rivalTop > playerTop + 25, `rival=${rivalTop.toFixed(0)} player=${playerTop.toFixed(0)}`);
check('nitro lifts the player above base top speed', nitroTop > playerTop + 25, `nitro=${nitroTop.toFixed(0)}`);

// ---- in-game integration ----
const { server, url } = await serve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
await page.evaluate(() => window.__NEON.test.start(0, 'time'));
await page.evaluate(() => window.__NEON.test.skipCountdown());
// give a full bar, floor it on an open straight, then hold nitro
await page.evaluate(() => { window.__NEON.nitro.charge = 1; });
await page.evaluate(([x, y]) => window.__NEON.test.setCar(x, y, 0, 480, 0), [-900, 2600]);
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(900);
const base = await page.evaluate(() => window.__NEON.car.speed);
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(700);
const boosted = await page.evaluate(() => window.__NEON.car.speed);
const barWidth = await page.evaluate(() => document.getElementById('nitro-fill').style.width);
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('ArrowUp');
check('in-game: nitro pushes past base top speed', boosted > base + 25 && boosted > 560,
  `${base.toFixed(0)} -> ${boosted.toFixed(0)}`);
check('in-game: nitro HUD bar reflects charge', barWidth && parseFloat(barWidth) > 0, `width=${barWidth}`);
check('nitro: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
