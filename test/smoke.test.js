// ============================================================================
// NEON DRIFT smoke test (dev-only; the shipped game has zero dependencies).
//
//   node test/smoke.test.js   (or: npm test)
//
// Asserts, per the build brief:
//   • page loads with zero console errors (desktop AND mobile viewports)
//   • 10 s of throttle+steering input moves the car > 500 px
//   • measured FPS ≥ 55 with 450+ live particles
//   • menu → race → pause → results clickthrough works
//   • touch layout doesn't overlap the HUD at 390×844
//   • nothing crashes with localStorage disabled
// ============================================================================

import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

const { server, url } = await serve(root);
const browser = await chromium.launch();

// ---------------------------------------------------------------- desktop
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(url);
  await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
  check('desktop: title screen loads', true);

  // menu clickthrough: any key → select → click a track card
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__NEON.state === 'select');
  check('desktop: select screen reached', true);
  await page.click('.track-card');
  await page.waitForFunction(() => window.__NEON.state === 'race');
  check('desktop: race starts from menu', true);
  await page.evaluate(() => window.__NEON.test.skipCountdown());

  // 10 s of throttle + occasional steering — car must cover > 500 px
  const start = await page.evaluate(() => ({ x: window.__NEON.car.x, y: window.__NEON.car.y }));
  await page.keyboard.down('ArrowUp');
  let maxDist = 0;
  const t0 = Date.now();
  let tick = 0;
  while (Date.now() - t0 < 10_000) {
    // brief steering pulses prove input works without spinning circles
    tick++;
    if (tick % 4 === 0) await page.keyboard.down('ArrowLeft');
    else await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(500);
    const c = await page.evaluate(() => ({ x: window.__NEON.car.x, y: window.__NEON.car.y }));
    const d = Math.hypot(c.x - start.x, c.y - start.y);
    if (d > maxDist) maxDist = d;
  }
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('ArrowLeft');
  check('desktop: car moved > 500 px under 10 s of input', maxDist > 500, `dist=${maxDist.toFixed(0)}`);

  // FPS with 450+ live particles + a track of skid marks on screen
  await page.evaluate(() => window.__NEON.test.burstParticles(450));
  const live = await page.evaluate(() => window.__NEON.particlesLive);
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const t = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - t < 4000) requestAnimationFrame(tick);
      else resolve(frames / ((performance.now() - t) / 1000));
    };
    requestAnimationFrame(tick);
  }));
  check('desktop: 450+ particles live', live >= 450, `live=${live}`);
  check('desktop: FPS ≥ 55', fps >= 55, `fps=${fps.toFixed(1)}`);

  // pause → resume → results
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__NEON.state === 'paused');
  check('desktop: pause works', true);
  await page.click('#pause-resume');
  await page.waitForFunction(() => window.__NEON.state === 'race');
  check('desktop: resume works', true);
  await page.evaluate(() => window.__NEON.test.finishRace());
  await page.waitForFunction(() => window.__NEON.state === 'results', null, { timeout: 6000 });
  const resultsVisible = await page.evaluate(() =>
    !document.getElementById('menu-results').classList.contains('hidden'));
  check('desktop: results screen shows', resultsVisible);
  await page.click('#results-menu');
  await page.waitForFunction(() => window.__NEON.state === 'title');
  check('desktop: back to main menu', true);

  check('desktop: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// ---------------------------------------------------------------- mobile
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(url);
  await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');

  // tap through to a race (any tap leaves the title screen)
  await page.touchscreen.tap(195, 420);
  await page.waitForFunction(() => window.__NEON.state === 'select');
  await page.tap('.track-card');
  await page.waitForFunction(() => window.__NEON.state === 'race');
  await page.evaluate(() => window.__NEON.test.skipCountdown());
  await page.waitForTimeout(400);

  // touch controls visible, ≥ 64 px, and clear of the HUD
  const layout = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };
    const left = vis(document.getElementById('btn-left'));
    const right = vis(document.getElementById('btn-right'));
    const brake = vis(document.getElementById('btn-brake'));
    const gas = vis(document.getElementById('btn-gas'));
    const speed = vis(document.getElementById('hud-speed'));
    const lap = vis(document.getElementById('hud-left'));
    const mini = vis(document.getElementById('minimap'));
    return { left, right, brake, gas, speed, lap, mini };
  });
  check('mobile: touch buttons visible', !!(layout.left && layout.right && layout.brake && layout.gas));
  check('mobile: buttons ≥ 64 px', layout.brake.width >= 64 && layout.left.width >= 64 && layout.gas.width >= 64,
    `brake=${layout.brake.width}px gas=${layout.gas.width}px`);
  const overlap = (a, b) => a && b &&
    a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
  const anyOverlap = overlap(layout.brake, layout.speed) || overlap(layout.left, layout.speed) ||
    overlap(layout.brake, layout.mini) || overlap(layout.left, layout.lap) ||
    overlap(layout.gas, layout.speed) || overlap(layout.gas, layout.brake) ||
    overlap(layout.gas, layout.mini);
  check('mobile: touch layout clear of HUD', !anyOverlap);

  // multi-touch: steer while holding handbrake
  await page.touchscreen.tap(60, 800); // press left steer region (sanity)
  const steered = await page.evaluate(() => new Promise((resolve) => {
    const game = window.__NEON.game;
    const down = (id, el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: id, pointerType: 'touch', bubbles: true,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
      }));
    };
    down(11, document.getElementById('btn-brake'));
    down(12, document.getElementById('btn-left'));
    down(13, document.getElementById('btn-gas'));
    setTimeout(() => {
      resolve({ steer: game.input.steer, handbrake: game.input.handbrake, gas: game.input.touch.gas });
    }, 80);
  }));
  check('mobile: steer + handbrake + gas all held (multi-touch)',
    steered.steer === -1 && steered.handbrake === true && steered.gas === true,
    `steer=${steered.steer} hb=${steered.handbrake} gas=${steered.gas}`);

  check('mobile: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// ------------------------------------------------- localStorage disabled
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__NEON.state === 'select');
  await page.click('.track-card');
  await page.waitForFunction(() => window.__NEON.state === 'race');
  await page.evaluate(() => window.__NEON.test.skipCountdown());
  await page.evaluate(() => window.__NEON.test.finishRace());
  await page.waitForFunction(() => window.__NEON.state === 'results', null, { timeout: 6000 });
  check('no-storage: full flow works with localStorage disabled', true);
  check('no-storage: zero console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
