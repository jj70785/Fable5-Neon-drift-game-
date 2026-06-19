// ============================================================================
// Pooled particle system: tire smoke, wall sparks, finish confetti.
// Every particle object is allocated once at boot; the hot loop never
// allocates. Smoke uses pre-rendered radial-gradient sprites (no shadowBlur),
// sparks are additive line streaks, confetti are rotating rects.
// ============================================================================

import { CONFIG } from './config.js';

const TYPE_SMOKE = 0, TYPE_SPARK = 1, TYPE_CONFETTI = 2;
const CONFETTI_COLORS = ['#00f0ff', '#ff2d95', '#ffe14d', '#f4f7ff', '#7c4dff'];

function makeSmokeSprite(size, inner, outer) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 1, r, r, r);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.6, outer);
  grad.addColorStop(1, 'rgba(120,140,190,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export class Particles {
  constructor() {
    const N = CONFIG.FX.POOL_SIZE;
    this.n = N;
    this.live = 0;
    // struct-of-arrays: cheap iteration, zero per-particle objects
    this.type = new Uint8Array(N);
    this.x = new Float32Array(N);
    this.y = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vy = new Float32Array(N);
    this.life = new Float32Array(N);
    this.maxLife = new Float32Array(N);
    this.size = new Float32Array(N);
    this.rot = new Float32Array(N);
    this.vr = new Float32Array(N);
    this.color = new Uint8Array(N);
    this.tint = new Uint8Array(N);     // 0 = tyre smoke, 1 = mud spray

    this.smokeSprite = makeSmokeSprite(64, 'rgba(190,205,235,0.50)', 'rgba(140,160,205,0.22)');
    this.mudSprite = makeSmokeSprite(64, 'rgba(120,92,50,0.62)', 'rgba(80,60,32,0.30)');
    this.confettiStyles = CONFETTI_COLORS;
    this._emitAcc = 0;  // fractional emission accumulator (tyre smoke)
    this._surfAcc = 0;  // fractional emission accumulator (surface fx)
  }

  clear() { this.live = 0; }

  _spawn() {
    if (this.live >= this.n) return -1;   // pool exhausted: drop newest
    return this.live++;
  }

  _kill(i) {
    const last = --this.live;             // swap-with-last keeps arrays dense
    if (i !== last) {
      this.type[i] = this.type[last];
      this.x[i] = this.x[last]; this.y[i] = this.y[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
      this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
      this.size[i] = this.size[last];
      this.rot[i] = this.rot[last]; this.vr[i] = this.vr[last];
      this.color[i] = this.color[last];
      this.tint[i] = this.tint[last];
    }
  }

  // tire smoke from a wheel; intensity 0..1 scales density
  emitSmoke(x, y, baseVx, baseVy, intensity, dt) {
    this._emitAcc += CONFIG.FX.SMOKE_RATE * intensity * dt;
    while (this._emitAcc >= 1) {
      this._emitAcc -= 1;
      const i = this._spawn();
      if (i < 0) return;
      this.type[i] = TYPE_SMOKE;
      this.tint[i] = 0;
      this.x[i] = x + (Math.random() - 0.5) * 6;
      this.y[i] = y + (Math.random() - 0.5) * 6;
      this.vx[i] = baseVx * 0.25 + (Math.random() - 0.5) * 60;
      this.vy[i] = baseVy * 0.25 + (Math.random() - 0.5) * 60;
      this.maxLife[i] = this.life[i] = CONFIG.FX.SMOKE_LIFE * (0.7 + Math.random() * 0.6);
      this.size[i] = 9 + Math.random() * 8;
      this.rot[i] = Math.random() * 6.28;
      this.vr[i] = (Math.random() - 0.5) * 2;
    }
  }

  // surface effects: mud spray (brown puffs) or ice frost (cyan glints)
  emitSurface(type, x, y, baseVx, baseVy, dt) {
    this._surfAcc += CONFIG.SURFACE.FX_RATE * dt;
    while (this._surfAcc >= 1) {
      this._surfAcc -= 1;
      const i = this._spawn();
      if (i < 0) return;
      if (type === 'mud') {
        this.type[i] = TYPE_SMOKE; this.tint[i] = 1;
        this.x[i] = x + (Math.random() - 0.5) * 8;
        this.y[i] = y + (Math.random() - 0.5) * 8;
        this.vx[i] = -baseVx * 0.18 + (Math.random() - 0.5) * 130;
        this.vy[i] = -baseVy * 0.18 + (Math.random() - 0.5) * 130;
        this.maxLife[i] = this.life[i] = 0.5 * (0.7 + Math.random() * 0.6);
        this.size[i] = 4 + Math.random() * 5;
        this.rot[i] = 0; this.vr[i] = 0;
      } else { // ice frost
        this.type[i] = TYPE_SPARK; this.tint[i] = 0;
        this.x[i] = x; this.y[i] = y;
        const a = Math.random() * 6.28, sp = 60 + Math.random() * 170;
        this.vx[i] = Math.cos(a) * sp + baseVx * 0.1;
        this.vy[i] = Math.sin(a) * sp + baseVy * 0.1;
        this.maxLife[i] = this.life[i] = 0.4 * (0.6 + Math.random() * 0.7);
        this.size[i] = 1.2 + Math.random() * 1.6;
        this.color[i] = 2; // cyan frost
      }
    }
  }

  // sparks on wall scrape: n bursts along the wall normal
  emitSparks(x, y, nx, ny, impact) {
    const count = Math.min(26, 4 + Math.floor(impact / 45));
    for (let k = 0; k < count; k++) {
      const i = this._spawn();
      if (i < 0) return;
      this.type[i] = TYPE_SPARK;
      this.x[i] = x; this.y[i] = y;
      // fan out around the normal
      const a = Math.atan2(ny, nx) + (Math.random() - 0.5) * 2.4;
      const sp = 120 + Math.random() * (220 + impact * 0.5);
      this.vx[i] = Math.cos(a) * sp;
      this.vy[i] = Math.sin(a) * sp;
      this.maxLife[i] = this.life[i] = CONFIG.FX.SPARK_LIFE * (0.5 + Math.random() * 0.8);
      this.size[i] = 1.5 + Math.random() * 2;
      this.color[i] = Math.random() < 0.6 ? 0 : 1; // yellow / white
    }
  }

  // celebration burst at the finish line
  emitConfetti(x, y) {
    for (let k = 0; k < CONFIG.FX.CONFETTI_COUNT; k++) {
      const i = this._spawn();
      if (i < 0) return;
      this.type[i] = TYPE_CONFETTI;
      const a = Math.random() * 6.28;
      const sp = 90 + Math.random() * 420;
      this.x[i] = x + (Math.random() - 0.5) * 30;
      this.y[i] = y + (Math.random() - 0.5) * 30;
      this.vx[i] = Math.cos(a) * sp;
      this.vy[i] = Math.sin(a) * sp - 120;
      this.maxLife[i] = this.life[i] = 1.3 + Math.random() * 1.2;
      this.size[i] = 3.5 + Math.random() * 4;
      this.rot[i] = Math.random() * 6.28;
      this.vr[i] = (Math.random() - 0.5) * 14;
      this.color[i] = (Math.random() * CONFETTI_COLORS.length) | 0;
    }
  }

  update(dt) {
    for (let i = this.live - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this._kill(i); continue; }
      const t = this.type[i];
      if (t === TYPE_SMOKE) {
        this.vx[i] *= 1 - 1.8 * dt;
        this.vy[i] *= 1 - 1.8 * dt;
        this.size[i] += 26 * dt;          // smoke billows out
      } else if (t === TYPE_SPARK) {
        this.vx[i] *= 1 - 3.4 * dt;
        this.vy[i] *= 1 - 3.4 * dt;
      } else {
        this.vx[i] *= 1 - 1.1 * dt;
        this.vy[i] = this.vy[i] * (1 - 1.1 * dt) + 360 * dt; // confetti falls
        this.rot[i] += this.vr[i] * dt;
      }
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
    }
  }

  // smoke renders under the car; sparks/confetti above it
  drawUnder(ctx) {
    for (let i = 0; i < this.live; i++) {
      if (this.type[i] !== TYPE_SMOKE) continue;
      const k = this.life[i] / this.maxLife[i];
      ctx.globalAlpha = k * 0.55;
      const s = this.size[i] * 2;
      const sprite = this.tint[i] === 1 ? this.mudSprite : this.smokeSprite;
      ctx.drawImage(sprite, this.x[i] - s / 2, this.y[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  drawOver(ctx) {
    // sparks: additive streaks
    let any = false;
    for (let i = 0; i < this.live; i++) {
      if (this.type[i] !== TYPE_SPARK) continue;
      if (!any) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; any = true; }
      const k = this.life[i] / this.maxLife[i];
      ctx.strokeStyle = this.color[i] === 0
        ? `rgba(255,225,77,${(k).toFixed(3)})`
        : this.color[i] === 2
          ? `rgba(150,235,255,${(k).toFixed(3)})`
          : `rgba(255,255,255,${(k).toFixed(3)})`;
      ctx.lineWidth = this.size[i];
      ctx.beginPath();
      ctx.moveTo(this.x[i], this.y[i]);
      ctx.lineTo(this.x[i] - this.vx[i] * 0.035, this.y[i] - this.vy[i] * 0.035);
      ctx.stroke();
    }
    if (any) ctx.restore();

    // confetti: tumble is faked by squashing width with cos(rot); batched by
    // (color, alpha-bucket) so canvas state changes are O(15), not O(n) —
    // per-particle fillStyle/globalAlpha churn is what kills software rendering
    for (let c = 0; c < this.confettiStyles.length; c++) {
      let styleSet = false;
      for (let bucket = 3; bucket >= 1; bucket--) {
        let alphaSet = false;
        for (let i = 0; i < this.live; i++) {
          if (this.type[i] !== TYPE_CONFETTI || this.color[i] !== c) continue;
          const k = Math.min(1, (this.life[i] / this.maxLife[i]) * 2);
          const b = k > 0.8 ? 3 : k > 0.45 ? 2 : 1;
          if (b !== bucket) continue;
          if (!styleSet) { ctx.fillStyle = this.confettiStyles[c]; styleSet = true; }
          if (!alphaSet) { ctx.globalAlpha = bucket / 3; alphaSet = true; }
          const s = this.size[i];
          const wob = Math.abs(Math.cos(this.rot[i])) * 0.8 + 0.2;
          ctx.fillRect(this.x[i] - (s * wob) / 2, this.y[i] - s / 4, s * wob, s / 2);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}
