import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { server, url } = await serve(root);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
await page.evaluate(() => window.__NEON.test.start(0, 'gp'));
await page.evaluate(() => window.__NEON.test.skipCountdown());
console.log('racers at start:', await page.evaluate(() => window.__NEON.racers.length));
// let AI drive for 6 seconds
await page.waitForTimeout(6000);
const st = await page.evaluate(() => {
  const rs = window.__NEON.racers;
  return rs.map(r => ({ name:r.name, place:r.place, lap:r.lap, idx:r.idx,
    x:Math.round(r.car.x), y:Math.round(r.car.y), spd:Math.round(r.car.speed) }));
});
console.log('after 6s:');
for (const r of st) console.log(' ', JSON.stringify(r));
await page.screenshot({ path: 'test/artifacts/gp.png' });
console.log('console errors:', errors.length ? errors.slice(0,5) : 'none');
await browser.close();
server.close();
