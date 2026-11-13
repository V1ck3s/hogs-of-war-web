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
function serveDisc(req, res, m) {
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
}

const stats = { discBytes: 0 };

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/healthz') { res.writeHead(200).end('ok'); return; }
  let m;
  if ((m = /^\/disc\/(\d+)\/(\d+)$/.exec(p))) return serveDisc(req, res, m);
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
function send(c, obj) { if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }

function roomView(r) {
  return {
    t: 'room', code: r.code, host: r.host, state: r.state, delay: r.delay,
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
  if (r.session && r.session.players.includes(c.id)) {
    // Everyone keeps simulating: the leaver's controller is released after the
    // last frame the server relayed for them, the same cut-off for all peers.
    const after = r.session.last.get(c.id) ?? -1;
    r.session.dropped.set(c.id, after);
    broadcast(r, { t: 'drop', id: c.id, after });
  }
  if (!r.members.length) { rooms.delete(r.code); log(`salon ${r.code} fermé`); return; }
  if (r.host === c.id) r.host = r.members[0];
  broadcastRoom(r);
}

function onJson(c, m) {
  const r = c.room ? rooms.get(c.room) : null;
  switch (m.t) {
    case 'hello':
      c.name = String(m.name || 'Cochon').slice(0, 24);
      send(c, { t: 'welcome', id: c.id, version: manifest?.version, maxPlayers: MAX_PLAYERS });
      return;
    case 'create': {
      if (r) leaveRoom(c);
      const code = newRoomCode();
      const nr = { code, host: c.id, members: [c.id], seats: new Map([[c.id, 0]]), state: 'lobby', delay: 5, session: null };
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
      // A seat while the game has not started; afterwards spectators wait for
      // the next game (a running simulation cannot gain a peer mid-way yet).
      nr.seats.set(c.id, nr.state === 'lobby' ? seatFree(nr) : -1);
      c.room = code;
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
      const aspect = Math.max(4 / 3, Math.min(32 / 9, +m.aspect || 16 / 9));
      r.session = { id: newId(), players, aspect, last: new Map(), dropped: new Map() };
      r.state = 'running';
      log(`salon ${r.code} : partie lancée, ${players.length} joueur(s)`);
      broadcastRoom(r);
      broadcast(r, { t: 'go', session: r.session.id, players, host: r.host, delay: r.delay, aspect });
      return;
    }
    case 'end':
      if (!r || r.host !== c.id) return;
      r.state = 'lobby';
      r.session = null;
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
      for (const id of r.members) if (id !== c.id) { const o = clients.get(id); if (o.ws.readyState === 1) o.ws.send(s); }
      return;
    }
    case 'hash': case 'chat':
      if (!r) return;
      if (m.t === 'chat') m.text = String(m.text || '').slice(0, 300);
      for (const id of r.members) if (id !== c.id) send(clients.get(id), { ...m, p: c.id, name: c.name });
      return;
    case 'ping':
      send(c, { t: 'pong', ts: m.ts });
      return;
    case 'rtt':
      c.rtt = Math.max(0, Math.min(5000, +m.rtt || 0));
      return;
    default:
  }
}

export function start({ port = PORT, host = HOST } = {}) {
  const tls = process.env.CDG_TLS_CERT && process.env.CDG_TLS_KEY;
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(process.env.CDG_TLS_CERT), key: fs.readFileSync(process.env.CDG_TLS_KEY) }, handler)
    : http.createServer(handler);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
  wss.on('connection', (ws) => {
    const c = { id: newId(), ws, name: 'Cochon', room: null, alive: true, rtt: 0 };
    clients.set(c.id, c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, bin) => {
      if (bin) return;
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m && typeof m.t === 'string') onJson(c, m);
    });
    ws.on('close', () => { leaveRoom(c); clients.delete(c.id); });
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
