# NEON DRIFT — design log

Decisions, tuning values, and the math behind the numbers. Everything
tunable lives in [`src/config.js`](src/config.js); this file explains *why*
the values are what they are.

## Architecture decisions

| Decision | Rationale |
| --- | --- |
| DOM for menus/HUD, canvas for the world | Crisp text for free, CSS neon glows, zero canvas text in the hot loop, and accessible real `<button>`s. The HUD caches every value and only touches the DOM on change. |
| Added `src/storage.js` (12th module beyond the brief's list) | Persistence is cross-cutting (settings, bests, ghosts). One guarded wrapper with an in-memory fallback beats three copies of try/catch. |
| Fixed timestep 120 Hz + render interpolation | Determinism for physics feel; interpolation keeps 60 Hz (or 144 Hz) displays smooth. Frame delta clamps at 50 ms and catch-up is capped at 8 steps — a backgrounded tab resumes gracefully instead of simulating minutes. |
| Track base baked to an offscreen canvas (0.55×) | The halo/asphalt/kerbs/dashes never change. Baking turns ~13 wide Path2D strokes per frame into one `drawImage`; only the two crisp neon edge lines are stroked live, chunked by bounding box so off-screen geometry costs nothing. |
| Skid canvas at 0.5× resolution | A full track at 1× would be ~50 MB of RGBA. Rubber is soft and dark — half resolution is invisible, and the fresh-mark neon glow is drawn live at full resolution anyway. |
| Screen-space starfield tiles, no pattern fill | A transformed `createPattern` fill resamples per pixel and cost ~26 FPS under software rendering. Tiling a 256² opaque sprite with `drawImage` doubles as the background clear. |
| No `backdrop-filter` | Blurring the full viewport every frame halved FPS in software rendering. Overlays use plain translucency. |
| Confetti tumble = width squash, not rotation | `save/translate/rotate/restore` per particle is the slow path; `fillRect` with a cos-squashed width reads identically at 4–8 px. |
| Test hooks (`window.__NEON`) ship in the game | A few getters and ~20 lines. They power the smoke test and the F3 overlay; harmless at runtime. |
| Drift Attack banks pending points when the timer ends | Feels fair — the run ends mid-slide through no fault of yours. Walls still forfeit. |
| No wrong-way indicator | Checkpoints are strictly ordered, so a wrong-way lap can't validate; adding UI for it cluttered the HUD. Gate notches + chevrons telegraph direction instead. |
| Mobile pause/respawn at top **center**, not top corner | The brief said "pause icon top corner", but both corners are taken (lap/time left, minimap right). Center keeps every spec'd HUD element unobstructed at 390×844 — verified by the smoke test's overlap check. |
| Rear-light trail | Not in the brief: a fading additive magenta ribbon behind the car above ~240 px/s. It sells speed on straights the way skids sell drifts, and costs a 72-entry ring buffer. |

## Car physics (final values)

Velocity lives in world space and is decomposed against the heading every
tick — grip is just how fast lateral velocity bleeds. Drifting *is* having
lateral velocity, so every feel knob is one number somewhere:

| Constant | Value | Why |
| --- | --- | --- |
| `THROTTLE_FORCE` | 1000 px/s² | With drag + rolling resistance, equilibrium lands at ~624 px/s. |
| `DRAG_K` / `ROLL_LIN` / `ROLL_CONST` | 0.00195 / 0.34 / 28 | Measured: **617 px/s at t = 1.8 s** (spec: ~620 in ~1.8 s). |
| `TURN_RATE` | 2.8 rad/s | Spec anchor; scaled by `min(1, v/150)` so a parked car cannot turn, and damped 50% at top speed. |
| `GRIP_FULL` | 8.8 s⁻¹ | Normal cornering sits at ~10° slip — composed, but alive. |
| `GRIP_DRIFT_FRAC` | 0.30 | Drift grip ≈ 2.6 s⁻¹ (spec: 25–35%). |
| `DRIFT_ENTER_SLIP` / `EXIT` | 15.5° / 5.7° + 0.18 s | Hysteresis so the state can't flicker mid-slide. |
| `DRIFT_YAW_BOOST` | 1.6 | The single most important feel number: counter-steer authority while sliding. |
| `DRIFT_ALIGN` | 0.9 s⁻¹ | Passive heading→velocity alignment in drift; recovery help that never fights initiation. |
| `MAX_SLIP_SOFT` | 45° | Past this the tires "dig in" (grip scales up 2.4×/rad) and steering *into* the slide fades — slides saturate around 45–55° instead of spinning. Counter-steer keeps full authority. |
| Wall response | keep 70% tangential, 18% bounce | Tangential scrub scales with how head-on the hit is, so grazing a wall grinds speed off without feeling like glue. |

Measured behaviours (asserted by `test/physics-check.mjs` on every run):
sustained handbrake slide holds a steady **36° slip at 440+ px/s**;
full counter-steer recovers to <10° slip in **under 1.4 s** at 500+ px/s.

### Manual trace: the four spec scenarios

- **Steering at a standstill** — `speedFactor = min(1, |vF|/150) = 0`, so
  yaw authority is exactly 0. Asserted: heading change < 0.001 rad after
  0.6 s of full lock.
- **Full-speed wall hit** — at 600 px/s head-on: normal velocity becomes
  `600 × 0.18 = 108` px/s outward (small bounce), tangential keeps 70%.
  Asserted: speed < 220 px/s after impact, position stays inside the track.
- **Drift entry/exit** — entry via handbrake at speed or slip > 15.5°;
  exit requires slip < 5.7° for 0.18 s, so a wobble mid-slide can't drop
  the drift state (and the score chain) by accident.
- **dt clamp after tab-out** — a 10-minute background tab produces one
  frame with `frameMs = 600 000`, clamped to 50 ms → at most 6 physics
  steps (`50 ms / 8.33 ms`), under the 8-step cap. Additionally
  `visibilitychange` auto-pauses, so in practice the race is frozen and
  the accumulator is reset on resume.

## Tracks

Catmull-Rom centerlines (20–35 control points each), resampled to 12 px
spacing; walls are ±width/2 offsets along the normals, stored as segments
in a 128 px spatial hash. 7 ordered checkpoint gates (~every 14%) validate
laps and anchor respawns.

| Track | Width | Length | Character |
| --- | --- | --- | --- |
| Sunset Loop | 150 px | 8 825 px | Big radii, one gentle S — the teacher. |
| Circuit Royale | 118 px | 9 600 px | Chicane flick + 180° hairpin — precision. |
| Vice Spiral | 132 px | 16 545 px | Outer sweepers diving into a two-hairpin infield spiral. |

A collision subtlety worth recording: a circle on the far side of a wall
is **only** snapped back when it's within 10 px of the line (true
tunneling is bounded by one 120 Hz step ≈ 6 px). Anything farther is the
car legitimately driving a *different* nearby track section — the original
"always snap inside" logic created a phantom wall where Sunset Loop's
final corner runs close to its start straight.

## Medal targets

`target(tier) = ceil(LAPS × length / (fraction × TOP_SPEED))` — i.e. "hold
this fraction of top speed on average for three laps." Fractions are
per-track because technical layouts cap realistic average speed:

| Track | Gold | Silver | Bronze | → times (3 laps) |
| --- | --- | --- | --- | --- |
| Sunset Loop | 0.62 | 0.54 | 0.44 | 69 s / 80 s / 98 s |
| Circuit Royale | 0.54 | 0.47 | 0.385 | 87 s / 99 s / 121 s |
| Vice Spiral | 0.57 | 0.495 | 0.405 | 141 s / 162 s / 198 s |

Bronze ≈ "finished cleanly with a few wall taps", gold ≈ "drifting the
hairpins instead of braking for them."

## Drift scoring

`points/s = speed × |slip| × 1.5` while sliding (≥160 px/s, ≥9°). A 450
px/s slide at 35° ≈ **410 pts/s** base; with the ×8 chain that's ~3 300/s
— a clean 120 s run lands in the satisfying 100–250 k range. Chain window
1.5 s, multiplier +1 per banked drift, wall contact forfeits pending
points and resets to ×1. Banked-vs-pending is deliberately visible: pending
(yellow) shows `pending × mult` so you always know what a wall will cost.

## Ghosts

30 Hz samples of (x, y, heading) stored as flat integer arrays
(x·10, y·10, heading·100 → 1 px decimal, ~0.6° resolution). A 90 s run is
~55 KB of JSON; if a run would exceed 100 KB the recorder halves the rate
before saving (playback interpolates, so a 15 Hz ghost still glides).
Saved only on a new best total, per track, under `neondrift.ghost.<id>`.

## Audio

- **Engine**: saw + detuned square an octave down → lowpass. Pitch maps to
  speed (62–312 Hz), cutoff to speed+throttle (260–3600 Hz).
- **Skid**: looped white-noise buffer → bandpass @ 880 Hz; gain follows
  slip × speed. It *is* the drift meter, audibly.
- **Music**: 100 BPM, 8-bar loop in A minor (Am–F–C–G). Four-on-the-floor
  kick with a sidechain duck on the whole music bus, snare on 2/4, eighth
  hats, driving eighth-note bass with octave pops, and a pentatonic arp on
  16ths feeding a dotted-eighth feedback delay. A 3-osc detuned pad swells
  once a bar. ~120 lines of scheduler, no samples.
- AudioContext is created on the first gesture; `M` mutes the master,
  music/SFX have separate toggles, and the context suspends when hidden.

## Performance notes

Verified by the smoke test in **headless Chromium with software
rendering** (a deliberately brutal floor — real GPUs are far faster):
60 FPS with 450+ live particles and a full session of skid marks. The hot
loop allocates nothing: particles are struct-of-arrays with swap-back
removal, popups/segments are pooled, HUD writes are change-detected, and
collision queries reuse stamped candidate arrays.
