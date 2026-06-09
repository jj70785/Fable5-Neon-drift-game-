// Screenshot helper for the polish pass.
import { chromium } from 'playwright';
import { serve } from './server.mjs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'test/artifacts'), { recursive: true });
const { server, url } = await serve(root);
const browser = await chromium.launch();

// desktop title + select + race
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url);
await page.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
await page.waitForTimeout(900);
await page.screenshot({ path: 'test/artifacts/p-title.png' });
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.screenshot({ path: 'test/artifacts/p-select.png' });
await page.evaluate(() => window.__NEON.test.start(1, 'time'));
await page.evaluate(() => window.__NEON.test.skipCountdown());
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(2600);
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('Space');
await page.waitForTimeout(300);
await page.keyboard.up('Space');
await page.waitForTimeout(350);
await page.screenshot({ path: 'test/artifacts/p-race.png' });
await page.close();

// mobile race
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await m.goto(url);
await m.waitForFunction(() => window.__NEON && window.__NEON.state === 'title');
await m.screenshot({ path: 'test/artifacts/p-mobile-title.png' });
await m.evaluate(() => window.__NEON.test.start(0, 'drift'));
await m.evaluate(() => window.__NEON.test.skipCountdown());
await m.waitForTimeout(1500);
await m.screenshot({ path: 'test/artifacts/p-mobile-race.png' });
await m.close();

await browser.close();
server.close();
