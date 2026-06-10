// ============================================================================
// NEON DRIFT — central tuning file.
// Every gameplay/feel constant lives here. Units: pixels, seconds, radians.
// World scale: the car is ~40 px long; 1 world px == 1 css px at zoom 1.
// ============================================================================

export const CONFIG = {

  // --- core loop -----------------------------------------------------------
  PHYSICS_HZ: 120,          // fixed-timestep simulation rate
  MAX_FRAME_MS: 50,         // clamp frame delta (tab-switch protection)
  MAX_STEPS_PER_FRAME: 8,   // hard cap on physics catch-up steps
  DPR_CAP: 2,               // devicePixelRatio cap (perf on 3x phones)
  SAVE_VERSION: 3,          // bump when physics tuning invalidates old records

  // --- car physics (arcade drift model) -------------------------------------
  CAR: {
    LENGTH: 40,             // visual length, px
    WIDTH: 20,              // visual width, px
    RADIUS: 13,             // collision circle radius (center)
    NOSE_TAIL: 13,          // offset of front/rear collision circles
    END_RADIUS: 10,         // radius of front/rear collision circles

    THROTTLE_FORCE: 880,    // px/s^2 forward force at full throttle
    REVERSE_FORCE: 520,     // px/s^2 reversing force
    MAX_REVERSE: 210,       // px/s reverse speed cap
    BRAKE_FORCE: 1500,      // px/s^2 when braking from forward motion
    DRAG_K: 0.00229,        // quadratic drag; equilibrium with throttle+rolling ≈ 540
    ROLL_LIN: 0.34,         // linear rolling resistance, 1/s
    ROLL_CONST: 28,         // constant rolling resistance, px/s^2
    TOP_SPEED: 540,         // px/s — v2: lowered from 620 after phone playtesting
                            //   (more reaction time, walls feel fair on small screens)
    COAST_DRAG_SCALE: 0.15, // v3: drag+rolling scaled way down while coasting (no
                            //   inputs) so lifting the throttle glides (~75% of top
                            //   speed kept after 1 s) instead of feeling like brakes
    CRUISE_SPEED: 340,      // v3: touch auto-throttle cruises here without GAS
    CRUISE_BRAKE: 0.22,     // v3: brake fraction fed when above cruise, gas released

    GRIP_FULL: 8.8,         // lateral velocity bleed rate, 1/s (normal grip)
    GRIP_DRIFT_FRAC: 0.32,  // drift grip = GRIP_FULL * this (~25-35% per spec)
    HANDBRAKE_DECEL: 460,   // extra forward decel while handbrake held, px/s^2
    HANDBRAKE_STRAIGHT_DECEL: 720, // v3: handbrake with no steering = real brakes
                            //   (playtester idea: DRIFT button doubles as brake)

    TURN_RATE: 2.8,         // rad/s steering authority at mid speed
    STEER_REF_SPEED: 150,   // px/s where steering reaches full authority
    HIGH_SPEED_DAMP: 0.42,  // how much steering softens at top speed (0..1)
                            //   v2: was 0.5 — more authority so walls are avoidable
    DRIFT_YAW_BOOST: 1.6,   // extra yaw authority while drifting (counter-steer)
    DRIFT_ALIGN: 0.9,       // passive heading→velocity alignment in drift, 1/s
                            //   (makes slides recoverable; the key feel knob)

    DRIFT_ENTER_SLIP: 0.27, // rad (~15.5°) slip angle that triggers drift
    DRIFT_EXIT_SLIP: 0.10,  // rad slip below which drift can end
    DRIFT_EXIT_TIME: 0.18,  // s of low slip required to exit drift
    DRIFT_MIN_SPEED: 120,   // px/s minimum forward speed to start/stay drifting
    HANDBRAKE_KICK: 0.25,   // extra yaw fraction while initiating with handbrake
    MAX_SLIP_SOFT: 0.78,    // rad (~45°): past this, tires dig in hard (max sustainable)
    SLIP_STEER_FADE: 0.5,   // rad: steering INTO the slide fades beyond this slip
  },

  // --- wall collisions -------------------------------------------------------
  WALL: {
    TANGENT_KEEP: 0.7,      // tangential velocity kept on impact (speed scrub)
    BOUNCE: 0.18,           // normal restitution (small bounce, never glue)
    SPARK_MIN_IMPACT: 60,   // px/s normal speed to spawn sparks
    SHAKE_SCALE: 1 / 950,   // impact speed → shake amount
    SHAKE_MAX: 10,          // px max shake amplitude
    SHAKE_DECAY: 5.2,       // 1/s exponential shake decay
  },

  // --- camera ----------------------------------------------------------------
  CAMERA: {
    FOLLOW_RATE: 5.2,       // 1/s exponential follow damping
    LOOKAHEAD: 0.5,         // s of velocity lookahead (v2: was 0.42 — see further ahead)
    ZOOM_BASE: 1.0,         // zoom at standstill (scaled by viewport)
    ZOOM_AT_SPEED: 0.76,    // zoom at top speed (v2: was 0.8 — wider view when fast)
    ZOOM_RATE: 2.2,         // 1/s zoom damping
    VIEW_REF: 860,          // px of world the short screen axis should show
    VIEW_MIN: 0.52,         // viewport zoom multiplier clamp
    VIEW_MAX: 1.12,
    FINISH_PUNCH: 0.16,     // zoom punch on race finish
  },

  // --- drift scoring (Drift Attack) -------------------------------------------
  SCORE: {
    RATE: 1.7,              // points/s = speed * |slip| * RATE (v2: was 1.5,
                            //   compensates the lower speeds so scores feel the same)
    MIN_DRIFT_TIME: 0.25,   // s a drift must last to bank
    CHAIN_WINDOW: 1.5,      // s between drifts to keep the chain alive
    MULT_MAX: 8,            // multiplier cap ×1 → ×8
    DRIFT_ATTACK_TIME: 120, // s round length
    MIN_SPEED: 120,         // px/s below which a drift stops scoring (v3: was 140,
                            //   points resume sooner while rebuilding after a hit)
    MIN_SLIP: 0.16,         // rad (~9°) below which a drift stops scoring
    FORFEIT_IMPACT: 90,     // px/s wall impact that forfeits a drift; lighter
                            //   scrapes keep the chain (v3 playtest bug fix)
    FORFEIT_GRACE: 0.3,     // s after a forfeit during which contact can't forfeit again
  },

  // --- particles ---------------------------------------------------------------
  FX: {
    POOL_SIZE: 1500,        // total pooled particles
    SMOKE_RATE: 95,         // particles/s per wheel at full slip
    SMOKE_LIFE: 0.85,       // s
    SPARK_LIFE: 0.45,
    CONFETTI_COUNT: 150,
    SLOWMO_SCALE: 0.32,     // time scale during finish slow-mo
    SLOWMO_TIME: 0.34,      // s (real time) of slow-mo
    POPUP_LIFE: 1.1,        // s floating score popups
  },

  // --- skid marks ----------------------------------------------------------------
  SKID: {
    CANVAS_SCALE: 0.5,      // offscreen rubber canvas resolution (memory saver)
    WIDTH: 6,               // rubber mark width, px (world)
    ALPHA: 0.34,            // darkness of a stamped mark
    MIN_SLIP: 0.14,         // rad of slip before marks appear
    MIN_MOVE: 6,            // px a wheel must travel before stamping a segment
    GLOW_SEGMENTS: 256,     // ring buffer of fresh glowing segments
    GLOW_TIME: 1.1,         // s for fresh-mark neon glow to fade
  },

  // --- audio -----------------------------------------------------------------------
  AUDIO: {
    MASTER: 0.85,
    ENGINE: 0.17,
    SKID: 0.5,
    MUSIC: 0.34,
    UI: 0.5,
    BPM: 100,               // generative synthwave tempo
  },

  // --- ghosts ---------------------------------------------------------------------
  GHOST: {
    SAMPLE_HZ: 30,          // pose samples per second
    MAX_BYTES: 100 * 1024,  // serialized budget; downsamples to fit
  },

  // --- race ------------------------------------------------------------------------
  RACE: {
    LAPS: 3,
    CHECKPOINT_EVERY: 0.15, // fraction of track length between checkpoints
    COUNTDOWN: 3,           // seconds of 3-2-1
    RESPAWN_COOLDOWN: 0.5,
  },

  // --- look ------------------------------------------------------------------------
  COLORS: {
    BG: '#070b1f',
    GRID: 'rgba(0,240,255,0.07)',
    GRID_MAJOR: 'rgba(0,240,255,0.13)',
    ASPHALT: '#10162e',
    ASPHALT_EDGE: 'rgba(0,0,0,0.30)',
    CYAN: '#00f0ff',
    MAGENTA: '#ff2d95',
    YELLOW: '#ffe14d',
    WHITE: '#f4f7ff',
  },

  SPEED_DISPLAY: 0.225,     // px/s → "mph" display factor (540 → ~122 mph)
};
