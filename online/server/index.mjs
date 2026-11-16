// Cochons de Guerre en ligne — the server provides the game, every player runs it.
//
// The recompiled game (WebAssembly) runs in each player's browser. This server
//   * serves the page and the game (wasm + small runtime files), and streams
//     the disc to the browsers in immutable chunks, on demand (nobody needs
//     the game on their computer);
//   * hosts the rooms and relays the lockstep inputs between players: every
//     browser runs the same simulation from the same inputs, so each player has
//     their own copy of the game and their own view of it.
//
//   node tools/prepare.mjs   (once, after building cochons/build-web)
//   PORT=8090 node server/index.mjs
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../public');
const GAME = path.resolve(process.env.CDG_GAME || path.resolve(HERE, '../game'));
const PORT = +(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
export const MAX_PLAYERS = 4;
const MAX_ROOM = 8;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Every session's lockstep inputs are kept on the server's disk (they are only
// pad words), so that a crash a player reports can be replayed exactly
// (?replay=<name>, tests/replay.mjs). CDG_RECORD=0 turns this off.
const RECORDINGS = path.resolve(HERE, '../recordings');
const RECORD = process.env.CDG_RECORD !== '0';
function record(r, obj) {
  if (!RECORD || !r.session) return;
  try {
    if (!r.session.rec) {
      fs.mkdirSync(RECORDINGS, { recursive: true });
      r.session.rec = path.join(RECORDINGS, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${r.code}.jsonl`);
    }
    fs.appendFileSync(r.session.rec, JSON.stringify(obj) + '\n');
  } catch { /* recording is best effort */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.bin': 'application/octet-stream',
};

// SharedArrayBuffer (the game's threads) needs a cross-origin isolated page.
const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
};

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
let manifest = readJson(path.join(GAME, 'files.json'));
let disc = readJson(path.join(GAME, 'disc.json'));

function sendFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain', ...ISOLATION }).end('404'); return; }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': cache, ...ISOLATION };
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /wasm|javascript/.test(type);
    if (gzip) {
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
      fs.createReadStream(file).pipe(zlib.createGzip({ level: 6 })).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    }
  });
}

// /disc/<track>/<chunk>: one immutable chunk of a disc track.
// Tests only: CDG_DISC_FAIL=<0..1> answers that share of disc chunk requests
// with an error, as a flaky link would (tests/discfail.mjs).
const DISC_FAIL = +(process.env.CDG_DISC_FAIL || 0);
function serveDisc(req, res, m) {
  if (DISC_FAIL > 0 && Math.random() < DISC_FAIL) { res.writeHead(503, ISOLATION).end(); return; }
  const t = disc && disc.tracks[+m[1]];
  const i = +m[2];
  if (!t || !Number.isInteger(i) || i < 0 || i * disc.chunk >= t.size) {
    res.writeHead(404, ISOLATION).end(); return;
  }
  const start = i * disc.chunk;
  const end = Math.min(t.size, start + disc.chunk) - 1;
  res.writeHead(200, {
    'content-type': 'application/octet-stream', 'content-length': end - start + 1,
    'cache-control': 'public, max-age=31536000, immutable', ...ISOLATION,
  });
  fs.createReadStream(path.join(disc.dir, t.name), { start, end }).pipe(res);
  stats.discBytes += end - start + 1;
  noteHot(+m[1], i);
}

// Chunks games need, in order of first use (boot, menus, battles...): the
// browsers prefetch them while players gather in the lobby (disc-worker.js).
const HOT_FILE = path.join(GAME, 'hot.json');
const HOT_MAX = 480;   // 120 MB
const hot = new Map((readJson(HOT_FILE)?.chunks || []).map(([t, i]) => [`${t}/${i}`, [t, i]]));
let hotDirty = false;
function noteHot(t, i) {
  const k = `${t}/${i}`;
  if (hot.has(k) || hot.size >= HOT_MAX) return;
  hot.set(k, [t, i]);
  hotDirty = true;
}
setInterval(() => {
  if (!hotDirty) return;
  hotDirty = false;
  fs.writeFile(HOT_FILE, JSON.stringify({ chunks: [...hot.values()] }), () => {});
}, 10000).unref();
function hotList() {
  return { tracks: disc ? disc.tracks.map((t) => Math.ceil(t.size / disc.chunk)) : [], chunks: [...hot.values()] };
}

const stats = { discBytes: 0 };

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  let m0;
  if (p === '/healthz') { res.writeHead(200).end('ok'); return; }
  if ((m0 = /^\/replay\/([\w.-]+\.jsonl)$/.exec(p))) {
    // Recorded inputs, for the operator's own replays only (not through a tunnel).
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
    const f = path.join(RECORDINGS, m0[1]);
    if (!local || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', ...ISOLATION });
    res.end(fs.readFileSync(f));
    return;
  }
  let m;
  if ((m = /^\/disc\/(\d+)\/(\d+)$/.exec(p))) return serveDisc(req, res, m);
  if (p === '/disc/hot.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...ISOLATION });
    res.end(JSON.stringify(hotList()));
    return;
  }
  if (p === '/rooms') {
    // Open rooms for the lobby's list (codes are invitations anyway).
    const list = [...rooms.values()].map((r) => ({
      code: r.code, host: clients.get(r.host)?.name || '?', mode: r.mode, state: r.state,
      players: [...r.seats.values()].filter((s) => s >= 0).length,
    }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...ISOLATION });
    res.end(JSON.stringify(list));
    return;
  }
  if (p === '/game/info.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', ...ISOLATION });
    res.end(JSON.stringify({ ready: !!manifest, version: manifest?.version, maxPlayers: MAX_PLAYERS }));
    return;
  }
  if ((m = /^\/game\/([\w.-]+)$/.exec(p))) {
    // Versioned by the page (?v=...), so the browser may keep them.
    const cache = url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return sendFile(req, res, path.join(GAME, m[1]), cache);
  }
  const rel = p === '/' ? '/index.html' : p;
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, ISOLATION).end(); return; }
  sendFile(req, res, file, 'no-cache');
}

// ------------------------------------------------------------------ rooms
const rooms = new Map();
const clients = new Map();
const newId = () => crypto.randomBytes(4).toString('hex');
function newRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
// Tests only: CDG_SLOW=<name>:<ms>:<jitter ms> delays everything to and from
// the player of that name by ms + random(jitter) each way, order kept (a bad
// connection, tests/badnet.mjs).
const SLOW = (() => {
  const v = process.env.CDG_SLOW;
  if (!v) return null;
  const [name, base, jitter] = v.split(':');
  return { name, base: +base || 0, jitter: +jitter || 0 };
})();
function later(c, key, fn) {
  if (!SLOW || !c || c.name !== SLOW.name) { fn(); return; }
  const now = Date.now();
  const at = Math.max(c[key] || 0, now + SLOW.base + Math.random() * SLOW.jitter);
  c[key] = at;
  setTimeout(fn, at - now);
}
function send(c, obj) {
  if (!c) return;
  const text = JSON.stringify(obj);
  later(c, 'outAt', () => { if (c.ws.readyState === 1) c.ws.send(text); });
}
// Lockstep traffic (inputs, digests) goes to a player's lane when it has one:
// a second socket opened by the page's lockstep worker, so that a busy page
// (drawing, garbage collection, background tab) never delays it.
function laneOf(c) { return c && c.lane && c.lane.readyState === 1 ? c.lane : c && c.ws.readyState === 1 ? c.ws : null; }
function sendLane(c, text) { later(c, 'outAt', () => { const w = laneOf(c); if (w) w.send(text); }); }

function roomView(r) {
  return {
    t: 'room', code: r.code, host: r.host, state: r.state, delay: r.delay, mode: r.mode, cpus: r.cpus | 0,
    session: r.session ? { id: r.session.id, players: r.session.players } : null,
    members: r.members.map((id) => {
      const c = clients.get(id);
      return { id, name: c.name, seat: r.seats.get(id) ?? -1, rtt: c.rtt | 0 };
    }),
  };
}
function broadcast(r, obj) { for (const id of r.members) send(clients.get(id), obj); }
const broadcastRoom = (r) => broadcast(r, roomView(r));

function seatFree(r) {
  const used = new Set(r.seats.values());
  for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s;
  return -1;
}

function leaveRoom(c) {
  const r = rooms.get(c.room);
  c.room = null;
  if (!r) return;
  r.members = r.members.filter((id) => id !== c.id);
  r.seats.delete(c.id);
  r.pending = (r.pending || []).filter((p) => p.id !== c.id);
  if (r.session) r.session.inGame.delete(c.id);
  if (r.snapFrom === c.id) { r.snapFrom = null; requestSnapshot(r); }
  if (r.session && r.session.players.includes(c.id)) {
    // Everyone keeps simulating: the leaver's controller is released after the
    // last frame the server relayed for them, the same cut-off for all peers.
    const after = r.session.last.get(c.id) ?? -1;
    r.session.dropped.set(c.id, after);
    broadcast(r, { t: 'drop', id: c.id, after });
    record(r, { t: 'drop', i: r.session.players.indexOf(c.id), after });
  }
  if (!r.members.length) { rooms.delete(r.code); log(`salon ${r.code} fermé`); return; }
  if (r.host === c.id) r.host = r.members[0];
  broadcastRoom(r);
}

// ------------------------------------------------------------------ late join
// Ask one peer that runs the game (the host if possible) for a snapshot.
function requestSnapshot(r) {
  if (!r.session || r.snapFrom || !(r.pending || []).length) return;
  const S = r.session;
  const candidates = [r.host, ...S.players, ...S.inGame].filter((id) =>
    id && S.inGame.has(id) && clients.get(id) && !(r.pending || []).some((p) => p.id === id));
  const from = candidates[0];
  if (!from) return;
  r.snapFrom = from;
  send(clients.get(from), { t: 'snapreq' });
  log(`salon ${r.code} : instantané demandé à ${clients.get(from).name}`);
}

function onSnapshotBytes(c, data) {
  const r = c.room ? rooms.get(c.room) : null;
  if (!r || !r.session || r.snapFrom !== c.id || !c.snapMeta) return;
  const f = c.snapMeta.f;
  c.snapMeta = null;
  r.snapFrom = null;
  const S = r.session;
  const joined = [];
  for (const p of r.pending || []) {
    if (!r.members.includes(p.id)) continue;
    if (p.idx >= 0) {
      const old = S.players[p.idx];
      S.dropped.delete(old);
      S.players[p.idx] = p.id;
      S.names.set(p.id, clients.get(p.id)?.name);
    }
    S.inGame.add(p.id);
    joined.push(clients.get(p.id)?.name || '?');
  }
  r.pending = [];
  // A new schedule from the snapshot's frame (old inputs are void).
  S.id = newId();
  S.last = new Map();
  for (const id of S.dropped.keys()) S.dropped.set(id, f - 1);
  const hostIndex = Math.max(0, S.players.indexOf(r.host));
  const dropped = [...S.dropped.keys()].map((id) => [S.players.indexOf(id), f - 1]).filter(([i]) => i >= 0);
  const meta = JSON.stringify({
    t: 'resync', session: S.id, f, players: S.players, delay: r.delay, hostIndex, dropped,
    mode: r.mode, cpus: r.cpus | 0, host: r.host, joined: joined.join(', '),
  });
  for (const id of S.inGame) {
    const o = clients.get(id);
    if (o && o.ws.readyState === 1) { o.ws.send(meta); o.ws.send(data, { binary: true }); }
  }
  log(`salon ${r.code} : ${joined.join(', ')} rejoint la partie (instantané de l’image ${f}, ${data.length} octets)`);
  broadcastRoom(r);
}

function onJson(c, m) {
  const r = c.room ? rooms.get(c.room) : null;
  switch (m.t) {
    case 'hello':
      c.name = String(m.name || 'Cochon').slice(0, 24);
      send(c, { t: 'welcome', id: c.id, key: c.key, version: manifest?.version, maxPlayers: MAX_PLAYERS });
      return;
    case 'create': {
      if (r) leaveRoom(c);
      const code = newRoomCode();
      const nr = { code, host: c.id, members: [c.id], seats: new Map([[c.id, 0]]), state: 'lobby', delay: 2, session: null, mode: 'multi', cpus: 1 };
      rooms.set(code, nr);
      c.room = code;
      log(`salon ${code} créé par ${c.name}`);
      broadcastRoom(nr);
      return;
    }
    case 'join': {
      const code = String(m.code || '').toUpperCase().trim();
      const nr = rooms.get(code);
      if (!nr) { send(c, { t: 'error', message: `Salon ${code} introuvable.` }); return; }
      if (nr.members.length >= MAX_ROOM) { send(c, { t: 'error', message: 'Salon complet.' }); return; }
      if (r) leaveRoom(c);
      nr.members.push(c.id);
      c.room = code;
      if (nr.state === 'running' && nr.session) {
        // Joining a running game: the place of a player who left (same name
        // first), otherwise a spectator; either way the game is synchronised
        // from a snapshot every peer reloads.
        const S = nr.session;
        let idx = -1;
        for (const id of S.dropped.keys()) {
          const i = S.players.indexOf(id);
          if (i >= 0 && !(nr.pending || []).some((p) => p.idx === i) && (idx < 0 || S.names.get(id) === c.name)) idx = i;
        }
        nr.seats.set(c.id, idx);
        (nr.pending ||= []).push({ id: c.id, idx });
        broadcastRoom(nr);
        requestSnapshot(nr);
        return;
      }
      nr.seats.set(c.id, nr.state === 'lobby' ? seatFree(nr) : -1);
      broadcastRoom(nr);
      return;
    }
    case 'leave':
      leaveRoom(c);
      send(c, { t: 'room', code: null });
      return;
    case 'seat': {
      // A member picks a seat (or -1 to watch) before the start.
      if (!r || r.state !== 'lobby') return;
      const s = m.seat | 0;
      if (s >= MAX_PLAYERS || s < -1) return;
      if (s >= 0 && [...r.seats.entries()].some(([id, x]) => x === s && id !== c.id)) return;
      r.seats.set(c.id, s);
      broadcastRoom(r);
      return;
    }
    case 'mode':
      if (!r || r.host !== c.id || r.state !== 'lobby') return;
      r.mode = m.mode === 'solo' ? 'solo' : 'multi';
      if (m.cpus !== undefined) r.cpus = Math.max(0, Math.min(3, m.cpus | 0));
      broadcastRoom(r);
      return;
    case 'snap':
      // The snapshot's bytes follow in a binary message from the same peer.
      if (!r || !r.session || r.snapFrom !== c.id) return;
      c.snapMeta = { f: m.f | 0 };
      return;
    case 'snapfail':
      if (r && r.snapFrom === c.id) { r.snapFrom = null; setTimeout(() => requestSnapshot(r), 1000); }
      return;
    case 'delay':
      if (!r || r.host !== c.id || r.state !== 'lobby') return;
      r.delay = Math.max(2, Math.min(20, m.delay | 0));
      broadcastRoom(r);
      return;
    case 'start': {
      // Everyone boots the game from frame 0 with the same participants.
      if (!r || r.host !== c.id || r.state !== 'lobby') return;
      const players = [...r.seats.entries()].filter(([, s]) => s >= 0).sort((a, b) => a[1] - b[1]).map(([id]) => id);
      if (!players.length) return;
      r.session = {
        id: newId(), players, last: new Map(), dropped: new Map(),
        names: new Map(players.map((id) => [id, clients.get(id)?.name])),
        inGame: new Set(r.members),
      };
      r.state = 'running';
      log(`salon ${r.code} : partie lancée, ${players.length} joueur(s)`);
      broadcastRoom(r);
      broadcast(r, { t: 'go', session: r.session.id, players, host: r.host, hostIndex: Math.max(0, players.indexOf(r.host)), delay: r.delay, mode: r.mode, cpus: r.cpus | 0 });
      record(r, { t: 'go', version: manifest?.version, players: players.length, hostIndex: Math.max(0, players.indexOf(r.host)), delay: r.delay, mode: r.mode, cpus: r.cpus | 0 });
      return;
    }
    case 'end':
      if (!r || r.host !== c.id) return;
      r.state = 'lobby';
      r.session = null;
      r.pending = [];
      r.snapFrom = null;
      for (const id of r.members) if (!r.seats.has(id) || r.seats.get(id) < 0) r.seats.set(id, seatFree(r));
      broadcastRoom(r);
      broadcast(r, { t: 'ended' });
      return;
    case 'in': {
      // Lockstep inputs {f, w:[...]} for frames f.. of this player.
      if (!r || !r.session || m.s !== r.session.id || !r.session.players.includes(c.id)) return;
      if (r.session.dropped.has(c.id)) return;
      const lastF = (m.f | 0) + (Array.isArray(m.w) ? m.w.length : 0) - 1;
      r.session.last.set(c.id, Math.max(r.session.last.get(c.id) ?? -1, lastF));
      const s = JSON.stringify({ t: 'in', s: m.s, p: c.id, f: m.f | 0, w: m.w });
      record(r, { i: r.session.players.indexOf(c.id), f: m.f | 0, w: m.w });
      for (const id of r.members) if (id !== c.id) sendLane(clients.get(id), s);
      return;
    }
    case 'hash': {
      if (!r) return;
      const s = JSON.stringify({ ...m, p: c.id, name: c.name });
      if (r.session && !(m.f % 600)) record(r, { t: 'hash', f: m.f | 0, h: m.h });
      for (const id of r.members) if (id !== c.id) sendLane(clients.get(id), s);
      return;
    }
    case 'diag': {
      // A player's page reports a crash or a stall (what it saw, for the log).
      let d = '';
      try { d = JSON.stringify(m.d); } catch { d = String(m.d); }
      log(`diagnostic ${r ? `salon ${r.code}` : 'hors salon'}, ${c.name} : ${String(m.kind || '?').slice(0, 20)} ${d.slice(0, 20000)}`);
      return;
    }
    case 'chat':
      if (!r) return;
      m.text = String(m.text || '').slice(0, 300);
      for (const id of r.members) if (id !== c.id) send(clients.get(id), { ...m, p: c.id, name: c.name });
      return;
    case 'ping':
      send(c, { t: 'pong', ts: m.ts });
      return;
    case 'rtt':
      c.rtt = Math.max(0, Math.min(5000, +m.rtt || 0));
      if (r) {
        // Everyone sends their inputs early enough for the slowest link.
        const maxRtt = Math.max(...r.members.map((id) => clients.get(id)?.rtt | 0));
        if (maxRtt !== r.maxRtt) {
          r.maxRtt = maxRtt;
          for (const id of r.members) send(clients.get(id), { t: 'net', maxRtt });
        }
      }
      return;
    default:
  }
}

export function start({ port = PORT, host = HOST } = {}) {
  const tls = process.env.CDG_TLS_CERT && process.env.CDG_TLS_KEY;
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(process.env.CDG_TLS_CERT), key: fs.readFileSync(process.env.CDG_TLS_KEY) }, handler)
    : http.createServer(handler);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 << 20 });
  wss.on('connection', (ws) => {
    const c = { id: newId(), ws, name: 'Cochon', room: null, alive: true, rtt: 0, key: crypto.randomBytes(12).toString('hex') };
    clients.set(c.id, c);
    let owner = null;   // set when this socket is another client's lane
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, bin) => later(owner || c, 'inAt', () => onMessage(data, bin)));
    const onMessage = (data, bin) => {
      let m;
      if (owner) {
        // A lane carries only that player's lockstep inputs and digests.
        if (bin) return;
        try { m = JSON.parse(data); } catch { return; }
        if (m && m.t === 'ping') { const t = JSON.stringify({ t: 'pong', ts: m.ts }); later(owner, 'outAt', () => { if (ws.readyState === 1) ws.send(t); }); return; }
        if (m && (m.t === 'in' || m.t === 'hash' || m.t === 'diag') && clients.get(owner.id) === owner) onJson(owner, m);
        return;
      }
      if (bin) { onSnapshotBytes(c, data); return; }
      try { m = JSON.parse(data); } catch { return; }
      if (m && m.t === 'lane') {
        const o = clients.get(String(m.id || ''));
        if (!o || o === c || !o.key || o.key !== m.key) { ws.close(); return; }
        owner = o;
        o.lane = ws;
        clients.delete(c.id);   // not a player: keep-alive goes through its pings below
        return;
      }
      if (m && typeof m.t === 'string') onJson(c, m);
    };
    ws.on('close', () => {
      if (owner) { if (owner.lane === ws) owner.lane = null; return; }
      leaveRoom(c); clients.delete(c.id);
    });
  });
  const ka = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, 15000);
  ka.unref();
  server.listen(port, host, () => {
    log(`Cochons de Guerre en ligne : ${tls ? 'https' : 'http'}://localhost:${port}/` +
      (manifest ? ` (jeu ${manifest.version})` : ' — jeu absent : lancez « node tools/prepare.mjs »'));
  });
  return { server, wss, rooms, clients, stats, reload() { manifest = readJson(path.join(GAME, 'files.json')); disc = readJson(path.join(GAME, 'disc.json')); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
