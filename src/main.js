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

const STATE = {
  TITLE: 'title',
  SELECT: 'select',
  RACE: 'race',
  PAUSED: 'paused',
  RESULTS: 'results',
};

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

    // race context (filled by startRace)
    this.trackIndex = 0;
    this.mode = 'time';
    this.track = null;
    this.car = null;

    // title background bits (allocated once)
    this._stars = [];
    let seed = 1234567;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 90; i++) {
      this._stars.push({ x: rnd(), y: rnd() * 0.5, r: 0.5 + rnd() * 1.4, tw: rnd() * 6.28 });
    }
    this._t = 0; // global animation clock (visual only)
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

    // touch controls appear for coarse pointers, or on first touch
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
      this.ui.showTouch(false); // shown during races only; flag remembered
      this._touchUI = true;
    }
    this.input.bindButton(this.ui.el.btnLeft, 'left');
    this.input.bindButton(this.ui.el.btnRight, 'right');
    this.input.bindButton(this.ui.el.btnBrake, 'brake');
    this.input.bindButton(this.ui.el.btnPause, 'pause');
    this.input.bindButton(this.ui.el.btnRespawn, 'respawn');

    this.ui.reflectSettings(this.settings);
    this.ui.showScreen('title');
    this.refreshTrackCards();

    // dev/test hooks (tiny, also used by the smoke test)
    window.__NEON = {
      version: '1.0.0',
      get state() { return game.state; },
      get car() { return game.car; },
      get fpsAvg() { return game.fpsAvg; },
      get particlesLive() { return 0; },
      test: {
        start: (i = 0, mode = 'time') => game.startRace(i, mode),
        skipCountdown: () => { if (game.race) { game.race.phase = 'running'; game.ui.setCountdown(null); } },
        finishRace: () => { if (game.race) game.finishRace(); },
        burstParticles: () => {},
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
  }

  // ------------------------------------------------------------- state mgmt
  setState(s) {
    this.state = s;
    this.stateTime = 0;
  }

  startRace(trackIndex, mode) {
    // requires track + physics modules (next milestones); guard until wired
    if (!this._raceReady) return;
    this._startRaceImpl(trackIndex, mode);
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
    this._last = performance.now(); // don't integrate pause time
  }

  finishRace() { /* implemented with modes milestone */ }

  refreshTrackCards() {
    // placeholder cards until track module lands
    this.ui.buildTrackCards([
      { name: 'SUNSET LOOP', diff: 'FLOWING', thumb: null, bestText: 'coming online…' },
      { name: 'CIRCUIT ROYALE', diff: 'TECHNICAL', thumb: null, bestText: 'coming online…' },
      { name: 'VICE SPIRAL', diff: 'DRIFT HEAVEN', thumb: null, bestText: 'coming online…' },
    ]);
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
    if (frameMs > 250) frameMs = 250;          // debugger stall — swallow
    this._fpsPush(frameMs);

    const rdt = Math.min(frameMs, CONFIG.MAX_FRAME_MS) / 1000; // clamped real dt
    this._t += rdt;
    this.stateTime += rdt;

    // slow-mo bookkeeping (real-time driven)
    if (this.slowmo > 0) {
      this.slowmo -= rdt;
      this.timeScale = this.slowmo > 0 ? CONFIG.FX.SLOWMO_SCALE : 1;
    }

    this.handleGlobalInput();

    // fixed-timestep simulation
    this._stepsThisFrame = 0;
    if (this.state === STATE.RACE || this.state === STATE.RESULTS) {
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
        if (inp.consume('pause')) this.pause();
        break;
      case STATE.PAUSED:
        if (inp.consume('pause')) this.resume();
        break;
      case STATE.RESULTS:
        break;
    }
  }

  // one physics tick at fixed dt (race simulation fills in next milestone)
  fixedStep(h) {
    if (this.race && this._raceStep) this._raceStep(h);
  }

  // ---------------------------------------------------------------- render
  render(rdt) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (this.state === STATE.TITLE || this.state === STATE.SELECT) {
      this.renderTitleBG(ctx);
    } else {
      this.renderWorld(ctx, rdt);
    }
  }

  // synthwave poster backdrop: stars, sun, perspective grid
  renderTitleBG(ctx) {
    const w = this.w, h = this.h, t = this._t;
    const horizon = h * 0.55;

    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#070b1f');
    sky.addColorStop(0.65, '#10103a');
    sky.addColorStop(1, '#2b0f4a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);

    // stars
    ctx.fillStyle = '#cfe9ff';
    for (let i = 0; i < this._stars.length; i++) {
      const s = this._stars[i];
      const a = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.8 + s.tw));
      ctx.globalAlpha = a * 0.8;
      ctx.fillRect(s.x * w, s.y * h, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    // sun: banded gradient disc
    const sunR = Math.min(w, h) * 0.21;
    const sunX = w * 0.5, sunY = horizon - sunR * 0.25;
    const sun = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
    sun.addColorStop(0, '#ffe14d');
    sun.addColorStop(0.55, '#ff8a3d');
    sun.addColorStop(1, '#ff2d95');
    ctx.save();
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = sun;
    ctx.fillRect(sunX - sunR, sunY - sunR, sunR * 2, sunR * 2);
    // horizontal cut bands that slide
    ctx.fillStyle = '#070b1f';
    const bands = 7;
    for (let i = 0; i < bands; i++) {
      const k = i / bands;
      const bh = 2 + k * 9;
      const y = sunY - sunR * 0.05 + k * k * sunR * 1.15 + ((t * 14) % (sunR * 0.16));
      ctx.fillRect(sunX - sunR, y, sunR * 2, bh);
    }
    ctx.restore();
    // sun glow
    const glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 2.4);
    glow.addColorStop(0, 'rgba(255,100,120,0.20)');
    glow.addColorStop(1, 'rgba(255,100,120,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sunX - sunR * 2.4, sunY - sunR * 2.4, sunR * 4.8, sunR * 4.8);

    // floor
    const floor = ctx.createLinearGradient(0, horizon, 0, h);
    floor.addColorStop(0, '#1b0b38');
    floor.addColorStop(1, '#070b1f');
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizon, w, h - horizon);

    // perspective grid — verticals fan from vanishing point
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
    // horizontals roll toward the viewer
    const rows = 14;
    const scroll = (t * 1.4) % 1;
    for (let n = 0; n < rows; n++) {
      const z = n + 1 - scroll;
      const y = horizon + (h - horizon) * (1 / (1 + z * 0.55)) * 1.55 - 8;
      if (y < horizon || y > h + 30) continue;
      const a = Math.max(0, 0.5 - z * 0.035);
      ctx.strokeStyle = `rgba(0,240,255,${a.toFixed(3)})`;
      ctx.lineWidth = 1 + (1 - z / rows) * 1.6;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // horizon line
    ctx.strokeStyle = 'rgba(255,45,149,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();
  }

  // race world render (full version arrives with the track milestone)
  renderWorld(ctx, rdt) {
    ctx.fillStyle = CONFIG.COLORS.BG;
    ctx.fillRect(0, 0, this.w, this.h);
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
    const spd = car ? Math.hypot(car.vx, car.vy) : 0;
    const slip = car ? (car.slip * 180 / Math.PI) : 0;
    this.ui.setDebug(
      `FPS    ${this.fpsAvg.toFixed(1)}\n` +
      `frame  ${frameMs.toFixed(1)} ms · steps ${this._stepsThisFrame}\n` +
      `state  ${this.state}${this.race ? '/' + this.race.phase : ''}\n` +
      `speed  ${spd.toFixed(0)} px/s\n` +
      `slip   ${slip.toFixed(1)}°${car && car.drifting ? '  DRIFT' : ''}\n` +
      `scale  ×${this.timeScale.toFixed(2)}`
    );
  }
}

const game = new Game();
game.boot();
