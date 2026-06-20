# NEON DRIFT

A synthwave arcade drift-racing game that runs entirely in your browser.
Pure vanilla JavaScript + Canvas 2D — **no frameworks, no build step, no
downloaded assets**. Every pixel is drawn procedurally and every sound is
synthesized live with the Web Audio API.

![genre](https://img.shields.io/badge/genre-arcade%20drift-ff2d95)
![tech](https://img.shields.io/badge/tech-vanilla%20JS%20%2B%20canvas-00f0ff)
![deps](https://img.shields.io/badge/runtime%20deps-zero-ffe14d)

## The game

- **5 handcrafted neon tracks** — *Sunset Loop* (fast & flowing), *Circuit
  Royale* (chicanes + a hairpin), *Vice Spiral* (high-speed sweepers into
  tight hairpins), *Aurora Bay* (long coastal sweepers), and *Toxic Mile*
  (a hazard playground). All laced with **surface hazards**: 🧊 ice that
  sends you sliding, 🟤 mud that scrubs your speed and kills drifts, and ⚡
  boost pads that fling you down the straights.
- **Grand Prix** — race **3 AI rivals** over 3 laps with live positions and
  a podium finish. They use your exact car physics (fair), brake for
  corners, draft, bump, and rubber-band so it stays close and winnable.
- **Time Trial** — 3 laps against the clock. Bronze / silver / gold medal
  targets per track, live delta vs. your best at every checkpoint, and your
  best run replayed as a translucent **ghost car**.
- **Drift Attack** — 120 seconds to rack up points. Score flows while you
  slide (speed × angle), chain drifts within 1.5 s to build a **×8
  multiplier**, bank points by straightening out — touch a wall mid-drift
  and the unbanked chunk is gone.
- Roadside scenery (palms, billboards, neon barriers), persistent skid
  marks, pooled tire smoke, frost & mud spray, wall sparks, screen shake,
  slow-mo finishes, confetti, a generative synthwave soundtrack, and a car
  that's genuinely fun to throw sideways.

## Controls

### Desktop
| Key | Action |
| --- | --- |
| `W` / `↑` | Throttle (release to coast/glide) |
| `S` / `↓` | Brake to a stop · press again from standstill to reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Handbrake — hold **with steering** to drift, **while straight** it's a hard brake |
| `Shift` | Nitro — spend the bar for a speed burst (fills as you drift; GP + Time Trial) |
| `R` | Respawn at the last checkpoint |
| `Esc` / `P` | Pause |
| `M` | Mute |
| `F3` | Debug overlay (FPS, slip angle, particles) |

### Phone / tablet
The car cruises on its own at a comfortable pace. Hold **GAS** (yellow,
right side) for full speed and release it to slow into corners. Steer with
the **◀ ▶** buttons (bottom-left), tap **NOS** (cyan, above the steer pad)
to burn nitro. Hold **DRIFT** while steering to slide — hold it while going
straight and it's your brake. Everything is multi-touch safe; respawn ↺ and
pause Ⅱ sit at the top.

**Nitro:** drifting fills the nitro bar; spend it for a speed burst. In
**Grand Prix** the rivals are faster than you on the straights, so you bank
nitro through the corners and spend it to keep up — out-drive them, don't
out-drag them.

**Surfaces:** 🧊 **ice** (now big rectangular slabs) kicks your rear out and
tries to spin you — catch it with counter-steer; 🟤 **mud** is mild if you
keep it straight but grabs and scrubs you hard if you drift across it; ⚡
**boost pads** fling you down the straights.

## Install it like an app (PWA)

NEON DRIFT is an installable Progressive Web App: once you've opened it in
a browser, it caches itself and **plays fully offline**.

- **Android (Chrome):** open the game URL → menu ⋮ → **Add to Home screen**
  (or tap the install prompt). Launches fullscreen with its own icon.
- **iPhone/iPad (Safari):** open the game URL → Share □↑ → **Add to Home
  Screen**. Launches standalone without browser chrome.

Races also request fullscreen, keep the screen awake, and give little
haptic buzzes on wall hits and banked drifts (toggle **HAPTICS** in the
track-select settings).

**Drift like you mean it:** flick the handbrake while turning, then
counter-steer to hold the slide. Clean exits bank your points; chain the
next drift quickly to grow the multiplier.

## Run it locally

ES modules don't load over `file://`, so serve the folder with any static
server (no install, no build):

```bash
# any ONE of these, from the repo root:
python3 -m http.server 8080
npx serve
php -S localhost:8080
```

…then open <http://localhost:8080>.

## Deploy to GitHub Pages (step by step)

1. Push this repository to GitHub.
2. On GitHub, open **Settings → Pages** (left sidebar).
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
4. Pick your branch (e.g. `main`), folder **/ (root)**, and click **Save**.
5. Wait ~1 minute. Your game is live at
   `https://<your-username>.github.io/<repo-name>/`.

Everything is relative-path based, so it works from any subpath with zero
configuration.

## Development & tests

The shipped game has **zero dependencies**. Dev-only tooling (Playwright)
powers a headless smoke test that loads the game, drives the car, measures
FPS, clicks through every screen, checks the mobile touch layout, and
verifies nothing breaks with `localStorage` disabled:

```bash
npm install
npx playwright install chromium
npm test
```

Extra dev harnesses live in `test/` (`physics-check`, `drift-check`,
`fx-check`, `ghost-check`) — each validates one subsystem with scripted
input and real assertions.

## How it's built

- Fixed-timestep physics at 120 Hz with render interpolation and a clamped
  frame delta (tab-switching can't explode the simulation).
- Arcade drift model: velocity is decomposed into forward/lateral parts
  each tick; drifting drops lateral grip to ~30% and grants extra yaw
  authority so a competent counter-steer always catches the slide.
- Tracks are Catmull-Rom splines, resampled to uniform spacing, with offset
  wall polylines stored in a spatial hash for cheap collision.
- All glow is layered strokes / radial gradients / pre-rendered sprites —
  `shadowBlur` is never used in the hot loop.
- See [`DESIGN.md`](DESIGN.md) for the full decision log and tuning values.

---

**Built by JDT Tech Help.**
