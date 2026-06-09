// ============================================================================
// Persistent skid marks.
//
// Rubber is stamped onto an offscreen canvas covering the track bounds at
// reduced resolution; it never clears during a race, so a full session of
// rubber builds up for free — drawing it back is a single drawImage of the
// visible region. Fresh marks also live in a small ring buffer that is
// drawn with an additive neon glow which fades over GLOW_TIME seconds.
// ============================================================================

import { CONFIG } from './config.js';

const K = CONFIG.SKID;

export class SkidMarks {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.scale = K.CANVAS_SCALE;
    this.bounds = null;
    // fresh-glow ring buffer (flat arrays, allocated once)
    const G = K.GLOW_SEGMENTS;
    this.gN = G;
    this.gx1 = new Float32Array(G); this.gy1 = new Float32Array(G);
    this.gx2 = new Float32Array(G); this.gy2 = new Float32Array(G);
    this.gAge = new Float32Array(G).fill(99);
    this.gHead = 0;
    // previous wheel positions (per wheel id 0/1)
    this.prev = [{ x: 0, y: 0, on: false }, { x: 0, y: 0, on: false }];
  }

  // (re)bind to a track; reallocates only when the track changes
  begin(track) {
    const b = track.bounds;
    if (this.bounds !== b) {
      this.bounds = b;
      const w = Math.ceil((b.maxX - b.minX) * this.scale);
      const h = Math.ceil((b.maxY - b.minY) * this.scale);
      this.canvas = document.createElement('canvas');
      this.canvas.width = w; this.canvas.height = h;
      this.ctx = this.canvas.getContext('2d');
      this.ctx.lineCap = 'round';
    } else {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.ctx.setTransform(this.scale, 0, 0, this.scale, -this.bounds.minX * this.scale, -this.bounds.minY * this.scale);
    this.gAge.fill(99);
    this.prev[0].on = false;
    this.prev[1].on = false;
  }

  // stamp one wheel's movement; wheel = 0|1, intensity 0..1
  stamp(wheel, x, y, intensity, drifting) {
    const p = this.prev[wheel];
    if (!drifting || intensity <= 0) { p.on = false; return; }
    if (p.on) {
      const dx = x - p.x, dy = y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > K.MIN_MOVE * K.MIN_MOVE && d2 < 80 * 80) { // skip teleports & micro-moves
        const g = this.ctx;
        g.strokeStyle = `rgba(8,10,18,${(K.ALPHA * intensity).toFixed(3)})`;
        g.lineWidth = K.WIDTH;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(x, y);
        g.stroke();
        // remember for the fresh neon glow pass
        const h = this.gHead;
        this.gx1[h] = p.x; this.gy1[h] = p.y;
        this.gx2[h] = x; this.gy2[h] = y;
        this.gAge[h] = 0;
        this.gHead = (h + 1) % this.gN;
        p.x = x; p.y = y;
      } else if (d2 >= 80 * 80) {
        p.x = x; p.y = y;                      // respawn jump: restart streak
      }
    } else {
      p.x = x; p.y = y; p.on = true;
    }
  }

  age(dt) {
    for (let i = 0; i < this.gN; i++) {
      if (this.gAge[i] < K.GLOW_TIME) this.gAge[i] += dt;
    }
  }

  // blit the visible part of the rubber canvas (world-space ctx)
  draw(ctx, left, top, right, bottom) {
    if (!this.canvas) return;
    const b = this.bounds, s = this.scale;
    const x0 = Math.max(left, b.minX), y0 = Math.max(top, b.minY);
    const x1 = Math.min(right, b.maxX), y1 = Math.min(bottom, b.maxY);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.drawImage(this.canvas,
      (x0 - b.minX) * s, (y0 - b.minY) * s, (x1 - x0) * s, (y1 - y0) * s,
      x0, y0, x1 - x0, y1 - y0);
  }

  // fresh marks get a magenta under-glow that fades out (additive)
  drawGlow(ctx) {
    let any = false;
    for (let i = 0; i < this.gN; i++) {
      const age = this.gAge[i];
      if (age >= K.GLOW_TIME) continue;
      if (!any) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; any = true; }
      const k = 1 - age / K.GLOW_TIME;
      ctx.strokeStyle = `rgba(255,45,149,${(k * 0.30).toFixed(3)})`;
      ctx.lineWidth = K.WIDTH + 2;
      ctx.beginPath();
      ctx.moveTo(this.gx1[i], this.gy1[i]);
      ctx.lineTo(this.gx2[i], this.gy2[i]);
      ctx.stroke();
    }
    if (any) ctx.restore();
  }
}
