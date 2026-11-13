// Netplay simulation without a browser: two cores + two Lockstep engines
// connected by a fake network with random latency (messages reordered),
// random inputs from both players on the shared controller 1. The RAM of both
// consoles must stay identical.
//
//   node web/tests/netplay-sim.mjs <disc.cue> [state-file] [frames]
// Without a state file the consoles start from power-on.
import fs from 'node:fs';
import { createCore } from '../tools/headless.mjs';
import { Lockstep } from '../public/js/lockstep.js';

const [disc, stateFile, framesArg] = process.argv.slice(2);
const N = +(framesArg || 3000);
if (!disc) { console.error('usage: netplay-sim.mjs <disc.cue> [state] [frames]'); process.exit(2); }

const cores = { a: await createCore({ discPath: disc }), b: await createCore({ discPath: disc }) };
if (stateFile) for (const c of Object.values(cores)) if (!c.loadState(fs.readFileSync(stateFile))) throw new Error('state');

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
let now = 0;
const inflight = [];
const mk = (id, other) => new Lockstep({
  localId: id,
  send: (m) => inflight.push({ at: now + 1 + Math.floor(rnd() * 6), to: other, m: { ...m, p: id } }),
});
const ls = { a: mk('a', 'b'), b: mk('b', 'a') };
const sync = { epoch: 1, frame: 0, delay: 4, ports: { a: 0, b: 0 } };
ls.a.begin(sync); ls.b.begin(sync);

// Each player "plays" in bursts: holds a random button for a while, then idles.
const players = { a: { mask: 0, left: 0 }, b: { mask: 0, left: 0 } };
const BTN = [1 << 4, 1 << 5, 1 << 6, 1 << 7, 1 << 0, 1 << 8, 1 << 10, 1 << 11, 1 << 9];
function playerInput(p) {
  if (p.left-- <= 0) {
    p.mask = rnd() < 0.5 ? 0 : BTN[(rnd() * BTN.length) | 0];
    p.left = 5 + Math.floor(rnd() * 60);
  }
  return p.mask;
}

const done = { a: 0, b: 0 };
const hashes = { a: new Map(), b: new Map() };
let holderChanges = 0, lastHolder = null;
const t0 = Date.now();
while (done.a < N || done.b < N) {
  now++;
  for (let i = inflight.length - 1; i >= 0; i--) {
    if (inflight[i].at <= now) { const { to, m } = inflight[i]; inflight.splice(i, 1); ls[to].receive(m); }
  }
  for (const id of ['a', 'b']) {
    if (done[id] >= N) continue;
    ls[id].pushLocal(playerInput(players[id]));
    // peers run at slightly different speeds
    if (rnd() < (id === 'a' ? 0.9 : 0.75)) {
      const masks = ls[id].advance();
      if (!masks) continue;
      masks.forEach((m, p) => cores[id].setInput(p, m));
      cores[id].runFrame();
      done[id]++;
      if (id === 'a' && ls.a.holder[0] !== lastHolder) { holderChanges++; lastHolder = ls.a.holder[0]; }
      if (Lockstep.wantsHash(ls[id].frame)) hashes[id].set(ls[id].frame, cores[id].ramHash());
    }
  }
}
let compared = 0, bad = 0;
for (const [f, h] of hashes.a) {
  if (!hashes.b.has(f)) continue;
  compared++;
  if (hashes.b.get(f) !== h) { bad++; console.error(`DESYNC à l'image ${f}`); }
}
console.log(`${N} images x2 en ${((Date.now() - t0) / 1000).toFixed(0)} s, ${compared} empreintes comparées, ` +
  `${holderChanges} changements de détenteur de la manette, blocages a=${ls.a.stats.stalls} b=${ls.b.stats.stalls}`);
if (bad || !compared) { console.error('ÉCHEC'); process.exit(1); }
console.log('OK : les deux consoles sont restées identiques.');
