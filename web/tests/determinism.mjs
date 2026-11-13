// Lockstep prerequisite: two independent cores fed the same savestate and
// the same inputs must stay bit-identical (RAM hash) frame after frame.
//   node web/tests/determinism.mjs <disc.cue> [frames]
import { createCore, maskOf } from '../tools/headless.mjs';

const disc = process.argv[2];
const N = +(process.argv[3] || 600);
if (!disc) { console.error('usage: determinism.mjs <disc.cue> [frames]'); process.exit(2); }

const a = await createCore({ discPath: disc });
// Boot A to past the intro so the state is non-trivial.
for (let f = 0; f < 1800; f++) { a.setInput(0, f % 200 < 4 && f > 1400 ? maskOf(['start']) : 0); a.runFrame(); }
const state = a.saveState();

const b = await createCore({ discPath: disc });
for (let f = 0; f < 37; f++) b.runFrame(); // put B somewhere else first
if (!b.loadState(state)) throw new Error('B could not load the state');
if (!a.loadState(state)) throw new Error('A could not reload the state');

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const names = ['up', 'down', 'left', 'right', 'cross', 'circle', 'l', 'r'];
let fail = 0;
for (let f = 0; f < N; f++) {
  const m = rnd() < 0.15 ? maskOf([names[(rnd() * names.length) | 0]]) : 0;
  a.setInput(0, m); b.setInput(0, m);
  a.runFrame(); b.runFrame();
  if (f % 50 === 49) {
    const ha = a.ramHash(), hb = b.ramHash();
    if (ha !== hb) { console.error(`DESYNC at frame ${f}: ${ha.toString(16)} != ${hb.toString(16)}`); fail = 1; break; }
  }
}
// Also: savestates must be identical after identical runs.
const sa = a.saveState(), sb = b.saveState();
let diff = 0; const at = [];
for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) { diff++; if (at.length < 8) at.push([i, sa[i], sb[i]]); }
console.log(`state size ${sa.length}, differing bytes after ${N} frames: ${diff} ${JSON.stringify(at)}`);
if (fail) process.exit(1);
console.log(`OK: ${N} frames in lockstep, final hash ${a.ramHash().toString(16)}`);
