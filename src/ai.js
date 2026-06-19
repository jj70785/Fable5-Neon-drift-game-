// ============================================================================
// AI driver for Grand Prix rivals.
//
// Each rival drives a real Car (same physics as the player — fair). The
// controller is pure-pursuit: track the nearest centerline point, aim at a
// lookahead point further along the racing line, and steer toward it. Target
// speed is set by the curvature coming up, so rivals brake for corners and
// floor it on straights. A per-rival skill and a lateral line offset keep
// them from stacking, and the game can nudge `speedScale` for light
// rubber-banding so races stay close and winnable.
// ============================================================================

import { CONFIG } from './config.js';

const TAU = Math.PI * 2;
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export class AIDriver {
  constructor(track, skill, offset) {
    this.track = track;
    this.skill = skill;          // ~0.86..1.04 pace multiplier
    this.offset = offset;        // px lateral racing-line offset
    this.idx = 0;                // nearest centerline index (progress marker)
    this.speedScale = 1;         // rubber-band multiplier (set by the game)
    this._c = { steer: 0, throttle: 0, brake: 0, handbrake: false };
  }

  reset(idx) { this.idx = idx | 0; this.speedScale = 1; }

  // advance idx to the nearest centerline point in a forward window
  _progress(car) {
    const t = this.track, n = t.n;
    let best = this.idx, bd = 1e18;
    for (let k = -2; k < 26; k++) {
      const i = (this.idx + k + n) % n;
      const dx = t.cx[i] - car.x, dy = t.cy[i] - car.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    this.idx = best;
  }

  // signed curvature magnitude (rad/px) over a span around index i
  _curvature(i, span) {
    const t = this.track, n = t.n;
    const a = (i - span + n) % n, b = (i + span) % n;
    let da = Math.atan2(t.ty[b], t.tx[b]) - Math.atan2(t.ty[a], t.tx[a]);
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    return Math.abs(da) / (2 * span * t.spacing);
  }

  // produce controls for this step. locked = countdown / not running yet.
  control(car, locked) {
    const c = this._c;
    if (locked) { c.steer = 0; c.throttle = 0; c.brake = 0; c.handbrake = false; return c; }

    const t = this.track, n = t.n;
    this._progress(car);

    // lookahead grows with speed so fast cars aim further down the road
    const lookSegs = Math.round(7 + car.speed / 36);
    const li = (this.idx + lookSegs) % n;
    const nx = -t.ty[li], ny = t.tx[li];
    const tx = t.cx[li] + nx * this.offset;
    const ty = t.cy[li] + ny * this.offset;

    let desired = Math.atan2(ty - car.y, tx - car.x);
    let dAng = desired - car.heading;
    while (dAng > Math.PI) dAng -= TAU;
    while (dAng < -Math.PI) dAng += TAU;
    const steer = clamp(dAng * 2.4, -1, 1);

    // corner severity from the curvature a little ahead → target speed
    const curv = this._curvature((this.idx + 6) % n, 7);
    const corner = clamp((curv - 0.0006) * 540, 0, 1);
    let target = CONFIG.CAR.TOP_SPEED * (1 - 0.6 * corner) * this.skill * this.speedScale;
    if (target < 190) target = 190;

    if (car.speed > target + 35) { c.throttle = 0; c.brake = 1; }
    else if (car.speed > target) { c.throttle = 0.2; c.brake = 0; }
    else { c.throttle = 1; c.brake = 0; }

    // flick the handbrake to rotate through the tightest corners at speed
    c.handbrake = corner > 0.82 && car.speed > 300 && Math.abs(steer) > 0.45;
    c.steer = steer;
    return c;
  }
}

// rival display names + neon colours (player is cyan/white)
export const RIVALS = [
  { name: 'VIPER', color: '#ff2d95' },
  { name: 'BOLT', color: '#ffe14d' },
  { name: 'ECHO', color: '#5dff8a' },
];
