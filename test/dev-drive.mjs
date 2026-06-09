// Dev harness (not the smoke test): loads the game headless, drives the car,
// prints physics telemetry, captures screenshots into test/artifacts/.
// Usage: node test/dev-drive.mjs [trackIndex]
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'test/artifacts'), { recursive: true });
const { server, url } = await serve(root);
const trackIndex = Number(process.argv[2] || 0);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url);
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
await page.screenshot({ path: 'test/artifacts/title.png' });

// into the race
await page.evaluate((i) => window.__NEON.test.start(i, 'time'), trackIndex);
await page.waitForTimeout(150);
await page.evaluate(() => window.__NEON.test.skipCountdown());

// telemetry helper
const sample = () => page.evaluate(() => {
  const c = window.__NEON.car;
  return {
    x: +c.x.toFixed(1), y: +c.y.toFixed(1),
    speed: +c.speed.toFixed(1), vF: +c.vF.toFixed(1),
    slip: +(c.slip * 180 / Math.PI).toFixed(1),
    drifting: c.drifting, heading: +(c.heading * 180 / Math.PI).toFixed(1),
    fps: +window.__NEON.fpsAvg.toFixed(1),
  };
});

// 1) acceleration run: hold throttle, log speed each 0.3 s
console.log('--- acceleration ---');
await page.keyboard.down('ArrowUp');
for (let t = 0.3; t <= 2.4; t += 0.3) {
  await page.waitForTimeout(300);
  const s = await sample();
  console.log(`t=${t.toFixed(1)}s speed=${s.speed} slip=${s.slip}`);
}

// 2) corner: steer hard left while on throttle
console.log('--- steady steer ---');
await page.keyboard.down('ArrowLeft');
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(250);
  const s = await sample();
  console.log(`speed=${s.speed} slip=${s.slip} drift=${s.drifting} fps=${s.fps}`);
}
await page.screenshot({ path: 'test/artifacts/corner.png' });

// 3) handbrake drift entry + counter-steer catch
console.log('--- handbrake drift ---');
await page.keyboard.down('Space');
await page.waitForTimeout(450);
let s = await sample();
console.log(`pull: speed=${s.speed} slip=${s.slip} drift=${s.drifting}`);
await page.keyboard.up('Space');
await page.keyboard.up('ArrowLeft');
await page.keyboard.down('ArrowRight'); // counter-steer
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(250);
  s = await sample();
  console.log(`catch: speed=${s.speed} slip=${s.slip} drift=${s.drifting}`);
}
await page.keyboard.up('ArrowRight');
await page.screenshot({ path: 'test/artifacts/drift.png' });
await page.keyboard.up('ArrowUp');

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
server.close();
