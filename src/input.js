// Unified input: keyboard + touch produce one state object the game reads.
//   steer: -1..1, throttle: 0..1, brake: 0..1, handbrake: bool
//   edge-triggered actions are collected per frame via consume().
// Touch: pointer events, multi-touch safe (per-pointer bookkeeping), with
// auto-throttle while touch controls are active.

export class Input {
  constructor() {
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;

    this.keys = new Set();
    this.edges = new Set();      // action names pressed since last consume
    this.touchActive = false;    // becomes true on first touch interaction
    this.touch = { left: false, right: false, brake: false };
    this._touchPointers = new Map(); // pointerId -> control name
    this.onFirstGesture = null;  // hook: create/resume AudioContext
    this._gestureFired = false;
  }

  attach() {
    window.addEventListener('keydown', (e) => this._onKey(e, true), { passive: false });
    window.addEventListener('keyup', (e) => this._onKey(e, false), { passive: false });
    window.addEventListener('pointerdown', () => this._gesture(), { capture: true });
    window.addEventListener('blur', () => this.releaseAll());
  }

  _gesture() {
    if (this._gestureFired) return;
    this._gestureFired = true;
    if (this.onFirstGesture) this.onFirstGesture();
  }

  _onKey(e, down) {
    if (down) this._gesture();
    const code = e.code;
    // the page is the game: stop arrows/space scrolling and F3 dev tools
    if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' ||
        code === 'ArrowRight' || code === 'Space' || code === 'F3' || code === 'Tab') {
      e.preventDefault();
    }
    if (down && !e.repeat) {
      this.edges.add('any');
      switch (code) {
        case 'KeyR': this.edges.add('respawn'); break;
        case 'Escape': case 'KeyP': this.edges.add('pause'); break;
        case 'KeyM': this.edges.add('mute'); break;
        case 'F3': this.edges.add('debug'); break;
        case 'Enter': this.edges.add('confirm'); break;
      }
    }
    if (down) this.keys.add(code); else this.keys.delete(code);
    this._recompute();
  }

  // wire one touch button to a named control; multi-touch safe
  bindButton(el, name) {
    const press = (e) => {
      e.preventDefault();
      this._gesture();
      this.touchActive = true;
      this._touchPointers.set(e.pointerId, name);
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* detached */ }
      this._applyTouch(name, true);
      if (name === 'pause') this.edges.add('pause');
      if (name === 'respawn') this.edges.add('respawn');
      this.edges.add('any');
    };
    const release = (e) => {
      if (!this._touchPointers.has(e.pointerId)) return;
      this._touchPointers.delete(e.pointerId);
      this._applyTouch(name, false);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _applyTouch(name, down) {
    if (name === 'left') this.touch.left = down;
    if (name === 'right') this.touch.right = down;
    if (name === 'brake') this.touch.brake = down;
    this._recompute();
  }

  _recompute() {
    const k = this.keys;
    let steer = 0;
    if (k.has('ArrowLeft') || k.has('KeyA')) steer -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) steer += 1;
    if (this.touch.left) steer -= 1;
    if (this.touch.right) steer += 1;
    this.steer = Math.max(-1, Math.min(1, steer));

    this.throttle = (k.has('ArrowUp') || k.has('KeyW')) ? 1 : 0;
    this.brake = (k.has('ArrowDown') || k.has('KeyS')) ? 1 : 0;
    this.handbrake = k.has('Space') || this.touch.brake;
  }

  // auto-throttle for touch play: called by the game during races
  effectiveThrottle() {
    if (this.touchActive && this.throttle === 0 && this.brake === 0) return 1;
    return this.throttle;
  }

  consume(action) {
    if (this.edges.has(action)) { this.edges.delete(action); return true; }
    return false;
  }

  clearEdges() { this.edges.clear(); }

  releaseAll() {
    this.keys.clear();
    this._touchPointers.clear();
    this.touch.left = this.touch.right = this.touch.brake = false;
    this._recompute();
  }
}
