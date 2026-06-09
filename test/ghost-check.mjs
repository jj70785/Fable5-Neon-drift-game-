// Ghost + persistence validation (dev harness).
// Completes a REAL (shortened to 1 lap) Time Trial by coasting through every
// checkpoint gate in order, then verifies: best time + splits + ghost are
// persisted, the ghost replays on the next run, and the delta HUD fires.
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'test/artifacts'), { recursive: true });
const { server, url } = await serve(root);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
await page.evaluate(() => { window.__NEON.config.RACE.LAPS = 1; });
await page.evaluate(() => window.__NEON.test.start(0, 'time'));
await page.evaluate(() => window.__NEON.test.skipCountdown());

// coast through each gate in order: place just before it, moving through
const driveLap = async () => {
  const gateCount = await page.evaluate(() => window.__NEON.game.track.gates.length);
  const order = [];
  for (let g = 1; g < gateCount; g++) order.push(g);
  order.push(0); // start/finish last
  for (const g of order) {
    await page.evaluate((gi) => {
      const game = window.__NEON.game;
      const gate = game.track.gates[gi];
      game.car.reset(gate.cx - gate.tx * 70, gate.cy - gate.ty * 70, gate.heading);
      game.car.vx = gate.tx * 320;
      game.car.vy = gate.ty * 320;
    }, g);
    await page.waitForTimeout(380);
  }
};
await driveLap();
await page.waitForFunction(() => window.__NEON.phase === 'finished', null, { timeout: 5000 });
const lap1 = await page.evaluate(() => window.__NEON.game.race.total);
check('1-lap race finishes by crossing all gates', lap1 > 0, `total=${lap1?.toFixed(3)}`);

await page.waitForFunction(() => window.__NEON.state === 'results', null, { timeout: 5000 });
const persisted = await page.evaluate(() => {
  const v = window.__NEON.config.SAVE_VERSION;
  return {
    best: !!window.localStorage.getItem(`neondrift.best.sunset.v${v}`),
    ghost: window.localStorage.getItem(`neondrift.ghost.sunset.v${v}`),
  };
});
check('best time persisted', persisted.best);
check('ghost persisted under 100 KB', !!persisted.ghost && persisted.ghost.length < 100 * 1024,
  `bytes=${persisted.ghost ? persisted.ghost.length : 0}`);

// second run: ghost should replay + delta HUD should fire at gate crossings
await page.evaluate(() => window.__NEON.game.restartRace());
await page.evaluate(() => window.__NEON.test.skipCountdown());
const ghostActive = await page.evaluate(() => window.__NEON.game.ghostPlay.active);
check('ghost replays on next run', ghostActive);
await page.waitForTimeout(1200);
await page.screenshot({ path: 'test/artifacts/ghost.png' });

// cross gate 1 → delta appears
await page.evaluate(() => {
  const game = window.__NEON.game;
  const gate = game.track.gates[1];
  game.car.reset(gate.cx - gate.tx * 70, gate.cy - gate.ty * 70, gate.heading);
  game.car.vx = gate.tx * 320;
  game.car.vy = gate.ty * 320;
});
await page.waitForTimeout(450);
const deltaShown = await page.evaluate(() =>
  !document.getElementById('hud-delta').classList.contains('hidden'));
check('delta vs best shows at checkpoints', deltaShown);

check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
