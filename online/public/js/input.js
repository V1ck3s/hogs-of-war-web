// Keyboard + gamepad → PS1 pad mask (active-high, PS1 bit order).
export const BIT = {
  select: 0, l3: 1, r3: 2, start: 3, up: 4, right: 5, down: 6, left: 7,
  l2: 8, r2: 9, l1: 10, r1: 11, triangle: 12, circle: 13, cross: 14, square: 15,
};

// Labels follow the game's own "CONFIGURATION MANETTE" screen.
export const ACTIONS = [
  ['up', 'Up (move / aim)'], ['down', 'Down (move / aim)'], ['left', 'Left (move / aim)'], ['right', 'Right (move / aim)'],
  ['cross', 'Action / fire (✕)'], ['circle', 'Weapons menu (○)'], ['square', 'Jump (□)'], ['triangle', 'Cancel (△)'],
  ['l1', 'Camera (L1)'], ['l2', 'Camera (L2)'], ['r1', 'Aim — up (R1)'], ['r2', 'Aim — down (R2)'],
  ['start', 'Pause (Start)'], ['select', 'Select'],
];

// PC layout, by physical key position (event.code), so it is ZQSD on an
// AZERTY keyboard and WASD on a QWERTY one: move with the left hand, act with
// Space / Enter, pause with Escape. Arrows move too.
export const DEFAULT_KEYS = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  cross: ['Space', 'NumpadEnter'], circle: ['Backspace'], square: ['KeyF'], triangle: ['KeyR'],
  l1: ['KeyQ'], r1: ['KeyE'], l2: ['KeyZ'], r2: ['KeyC'],
  start: ['Enter', 'Escape'], select: ['Tab'],
};
const STORE = 'cdg.online.keys.v2';

const PAD = {
  0: 'cross', 1: 'circle', 2: 'square', 3: 'triangle', 4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2',
  8: 'select', 9: 'start', 10: 'l3', 11: 'r3', 12: 'up', 13: 'down', 14: 'left', 15: 'right',
};

function load() {
  try { return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return { ...DEFAULT_KEYS }; }
}

export class Input {
  constructor() {
    this.keys = load();
    this.down = new Set();
    this.capture = null;
    this.enabled = true;
    addEventListener('keydown', (e) => this.key(e, true));
    addEventListener('keyup', (e) => this.key(e, false));
    addEventListener('blur', () => this.down.clear());
  }

  key(e, isDown) {
    if (this.capture && isDown) { e.preventDefault(); const cb = this.capture; this.capture = null; cb(e.code); return; }
    const t = e.target;
    if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
    const mapped = Object.values(this.keys).some((l) => l.includes(e.code));
    // Only while the game is on screen: in the lobby Tab, Space and Enter keep
    // their usual meaning (form navigation, buttons).
    const play = document.getElementById('play');
    if (mapped && play && !play.hidden && !document.querySelector('dialog[open]')) e.preventDefault();
    if (isDown) this.down.add(e.code); else this.down.delete(e.code);
  }

  setKey(action, code) {
    for (const a of Object.keys(this.keys)) this.keys[a] = this.keys[a].filter((c) => c !== code);
    this.keys[action] = [code, ...(this.keys[action] || []).filter((c) => c.startsWith('Arrow'))];
    try { localStorage.setItem(STORE, JSON.stringify(this.keys)); } catch { /* ignore */ }
  }

  reset() { this.keys = { ...DEFAULT_KEYS }; try { localStorage.removeItem(STORE); } catch { /* ignore */ } }

  mask() {
    if (!this.enabled) return 0;
    let m = 0;
    for (const [a, codes] of Object.entries(this.keys)) if (codes.some((c) => this.down.has(c))) m |= 1 << BIT[a];
    for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
      if (!gp || !gp.connected) continue;
      gp.buttons.forEach((b, i) => { if (PAD[i] && (b.pressed || b.value > 0.5)) m |= 1 << BIT[PAD[i]]; });
      const [x = 0, y = 0] = gp.axes;
      if (x < -0.5) m |= 1 << BIT.left;
      if (x > 0.5) m |= 1 << BIT.right;
      if (y < -0.5) m |= 1 << BIT.up;
      if (y > 0.5) m |= 1 << BIT.down;
    }
    return m;
  }
}

// Letters as printed on the player's own keyboard (Z, Q on AZERTY) when the
// browser can tell (Chrome, Edge); otherwise the AZERTY reading of the code,
// this being a French game.
const AZERTY = { KeyQ: 'A', KeyW: 'Z', KeyA: 'Q', KeyZ: 'W', KeyM: ',', Semicolon: 'M' };
let layout = null;
export const layoutReady = (navigator.keyboard && navigator.keyboard.getLayoutMap
  ? navigator.keyboard.getLayoutMap().then((m) => { layout = m; }).catch(() => {}) : Promise.resolve());

export function keyLabel(code) {
  if (!code) return '—';
  const named = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', NumpadEnter: 'Enter (keypad)', Space: 'Space',
    Escape: 'Esc', Tab: 'Tab', Backspace: 'Backspace', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  };
  if (named[code]) return named[code];
  const l = layout && layout.get(code);
  if (l) return l.toUpperCase();
  if (AZERTY[code]) return AZERTY[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}
