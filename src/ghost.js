// ============================================================================
// Ghost recording / playback / persistence.
//
// While racing, (x, y, heading) is sampled at GHOST.SAMPLE_HZ into flat
// arrays. On a new best Time Trial the run is saved via storage as integers
// (x·10, y·10, heading·100 — i.e. 1 decimal of px, 2 of rad). If a long run
// would exceed the size budget, every other sample is dropped before saving;
// playback interpolates, so a 15 Hz ghost still glides.
// ============================================================================

import { CONFIG } from './config.js';
import { storage } from './storage.js';

const G = CONFIG.GHOST;

export class GhostRecorder {
  constructor() {
    this.xs = [];
    this.ys = [];
    this.hs = [];
    this._acc = 0;
    this.recording = false;
  }

  start() {
    this.xs.length = 0;
    this.ys.length = 0;
    this.hs.length = 0;
    this._acc = 0;
    this.recording = true;
  }

  stop() { this.recording = false; }

  // call every physics step with the race-time step
  sample(dt, car) {
    if (!this.recording) return;
    this._acc += dt;
    const period = 1 / G.SAMPLE_HZ;
    while (this._acc >= period) {
      this._acc -= period;
      this.xs.push(Math.round(car.x * 10));
      this.ys.push(Math.round(car.y * 10));
      this.hs.push(Math.round(car.heading * 100));
    }
  }

  // pack for storage, downsampling until under the byte budget
  toData() {
    let xs = this.xs, ys = this.ys, hs = this.hs, hz = G.SAMPLE_HZ;
    let json = JSON.stringify({ hz, xs, ys, hs });
    while (json.length > G.MAX_BYTES && xs.length > 2) {
      const half = (arr) => arr.filter((_, i) => i % 2 === 0);
      xs = half(xs); ys = half(ys); hs = half(hs);
      hz = hz / 2;
      json = JSON.stringify({ hz, xs, ys, hs });
    }
    return { hz, xs, ys, hs };
  }
}

export class GhostPlayer {
  constructor() {
    this.data = null;
    this.n = 0;
  }

  load(data) {
    if (!data || !data.xs || data.xs.length < 2 ||
        data.xs.length !== data.ys.length || data.xs.length !== data.hs.length) {
      this.data = null; this.n = 0;
      return false;
    }
    this.data = data;
    this.n = data.xs.length;
    return true;
  }

  get active() { return this.n > 1; }

  // pose at race-time t (seconds), interpolated; out = {x, y, heading, done}
  poseAt(t, out) {
    const d = this.data;
    const ft = t * d.hz;
    let i = Math.floor(ft);
    if (i < 0) i = 0;
    out.done = i >= this.n - 1;
    if (out.done) i = this.n - 2;
    const k = out.done ? 1 : ft - i;
    out.x = (d.xs[i] + (d.xs[i + 1] - d.xs[i]) * k) / 10;
    out.y = (d.ys[i] + (d.ys[i + 1] - d.ys[i]) * k) / 10;
    // headings are small ints (rad·100); lerp through the wrap
    let a = d.hs[i], b = d.hs[i + 1];
    let diff = b - a;
    if (diff > 314) diff -= 628;
    else if (diff < -314) diff += 628;
    out.heading = (a + diff * k) / 100;
    return out;
  }
}

export function saveGhost(trackId, recorder) {
  try {
    storage.set(`ghost.${trackId}`, recorder.toData());
  } catch (e) { /* quota — ghost is a luxury, never crash */ }
}

export function loadGhost(trackId) {
  return storage.get(`ghost.${trackId}`, null);
}
