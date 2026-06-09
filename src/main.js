// ============================================================================
// NEON DRIFT — boot, fixed-timestep game loop, state machine.
// States: title → select → race (countdown/running/finished) ⇄ paused → results
// Physics runs at CONFIG.PHYSICS_HZ with render interpolation; frame delta is
// clamped so a backgrounded tab never explodes the simulation.
// ============================================================================

import { CONFIG } from './config.js';
import { storage } from './storage.js';
import { Input } from './input.js';
import { UI, fmtTime } from './ui.js';
import { Car } from './physics.js';
import { TRACK_DEFS, getTrack } from './track.js';

const STATE = {
  TITLE: 'title',
  SELECT: 'select',
  RACE: 'race',
  PAUSED: 'paused',
  RESULTS: 'results',
};

const TAU = Math.PI * 2;

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * t;
}
function fmtTimeShort(t) {
  const m = Math.floor(t / 60), s = Math.round(t - m * 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ---------------------------------------------------------------- car sprite
// Pre-rendered at 2x so glow is one cheap drawImage per frame (no shadowBlur).
function makeCarSprite(ghost) {
  const S = 140, c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  g.scale(2, 2); // 1 unit = 1 world px, car axis +x

  if (!ghost) {
    // under-glow
    const glow = g.createRadialGradient(0, 0, 4, 0, 0, 33);
    glow.addColorStop(0, 'rgba(0,240,255,0.50)');
    glow.addColorStop(0.55, 'rgba(0,240,255,0.16)');
    glow.addColorStop(1, 'rgba(0,240,255,0)');
    g.fillStyle = glow;
    g.fillRect(-34, -34, 68, 68);
  }

  const body = () => {
    g.beginPath();
    g.moveTo(21, 0);
    g.lineTo(13, -7.5);
    g.lineTo(-13, -10.5);
    g.lineTo(-17, -6.5);
    g.lineTo(-17, 6.5);
    g.lineTo(-13, 10.5);
    g.lineTo(13, 7.5);
    g.closePath();
  };

  if (ghost) {
    body();
    g.fillStyle = 'rgba(0,240,255,0.13)';
    g.fill();
    g.strokeStyle = 'rgba(0,240,255,0.9)';
    g.lineWidth = 1.4;
    g.stroke();
    g.strokeStyle = 'rgba(244,247,255,0.5)';
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(-16, -7.5); g.lineTo(-16, 7.5); g.stroke();
  } else {
    body();
    const paint = g.createLinearGradient(21, 0, -17, 0);
    paint.addColorStop(0, '#fdffff');
    paint.addColorStop(0.45, '#c9f4ff');
    paint.addColorStop(1, '#8fb6e8');
    g.fillStyle = paint;
    g.fill();
    g.strokeStyle = 'rgba(0,240,255,0.95)';
    g.lineWidth = 1.5;
    g.stroke();
    // canopy
    g.beginPath();
    g.moveTo(7, 0); g.lineTo(1, -5); g.lineTo(-8, -6); g.lineTo(-8, 6); g.lineTo(1, 5);
    g.closePath();
    g.fillStyle = '#0b1736';
    g.fill();
    g.strokeStyle = 'rgba(0,240,255,0.55)';
    g.lineWidth = 0.8;
    g.stroke();
    // magenta side slashes
    g.strokeStyle = 'rgba(255,45,149,0.95)';
    g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(10, -8); g.lineTo(3, -9.6); g.stroke();
    g.beginPath(); g.moveTo(10, 8); g.lineTo(3, 9.6); g.stroke();
    // rear light bar + glow
    g.fillStyle = '#ff2d95';
    g.fillRect(-17.4, -7.5, 2.2, 15);
    const tail = g.createRadialGradient(-18, 0, 1, -18, 0, 14);
    tail.addColorStop(0, 'rgba(255,45,149,0.5)');
    tail.addColorStop(1, 'rgba(255,45,149,0)');
    g.fillStyle = tail;
    g.fillRect(-32, -14, 28, 28);
  }
  return c;
}

function makeStarTile() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = CONFIG.COLORS.BG; // opaque: doubles as the background fill
  g.fillRect(0, 0, 256, 256);
  let seed = 987654321;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 16; i++) {
    const a = 0.25 + rnd() * 0.5;
    g.fillStyle = `rgba(190,220,255,${a.toFixed(2)})`;
    const r = rnd() < 0.85 ? 1 : 2;
    g.fillRect(Math.floor(rnd() * 256), Math.floor(rnd() * 256), r, r);
  }
  return c;
}

// ============================================================================
class Game {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0; this.h = 0;            // css pixels

    this.state = STATE.TITLE;
    this.stateTime = 0;
    this.timeScale = 1;
    this.slowmo = 0;                   // remaining real-time seconds of slow-mo

    this.acc = 0;
    this.alpha = 1;                    // render interpolation factor
    this._last = performance.now();
    this._stepsThisFrame = 0;

    // fps tracking (rolling)
    this._fpsBuf = new Float32Array(90);
    this._fpsIdx = 0;
    this._fpsCount = 0;
    this.fpsAvg = 60;
    this._dbgTimer = 0;
    this.debugOn = false;

    this.settings = Object.assign({ music: true, sfx: true, shake: true },
      storage.get('settings', {}));
    this.muted = !!storage.get('muted', false);

    this.input = new Input();
    this.ui = new UI({
      onStart: (i) => this.startRace(i, this.ui.mode),
      onResume: () => this.resume(),
      onRestart: () => this.restartRace(),
      onQuit: () => this.quitToSelect(),
      onMainMenu: () => this.quitToTitle(),
      onModeChange: () => this.refreshTrackCards(),
      onSetting: (name) => this.toggleSetting(name),
    });

    // race context
    this.trackIndex = 0;
    this.mode = 'time';
    this.track = null;
    this.car = new Car();
    this.race = null;
    this._respawnQueued = false;
    this._respawnCd = 0;
    this.lastImpact = 0;

    this.cam = { x: 0, y: 0, zoom: 1, punch: 0, shakeAmp: 0, shakeX: 0, shakeY: 0 };
    this.viewScale = 1;

    // render assets (allocated once)
    this.carSprite = makeCarSprite(false);
    this.ghostSprite = makeCarSprite(true);
    this.starTile = makeStarTile();
    this.starPattern = null;           // created lazily (needs ctx)
    this.miniCtx = null;

    // title background bits
    this._stars = [];
    let seed = 1234567;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 90; i++) {
      this._stars.push({ x: rnd(), y: rnd() * 0.5, r: 0.5 + rnd() * 1.4, tw: rnd() * 6.28 });
    }
    this._t = 0;
  }

  // ------------------------------------------------------------------ boot
  boot() {
    this.input.attach();
    this.input.onFirstGesture = () => { /* audio engine hooks in later */ };

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => this.resize());
    this.resize();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === STATE.RACE) this.pause();
    });

    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
      this._touchUI = true;
    }
    this.input.bindButton(this.ui.el.btnLeft, 'left');
    this.input.bindButton(this.ui.el.btnRight, 'right');
    this.input.bindButton(this.ui.el.btnBrake, 'brake');
    this.input.bindButton(this.ui.el.btnPause, 'pause');
    this.input.bindButton(this.ui.el.btnRespawn, 'respawn');

    const mini = this.ui.el.minimap;
    mini.width = 440; mini.height = 320;
    this.miniCtx = mini.getContext('2d');

    this.ui.reflectSettings(this.settings);
    this.ui.showScreen('title');
    this.refreshTrackCards();

    // dev/test hooks (tiny; also used by the smoke test)
    const self = this;
    window.__NEON = {
      version: '1.0.0',
      get state() { return self.state; },
      get phase() { return self.race ? self.race.phase : null; },
      get car() { return self.car; },
      get fpsAvg() { return self.fpsAvg; },
      get particlesLive() { return 0; },
      test: {
        start: (i = 0, mode = 'time') => self.startRace(i, mode),
        skipCountdown: () => {
          if (self.race && self.race.phase === 'countdown') {
            self.race.cd = -10; self.race.phase = 'running'; self.ui.setCountdown(null);
          }
        },
        finishRace: () => { if (self.race) self.finishRace(); },
        burstParticles: () => {},
        setCar: (x, y, heading, vx = 0, vy = 0) => {
          self.car.reset(x, y, heading);
          self.car.vx = vx; self.car.vy = vy;
          self.cam.x = x; self.cam.y = y;
        },
      },
    };

    requestAnimationFrame((t) => { this._last = t; this.frame(t); });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_CAP);
    const w = window.innerWidth, h = window.innerHeight;
    this.dpr = dpr; this.w = w; this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    const cc = CONFIG.CAMERA;
    this.viewScale = clamp(Math.min(w, h) / cc.VIEW_REF, cc.VIEW_MIN, cc.VIEW_MAX);
  }

  // ------------------------------------------------------------- state mgmt
  setState(s) { this.state = s; this.stateTime = 0; }

  startRace(trackIndex, mode) {
    this.trackIndex = trackIndex;
    this.mode = mode || this.ui.mode;
    this.track = getTrack(trackIndex);
    this.track.bake();

    const sp = this.track.startPose;
    this.car.reset(sp.x, sp.y, sp.heading);
    this.acc = 0; this.alpha = 1;
    this.timeScale = 1; this.slowmo = 0;
    this._respawnQueued = false; this._respawnCd = 0;

    this.race = {
      phase: 'countdown',
      cd: CONFIG.RACE.COUNTDOWN + 0.4,
      time: 0,
      lap: 1,
      expected: 1,
      lastGate: 0,
      lapStart: 0,
      lapTimes: [],
      splits: [],
      remaining: CONFIG.SCORE.DRIFT_ATTACK_TIME,
      finishT: 0,
      resultsShown: false,
      total: 0,
    };

    this.cam.x = sp.x; this.cam.y = sp.y;
    this.cam.zoom = this.viewScale * CONFIG.CAMERA.ZOOM_BASE;
    this.cam.punch = 0; this.cam.shakeAmp = 0;

    this.ui.showScreen(null);
    this.ui.showHud(true);
    this.ui.showLap(this.mode === 'time');
    this.ui.showDriftHud(this.mode === 'drift');
    if (this.mode === 'drift') this.ui.setDriftTimer('2:00', false); else this.ui.hideDriftTimer();
    this.ui.setDelta(null);
    this.ui.clearPopups();
    this.ui.showTouch(!!this._touchUI || this.input.touchActive);
    this.setState(STATE.RACE);
  }

  restartRace() { if (this.race) this.startRace(this.trackIndex, this.mode); }

  quitToSelect() {
    this.race = null;
    this.ui.showHud(false);
    this.ui.showTouch(false);
    this.ui.setCountdown(null);
    this.ui.clearPopups();
    this.refreshTrackCards();
    this.ui.showScreen('select');
    this.setState(STATE.SELECT);
  }

  quitToTitle() {
    this.quitToSelect();
    this.ui.showScreen('title');
    this.setState(STATE.TITLE);
  }

  pause() {
    if (this.state !== STATE.RACE) return;
    this.setState(STATE.PAUSED);
    this.ui.showScreen('pause');
    this.input.releaseAll();
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this.setState(STATE.RACE);
    this.ui.showScreen(null);
    this._last = performance.now();
  }

  finishRace() {
    const race = this.race;
    if (!race || race.phase === 'finished') return;
    race.phase = 'finished';
    race.total = race.time;
    this.slowmo = CONFIG.FX.SLOWMO_TIME;
    this.timeScale = CONFIG.FX.SLOWMO_SCALE;
    this.cam.punch = CONFIG.CAMERA.FINISH_PUNCH;

    if (this.mode === 'time' && race.lapTimes.length >= CONFIG.RACE.LAPS) {
      const key = `best.${this.track.def.id}`;
      const prev = storage.get(key, null);
      race.isNewBest = !prev || race.total < prev.total;
      if (race.isNewBest) {
        storage.set(key, { total: race.total, laps: race.lapTimes.slice(), splits: race.splits.slice() });
      }
      race.prevBest = prev ? prev.total : null;
    }
  }

  _showResultsNow() {
    const race = this.race;
    race.resultsShown = true;
    this.setState(STATE.RESULTS);
    if (this.mode === 'time') {
      const m = this.track.medals;
      const total = race.total;
      let medal = null;
      if (total <= m.gold) medal = 'gold';
      else if (total <= m.silver) medal = 'silver';
      else if (total <= m.bronze) medal = 'bronze';
      const lines = race.lapTimes.map((t, i) => `LAP ${i + 1}   ${fmtTime(t)}`);
      if (race.prevBest) lines.push(`PREVIOUS BEST   ${fmtTime(race.prevBest)}`);
      this.ui.showResults({
        title: 'FINISH',
        main: fmtTime(total),
        isNewBest: !!race.isNewBest,
        medal,
        lines,
        targets: [
          `GOLD ${fmtTimeShort(m.gold)} · SILVER ${fmtTimeShort(m.silver)} · BRONZE ${fmtTimeShort(m.bronze)}`,
        ],
      });
    } else {
      this.ui.showResults({
        title: 'TIME UP',
        main: '0',
        isNewBest: false,
        medal: null,
        lines: [],
        targets: [],
      });
    }
  }

  refreshTrackCards() {
    const mode = this.ui.mode;
    const infos = TRACK_DEFS.map((def, i) => {
      const track = getTrack(i);
      let bestText = 'NO RECORD';
      let medals = [];
      if (mode === 'time') {
        const best = storage.get(`best.${def.id}`, null);
        if (best) bestText = `BEST ${fmtTime(best.total)}`;
        const m = track.medals;
        medals = [
          { tier: 'gold', label: `G ${fmtTimeShort(m.gold)}`, earned: best && best.total <= m.gold },
          { tier: 'silver', label: `S ${fmtTimeShort(m.silver)}`, earned: best && best.total <= m.silver },
          { tier: 'bronze', label: `B ${fmtTimeShort(m.bronze)}`, earned: best && best.total <= m.bronze },
        ];
      } else {
        const hs = storage.get(`drift.${def.id}`, null);
        if (hs) bestText = `BEST ${Math.floor(hs).toLocaleString('en-US')}`;
      }
      return { name: def.name, diff: def.diff, thumb: track.mini.canvas, bestText, medals };
    });
    this.ui.buildTrackCards(infos);
  }

  toggleSetting(name) {
    this.settings[name] = !this.settings[name];
    storage.set('settings', this.settings);
    this.ui.reflectSettings(this.settings);
  }

  toggleMute() {
    this.muted = !this.muted;
    storage.set('muted', this.muted);
  }

  // ------------------------------------------------------------------ loop
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    let frameMs = now - this._last;
    this._last = now;
    if (frameMs < 0) frameMs = 0;
    if (frameMs > 250) frameMs = 250;
    this._fpsPush(frameMs);

    const rdt = Math.min(frameMs, CONFIG.MAX_FRAME_MS) / 1000;
    this._t += rdt;
    this.stateTime += rdt;

    if (this.slowmo > 0) {
      this.slowmo -= rdt;
      this.timeScale = this.slowmo > 0 ? CONFIG.FX.SLOWMO_SCALE : 1;
    }

    this.handleGlobalInput();

    this._stepsThisFrame = 0;
    if (this.state === STATE.RACE || this.state === STATE.RESULTS) {
      this.updateCountdown(rdt);
      const h = 1 / CONFIG.PHYSICS_HZ;
      this.acc += rdt * this.timeScale;
      while (this.acc >= h && this._stepsThisFrame < CONFIG.MAX_STEPS_PER_FRAME) {
        this.fixedStep(h);
        this.acc -= h;
        this._stepsThisFrame++;
      }
      if (this._stepsThisFrame >= CONFIG.MAX_STEPS_PER_FRAME) this.acc = 0;
      this.alpha = this.acc / h;
    }

    this.render(rdt);
    this.ui.update(rdt);
    this._updateDebug(frameMs);
    this.input.clearEdges();
  }

  handleGlobalInput() {
    const inp = this.input;
    if (inp.consume('debug')) this.debugOn = this.ui.toggleDebug();
    if (inp.consume('mute')) this.toggleMute();

    switch (this.state) {
      case STATE.TITLE:
        if (inp.consume('any')) {
          this.ui.showScreen('select');
          this.setState(STATE.SELECT);
        }
        break;
      case STATE.SELECT:
        if (inp.consume('pause')) { this.ui.showScreen('title'); this.setState(STATE.TITLE); }
        break;
      case STATE.RACE:
        if (inp.consume('pause')) { this.pause(); break; }
        if (inp.consume('respawn')) this._respawnQueued = true;
        break;
      case STATE.PAUSED:
        if (inp.consume('pause')) this.resume();
        break;
      case STATE.RESULTS:
        if (inp.consume('pause')) this.quitToSelect();
        break;
    }
  }

  updateCountdown(rdt) {
    const race = this.race;
    if (!race) return;
    if (race.phase === 'countdown') {
      race.cd -= rdt;
      const n = Math.ceil(race.cd);
      if (race.cd <= 0) {
        race.phase = 'running';
        this.ui.setCountdown('GO!');
        race.goTimer = 0.8;
      } else {
        this.ui.setCountdown(String(n));
      }
    } else if (race.goTimer != null && race.goTimer > 0) {
      race.goTimer -= rdt;
      if (race.goTimer <= 0) this.ui.setCountdown(null);
    }
    if (race.phase === 'finished' && !race.resultsShown) {
      race.finishT += rdt;
      if (race.finishT > 1.35) this._showResultsNow();
    }
  }

  // ------------------------------------------------------------ fixed step
  fixedStep(h) {
    const race = this.race;
    if (!race) return;
    const car = this.car;
    const inp = this.input;

    const locked = race.phase !== 'running';
    const steer = locked ? 0 : inp.steer;
    const throttle = locked ? 0 : inp.effectiveThrottle();
    const brake = locked ? 0 : inp.brake;
    const hb = locked ? false : inp.handbrake;

    if (this._respawnCd > 0) this._respawnCd -= h;
    if (this._respawnQueued) {
      this._respawnQueued = false;
      if (race.phase === 'running' && this._respawnCd <= 0) {
        const g = this.track.gatePose(race.lastGate);
        car.reset(g.cx, g.cy, g.heading);
        this._respawnCd = CONFIG.RACE.RESPAWN_COOLDOWN;
      }
    }

    car.step(h, steer, throttle, brake, hb);
    const impact = this.track.collideCar(car);
    if (impact > 0) this._onWallHit(impact);

    if (race.phase === 'running') {
      race.time += h;

      // checkpoint gates: must be crossed in order (blocks shortcuts)
      if (this.track.crossedGate(race.expected, car.prevX, car.prevY, car.x, car.y)) {
        race.lastGate = race.expected;
        race.splits.push(race.time);
        if (race.expected === 0) {
          const lapT = race.time - race.lapStart;
          race.lapTimes.push(lapT);
          race.lapStart = race.time;
          race.lap++;
          if (this.mode === 'time' && race.lap > CONFIG.RACE.LAPS) this.finishRace();
        }
        race.expected = (race.expected + 1) % this.track.gates.length;
      }

      if (this.mode === 'drift') {
        race.remaining -= h;
        if (race.remaining <= 0) { race.remaining = 0; this.finishRace(); }
      }
    }
  }

  _onWallHit(impact) {
    this.lastImpact = impact;
    const W = CONFIG.WALL;
    if (this.settings.shake) {
      const amp = clamp(impact * W.SHAKE_SCALE, 0, 1) * W.SHAKE_MAX;
      if (amp > this.cam.shakeAmp) this.cam.shakeAmp = amp;
    }
  }

  // ---------------------------------------------------------------- render
  render(rdt) {
    const ctx = this.ctx;
    if (this.state === STATE.TITLE || this.state === STATE.SELECT) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.renderTitleBG(ctx);
      return;
    }
    this.renderWorld(ctx, rdt);
    this.updateHud();
  }

  updateCamera(rdt, ix, iy) {
    const cam = this.cam, cc = CONFIG.CAMERA, car = this.car;
    const tx = ix + car.vx * cc.LOOKAHEAD;
    const ty = iy + car.vy * cc.LOOKAHEAD;
    const k = 1 - Math.exp(-cc.FOLLOW_RATE * rdt);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;

    const sp01 = clamp(car.speed / CONFIG.CAR.TOP_SPEED, 0, 1);
    const zt = this.viewScale * lerp(cc.ZOOM_BASE, cc.ZOOM_AT_SPEED, sp01) * (1 + cam.punch);
    cam.zoom += (zt - cam.zoom) * (1 - Math.exp(-cc.ZOOM_RATE * rdt));
    cam.punch *= Math.exp(-3.2 * rdt);

    cam.shakeAmp *= Math.exp(-CONFIG.WALL.SHAKE_DECAY * rdt);
    if (cam.shakeAmp < 0.05) cam.shakeAmp = 0;
    if (this.settings.shake && cam.shakeAmp > 0) {
      cam.shakeX = (Math.random() * 2 - 1) * cam.shakeAmp;
      cam.shakeY = (Math.random() * 2 - 1) * cam.shakeAmp;
    } else {
      cam.shakeX = 0; cam.shakeY = 0;
    }
  }

  renderWorld(ctx, rdt) {
    const dpr = this.dpr, w = this.w, h = this.h;
    const car = this.car, a = this.alpha;
    const track = this.track;

    const ix = lerp(car.prevX, car.x, a);
    const iy = lerp(car.prevY, car.y, a);
    const ih = angleLerp(car.prevHeading, car.heading, a);
    this.updateCamera(rdt, ix, iy);

    const cam = this.cam, zoom = cam.zoom;
    const camX = cam.x + cam.shakeX, camY = cam.y + cam.shakeY;

    // background = parallax starfield (opaque tile, one full-screen fill)
    if (!this.starPattern) this.starPattern = ctx.createPattern(this.starTile, 'repeat');
    const px = camX * 0.3, py = camY * 0.3;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (w / 2 - px * zoom), dpr * (h / 2 - py * zoom));
    const vwS = w / zoom, vhS = h / zoom;
    ctx.fillStyle = this.starPattern;
    ctx.fillRect(px - vwS / 2, py - vhS / 2, vwS, vhS);

    // world transform
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (w / 2 - camX * zoom), dpr * (h / 2 - camY * zoom));
    const vw = w / zoom, vh = h / zoom;
    const left = camX - vw / 2, top = camY - vh / 2;
    const right = left + vw, bottom = top + vh;

    // neon grid floor
    this._drawGrid(ctx, left, top, right, bottom, zoom);

    // track: baked base + live crisp neon edge cores (visible chunks only)
    track.drawBase(ctx, left, top, right, bottom);
    const tc = track.renderColors;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    this._strokeChunks(ctx, track.outerChunks, tc.outerStrokes, left, top, right, bottom);
    this._strokeChunks(ctx, track.innerChunks, tc.innerStrokes, left, top, right, bottom);

    // car shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(ix + 3, iy + 5, 23, 15, ih, 0, TAU);
    ctx.fill();

    // car sprite
    ctx.save();
    ctx.translate(ix, iy);
    ctx.rotate(ih);
    ctx.drawImage(this.carSprite, -35, -35, 70, 70);
    ctx.restore();

    // minimap
    this._drawMinimap(ix, iy);
  }

  _strokeChunks(ctx, chunks, strokes, left, top, right, bottom) {
    for (let s = 1; s < strokes.length; s++) {
      ctx.strokeStyle = strokes[s][0];
      ctx.lineWidth = strokes[s][1];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c.maxX < left || c.minX > right || c.maxY < top || c.minY > bottom) continue;
        ctx.stroke(c.path);
      }
    }
  }

  _drawGrid(ctx, left, top, right, bottom, zoom) {
    const minor = 240, major = 1200;
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = CONFIG.COLORS.GRID;
    ctx.beginPath();
    for (let x = Math.floor(left / minor) * minor; x <= right; x += minor) {
      if (x % major === 0) continue;
      ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    }
    for (let y = Math.floor(top / minor) * minor; y <= bottom; y += minor) {
      if (y % major === 0) continue;
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    ctx.stroke();
    ctx.strokeStyle = CONFIG.COLORS.GRID_MAJOR;
    ctx.lineWidth = 1.6 / zoom;
    ctx.beginPath();
    for (let x = Math.floor(left / major) * major; x <= right; x += major) {
      ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    }
    for (let y = Math.floor(top / major) * major; y <= bottom; y += major) {
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    ctx.stroke();
  }

  _drawMinimap(carX, carY) {
    const g = this.miniCtx;
    if (!g) return;
    const track = this.track;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, 440, 320);
    g.drawImage(track.mini.canvas, 0, 0);
    const p = track.worldToMini(carX, carY, this._miniTmp || (this._miniTmp = { x: 0, y: 0 }));
    g.fillStyle = '#ff2d95';
    g.beginPath(); g.arc(p.x, p.y, 9, 0, TAU); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(p.x, p.y, 4, 0, TAU); g.fill();
  }

  updateHud() {
    const race = this.race, car = this.car, ui = this.ui;
    if (!race) return;
    ui.setSpeed(Math.round(car.speed * CONFIG.SPEED_DISPLAY));
    if (this.mode === 'time') {
      ui.setLap(`${Math.min(race.lap, CONFIG.RACE.LAPS)}/${CONFIG.RACE.LAPS}`);
      ui.setTime(fmtTime(race.phase === 'finished' ? race.total : race.time));
    } else {
      const r = Math.max(0, race.remaining);
      const m = Math.floor(r / 60), s = Math.floor(r % 60);
      ui.setDriftTimer(`${m}:${s < 10 ? '0' : ''}${s}`, r < 15);
      ui.setTime(fmtTime(race.time));
    }
  }

  // synthwave poster backdrop: stars, sun, perspective grid
  renderTitleBG(ctx) {
    const w = this.w, h = this.h, t = this._t;
    const horizon = h * 0.55;

    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#070b1f');
    sky.addColorStop(0.65, '#10103a');
    sky.addColorStop(1, '#2b0f4a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);

    ctx.fillStyle = '#cfe9ff';
    for (let i = 0; i < this._stars.length; i++) {
      const s = this._stars[i];
      const a = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.8 + s.tw));
      ctx.globalAlpha = a * 0.8;
      ctx.fillRect(s.x * w, s.y * h, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    const sunR = Math.min(w, h) * 0.21;
    const sunX = w * 0.5, sunY = horizon - sunR * 0.25;
    const sun = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
    sun.addColorStop(0, '#ffe14d');
    sun.addColorStop(0.55, '#ff8a3d');
    sun.addColorStop(1, '#ff2d95');
    ctx.save();
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, TAU);
    ctx.clip();
    ctx.fillStyle = sun;
    ctx.fillRect(sunX - sunR, sunY - sunR, sunR * 2, sunR * 2);
    ctx.fillStyle = '#070b1f';
    const bands = 7;
    for (let i = 0; i < bands; i++) {
      const k = i / bands;
      const bh = 2 + k * 9;
      const y = sunY - sunR * 0.05 + k * k * sunR * 1.15 + ((t * 14) % (sunR * 0.16));
      ctx.fillRect(sunX - sunR, y, sunR * 2, bh);
    }
    ctx.restore();
    const glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 2.4);
    glow.addColorStop(0, 'rgba(255,100,120,0.20)');
    glow.addColorStop(1, 'rgba(255,100,120,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sunX - sunR * 2.4, sunY - sunR * 2.4, sunR * 4.8, sunR * 4.8);

    const floor = ctx.createLinearGradient(0, horizon, 0, h);
    floor.addColorStop(0, '#1b0b38');
    floor.addColorStop(1, '#070b1f');
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizon, w, h - horizon);

    ctx.lineWidth = 1.5;
    const cx = w * 0.5;
    ctx.strokeStyle = 'rgba(0,240,255,0.35)';
    ctx.beginPath();
    const lanes = 22;
    for (let i = -lanes; i <= lanes; i++) {
      const xb = cx + i * (w * 0.09);
      ctx.moveTo(cx + (xb - cx) * 0.02, horizon);
      ctx.lineTo(xb, h + 40);
    }
    ctx.stroke();
    const rows = 14;
    const scroll = (t * 1.4) % 1;
    for (let n = 0; n < rows; n++) {
      const z = n + 1 - scroll;
      const y = horizon + (h - horizon) * (1 / (1 + z * 0.55)) * 1.55 - 8;
      if (y < horizon || y > h + 30) continue;
      const alpha = Math.max(0, 0.5 - z * 0.035);
      ctx.strokeStyle = `rgba(0,240,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = 1 + (1 - z / rows) * 1.6;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,45,149,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();
  }

  // ----------------------------------------------------------------- debug
  _fpsPush(ms) {
    this._fpsBuf[this._fpsIdx] = ms;
    this._fpsIdx = (this._fpsIdx + 1) % this._fpsBuf.length;
    if (this._fpsCount < this._fpsBuf.length) this._fpsCount++;
    let sum = 0;
    for (let i = 0; i < this._fpsCount; i++) sum += this._fpsBuf[i];
    this.fpsAvg = 1000 * this._fpsCount / Math.max(1, sum);
  }

  _updateDebug(frameMs) {
    if (!this.debugOn) return;
    this._dbgTimer -= frameMs;
    if (this._dbgTimer > 0) return;
    this._dbgTimer = 250;
    const car = this.car;
    const slip = car ? (car.slip * 180 / Math.PI) : 0;
    this.ui.setDebug(
      `FPS    ${this.fpsAvg.toFixed(1)}\n` +
      `frame  ${frameMs.toFixed(1)} ms · steps ${this._stepsThisFrame}\n` +
      `state  ${this.state}${this.race ? '/' + this.race.phase : ''}\n` +
      `speed  ${car.speed.toFixed(0)} px/s · vF ${car.vF.toFixed(0)}\n` +
      `slip   ${slip.toFixed(1)}°${car.drifting ? '  DRIFT' : ''}\n` +
      `zoom   ${this.cam.zoom.toFixed(2)} · ×${this.timeScale.toFixed(2)}`
    );
  }
}

const game = new Game();
game.boot();
