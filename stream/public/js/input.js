// Keyboard + gamepad → PS1 pad mask (active-high, PS1 bit order).
export const BIT = {
  select: 0, l3: 1, r3: 2, start: 3, up: 4, right: 5, down: 6, left: 7,
  l2: 8, r2: 9, l1: 10, r1: 11, triangle: 12, circle: 13, cross: 14, square: 15,
};

export const ACTIONS = [
  ['up', 'Haut'], ['down', 'Bas'], ['left', 'Gauche'], ['right', 'Droite'],
  ['cross', 'Croix ✕ (valider / tirer)'], ['circle', 'Rond ○ (retour)'], ['square', 'Carré □'], ['triangle', 'Triangle △'],
  ['l1', 'L1'], ['r1', 'R1'], ['l2', 'L2'], ['r2', 'R2'],
  ['start', 'Start'], ['select', 'Select'],
];

// Physical key positions (event.code): same on AZERTY and QWERTY for these.
export const DEFAULT_KEYS = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  cross: ['KeyX', 'Space'], circle: ['KeyC'], square: ['KeyS'], triangle: ['KeyD'],
  l1: ['KeyE'], r1: ['KeyR'], l2: ['KeyF'], r2: ['KeyG'],
  start: ['Enter'], select: ['Backspace'],
};

const PAD = {
  0: 'cross', 1: 'circle', 2: 'square', 3: 'triangle', 4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2',
  8: 'select', 9: 'start', 10: 'l3', 11: 'r3', 12: 'up', 13: 'down', 14: 'left', 15: 'right',
};

function load() {
  try { return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem('cdg.stream.keys') || '{}') }; } catch { return { ...DEFAULT_KEYS }; }
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
    if (mapped) e.preventDefault();
    if (isDown) this.down.add(e.code); else this.down.delete(e.code);
  }

  setKey(action, code) {
    for (const a of Object.keys(this.keys)) this.keys[a] = this.keys[a].filter((c) => c !== code);
    this.keys[action] = [code];
    try { localStorage.setItem('cdg.stream.keys', JSON.stringify(this.keys)); } catch { /* ignore */ }
  }

  reset() { this.keys = { ...DEFAULT_KEYS }; try { localStorage.removeItem('cdg.stream.keys'); } catch { /* ignore */ } }

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

export function keyLabel(code) {
  if (!code) return '—';
  const named = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Entrée', Space: 'Espace',
    Backspace: 'Retour arr.', ShiftLeft: 'Maj g.', ShiftRight: 'Maj d.', ControlLeft: 'Ctrl g.', ControlRight: 'Ctrl d.', Tab: 'Tab',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}
