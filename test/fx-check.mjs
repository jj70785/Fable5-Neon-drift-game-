// FX validation (dev harness): smoke/skids during a drift, sparks on a wall
// hit, confetti + slow-mo on finish, and FPS with 450+ live particles.
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
await page.evaluate(() => window.__NEON.test.start(0, 'drift'));
await page.evaluate(() => window.__NEON.test.skipCountdown());
const place = (x, y, hdg, vx = 0, vy = 0) =>
  page.evaluate(([a, b, c, d, e]) => window.__NEON.test.setCar(a, b, c, d, e), [x, y, hdg, vx, vy]);

// drift on the bottom straight: smoke + skid marks
await place(-1050, 1000, 0, 430, 0);
await page.keyboard.down('ArrowUp');
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('Space');
await page.waitForTimeout(260);
await page.keyboard.up('Space');
await page.waitForTimeout(450);
const parts = await page.evaluate(() => window.__NEON.particlesLive);
check('smoke particles alive during drift', parts > 20, `live=${parts}`);
await page.screenshot({ path: 'test/artifacts/fx-drift.png' });
await page.keyboard.up('ArrowLeft');
await page.keyboard.up('ArrowUp');

// wall hit: sparks
await place(-700, 980, Math.PI / 2, 0, 540);
await page.waitForTimeout(120);
await page.screenshot({ path: 'test/artifacts/fx-sparks.png' });
const sparks = await page.evaluate(() => window.__NEON.particlesLive);
check('sparks spawn on impact', sparks > 5, `live=${sparks}`);

// finish: confetti + slow-mo
await place(-400, 1000, 0, 300, 0);
await page.evaluate(() => window.__NEON.test.finishRace());
await page.waitForTimeout(180);
await page.screenshot({ path: 'test/artifacts/fx-finish.png' });
const confetti = await page.evaluate(() => window.__NEON.particlesLive);
check('confetti bursts on finish', confetti > 100, `live=${confetti}`);

// FPS with 450+ particles (counts real animation frames over 3s)
await page.evaluate(() => window.__NEON.test.burstParticles(450));
const live = await page.evaluate(() => window.__NEON.particlesLive);
const fps = await page.evaluate(() => new Promise((resolve) => {
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
    else resolve(frames / ((performance.now() - t0) / 1000));
  };
  requestAnimationFrame(tick);
}));
check('455+ particles live', live >= 450, `live=${live}`);
console.log(`fps with ${live} particles (headless software rendering) = ${fps.toFixed(1)}`);
check('fps >= 55 with 450+ particles', fps >= 55, `fps=${fps.toFixed(1)}`);

check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
