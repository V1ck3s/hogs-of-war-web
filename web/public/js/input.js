// Keyboard + gamepad input -> RetroPad masks (bit layout of libretro).
import { prefGet, prefSet } from './storage.js';

export const BIT = {
  cross: 0, square: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7,
  circle: 8, triangle: 9, l1: 10, r1: 11, l2: 12, r2: 13, l3: 14, r3: 15,
};

export const ACTIONS = [
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['cross', 'Cross ✕'], ['circle', 'Circle ○'], ['square', 'Square □'], ['triangle', 'Triangle △'],
  ['l1', 'L1'], ['r1', 'R1'], ['l2', 'L2'], ['r2', 'R2'],
  ['start', 'Start'], ['select', 'Select'],
];

// event.code values = physical positions, identical on AZERTY and QWERTY
// for the letters chosen here (S D X C E R F G).
export const DEFAULT_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  cross: 'KeyX', circle: 'KeyC', square: 'KeyS', triangle: 'KeyD',
  l1: 'KeyE', r1: 'KeyR', l2: 'KeyF', r2: 'KeyG',
  start: 'Enter', select: 'Backspace',
};

// Standard Gamepad mapping button index -> action
const PAD_BUTTONS = {
  0: 'cross', 1: 'circle', 2: 'square', 3: 'triangle', 4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2',
  8: 'select', 9: 'start', 10: 'l3', 11: 'r3', 12: 'up', 13: 'down', 14: 'left', 15: 'right',
};

export class Input {
  constructor() {
    this.keys = { ...DEFAULT_KEYS, ...prefGet('keys', {}) };
    this.down = new Set();
    this.listeners = [];
    this.capture = null; // (code) => void while remapping
    this.enabled = true;
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.down.clear());
  }

  onKey(e, isDown) {
    if (this.capture && isDown) {
      e.preventDefault();
      const cb = this.capture; this.capture = null; cb(e.code);
      return;
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const mapped = Object.values(this.keys).includes(e.code);
    if (isDown) this.down.add(e.code); else this.down.delete(e.code);
    if (mapped) e.preventDefault();
    for (const l of this.listeners) l(e, isDown);
  }

  onRawKey(fn) { this.listeners.push(fn); }

  setKey(action, code) {
    for (const [a, c] of Object.entries(this.keys)) if (c === code && a !== action) this.keys[a] = '';
    this.keys[action] = code;
    prefSet('keys', this.keys);
  }

  resetKeys() { this.keys = { ...DEFAULT_KEYS }; prefSet('keys', this.keys); }

  keyboardMask() {
    if (!this.enabled) return 0;
    let m = 0;
    for (const [a, code] of Object.entries(this.keys)) if (code && this.down.has(code)) m |= 1 << BIT[a];
    return m;
  }

  /** Masks of connected gamepads, in navigator order. */
  gamepadMasks() {
    const out = [];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      let m = 0;
      gp.buttons.forEach((b, i) => {
        const a = PAD_BUTTONS[i];
        if (a && (b.pressed || b.value > 0.5)) m |= 1 << BIT[a];
      });
      const [x = 0, y = 0] = gp.axes;
      if (x < -0.5) m |= 1 << BIT.left;
      if (x > 0.5) m |= 1 << BIT.right;
      if (y < -0.5) m |= 1 << BIT.up;
      if (y > 0.5) m |= 1 << BIT.down;
      out.push(this.enabled ? m : 0);
    }
    return out;
  }
}

export function keyLabel(code) {
  if (!code) return '—';
  const named = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter',
    Backspace: 'Backspace', Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', Tab: 'Tab', Escape: 'Esc',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return layoutLabel(code) || code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Numpad ' + code.slice(6);
  return code;
}

let layoutMap = null;
if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
  navigator.keyboard.getLayoutMap().then((m) => { layoutMap = m; }).catch(() => {});
}
function layoutLabel(code) {
  const v = layoutMap && layoutMap.get(code);
  return v ? v.toUpperCase() : null;
}
