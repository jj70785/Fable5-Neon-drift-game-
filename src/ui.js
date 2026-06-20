// DOM-based UI: screens (title/select/pause/results), HUD, floating score
// popups, countdown, debug overlay. Canvas draws the world; the DOM draws
// everything readable — crisp text for free and zero canvas text in the
// hot loop. HUD setters cache last values so the DOM only mutates on change.

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(callbacks) {
    this.cb = callbacks; // {onStart(trackIdx), onResume, onRestart, onQuit, onModeChange(mode), onSetting(name, value)}
    this.mode = 'time';  // 'time' | 'drift'

    this.el = {
      hud: $('hud'), lap: $('lap-text'), time: $('time-text'),
      deltaBox: $('hud-delta'), delta: $('delta-text'),
      posBox: $('hud-pos'), pos: $('pos-text'),
      speed: $('speed-text'),
      driftBox: $('hud-drift'), driftScore: $('drift-score'),
      driftPending: $('drift-pending'), driftMult: $('drift-mult'), driftTimer: $('drift-timer'),
      minimap: $('minimap'),
      debug: $('debug-overlay'),
      touch: $('touch-controls'),
      btnLeft: $('btn-left'), btnRight: $('btn-right'), btnBrake: $('btn-brake'),
      btnGas: $('btn-gas'), btnNitro: $('btn-nitro'),
      nitroBox: $('hud-nitro'), nitroFill: $('nitro-fill'),
      btnPause: $('btn-pause'), btnRespawn: $('btn-respawn'),
      popupLayer: $('popup-layer'),
      countdown: $('countdown'),
      title: $('menu-title'), select: $('menu-select'), pause: $('menu-pause'), results: $('menu-results'),
      modeTime: $('mode-time'), modeDrift: $('mode-drift'), modeGP: $('mode-gp'), modeDesc: $('mode-desc'),
      trackRow: $('track-row'),
      setMusic: $('set-music'), setSfx: $('set-sfx'), setShake: $('set-shake'),
      setHaptics: $('set-haptics'),
      resultsTitle: $('results-title'), resultsNewBest: $('results-new-best'),
      resultsMain: $('results-main'), resultsMedal: $('results-medal'),
      resultsLaps: $('results-laps'), resultsTargets: $('results-targets'),
    };

    // HUD value caches (avoid DOM writes when nothing changed)
    this._c = { speed: -1, lap: '', time: '', score: -1, pending: -1, mult: -1, timer: '', delta: '', pos: -1, nitro: -1, nitroReady: null, nitroActive: null };

    // pooled floating popups
    this.popups = [];
    for (let i = 0; i < 12; i++) {
      const div = document.createElement('div');
      div.className = 'popup';
      div.style.display = 'none';
      this.el.popupLayer.appendChild(div);
      this.popups.push({ el: div, active: false, x: 0, y: 0, vy: 0, age: 0, life: 1 });
    }

    this._wire();
  }

  _wire() {
    const cb = this.cb;
    this.el.modeTime.addEventListener('click', () => this.setMode('time'));
    this.el.modeDrift.addEventListener('click', () => this.setMode('drift'));
    this.el.modeGP.addEventListener('click', () => this.setMode('gp'));
    $('pause-resume').addEventListener('click', () => cb.onResume());
    $('pause-restart').addEventListener('click', () => cb.onRestart());
    $('pause-quit').addEventListener('click', () => cb.onQuit());
    $('results-retry').addEventListener('click', () => cb.onRestart());
    $('results-tracks').addEventListener('click', () => cb.onQuit());
    $('results-menu').addEventListener('click', () => cb.onMainMenu());
    this.el.setMusic.addEventListener('click', () => cb.onSetting('music'));
    this.el.setSfx.addEventListener('click', () => cb.onSetting('sfx'));
    this.el.setShake.addEventListener('click', () => cb.onSetting('shake'));
    this.el.setHaptics.addEventListener('click', () => cb.onSetting('haptics'));
    if (!navigator.vibrate) this.el.setHaptics.style.display = 'none';
  }

  setMode(mode) {
    this.mode = mode;
    this.el.modeTime.classList.toggle('active', mode === 'time');
    this.el.modeDrift.classList.toggle('active', mode === 'drift');
    this.el.modeGP.classList.toggle('active', mode === 'gp');
    this.el.modeDesc.textContent =
      mode === 'time' ? '3 laps against the clock. Beat medal times, race your ghost.'
        : mode === 'drift' ? '120 seconds. Chain drifts to multiply your score — walls forfeit the chain.'
          : 'Race 3 rivals over 3 laps. Bump, drift and boost your way to the podium.';
    if (this.cb.onModeChange) this.cb.onModeChange(mode);
  }

  reflectSettings(s) {
    this.el.setMusic.textContent = s.music ? 'MUSIC ON' : 'MUSIC OFF';
    this.el.setMusic.classList.toggle('off', !s.music);
    this.el.setSfx.textContent = s.sfx ? 'SFX ON' : 'SFX OFF';
    this.el.setSfx.classList.toggle('off', !s.sfx);
    this.el.setShake.textContent = s.shake ? 'SHAKE ON' : 'SHAKE OFF';
    this.el.setShake.classList.toggle('off', !s.shake);
    this.el.setHaptics.textContent = s.haptics ? 'HAPTICS ON' : 'HAPTICS OFF';
    this.el.setHaptics.classList.toggle('off', !s.haptics);
  }

  // info: [{name, diff, thumb (canvas|null), bestText, medals:[{tier,label,earned}]}]
  buildTrackCards(infos) {
    this.el.trackRow.textContent = '';
    infos.forEach((info, i) => {
      const card = document.createElement('button');
      card.className = 'track-card';
      const c = document.createElement('canvas');
      c.width = 212; c.height = 110;
      if (info.thumb) {
        const g = c.getContext('2d');
        const s = Math.min(c.width / info.thumb.width, c.height / info.thumb.height);
        const w = info.thumb.width * s, h = info.thumb.height * s;
        g.drawImage(info.thumb, (c.width - w) / 2, (c.height - h) / 2, w, h);
      }
      card.appendChild(c);
      const name = document.createElement('div');
      name.className = 'track-name'; name.textContent = info.name;
      card.appendChild(name);
      const diff = document.createElement('div');
      diff.className = 'track-diff'; diff.textContent = info.diff;
      card.appendChild(diff);
      const best = document.createElement('div');
      best.className = 'track-best'; best.textContent = info.bestText || '—';
      card.appendChild(best);
      if (info.medals && info.medals.length) {
        const row = document.createElement('div');
        row.className = 'track-medals';
        for (const m of info.medals) {
          const el = document.createElement('span');
          el.className = `medal ${m.tier}${m.earned ? ' earned' : ''}`;
          el.textContent = m.label;
          row.appendChild(el);
        }
        card.appendChild(row);
      }
      card.addEventListener('click', () => this.cb.onStart(i));
      this.el.trackRow.appendChild(card);
    });
  }

  showScreen(name) {
    this.el.title.classList.toggle('hidden', name !== 'title');
    this.el.select.classList.toggle('hidden', name !== 'select');
    this.el.pause.classList.toggle('hidden', name !== 'pause');
    this.el.results.classList.toggle('hidden', name !== 'results');
  }

  showHud(on) { this.el.hud.classList.toggle('hidden', !on); }
  showTouch(on) { this.el.touch.classList.toggle('hidden', !on); }
  showDriftHud(on) { this.el.driftBox.classList.toggle('hidden', !on); }
  showLap(on) { $('hud-lap').classList.toggle('hidden', !on); }
  showPos(on) { this.el.posBox.classList.toggle('hidden', !on); }
  setPos(place) {
    if (place !== this._c.pos) { this._c.pos = place; this.el.pos.textContent = 'P' + place; }
  }
  showNitro(on) { this.el.nitroBox.classList.toggle('hidden', !on); }
  setNitro(charge, active) {
    const pct = Math.round(charge * 100);
    if (pct !== this._c.nitro) {
      this._c.nitro = pct;
      this.el.nitroFill.style.width = pct + '%';
    }
    const ready = charge >= 0.999;
    if (ready !== this._c.nitroReady) {
      this._c.nitroReady = ready;
      this.el.nitroBox.classList.toggle('full', ready);
    }
    if (active !== this._c.nitroActive) {
      this._c.nitroActive = active;
      this.el.nitroBox.classList.toggle('firing', active);
    }
  }

  // ---- HUD setters (cached) ----
  setSpeed(kmh) {
    if (kmh !== this._c.speed) { this._c.speed = kmh; this.el.speed.textContent = kmh; }
  }
  setLap(text) {
    if (text !== this._c.lap) { this._c.lap = text; this.el.lap.textContent = text; }
  }
  setTime(text) {
    if (text !== this._c.time) { this._c.time = text; this.el.time.textContent = text; }
  }
  setDelta(text, ahead) {
    if (text === null) { this.el.deltaBox.classList.add('hidden'); this._c.delta = ''; return; }
    this.el.deltaBox.classList.remove('hidden');
    this.el.deltaBox.classList.toggle('ahead', ahead);
    this.el.deltaBox.classList.toggle('behind', !ahead);
    if (text !== this._c.delta) { this._c.delta = text; this.el.delta.textContent = text; }
  }
  setDriftScore(score) {
    const v = Math.floor(score);
    if (v !== this._c.score) {
      this._c.score = v;
      this.el.driftScore.textContent = v.toLocaleString('en-US');
    }
  }
  bumpScore() {
    this.el.driftScore.classList.remove('bump');
    void this.el.driftScore.offsetWidth; // restart CSS animation
    this.el.driftScore.classList.add('bump');
  }
  setDriftPending(points, mult) {
    const p = Math.floor(points);
    if (p <= 0) {
      this.el.driftPending.classList.add('hidden');
      this.el.driftMult.classList.toggle('hidden', mult <= 1);
    } else {
      this.el.driftPending.classList.remove('hidden');
      this.el.driftMult.classList.remove('hidden');
      if (p !== this._c.pending) { this._c.pending = p; this.el.driftPending.textContent = '+' + p.toLocaleString('en-US'); }
    }
    if (mult !== this._c.mult) {
      this._c.mult = mult;
      this.el.driftMult.textContent = '×' + mult;
      if (mult > 1) {
        this.el.driftMult.classList.remove('bump');
        void this.el.driftMult.offsetWidth;
        this.el.driftMult.classList.add('bump');
      }
    }
  }
  setDriftTimer(text, low) {
    this.el.driftTimer.classList.remove('hidden');
    if (text !== this._c.timer) { this._c.timer = text; this.el.driftTimer.textContent = text; }
    this.el.driftTimer.classList.toggle('low', low);
  }
  hideDriftTimer() { this.el.driftTimer.classList.add('hidden'); }

  // ---- countdown ----
  setCountdown(text) {
    const el = this.el.countdown;
    if (text === null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    if (el.textContent !== text) {
      el.textContent = text;
      el.classList.remove('tick');
      void el.offsetWidth;
      el.classList.add('tick');
    }
  }

  // ---- popups ----
  spawnPopup(x, y, text, bad = false) {
    let p = this.popups.find(q => !q.active) || this.popups[0];
    p.active = true; p.age = 0; p.life = 1.1;
    p.x = x; p.y = y; p.vy = -52;
    p.el.textContent = text;
    p.el.classList.toggle('bad', bad);
    p.el.style.display = 'block';
    p.el.style.opacity = '1';
  }

  update(dt) {
    for (const p of this.popups) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        p.el.style.display = 'none';
        continue;
      }
      p.y += p.vy * dt;
      p.vy *= (1 - 1.6 * dt);
      const k = p.age / p.life;
      p.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%,-50%) scale(${1 + k * 0.12})`;
      p.el.style.opacity = k > 0.55 ? String(1 - (k - 0.55) / 0.45) : '1';
    }
  }

  clearPopups() {
    for (const p of this.popups) { p.active = false; p.el.style.display = 'none'; }
  }

  // ---- results ----
  // r: {mode, title, main, isNewBest, medal, lapsHtml[], targets[]}
  showResults(r) {
    this.el.resultsTitle.textContent = r.title;
    this.el.resultsMain.textContent = r.main;
    this.el.resultsNewBest.classList.toggle('hidden', !r.isNewBest);
    if (r.medal) {
      this.el.resultsMedal.className = 'medal-banner ' + r.medal;
      this.el.resultsMedal.id = 'results-medal';
      this.el.resultsMedal.classList.remove('hidden');
      this.el.resultsMedal.textContent = r.medal.toUpperCase() + ' MEDAL';
    } else {
      this.el.resultsMedal.classList.add('hidden');
    }
    this.el.resultsLaps.textContent = '';
    for (const line of (r.lines || [])) {
      const div = document.createElement('div');
      div.textContent = line;
      this.el.resultsLaps.appendChild(div);
    }
    this.el.resultsTargets.textContent = '';
    for (const line of (r.targets || [])) {
      const div = document.createElement('div');
      div.textContent = line;
      this.el.resultsTargets.appendChild(div);
    }
    this.showScreen('results');
  }

  // ---- debug ----
  toggleDebug() {
    this.el.debug.classList.toggle('hidden');
    return !this.el.debug.classList.contains('hidden');
  }
  setDebug(text) {
    if (!this.el.debug.classList.contains('hidden')) this.el.debug.textContent = text;
  }
}

// time formatting helpers shared by HUD + results
export function fmtTime(t) {
  if (t == null || !isFinite(t)) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}
export function fmtDelta(d) {
  const sign = d <= 0 ? '−' : '+';
  return `${sign}${Math.abs(d).toFixed(2)}`;
}
