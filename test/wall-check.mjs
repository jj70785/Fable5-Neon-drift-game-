// Wall-punishment validation: scraping along a wall murders your speed, but
// open-road driving is completely unaffected (no phantom friction).
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

const car = () => page.evaluate(() => window.__NEON.car.speed);
const place = (x, y, hdg, vx = 0, vy = 0) =>
  page.evaluate(([a, b, c, d, e]) => window.__NEON.test.setCar(a, b, c, d, e), [x, y, hdg, vx, vy]);
const releaseAll = async () => {
  for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']) await page.keyboard.up(k);
};

// 1. control: open road still reaches full speed (change must not slow normal driving)
await place(-900, 2600, 0, 0, 0);   // open space south of the track
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(1800);
const open = await car();
await releaseAll();
check('open-road driving is unaffected', open > 480, `speed=${open.toFixed(0)}`);

// 2. wall-ride: floor it while steering INTO the outer wall — speed should be
// crushed far below open-road pace instead of carrying through
await place(-700, 1076, 0, 400, 0);   // just inside the bottom-straight outer wall
await page.keyboard.down('ArrowUp');
await page.keyboard.down('ArrowRight'); // steer into the wall (+y side)
for (let i = 0; i < 14; i++) await page.waitForTimeout(80);
const ride = await car();
await releaseAll();
check('wall-riding crushes your speed', ride < 300 && ride < open - 200,
  `ride=${ride.toFixed(0)} (open=${open.toFixed(0)})`);
check('wall-riding is slow but not a dead stop (no glue)', ride > 60,
  `ride=${ride.toFixed(0)}`);

// 3. a brief glancing tap is NOT catastrophic (one contact, keep most speed)
await place(-700, 1020, 0, 460, 0);   // mid-road, angled at the wall
await page.keyboard.down('ArrowUp');
await page.evaluate(() => { window.__NEON.car.vy = 150; }); // nudge toward wall once
await page.waitForTimeout(120);
const tap = await car();
await releaseAll();
check('a glancing tap keeps most speed', tap > 300, `speed=${tap.toFixed(0)}`);

check('wall: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
