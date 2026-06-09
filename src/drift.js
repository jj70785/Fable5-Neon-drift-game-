// ============================================================================
// Drift Attack scoring.
//
// While the car is drifting at speed, points accrue ∝ speed × |slip|.
// A drift that lasts ≥ MIN_DRIFT_TIME banks its points when it ends cleanly.
// Ending a drift and starting another within CHAIN_WINDOW raises the chain
// multiplier (×1 → ×8). Touching a wall mid-drift forfeits the unbanked
// points and resets the multiplier — clean driving is the whole game.
//
// The game layer listens to the event flags set each step (banked/forfeit/
// multUp) to fire popups, HUD punches and audio.
// ============================================================================

import { CONFIG } from './config.js';

const S = CONFIG.SCORE;

export class DriftScore {
  constructor() { this.reset(); }

  reset() {
    this.total = 0;          // banked points
    this.pending = 0;        // accruing, not yet banked
    this.mult = 1;           // chain multiplier ×1..×8
    this.driftTime = 0;      // duration of the current drift
    this.chainTimer = 0;     // time left to chain after a drift ends
    this.active = false;     // currently accruing?
    this.bestChain = 0;      // best single banked amount (for results)

    // per-step event flags (read by the game layer)
    this.banked = 0;         // >0: points banked this step
    this.forfeited = 0;      // >0: points lost this step
    this.multUp = false;     // multiplier increased this step
  }

  // called every physics step in drift mode
  step(dt, car, wallImpact) {
    this.banked = 0;
    this.forfeited = 0;
    this.multUp = false;

    const driftingNow = car.drifting && car.speed > S.MIN_SPEED && Math.abs(car.slip) > S.MIN_SLIP;

    if (this.active) {
      if (wallImpact > 0) {
        // wall contact mid-drift: forfeit the chunk, chain broken
        this.forfeited = this.pending;
        this.pending = 0;
        this.mult = 1;
        this.active = false;
        this.driftTime = 0;
        this.chainTimer = 0;
        return;
      }
      if (driftingNow) {
        this.driftTime += dt;
        this.pending += car.speed * Math.abs(car.slip) * S.RATE * dt;
      } else {
        // drift ended — bank if it was a real drift
        if (this.driftTime >= S.MIN_DRIFT_TIME && this.pending > 0) {
          const points = Math.floor(this.pending * this.mult);
          this.total += points;
          this.banked = points;
          if (points > this.bestChain) this.bestChain = points;
          this.chainTimer = S.CHAIN_WINDOW;
        } else {
          this.pending = 0; // too short to count
        }
        this.pending = 0;
        this.driftTime = 0;
        this.active = false;
      }
    } else {
      if (this.chainTimer > 0) {
        this.chainTimer -= dt;
        if (this.chainTimer <= 0) this.mult = 1; // chain window expired
      }
      if (driftingNow) {
        // new drift begins; if chained, the multiplier climbs
        if (this.chainTimer > 0 && this.mult < S.MULT_MAX) {
          this.mult++;
          this.multUp = true;
        }
        this.chainTimer = 0;
        this.active = true;
        this.driftTime = 0;
        this.pending = 0;
      }
    }
  }

  // bank whatever is pending (clean end of round)
  flush() {
    if (this.active && this.driftTime >= S.MIN_DRIFT_TIME && this.pending > 0) {
      const points = Math.floor(this.pending * this.mult);
      this.total += points;
      this.banked = points;
      if (points > this.bestChain) this.bestChain = points;
    }
    this.pending = 0;
    this.active = false;
  }
}
