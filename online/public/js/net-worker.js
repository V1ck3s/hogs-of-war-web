// Lockstep pump, in a worker so that it keeps the game fed even when the tab
// is in the background (page timers get throttled there, worker timers do
// not). It writes each complete frame's pad words into the ring the game's
// emulation thread waits on (psx_lockstep_web.c), in shared wasm memory.
import { Lockstep, NEUTRAL } from './lockstep.js';

let ls = null;
let mem = null;
let word = NEUTRAL;
let lastHashFrame = -1;
const hashes = new Map();   // frame -> my digest
const pendingHashes = new Map(); // peers' digests for frames I have not reached
let timer = 0;

function views() {
  // Shared memory may grow (new SharedArrayBuffer object, same bytes).
  if (!mem.u32 || mem.u32.buffer !== mem.memory.buffer) {
    mem.u32 = new Uint32Array(mem.memory.buffer);
    mem.i32 = new Int32Array(mem.memory.buffer);
    mem.u16 = new Uint16Array(mem.memory.buffer);
  }
}

function tick() {
  views();
  const status = mem.status >> 2;
  const cur = Atomics.load(mem.u32, status);              // last frame consumed
  const batch = ls.local(cur, word);
  if (batch) postMessage({ t: 'send', msg: { t: 'in', f: batch.f, w: batch.w } });
  ls.pump(cur + mem.ring - 8, (f, words) => {
    const slot = f % mem.ring;
    const base = (mem.words >> 1) + slot * mem.maxp;
    for (let p = 0; p < mem.maxp; p++) mem.u16[base + p] = p < words.length ? words[p] : NEUTRAL;
    const tag = (mem.tags >> 2) + slot;
    Atomics.store(mem.u32, tag, f + 1);
    Atomics.notify(mem.i32, tag);
    if (f < 2) postMessage({ t: 'log', text: `publish ${f} tag@${tag * 4}=${Atomics.load(mem.u32, tag)} buf=${mem.memory.buffer.byteLength}` });
  });
  const hf = Atomics.load(mem.u32, status + 6);
  const h = Atomics.load(mem.u32, status + 2);
  if (hf !== lastHashFrame && hf > 0 && hf !== 0xffffffff && Atomics.load(mem.u32, status + 1) === hf) {
    lastHashFrame = hf;
    hashes.set(hf, h);
    if (hashes.size > 64) hashes.delete(hashes.keys().next().value);
    postMessage({ t: 'send', msg: { t: 'hash', f: hf, h } });
    const early = pendingHashes.get(hf);
    if (early) {
      pendingHashes.delete(hf);
      postMessage({ t: early.h === h ? 'hashok' : 'desync', f: hf, from: early.p });
    }
  }
}

let statsAt = 0;
function loop() {
  tick();
  const now = performance.now();
  if (now - statsAt > 500) {
    statsAt = now;
    const status = mem.status >> 2;
    postMessage({
      t: 'stats', frame: Atomics.load(mem.u32, status), waitMs: Atomics.load(mem.u32, status + 3),
      holder: Atomics.load(mem.u32, status + 4) - 1, team: Atomics.load(mem.u32, status + 5), waiting: ls.waitingOn(),
    });
  }
}

onmessage = (e) => {
  const m = e.data;
  switch (m.t) {
    case 'start':
      mem = { memory: m.memory, tags: m.tags, words: m.words, status: m.status, ring: m.ring, maxp: m.maxp };
      ls = new Lockstep({ players: m.players, me: m.me, delay: m.delay });
      clearInterval(timer);
      timer = setInterval(loop, 2);
      break;
    case 'mask':
      word = ~m.mask & NEUTRAL;
      if (ls) tick();
      break;
    case 'in':
      if (ls) { ls.receive(ls.players.indexOf(m.p), m.f, m.w); tick(); }
      break;
    case 'drop':
      if (ls) { ls.drop(ls.players.indexOf(m.id), m.after); tick(); }
      break;
    case 'hash': {
      const mine = hashes.get(m.f);
      if (mine !== undefined && mine !== m.h) postMessage({ t: 'desync', f: m.f, from: m.p });
      else if (mine !== undefined) postMessage({ t: 'hashok', f: m.f, from: m.p });
      else { pendingHashes.set(m.f, m); if (pendingHashes.size > 256) pendingHashes.delete(pendingHashes.keys().next().value); }
      break;
    }
    case 'stop':
      clearInterval(timer);
      ls = null;
      break;
    default:
  }
};
