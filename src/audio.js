// ============================================================================
// All audio is synthesized live with the Web Audio API — zero samples.
//
//   engine : two detuned saw/square oscillators → lowpass; pitch + cutoff
//            track speed and throttle
//   skid   : looped noise buffer → bandpass; gain tracks slip × speed
//   hits   : noise burst + sine thump scaled by impact
//   UI     : short oscillator blips/arps
//   music  : generative synthwave loop @ 100 BPM — four-on-the-floor kick,
//            snare, hats, sidechained bass (Am F C G), pentatonic arpeggio
//            through a dotted-eighth feedback delay, slow pad
//
// The AudioContext is created/resumed on the first user gesture (autoplay
// rules). Every public method is safe to call before init.
// ============================================================================

import { CONFIG } from './config.js';

const A = CONFIG.AUDIO;

// note helper: semitones from A4 → Hz
const N = (semi) => 440 * Math.pow(2, semi / 12);
// Am pentatonic-ish pool per chord (Am, F, C, G), two octaves
const CHORDS = [
  { root: N(-24),  arp: [N(-12), N(-9), N(-5), N(0), N(3), N(0), N(-5), N(-9)] },   // Am: A C E A C…
  { root: N(-28),  arp: [N(-16), N(-12), N(-7), N(-4), N(0), N(-4), N(-7), N(-12)] }, // F:  F A C E
  { root: N(-33),  arp: [N(-21), N(-17), N(-14), N(-9), N(-5), N(-9), N(-14), N(-17)] }, // C
  { root: N(-26),  arp: [N(-14), N(-10), N(-7), N(-2), N(2), N(-2), N(-7), N(-10)] },  // G
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.musicOn = true;
    this.sfxOn = true;
    this._musicPlaying = false;
    this._step = 0;            // 16th-note scheduler position
    this._nextNoteTime = 0;
    this._noiseBuf = null;
  }

  // ---- lifecycle -----------------------------------------------------------
  init() {
    if (this.ready) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
    } catch (e) { return; }
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : A.MASTER;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 9;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxOn ? 1 : 0;
    this.sfxBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicOn ? A.MUSIC : 0;
    this.duck = ctx.createGain();          // sidechain pump
    this.duck.connect(this.musicBus);
    this.musicBus.connect(this.master);

    // --- engine voice
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 400;
    this.engFilter.Q.value = 1.1;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 70;
    const sq = ctx.createOscillator();
    sq.type = 'square';
    sq.frequency.value = 35;
    sq.detune.value = 9;
    const sqG = ctx.createGain(); sqG.gain.value = 0.55;
    saw.connect(this.engFilter);
    sq.connect(sqG); sqG.connect(this.engFilter);
    this.engFilter.connect(this.engGain);
    this.engGain.connect(this.sfxBus);
    saw.start(); sq.start();
    this.engSaw = saw; this.engSq = sq;

    // --- skid voice (band-passed noise)
    this._noiseBuf = this._makeNoise(1.2);
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    const skidBP = ctx.createBiquadFilter();
    skidBP.type = 'bandpass';
    skidBP.frequency.value = 880;
    skidBP.Q.value = 0.9;
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this._noiseBuf;
    skidSrc.loop = true;
    skidSrc.connect(skidBP);
    skidBP.connect(this.skidGain);
    this.skidGain.connect(this.sfxBus);
    skidSrc.start();

    // --- music delay (dotted eighth @ 100 BPM = 0.225 s)
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = (60 / A.BPM) * 0.75;
    this.delayFb = ctx.createGain(); this.delayFb.gain.value = 0.34;
    this.delayWet = ctx.createGain(); this.delayWet.gain.value = 0.22;
    this.delay.connect(this.delayFb); this.delayFb.connect(this.delay);
    this.delay.connect(this.delayWet); this.delayWet.connect(this.duck);

    this.ready = true;
  }

  // best-effort autoplay before any gesture: succeeds on engaged origins /
  // revisits (mostly desktop); silently stays pending where policy blocks it
  tryAutostart() {
    try {
      this.init();
      if (!this.ready) return;
      this.ctx.resume().then(() => {
        if (this.ctx.state === 'running') this.startMusic();
      }).catch(() => {});
    } catch (e) { /* blocked — the first-gesture path will start it */ }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setMuted(m) {
    this.muted = m;
    if (this.ready) this.master.gain.setTargetAtTime(m ? 0 : A.MASTER, this.ctx.currentTime, 0.03);
  }
  setMusicOn(on) {
    this.musicOn = on;
    if (this.ready) this.musicBus.gain.setTargetAtTime(on ? A.MUSIC : 0, this.ctx.currentTime, 0.05);
  }
  setSfxOn(on) {
    this.sfxOn = on;
    if (this.ready) this.sfxBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
  }

  // ---- continuous voices (called every frame) ------------------------------
  // speed01/throttle 0..1; slip01 0..1 drives the skid noise
  setEngine(speed01, throttle, slip01) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const rpm = 0.25 + speed01 * 0.75 + throttle * 0.1;
    const f = 62 + rpm * 250;
    this.engSaw.frequency.setTargetAtTime(f, t, 0.04);
    this.engSq.frequency.setTargetAtTime(f / 2, t, 0.04);
    const cutoff = 260 + (speed01 * 0.75 + throttle * 0.45) * 3000;
    this.engFilter.frequency.setTargetAtTime(Math.min(3600, cutoff), t, 0.05);
    const vol = (0.05 + speed01 * 0.085 + throttle * 0.05) * (A.ENGINE / 0.17);
    this.engGain.gain.setTargetAtTime(vol, t, 0.06);

    this.skidGain.gain.setTargetAtTime(Math.min(1, slip01) * A.SKID, t, 0.05);
  }

  engineOff() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.engGain.gain.setTargetAtTime(0, t, 0.08);
    this.skidGain.gain.setTargetAtTime(0, t, 0.05);
  }

  // ---- one-shots -----------------------------------------------------------
  _blip(freq, dur, type, vol, when = 0, dest = null) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(dest || this.sfxBus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  uiMove() { this._blip(660, 0.07, 'square', 0.12 * A.UI); }
  uiSelect() {
    this._blip(523, 0.09, 'square', 0.14 * A.UI);
    this._blip(784, 0.12, 'square', 0.12 * A.UI, 0.07);
  }
  uiBack() { this._blip(392, 0.1, 'square', 0.12 * A.UI); }

  countdown(go) {
    if (go) {
      this._blip(880, 0.34, 'square', 0.2 * A.UI);
      this._blip(1108, 0.4, 'square', 0.16 * A.UI, 0.02);
    } else {
      this._blip(440, 0.16, 'square', 0.18 * A.UI);
    }
  }

  bank(mult) {
    // little rising "ka-ching" that climbs with the multiplier
    const base = 587 + Math.min(mult, 8) * 49;
    this._blip(base, 0.1, 'triangle', 0.22 * A.UI);
    this._blip(base * 1.335, 0.16, 'triangle', 0.2 * A.UI, 0.06);
  }
  multUp(mult) {
    this._blip(440 + mult * 60, 0.07, 'square', 0.16 * A.UI);
    this._blip(660 + mult * 60, 0.1, 'square', 0.14 * A.UI, 0.05);
  }
  forfeit() {
    this._blip(220, 0.18, 'sawtooth', 0.18 * A.UI);
    this._blip(155, 0.26, 'sawtooth', 0.16 * A.UI, 0.07);
  }

  wallHit(impact01) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const v = 0.1 + impact01 * 0.5;
    // noise burst
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700 + impact01 * 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16 + impact01 * 0.1);
    src.connect(lp); lp.connect(g); g.connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + 0.3);
    // body thump
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(v * 0.9, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(og); og.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.25);
  }

  finishFanfare() {
    const seq = [N(0), N(4), N(7), N(12)];
    seq.forEach((f, i) => {
      this._blip(f, 0.3, 'square', 0.16 * A.UI, i * 0.09);
      this._blip(f / 2, 0.35, 'triangle', 0.12 * A.UI, i * 0.09);
    });
  }

  // ---- generative music -----------------------------------------------------
  startMusic() {
    if (!this.ready || this._musicPlaying) return;
    this._musicPlaying = true;
    this._step = 0;
    this._nextNoteTime = this.ctx.currentTime + 0.06;
  }
  stopMusic() { this._musicPlaying = false; }

  // call every frame: schedules 16ths ~0.12 s ahead
  update() {
    if (!this.ready || !this._musicPlaying || this.ctx.state !== 'running') return;
    const SIXTEENTH = 60 / A.BPM / 4;
    while (this._nextNoteTime < this.ctx.currentTime + 0.12) {
      this._scheduleStep(this._step, this._nextNoteTime);
      this._nextNoteTime += SIXTEENTH;
      this._step = (this._step + 1) % 128;        // 8 bars of 16 steps
    }
  }

  _scheduleStep(step, t) {
    const bar = (step / 16) | 0;          // 0..7
    const s16 = step % 16;
    const chord = CHORDS[[0, 0, 1, 1, 2, 2, 3, 3][bar]];

    // kick: four on the floor
    if (s16 % 4 === 0) {
      this._kick(t);
      // sidechain pump
      this.duck.gain.cancelScheduledValues(t);
      this.duck.gain.setValueAtTime(0.55, t);
      this.duck.gain.linearRampToValueAtTime(1, t + 0.22);
    }
    // snare on 2 & 4
    if (s16 === 4 || s16 === 12) this._snare(t);
    // hats: eighths, with 16th fills every other bar
    if (s16 % 2 === 0 || bar % 2 === 1) this._hat(t, s16 % 4 === 2);

    // driving bass: eighths on the chord root, octave pop on the "and"s
    if (s16 % 2 === 0) {
      const up = (s16 % 8 === 6);
      this._bass(chord.root * (up ? 2 : 1), t);
    }
    // arpeggio: 16ths, skipping a few steps for groove
    if (s16 !== 3 && s16 !== 11) {
      this._arp(chord.arp[s16 % 8], t, s16 % 4 === 0 ? 0.05 : 0.034);
    }
    // pad: one soft chord per bar
    if (s16 === 0) this._pad(chord.root * 4, t);
  }

  _kick(t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.42, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g); g.connect(this.musicBus);
    o.start(t); o.stop(t + 0.2);
  }

  _snare(t) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.17, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    src.connect(bp); bp.connect(g); g.connect(this.duck);
    src.start(t, Math.random()); src.stop(t + 0.16);
    const o = ctx.createOscillator();
    o.type = 'triangle'; o.frequency.value = 190;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.1, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(og); og.connect(this.duck);
    o.start(t); o.stop(t + 0.1);
  }

  _hat(t, open) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7400;
    const g = ctx.createGain();
    const dur = open ? 0.09 : 0.035;
    g.gain.setValueAtTime(open ? 0.05 : 0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(hp); hp.connect(g); g.connect(this.duck);
    src.start(t, Math.random()); src.stop(t + dur + 0.02);
  }

  _bass(freq, t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(280, t + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.21, t);
    g.gain.setValueAtTime(0.21, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(lp); lp.connect(g); g.connect(this.duck);
    o.start(t); o.stop(t + 0.18);
  }

  _arp(freq, t, vol) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq * 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g);
    g.connect(this.duck);
    g.connect(this.delay);                 // echoes ride the delay line
    o.start(t); o.stop(t + 0.12);
  }

  _pad(freq, t) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.028, t + 0.5);
    g.gain.linearRampToValueAtTime(0.001, t + 2.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1100;
    lp.connect(g); g.connect(this.duck);
    for (const mul of [1, 1.5, 2.02]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq * mul;
      o.detune.value = (Math.random() - 0.5) * 14;
      o.connect(lp);
      o.start(t); o.stop(t + 2.4);
    }
  }
}
