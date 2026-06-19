// Surface validation: pure-node unit checks of ice / mud / boost in the car
// model, plus one in-browser integration check that the game actually feeds
// the surface under the car into the physics step.
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
function drive(init, surf, steer, throttle, brake, hb, secs) {
  const car = new Car();
  init(car);
  const steps = Math.round(secs / H);
  let maxSlip = 0, everDrift = false;
  for (let i = 0; i < steps; i++) {
    car.step(H, steer, throttle, brake, hb, surf);
    maxSlip = Math.max(maxSlip, Math.abs(car.slip));
    if (car.drifting) everDrift = true;
  }
  return { car, maxSlip, everDrift };
}
const ICE = { t: 'ice' }, MUD = { t: 'mud' }, BOOST = { t: 'boost', tx: 1, ty: 0 };
const fast = (c) => { c.vx = 320; c.vy = 0; c.heading = 0; };

// 1. ICE: same steering input slides far more than on asphalt
const ice = drive(fast, ICE, -1, 1, 0, false, 0.45);
const dry = drive(fast, null, -1, 1, 0, false, 0.45);
check('ice slides more than asphalt', ice.maxSlip > dry.maxSlip + 0.15 && ice.everDrift,
  `ice=${(ice.maxSlip * 57.3).toFixed(0)}° dry=${(dry.maxSlip * 57.3).toFixed(0)}°`);

// 2. MUD: scrubs speed hard compared with coasting on asphalt
const mud = drive(fast, MUD, 0, 0, 0, false, 0.5);
const coast = drive(fast, null, 0, 0, 0, false, 0.5);
check('mud scrubs speed', mud.car.speed < 235 && mud.car.speed < coast.car.speed - 50,
  `mud=${mud.car.speed.toFixed(0)} coast=${coast.car.speed.toFixed(0)}`);

// 3. MUD: digs in — a handbrake+steer slide cannot develop
const mudDrift = drive((c) => { c.vx = 340; c.heading = 0; }, MUD, 1, 1, 0, true, 0.5);
check('mud kills drifting', !mudDrift.everDrift, `drifted=${mudDrift.everDrift}`);

// 4. BOOST: shoves the car well past its entry speed
const boost = drive((c) => { c.vx = 200; c.heading = 0; }, BOOST, 0, 0, 0, false, 0.3);
check('boost pad accelerates the car', boost.car.speed > 400, `speed=${boost.car.speed.toFixed(0)}`);
check('boost respects its cap', boost.car.speed <= CONFIG.SURFACE.BOOST_MAX + 5,
  `speed=${boost.car.speed.toFixed(0)} cap=${CONFIG.SURFACE.BOOST_MAX}`);

// 5. in-game integration: driving onto a boost pad speeds the player up
const { server, url } = await serve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
// Aurora Bay (index 3) has a boost pad at its first surface
await page.evaluate(() => window.__NEON.test.start(3, 'time'));
await page.evaluate(() => window.__NEON.test.skipCountdown());
const gained = await page.evaluate(async () => {
  const g = window.__NEON.game, s = g.track.surfaces.find((p) => p.t === 'boost');
  g.test = g.test || {};
  window.__NEON.test.setCar(s.x - s.tx * 30, s.y - s.ty * 30, Math.atan2(s.ty, s.tx), s.tx * 180, s.ty * 180);
  const before = g.car.speed;
  await new Promise((r) => setTimeout(r, 350));
  return { before, after: g.car.speed };
});
check('in-game: boost pad speeds the player up', gained.after > gained.before + 120,
  `${gained.before.toFixed(0)} -> ${gained.after.toFixed(0)}`);
check('surfaces: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
