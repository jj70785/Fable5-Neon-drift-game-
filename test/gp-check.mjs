// Grand Prix validation: the field spawns, rivals drive themselves and make
// progress, positions resolve to a clean 1..4 ranking, and a completed race
// reaches a podium with standings and a saved best finish.
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
await page.evaluate(() => window.__NEON.test.start(0, 'gp'));
await page.evaluate(() => window.__NEON.test.skipCountdown());

check('field has player + 3 rivals', await page.evaluate(() => window.__NEON.racers.length) === 4);

// let the rivals drive for a few seconds, then check they made progress + rank
await page.waitForTimeout(4000);
const mid = await page.evaluate(() => {
  const rs = window.__NEON.racers;
  return {
    aiMaxIdx: Math.max(...rs.filter((r) => !r.isPlayer).map((r) => r.idx)),
    places: rs.map((r) => r.place).slice().sort(),
    aiSpeeds: rs.filter((r) => !r.isPlayer).map((r) => Math.round(r.car.speed)),
  };
});
check('rivals drive the racing line', mid.aiMaxIdx > 60, `aiMaxIdx=${mid.aiMaxIdx}`);
check('rivals are actually moving', mid.aiSpeeds.every((s) => s > 120), `speeds=${mid.aiSpeeds}`);
check('positions are a clean 1..4', JSON.stringify(mid.places) === '[1,2,3,4]', `places=${mid.places}`);
await page.screenshot({ path: 'test/artifacts/gp-race.png' });

// drive the PLAYER through every gate in order to finish the (1-lap) race
const gateCount = await page.evaluate(() => window.__NEON.game.track.gates.length);
const order = [];
for (let g = 1; g < gateCount; g++) order.push(g);
order.push(0);
for (const g of order) {
  await page.evaluate((gi) => {
    const game = window.__NEON.game;
    const gate = game.track.gates[gi];
    const car = game.car;             // the player's car (always)
    car.reset(gate.cx - gate.tx * 80, gate.cy - gate.ty * 80, gate.heading);
    car.vx = gate.tx * 340; car.vy = gate.ty * 340;
  }, g);
  await page.waitForTimeout(360);
}

await page.waitForFunction(() => window.__NEON.state === 'results', null, { timeout: 6000 });
const res = await page.evaluate(() => {
  const r = window.__NEON.game.race;
  return {
    place: r.place,
    standings: r.standings ? r.standings.length : 0,
    saved: window.localStorage.getItem(`neondrift.gp.sunset.v${window.__NEON.config.SAVE_VERSION}`),
    resultsVisible: !document.getElementById('menu-results').classList.contains('hidden'),
  };
});
check('player finishes with a valid place', res.place >= 1 && res.place <= 4, `place=${res.place}`);
check('podium shows full 4-car standings', res.standings === 4, `standings=${res.standings}`);
check('best finish persisted', !!res.saved, `saved=${res.saved}`);
check('results screen visible', res.resultsVisible);
check('grand prix: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
