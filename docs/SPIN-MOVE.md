# Spin Move — design doc (NOT yet implemented)

A drop-in design for a **360° spin** that earns nitro. Captured now so it's
easy to add later; nothing in this file is wired into the game yet.

## The idea

A slow, deliberate 360° spin you commit to for style and reward — not a
twitch. You trade a chunk of speed and ~1 second of vulnerability for a
top-up of the nitro bar. Pulling one off mid-race is risky (you bleed speed
and can't steer normally during it) but rewarding (free nitro), so it's a
skill expression, not a panic button.

## Feel / rules

- **Trigger:** double-tap **brake** (S / ↓) while moving above a minimum
  speed. Mobile: double-tap **DRIFT**. A double-tap (two presses within
  ~0.3 s) avoids firing on normal braking.
- **Duration:** ~0.9–1.2 s for a full rotation — *slow on purpose*. The
  heading rotates a full 360° at a fixed rate; it reads as a committed
  flourish, not an instant pirouette.
- **During the spin:** steering input is ignored (the rotation is scripted),
  lateral velocity is zeroed, and forward speed bleeds (you come out slower).
- **Reward:** completing a clean 360 tops up nitro by `SPIN.NITRO_REWARD`
  (e.g. +0.4 of the bar).
- **Cancel:** a wall hit during the spin cancels it with **no** reward (and
  the normal wall-impact response takes over). Dropping below a crawl also
  cancels.
- **Cooldown:** a short lockout (`SPIN.COOLDOWN`) so it can't be chained
  back-to-back.

## Why it's a clean drop-in

Every hook point already exists; the spin is isolated so it never touches the
core drift model:

| Piece | Where | Note |
| --- | --- | --- |
| Constants | `CONFIG.SPIN` (new block in `src/config.js`) | `DURATION`, `RATE` (= 2π/DURATION), `MIN_SPEED`, `SPEED_KEEP`, `NITRO_REWARD`, `COOLDOWN`, `DOUBLE_TAP_MS`. |
| Spin state | `Car` in `src/physics.js` | Add `this.spinT` (remaining spin time). At the top of `step`, if `spinT > 0`: `heading += SPIN.RATE * dt`, zero `vL`, scale `vF *= SPEED_KEEP`, `spinT -= dt`, then **return early** (skip normal steering/grip). One guarded branch — the rest of the model is untouched. |
| Trigger detection | `src/input.js` | Track the timestamp of each brake press; a second press within `DOUBLE_TAP_MS` sets an edge flag `consume('spin')` (same pattern as the existing `respawn`/`pause` edges). |
| Fire it | `src/main.js` `fixedStep` | On the `spin` edge, if `car.spinT <= 0` and `car.speed > SPIN.MIN_SPEED` and cooldown elapsed: set `car.spinT = SPIN.DURATION`, start the cooldown, spawn a smoke-ring VFX. |
| Reward | `src/nitro.js` | When `spinT` crosses to ≤ 0 *without* having hit a wall, call `nitro.add(SPIN.NITRO_REWARD)`. Track a `_spinHitWall` flag set by the collision path. |
| VFX | `src/main.js` / `src/particles.js` | A quick tyre-smoke ring + sparks; reuse `emitSmoke` in a circle and the existing spark burst. |

## Test sketch (for when it's built)

- Pure-node `Car`: setting `spinT` makes the heading sweep a full 2π over
  `DURATION` and ignores steering; speed comes out lower; `vL` ≈ 0 throughout.
- Input: two brake taps within `DOUBLE_TAP_MS` raise the `spin` edge; slower
  than that does not.
- Integration: firing a spin in a race tops up the nitro bar; a wall hit
  mid-spin cancels it with no reward.

## Open tuning questions

- Exact duration (0.9 vs 1.2 s) and how much speed it should cost.
- Whether the reward should scale with entry speed (faster spin = more nitro).
- Whether AI rivals ever use it (probably not — keep it a player flourish).
