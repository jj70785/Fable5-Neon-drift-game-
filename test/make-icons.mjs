// Generates PWA icons by rendering the NEON DRIFT mark on a headless canvas
// (dev-only; keeps the "all graphics are procedural" rule even for metadata).
//   node test/make-icons.mjs
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'icons'), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });

const drawIcon = (size, pad) => page.evaluate(([S, PAD]) => {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');

  // backdrop
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, '#0a0f2e');
  bg.addColorStop(1, '#070b1f');
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);

  // perspective grid floor
  const horizon = S * 0.62;
  g.strokeStyle = 'rgba(0,240,255,0.30)';
  g.lineWidth = S * 0.006;
  g.beginPath();
  for (let i = -8; i <= 8; i++) {
    g.moveTo(S / 2 + i * S * 0.018, horizon);
    g.lineTo(S / 2 + i * S * 0.16, S * 1.05);
  }
  g.stroke();
  for (let r = 0; r < 5; r++) {
    const y = horizon + (S - horizon) * (r * r) / 20;
    g.globalAlpha = 0.5 - r * 0.08;
    g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke();
  }
  g.globalAlpha = 1;

  // sun
  const sr = S * 0.30;
  const sun = g.createLinearGradient(0, horizon - sr, 0, horizon + sr * 0.2);
  sun.addColorStop(0, '#ffe14d');
  sun.addColorStop(0.6, '#ff8a3d');
  sun.addColorStop(1, '#ff2d95');
  g.save();
  g.beginPath();
  g.arc(S / 2, horizon - sr * 0.12, sr, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = sun;
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#070b1f';
  for (let i = 0; i < 4; i++) {
    g.fillRect(0, horizon - sr * 0.12 + i * sr * 0.22, S, (1 + i) * S * 0.008);
  }
  g.restore();

  // car wedge with glow, scaled into the padded square
  const k = (S * (1 - PAD * 2)) / 100;
  g.save();
  g.translate(S / 2, S * 0.66);
  g.rotate(-Math.PI / 2);            // nose up
  g.scale(k * 1.45, k * 1.45);
  const glow = g.createRadialGradient(0, 0, 2, 0, 0, 30);
  glow.addColorStop(0, 'rgba(0,240,255,0.65)');
  glow.addColorStop(1, 'rgba(0,240,255,0)');
  g.fillStyle = glow;
  g.fillRect(-32, -32, 64, 64);
  g.beginPath();
  g.moveTo(21, 0); g.lineTo(13, -7.5); g.lineTo(-13, -10.5); g.lineTo(-17, -6.5);
  g.lineTo(-17, 6.5); g.lineTo(-13, 10.5); g.lineTo(13, 7.5);
  g.closePath();
  const paint = g.createLinearGradient(21, 0, -17, 0);
  paint.addColorStop(0, '#fdffff');
  paint.addColorStop(0.45, '#c9f4ff');
  paint.addColorStop(1, '#8fb6e8');
  g.fillStyle = paint;
  g.fill();
  g.strokeStyle = 'rgba(0,240,255,0.95)';
  g.lineWidth = 1.6;
  g.stroke();
  g.fillStyle = '#0b1736';
  g.beginPath();
  g.moveTo(7, 0); g.lineTo(1, -5); g.lineTo(-8, -6); g.lineTo(-8, 6); g.lineTo(1, 5);
  g.closePath(); g.fill();
  g.fillStyle = '#ff2d95';
  g.fillRect(-17.4, -7.5, 2.2, 15);
  g.restore();

  return c.toDataURL('image/png');
}, [size, pad]);

const save = async (name, dataUrl) => {
  const b64 = dataUrl.split(',')[1];
  await writeFile(join(root, 'icons', name), Buffer.from(b64, 'base64'));
  console.log('wrote icons/' + name);
};

await save('icon-512.png', await drawIcon(512, 0.04));
await save('icon-192.png', await drawIcon(192, 0.04));
await save('icon-maskable-512.png', await drawIcon(512, 0.16)); // safe-zone padding
await save('apple-touch-icon.png', await drawIcon(180, 0.06));

await browser.close();
