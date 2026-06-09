// PWA validation (dev harness): manifest, icons, service-worker install,
// and the real prize — the game loading fully OFFLINE after first visit.
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { server, url } = await serve(root);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await context.newPage();
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

// manifest + icons reachable and well-formed
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return null;
  const res = await fetch(link.href);
  if (!res.ok) return null;
  return res.json();
});
check('manifest loads and parses', !!manifest && manifest.name === 'NEON DRIFT');
check('manifest has installable icons',
  !!manifest && manifest.icons.length >= 3 && manifest.icons.some(i => i.purpose === 'maskable'));
const iconStatus = await page.evaluate(async () =>
  (await Promise.all([
    fetch('./icons/icon-192.png'), fetch('./icons/icon-512.png'), fetch('./icons/apple-touch-icon.png'),
  ])).map(r => r.status));
check('icon files served', iconStatus.every(s => s === 200), iconStatus.join(','));

// service worker takes control + precaches
await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 })
  .catch(() => {});
const swControlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
check('service worker controls the page', swControlled);
const cached = await page.evaluate(async () => {
  const keys = await caches.keys();
  if (!keys.length) return 0;
  const c = await caches.open(keys[0]);
  return (await c.keys()).length;
});
check('core files precached', cached >= 15, `entries=${cached}`);

// the money shot: cut the network and reload — the game must still boot
await context.setOffline(true);
await page.reload();
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title', null, { timeout: 10000 })
  .catch(() => {});
const offlineBoot = await page.evaluate(() => !!window.__NEON && window.__NEON.state === 'title');
check('game boots fully OFFLINE', offlineBoot);
// drive a few seconds offline for good measure
if (offlineBoot) {
  await page.evaluate(() => window.__NEON.test.start(0, 'time'));
  await page.evaluate(() => window.__NEON.test.skipCountdown());
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1200);
  const speed = await page.evaluate(() => window.__NEON.car.speed);
  check('playable offline', speed > 300, `speed=${speed.toFixed(0)}`);
}
await context.setOffline(false);

// haptics toggle present on touch devices (vibrate API exists in Chromium)
const hapticsBtn = await page.evaluate(() => {
  const el = document.getElementById('set-haptics');
  return el ? el.textContent : null;
});
check('haptics setting wired', hapticsBtn === 'HAPTICS ON' || hapticsBtn === 'HAPTICS OFF', hapticsBtn);

check('zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
