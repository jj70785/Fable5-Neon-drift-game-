// ============================================================================
// Arcade drift car model.
//
// Velocity lives in WORLD space. Each tick we decompose it into forward /
// lateral components relative to the heading, apply forces there, recompose
// with the same basis, then rotate the heading from steering. Because the
// velocity vector does not rotate with the car, slip develops naturally when
// you steer — lateral grip is what pulls the velocity back in line, and
// dropping that grip is what makes a drift.
//
// Drift state machine:
//   GRIP  → DRIFT  when handbrake is pulled at speed, or |slip| > ~15°
//   DRIFT → GRIP   when slip stays small for DRIFT_EXIT_TIME (hysteresis)
// While drifting: lateral grip drops to ~30%, steering gains extra yaw
// authority (counter-steer must always be able to catch the slide), and a
// gentle heading→velocity alignment makes recovery forgiving.
// ============================================================================

import { CONFIG } from './config.js';

const C = CONFIG.CAR;
const W = CONFIG.WALL;
const TAU = Math.PI * 2;

export class Car {
  constructor() {
    this.x = 0; this.y = 0; this.heading = 0;
    this.vx = 0; this.vy = 0;
    this.prevX = 0; this.prevY = 0; this.prevHeading = 0;

    this.slip = 0;          // rad, signed (atan2(lateral, |forward|))
    this.vF = 0;            // forward speed (signed), px/s
    this.vL = 0;            // lateral speed (signed), px/s
    this.speed = 0;         // |velocity|
    this.drifting = false;
    this.throttle = 0;      // cached inputs for audio/fx
    this.handbrake = false;
    this.steer = 0;

    this._driftExitT = 0;
  }

  reset(x, y, heading) {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.heading = this.prevHeading = heading;
    this.vx = 0; this.vy = 0;
    this.vF = 0; this.vL = 0; this.speed = 0;
    this.slip = 0;
    this.drifting = false;
    this._driftExitT = 0;
  }

  step(dt, steer, throttle, brake, handbrake) {
    this.prevX = this.x; this.prevY = this.y; this.prevHeading = this.heading;
    this.throttle = throttle; this.handbrake = handbrake; this.steer = steer;

    const cos = Math.cos(this.heading), sin = Math.sin(this.heading);
    // decompose: forward = (cos,sin), left = (-sin,cos)
    let vF = this.vx * cos + this.vy * sin;
    let vL = -this.vx * sin + this.vy * cos;

    // slip angle: how far the velocity points away from the nose
    const speed = Math.hypot(vF, vL);
    const slip = speed > 30 ? Math.atan2(vL, Math.max(Math.abs(vF), 25)) : 0;
    this.slip = slip;

    // ---- drift state machine ----
    const absSlip = Math.abs(slip);
    if (!this.drifting) {
      const viaBrake = handbrake && vF > C.DRIFT_MIN_SPEED * 0.55;
      const viaSlip = absSlip > C.DRIFT_ENTER_SLIP && vF > C.DRIFT_MIN_SPEED;
      if (viaBrake || viaSlip) {
        this.drifting = true;
        this._driftExitT = 0;
      }
    } else {
      const calm = absSlip < C.DRIFT_EXIT_SLIP && !handbrake;
      if (calm) {
        this._driftExitT += dt;
        if (this._driftExitT > C.DRIFT_EXIT_TIME) this.drifting = false;
      } else {
        this._driftExitT = 0;
      }
      if (vF < C.DRIFT_MIN_SPEED * 0.45 && !handbrake) this.drifting = false;
    }

    // ---- longitudinal forces ----
    let aF = 0;
    if (throttle > 0) aF += C.THROTTLE_FORCE * throttle;
    if (brake > 0) {
      if (vF > 30) aF -= C.BRAKE_FORCE * brake;        // braking
      else aF -= C.REVERSE_FORCE * brake;              // reversing
    }
    if (handbrake) {
      aF -= Math.sign(vF) * C.HANDBRAKE_DECEL * Math.min(1, Math.abs(vF) / 60);
    }
    aF -= vF * Math.abs(vF) * C.DRAG_K;                // quadratic drag
    aF -= vF * C.ROLL_LIN;                             // linear rolling resistance
    vF += aF * dt;

    const roll = C.ROLL_CONST * dt;                    // constant rolling resistance
    if (Math.abs(vF) <= roll && throttle === 0 && brake === 0) vF = 0;
    else if (vF !== 0) vF -= Math.sign(vF) * roll;
    if (vF < -C.MAX_REVERSE) vF = -C.MAX_REVERSE;

    // ---- lateral grip ----
    let grip = this.drifting ? C.GRIP_FULL * C.GRIP_DRIFT_FRAC : C.GRIP_FULL;
    // beyond ~45° the tires dig in harder: caps sustainable slip, kills spins
    if (absSlip > 0.8) grip *= 1 + (absSlip - 0.8) * 1.7;
    vL *= Math.exp(-grip * dt);

    // recompose velocity with the PRE-steer basis (velocity must not rotate
    // with the car — that coupling is exactly what grip simulates)
    this.vx = vF * cos - vL * sin;
    this.vy = vF * sin + vL * cos;
    this.vF = vF; this.vL = vL;
    this.speed = Math.hypot(this.vx, this.vy);

    // ---- steering ----
    const absF = Math.abs(vF);
    const speedFactor = Math.min(1, absF / C.STEER_REF_SPEED);   // no turning while parked
    const hi = Math.min(1, absF / C.TOP_SPEED);
    const damp = 1 - C.HIGH_SPEED_DAMP * hi * hi;                // calmer at top speed
    let yawAuth = C.TURN_RATE * speedFactor * damp;
    if (this.drifting) {
      yawAuth *= C.DRIFT_YAW_BOOST;                              // counter-steer authority
      if (handbrake && absSlip < 0.35) yawAuth *= 1 + C.HANDBRAKE_KICK; // snappy initiation
    }
    let turn = steer * yawAuth;
    if (vF < -1) turn = -turn;                                   // mirrored in reverse
    if (this.drifting) turn += slip * C.DRIFT_ALIGN;             // recovery assist

    this.heading += turn * dt;
    if (this.heading > Math.PI) this.heading -= TAU;
    else if (this.heading < -Math.PI) this.heading += TAU;

    // ---- integrate ----
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  // rear-axle wheel positions (skid marks / smoke). out = {lx,ly,rx,ry}
  rearWheels(out) {
    const cos = Math.cos(this.heading), sin = Math.sin(this.heading);
    const bx = this.x - cos * C.NOSE_TAIL, by = this.y - sin * C.NOSE_TAIL;
    const ox = -sin * (C.WIDTH * 0.42), oy = cos * (C.WIDTH * 0.42);
    out.lx = bx + ox; out.ly = by + oy;
    out.rx = bx - ox; out.ry = by - oy;
    return out;
  }
}

// Wall impact response, shared by every wall type.
// (nx,ny): wall normal pointing INTO the track. depth: penetration depth.
// Per spec: kill the normal velocity component (small bounce), keep ~70% of
// the tangential component on solid hits — but scale the tangential scrub by
// how head-on the impact is, so grazing a wall scrubs a little and never
// feels like glue.
// Returns impact speed along the normal (px/s) for sparks / shake / audio.
export function resolveWallHit(car, nx, ny, depth) {
  car.x += nx * depth;
  car.y += ny * depth;

  const vn = car.vx * nx + car.vy * ny;     // negative when moving into the wall
  if (vn >= 0) return 0;

  const tx = -ny, ty = nx;
  const vt = car.vx * tx + car.vy * ty;

  const impact = -vn;
  const headOn = Math.min(1, impact / 300);
  const keep = 1 - (1 - W.TANGENT_KEEP) * headOn;

  const newVn = impact * W.BOUNCE;          // small bounce off
  const newVt = vt * keep;

  car.vx = nx * newVn + tx * newVt;
  car.vy = ny * newVn + ty * newVt;
  return impact;
}
