// Render profiling (dev harness): measure FPS with layers selectively
// disabled to find software-rendering bottlenecks.
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { server, url } = await serve(root);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url);
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
await page.evaluate(() => window.__NEON.test.start(0, 'drift'));
await page.evaluate(() => window.__NEON.test.skipCountdown());
await page.evaluate(([x, y]) => window.__NEON.test.setCar(x, y, 0, 300, 0), [-1050, 1000]);
await page.keyboard.down('ArrowUp');
await page.evaluate(() => window.__NEON.test.burstParticles(450));

const fps = () => page.evaluate(() => new Promise((resolve) => {
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
    else resolve(+(frames / ((performance.now() - t0) / 1000)).toFixed(1));
  };
  requestAnimationFrame(tick);
}));

console.log('baseline           ', await fps());

await page.evaluate(() => { document.getElementById('ui-root').style.display = 'none'; });
console.log('no DOM ui/vignette ', await fps());
await page.evaluate(() => { document.getElementById('ui-root').style.display = ''; });

await page.evaluate(() => { const g = window.__NEON.game; g._noStars = true; g._origRW = g.renderWorld; });
// patch layers via wrappers
await page.evaluate(() => {
  const g = window.__NEON.game;
  g._drawGridOrig = g._drawGrid; g._drawGrid = () => {};
});
console.log('no grid            ', await fps());
await page.evaluate(() => { const g = window.__NEON.game; g._drawGrid = g._drawGridOrig; });

await page.evaluate(() => {
  const g = window.__NEON.game;
  g._strokeChunksOrig = g._strokeChunks; g._strokeChunks = () => {};
});
console.log('no edge strokes    ', await fps());
await page.evaluate(() => { const g = window.__NEON.game; g._strokeChunks = g._strokeChunksOrig; });

await page.evaluate(() => {
  const g = window.__NEON.game;
  g.track._drawBaseOrig = g.track.drawBase; g.track.drawBase = () => {};
});
console.log('no track base blit ', await fps());
await page.evaluate(() => { const g = window.__NEON.game; g.track.drawBase = g.track._drawBaseOrig; });

await page.evaluate(() => {
  const g = window.__NEON.game;
  g.skids._drawOrig = g.skids.draw; g.skids.draw = () => {};
});
console.log('no skid blit       ', await fps());
await page.evaluate(() => { const g = window.__NEON.game; g.skids.draw = g.skids._drawOrig; });

await page.evaluate(() => {
  const g = window.__NEON.game;
  g.particles._upOrig = g.particles.drawUnder; g.particles._ovOrig = g.particles.drawOver;
  g.particles.drawUnder = () => {}; g.particles.drawOver = () => {};
});
console.log('no particles       ', await fps());
await page.evaluate(() => {
  const g = window.__NEON.game;
  g.particles.drawUnder = g.particles._upOrig; g.particles.drawOver = g.particles._ovOrig;
});

await page.evaluate(() => {
  const g = window.__NEON.game;
  g._starOrig = g.starPattern;
  // replace pattern fill with plain color fill
  g.starPattern = '#070b1f';
});
console.log('no star pattern    ', await fps());

await browser.close();
server.close();
