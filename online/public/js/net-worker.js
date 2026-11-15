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
let lead = 0;

// Lane: this worker's own socket to the server for lockstep traffic, so that
// inputs and digests never wait for the page's main thread. Until it is open
// (or if it drops) they go through the page's socket as before.
let lane = null, laneInfo = null, laneOpen = false, session = null;
function openLane() {
  if (!laneInfo || lane) return;
  let w;
  try { w = new WebSocket(laneInfo.url); } catch { return; }
  lane = w;
  w.onopen = () => { w.send(JSON.stringify({ t: 'lane', id: laneInfo.id, key: laneInfo.key })); laneOpen = true; };
  w.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.s !== undefined && m.s !== session) return;
    if (m.t === 'in' || m.t === 'hash') handle(m);
    else if (m.t === 'pong') postMessage({ t: 'rtt', rtt: performance.now() - m.ts });
  };
  w.onclose = () => { lane = null; laneOpen = false; if (laneInfo) setTimeout(openLane, 1000); };
}
// Round trip measured on the lane itself: independent of the page's load.
setInterval(() => {
  if (laneOpen && lane && lane.readyState === 1) lane.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
}, 1000);

function sendNet(msg) {
  if (laneOpen && lane && lane.readyState === 1) lane.send(JSON.stringify({ ...msg, s: session }));
  else postMessage({ t: 'send', msg });
}

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
  // Last frame the game consumed; a game that just loaded a snapshot has not
  // consumed any of the new schedule yet: count from its first frame.
  const cur = Math.max(Atomics.load(mem.u32, status), ls.start);
  const batch = ls.local(cur, word);
  if (batch) sendNet({ t: 'in', f: batch.f, w: batch.w });
  ls.pump(cur + mem.ring - 8, (f, words) => {
    const slot = f % mem.ring;
    const base = (mem.words >> 1) + slot * mem.stride;
    for (let p = 0; p < mem.maxp; p++) mem.u16[base + p] = p < words.length ? words[p] : NEUTRAL;
    mem.u16[base + mem.maxp] = ls.control(f);
    const tag = (mem.tags >> 2) + slot;
    Atomics.store(mem.u32, tag, f + 1);
    Atomics.notify(mem.i32, tag);
  });
  const hf = Atomics.load(mem.u32, status + 6);
  const h = Atomics.load(mem.u32, status + 2);
  if (hf !== lastHashFrame && hf > 0 && hf !== 0xffffffff && Atomics.load(mem.u32, status + 1) === hf) {
    lastHashFrame = hf;
    hashes.set(hf, h);
    if (hashes.size > 64) hashes.delete(hashes.keys().next().value);
    sendNet({ t: 'hash', f: hf, h });
    const early = pendingHashes.get(hf);
    if (early) {
      pendingHashes.delete(hf);
      postMessage({ t: early.h === h ? 'hashok' : 'desync', f: hf, from: early.p });
    }
  }
}

function clearTags() {
  views();
  const t0 = mem.tags >> 2;
  for (let i = 0; i < mem.ring; i++) Atomics.store(mem.u32, t0 + i, 0);
  for (let i = 0; i < mem.ring; i++) Atomics.notify(mem.i32, t0 + i);
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
      lead: ls.lead,
    });
  }
}

onmessage = (e) => handle(e.data);

function handle(m) {
  switch (m.t) {
    case 'start':
      if (m.session !== undefined) session = m.session;
      if (m.lane && !laneInfo) { laneInfo = m.lane; openLane(); }
      mem = { memory: m.memory, tags: m.tags, words: m.words, status: m.status, ring: m.ring, maxp: m.maxp, stride: m.stride };
      ls = new Lockstep({ players: m.players, me: m.me, delay: m.delay, start: m.start || 0, host: m.host || 0 });
      if (lead) ls.setLead(lead);
      if (m.start) clearTags();
      clearInterval(timer);
      timer = setInterval(loop, 2);
      break;
    case 'resync':
      if (m.session !== undefined) session = m.session;
      // Everyone reloads the same snapshot: a new schedule from its frame. The
      // ring is emptied first so that the game never takes a stale frame of
      // the previous schedule (peers ahead of the snapshot rewind to it).
      ls = new Lockstep({ players: m.players, me: m.me, delay: m.delay, start: m.start, host: m.host });
      for (const [i, after] of m.dropped || []) ls.drop(i, after);
      if (lead) ls.setLead(lead);
      clearTags();
      hashes.clear(); pendingHashes.clear();
      // The game's last digest belongs to the old timeline (a peer ahead of
      // the snapshot computed it before rewinding): never report it.
      views();
      lastHashFrame = Atomics.load(mem.u32, (mem.status >> 2) + 6);
      postMessage({ t: 'resync-ready', start: m.start });
      break;
    case 'lead':
      lead = m.n | 0;
      if (ls) { ls.setLead(lead); tick(); }
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
      laneInfo = null;
      if (lane) lane.close();
      break;
    default:
  }
}
