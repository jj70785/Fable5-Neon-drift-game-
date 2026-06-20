// ============================================================================
// Nitro: drift to fill the bar, spend it for a forward speed burst.
//
// Mirrors DriftScore's shape (a tiny state machine the game steps each tick).
// The fill rate is driven by the same drift intensity the smoke/skid systems
// use (slip × speed while drifting), so the reward is "slide well, go faster"
// — which finally gives drifting a job in Grand Prix and Time Trial.
//
// `step` returns the extra forward force to feed into Car.step this tick
// (0 when not boosting), so physics stays the single source of truth.
// ============================================================================

import { CONFIG } from './config.js';

const N = CONFIG.NITRO;

export class Nitro {
  constructor() { this.reset(); }

  reset() {
    this.charge = 0;        // 0..1
    this.active = false;    // currently firing?
    this.justFired = false; // edge flag (read by the game for sfx/vfx)
  }

  // dt: physics step; car: the player car; want: nitro button/key held.
  // returns the forward boost force (px/s²) to apply this tick.
  step(dt, car, want) {
    this.justFired = false;

    // ---- fill while drifting (same intensity as smoke/skids) ----
    if (car.drifting && car.speed > 90) {
      const intensity = clamp(Math.abs(car.slip) / 0.55, 0, 1) * clamp(car.speed / 320, 0, 1);
      this.charge = Math.min(1, this.charge + N.FILL_RATE * intensity * dt);
    }

    // ---- spend ----
    if (this.active) {
      if (!want || this.charge <= 0) {
        this.active = false;
      } else {
        this.charge = Math.max(0, this.charge - N.DRAIN * dt);
        if (this.charge <= 0) this.active = false;
      }
    } else if (want && this.charge >= N.MIN_FIRE) {
      this.active = true;
      this.justFired = true;
    }

    if (!this.active) return 0;

    // taper the force off near the nitro top speed so it doesn't run away
    const head = (N.MAX - car.speed) / 60;
    return N.FORCE * clamp(head, 0, 1);
  }

  // for the spin move later: a one-shot top-up (see docs/SPIN-MOVE.md)
  add(amount) { this.charge = clamp(this.charge + amount, 0, 1); }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
