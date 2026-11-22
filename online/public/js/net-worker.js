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
const inbox = [];   // recent remote 'in' messages (see 'resync')
let outPend = null; // my words not sent yet (see tick)

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
  // My words reach my own game at once; to the others they go 4 frames at a
  // time (a quarter of the messages: ~2 KB/s instead of ~7 KB/s). Only
  // players watching me see them later (at most 60 ms): the game never waits
  // for my words on my own machine.
  const batch = ls.local(cur, word);
  const now = performance.now();
  if (batch) {
    if (!outPend) outPend = { f: batch.f, w: [], at: now };
    outPend.w.push(...batch.w);
  }
  if (outPend && (outPend.w.length >= 4 || now - outPend.at >= 60)) {
    sendNet({ t: 'in', f: outPend.f, w: outPend.w });
    outPend = null;
  }
  // Each participant's words go to the game as soon as they are known; the
  // game waits only for the one in control (psx_lockstep_web.c).
  ls.pump(cur + mem.ring - 8, (p, f, w) => {
    const idx = (f % mem.ring) * mem.stride + p;
    mem.u16[(mem.words >> 1) + idx] = w;
    const tag = (mem.tags >> 2) + idx;
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
  const t0 = mem.tags >> 2, n = mem.ring * mem.stride;
  for (let i = 0; i < n; i++) Atomics.store(mem.u32, t0 + i, 0);
  for (let i = 0; i < n; i++) Atomics.notify(mem.i32, t0 + i);
}

// Last frame of each participant who left (0xFFFFFFFF: still there), read by
// the game to fall back to the host for their turns.
function setGone(index, after) {
  views();
  if (index < 0 || index >= mem.maxp) return;
  Atomics.store(mem.u32, (mem.gone >> 2) + index, after < 0 ? 0 : after >>> 0);
}
function resetGone() {
  views();
  for (let i = 0; i < mem.maxp; i++) Atomics.store(mem.u32, (mem.gone >> 2) + i, 0xFFFFFFFF);
}

// Watchdog: the game not taking a new frame for 5 s, or the page's own
// thread not answering for 5 s, is reported to the server's log (through the
// lane, which does not need the page). Data only: what each side last saw.
let pageBeat = 0, pageInfo = null, lastFrame = -1, lastFrameAt = 0, stallSent = false, pageSent = false;
function sendDiag(kind, extra) {
  views();
  const status = mem.status >> 2;
  const d = {
    frame: Atomics.load(mem.u32, status), waitMs: Atomics.load(mem.u32, status + 3),
    published: ls ? ls.nextPublish : -1, sentUpTo: ls ? ls.nextLocal : -1, lead: ls ? ls.lead : 0,
    waiting: ls ? waitingFor() : [], lane: laneOpen, pageBeatAgoMs: pageBeat ? Math.round(performance.now() - pageBeat) : -1,
    page: pageInfo, ...extra,
  };
  const msg = { t: 'diag', kind, d };
  if (laneOpen && lane && lane.readyState === 1) lane.send(JSON.stringify(msg));
  else postMessage({ t: 'send', msg });
}
function watchdog(now) {
  views();
  const f = Atomics.load(mem.u32, mem.status >> 2);
  if (f !== lastFrame) {
    if (stallSent) sendDiag('resumed', { stalledMs: Math.round(now - lastFrameAt) });
    lastFrame = f; lastFrameAt = now; stallSent = false;
  } else if (!stallSent && lastFrameAt && now - lastFrameAt > 5000) {
    stallSent = true;
    sendDiag('stall', { stalledMs: Math.round(now - lastFrameAt) });
  }
  if (pageBeat && now - pageBeat > 5000) {
    if (!pageSent) { pageSent = true; sendDiag('page-stalled', {}); }
  } else if (pageSent && pageBeat && now - pageBeat < 2000) {
    pageSent = false; sendDiag('page-resumed', {});
  }
}

// Participant the game is waiting for right now (none: it is running).
function waitingFor() {
  const w = Atomics.load(mem.u32, (mem.status >> 2) + 7);
  return w ? [w - 1] : [];
}

let statsAt = 0;
function loop() {
  tick();
  const now = performance.now();
  watchdog(now);
  if (now - statsAt > 500) {
    statsAt = now;
    const status = mem.status >> 2;
    const st = (i) => Atomics.load(mem.u32, status + i);
    postMessage({
      t: 'stats', frame: st(0), waitMs: st(3), holder: st(4) - 1, team: st(5), waiting: waitingFor(), lead: ls.lead,
      // Watching another player (psx_lockstep_web.c): words in hand, level
      // aimed at, times they ran out, pace; then how evenly frames follow
      // one another (frames timed, late ones, very late ones, longest gap).
      play: { low: st(8), level: st(9), dry: st(10), pace: st(11) },
      even: { n: st(12), late: st(13), hitch: st(14), maxMs: st(15) },
    });
  }
}

onmessage = (e) => handle(e.data);

function handle(m) {
  switch (m.t) {
    case 'start':
      if (m.session !== undefined) session = m.session;
      if (m.lane && !laneInfo) { laneInfo = m.lane; openLane(); }
      mem = { memory: m.memory, tags: m.tags, words: m.words, status: m.status, ring: m.ring, maxp: m.maxp, stride: m.stride, gone: m.gone };
      ls = new Lockstep({ players: m.players, me: m.me, delay: m.delay, start: m.start || 0, host: m.host || 0 });
      resetGone();
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
      outPend = null;
      resetGone();
      for (const [i, after] of m.dropped || []) { ls.drop(i, after); setGone(i, after); }
      // Words that arrived before this resync (a joining player starts sending
      // as soon as it has loaded the snapshot, which may be before this peer
      // hears of it): fed again in arrival order, so the latest word wins.
      for (const q of inbox) ls.receive(ls.players.indexOf(q.p), q.f, q.w);
      if (lead) ls.setLead(lead);
      clearTags();
      hashes.clear(); pendingHashes.clear();
      // The game's last digest belongs to the old timeline (a peer ahead of
      // the snapshot computed it before rewinding): never report it.
      views();
      lastHashFrame = Atomics.load(mem.u32, (mem.status >> 2) + 6);
      postMessage({ t: 'resync-ready', start: m.start });
      break;
    case 'beat':
      pageBeat = performance.now(); pageInfo = m.info;
      break;
    case 'gap-reset':
      // The page has reported the longest gap between two frames: count anew.
      if (mem) { views(); Atomics.store(mem.u32, (mem.status >> 2) + 15, 0); }
      break;
    case 'diag':
      if (mem) sendDiag(m.kind, m.extra || {});
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
      inbox.push(m);
      if (inbox.length > 4096) inbox.shift();
      if (ls) { ls.receive(ls.players.indexOf(m.p), m.f, m.w); tick(); }
      break;
    case 'drop':
      if (ls) { const i = ls.players.indexOf(m.id); ls.drop(i, m.after); setGone(i, m.after); tick(); }
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
