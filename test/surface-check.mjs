// Surface validation: pure-node checks of ice (now spins the rear out), mud
// (now only punishes if you drift through it), and boost, plus in-browser
// checks that the game feeds surfaces into physics and that rectangular ice
// patches hit-test correctly.
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Car } from '../src/physics.js';
import { CONFIG } from '../src/config.js';

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

const H = 1 / CONFIG.PHYSICS_HZ;
const ICE = { t: 'ice' }, MUD = { t: 'mud' }, BOOST = { t: 'boost', tx: 1, ty: 0 };

// 1. ICE: turning into a corner makes the rear step out far more than on
//    asphalt — the same steering input spins you out.
function steerOn(surf) {
  const car = new Car();
  car.heading = 0; car.vx = 400;
  let maxSlip = 0;
  for (let i = 0; i < 70; i++) {
    car.step(H, -0.7, 1, 0, false, surf);
    maxSlip = Math.max(maxSlip, Math.abs(car.slip));
  }
  return maxSlip;
}
const iceSteer = steerOn(ICE), drySteer = steerOn(null);
check('ice spins the rear out (steering oversteers hard)',
  iceSteer > drySteer + 0.3 && iceSteer > 0.6,
  `ice=${(iceSteer * 57.3).toFixed(0)}° dry=${(drySteer * 57.3).toFixed(0)}°`);

// 2. ICE is catchable — active counter-steer (steer = sign(slip)) keeps it from
//    swapping ends.
{
  const car = new Car();
  car.heading = 0; car.vx = 400; car.vy = 40;
  let maxSlip = 0;
  for (let i = 0; i < 80; i++) {
    car.step(H, Math.sign(car.slip), 1, 0, false, ICE); // counter-steer into the slide
    maxSlip = Math.max(maxSlip, Math.abs(car.slip));
  }
  check('ice spin is catchable with counter-steer', maxSlip < 1.2,
    `maxSlip=${(maxSlip * 57.3).toFixed(0)}°`);
}

// 3. MUD straight-line is now only a mild cost; drifting through it still
//    scrubs hard.
function mudRun(vy) {
  const car = new Car();
  car.heading = 0; car.vx = 380; car.vy = vy;
  for (let i = 0; i < 60; i++) car.step(H, 0, 0, 0, false, MUD); // coast 0.5 s
  return car.speed;
}
const mudStraight = mudRun(0);     // no slip → light drag
const mudDrift = mudRun(230);      // big slip → drifting → heavy drag
check('mud is mild when driven straight', mudStraight > 250, `speed=${mudStraight.toFixed(0)}`);
check('mud still scrubs hard if you drift through it', mudDrift < mudStraight - 90,
  `drift=${mudDrift.toFixed(0)} straight=${mudStraight.toFixed(0)}`);

// 4. BOOST still shoves past entry speed and respects the cap.
const bcar = new Car();
bcar.heading = 0; bcar.vx = 200;
for (let i = 0; i < 36; i++) bcar.step(H, 0, 0, 0, false, BOOST);
check('boost pad accelerates the car', bcar.speed > 400, `speed=${bcar.speed.toFixed(0)}`);
check('boost respects its cap', bcar.speed <= CONFIG.SURFACE.BOOST_MAX + 5, `speed=${bcar.speed.toFixed(0)}`);

// 5. In-browser: rectangular ice patch hit-tests, and boost works in-game.
const { server, url } = await serve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');

// Sunset (0) has a rectangular ice patch
await page.evaluate(() => window.__NEON.test.start(0, 'time'));
await page.evaluate(() => window.__NEON.test.skipCountdown());
const rect = await page.evaluate(() => {
  const t = window.__NEON.game.track;
  const ice = t.surfaces.find((p) => p.t === 'ice');
  // centre is inside; a point well beyond the long axis is outside
  const inside = t.surfaceAt(ice.x, ice.y);
  const farX = ice.x + ice.tx * (ice.h / 2 + 60);
  const farY = ice.y + ice.ty * (ice.h / 2 + 60);
  const outside = t.surfaceAt(farX, farY);
  return { isRect: !!ice.rect, insideIce: inside && inside.t === 'ice', outsideClear: !outside || outside.t !== 'ice' };
});
check('ice patches are rectangles', rect.isRect);
check('rect ice hit-tests: centre is ice', rect.insideIce);
check('rect ice hit-tests: beyond the slab is clear', rect.outsideClear);

const boostGain = await page.evaluate(async () => {
  const g = window.__NEON.game, s = g.track.surfaces.find((p) => p.t === 'boost');
  window.__NEON.test.setCar(s.x - s.tx * 30, s.y - s.ty * 30, Math.atan2(s.ty, s.tx), s.tx * 180, s.ty * 180);
  const before = g.car.speed;
  await new Promise((r) => setTimeout(r, 350));
  return { before, after: g.car.speed };
});
check('in-game: boost pad speeds the player up', boostGain.after > boostGain.before + 120,
  `${boostGain.before.toFixed(0)} -> ${boostGain.after.toFixed(0)}`);
check('surfaces: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
