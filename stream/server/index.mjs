// Cochons de Guerre — streaming game server.
//
// The game (native recompiled French PS1 code, see ../../cochons) runs here,
// one instance per room. Clients receive H.264 video + Opus audio over a
// WebSocket and send their pad state back. Players need nothing but a browser.
//
//   CDG_GAME_DIR=../cochons/build PORT=8090 node server/index.mjs
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GameInstance, QUALITY } from './game-instance.mjs';
import { Arbiter } from './arbiter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../public');
const PORT = +(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const GAME_DIR = path.resolve(process.env.CDG_GAME_DIR || path.join(HERE, '../../cochons/build'));
const GAME_BIN = process.env.CDG_GAME_BIN || 'Cochons_de_Guerre';
const MAX_ROOMS = +(process.env.CDG_MAX_ROOMS || 1);
const MAX_MEMBERS = 8;
const WORK_ROOT = process.env.CDG_WORK_DIR || path.join(os.tmpdir(), 'cochons-stream');
const SAVE_ROOT = process.env.CDG_SAVE_DIR || path.join(HERE, '../saves');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

// WebCodecs (video/audio decoding in the browser) needs a secure context:
// serve HTTPS directly (CDG_TLS_CERT / CDG_TLS_KEY) or put the server behind
// an HTTPS reverse proxy. Plain HTTP only works for http://localhost.
const TLS = process.env.CDG_TLS_CERT && process.env.CDG_TLS_KEY
  ? { cert: fs.readFileSync(process.env.CDG_TLS_CERT), key: fs.readFileSync(process.env.CDG_TLS_KEY) } : null;
const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200).end('ok'); return; }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.resolve(PUBLIC, '.' + p);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
};
const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);

// ------------------------------------------------------------------ rooms
const rooms = new Map();
const closing = new Set(); // rooms whose game is still shutting down
const clients = new Map();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const newId = () => crypto.randomBytes(4).toString('hex');
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}

// Binary frames to clients: [u8 type][payload]
//   1 = video access unit: [u8 key][f64 ts ms][annexb...]
//   2 = audio opus packet: [f64 ts ms][opus...]
function videoPacket(au, key) {
  const h = Buffer.alloc(10);
  h[0] = 1; h[1] = key ? 1 : 0; h.writeDoubleLE(Date.now(), 2);
  return Buffer.concat([h, au]);
}
function audioPacket(pkt) {
  const h = Buffer.alloc(9);
  h[0] = 2; h.writeDoubleLE(Date.now(), 1);
  return Buffer.concat([h, pkt]);
}

function sendJson(c, obj) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }

function roomView(room) {
  return {
    t: 'room', code: room.code, host: room.host, state: room.state, quality: room.quality,
    turbo: room.turbo, holder: room.arbiter.holder, error: room.error || null,
    qualities: Object.keys(QUALITY),
    members: room.members.map((id) => ({ id, name: clients.get(id).name, spectator: clients.get(id).spectator })),
  };
}

function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const id of room.members) { const c = clients.get(id); if (c.ws.readyState === 1) c.ws.send(s); }
}
const broadcastRoom = (room) => broadcast(room, roomView(room));

function sendBinary(room, buf, { videoOnly = false } = {}) {
  for (const id of room.members) {
    const c = clients.get(id);
    if (c.ws.readyState !== 1) continue;
    if (videoOnly && !c.wantsVideo) continue;
    // Drop frames for clients whose socket is backing up (slow link):
    // they resync on the next keyframe instead of drifting behind.
    if (c.ws.bufferedAmount > 2 << 20) { c.needKey = true; continue; }
    c.ws.send(buf);
  }
}

async function createRoom(c, opts) {
  if (rooms.size >= MAX_ROOMS) {
    sendJson(c, { t: 'error', message: `The server is full (${MAX_ROOMS} game(s) running). Join an existing room.` });
    return;
  }
  const code = newCode();
  const room = {
    code, host: c.id, members: [c.id], state: 'starting', quality: QUALITY[opts.quality] ? opts.quality : '720p',
    turbo: false, arbiter: null, game: null,
  };
  room.arbiter = new Arbiter({ onWord: (w) => room.game && room.game.sendPad(w), onHolder: () => broadcastRoom(room) });
  rooms.set(code, room);
  c.room = code;
  broadcastRoom(room);
  log(`room ${code} created by ${c.name}`);
  const workDir = path.join(WORK_ROOT, code);
  fs.rmSync(workDir, { recursive: true, force: true });
  const game = new GameInstance({
    gameDir: GAME_DIR, binary: GAME_BIN, workDir, saveDir: SAVE_ROOT,
    quality: room.quality, aspect: opts.aspect || 16 / 9, log: (m) => log(`[${code}] ${m}`),
  });
  room.game = game;
  game.on('videoConfig', (cfg) => {
    for (const id of room.members) clients.get(id).needKey = true;
    broadcast(room, { t: 'video', ...cfg });
  });
  game.on('video', (au, key) => {
    const pkt = videoPacket(au, key);
    for (const id of room.members) {
      const m = clients.get(id);
      if (m.ws.readyState !== 1) continue;
      if (m.needKey) { if (!key) continue; m.needKey = false; }
      if (m.ws.bufferedAmount > 2 << 20) { m.needKey = true; continue; }
      m.ws.send(pkt);
    }
  });
  game.on('audio', (pkt) => sendBinary(room, audioPacket(pkt)));
  game.on('exit', () => { room.state = 'stopped'; room.error = 'The game has stopped.'; broadcastRoom(room); });
  try {
    await game.start();
    room.state = 'running';
    log(`room ${code}: game started (${game.display}, ${game.size().w}x${game.size().h})`);
  } catch (e) {
    room.state = 'stopped';
    room.error = 'Could not start the game: ' + e.message;
    log(`room ${code}: ${room.error}`);
  }
  broadcastRoom(room);
}

function joinRoom(c, code) {
  const room = rooms.get(String(code || '').toUpperCase().trim());
  if (!room) { sendJson(c, { t: 'error', message: 'Room not found.' }); return; }
  if (room.members.length >= MAX_MEMBERS) { sendJson(c, { t: 'error', message: 'Room full.' }); return; }
  leaveRoom(c);
  room.members.push(c.id);
  c.room = room.code;
  c.needKey = true;
  if (room.game && room.game.videoConfig) sendJson(c, { t: 'video', ...room.game.videoConfig });
  broadcastRoom(room);
  log(`${c.name} joined ${room.code}`);
}

function leaveRoom(c) {
  const room = c.room && rooms.get(c.room);
  c.room = null;
  if (!room) return;
  room.members = room.members.filter((id) => id !== c.id);
  room.arbiter.remove(c.id);
  if (!room.members.length) {
    log(`room ${room.code} closed`);
    rooms.delete(room.code);
    if (room.game) { closing.add(room); room.game.stop().finally(() => closing.delete(room)); }
    return;
  }
  if (room.host === c.id) room.host = room.members[0];
  broadcastRoom(room);
}

async function onMessage(c, m) {
  const room = c.room && rooms.get(c.room);
  const isHost = room && room.host === c.id;
  switch (m.t) {
    case 'hello':
      c.name = String(m.name || 'Hog').slice(0, 24) || 'Hog';
      sendJson(c, { t: 'welcome', id: c.id, rooms: [...rooms.values()].map((r) => ({ code: r.code, members: r.members.length })), maxRooms: MAX_ROOMS });
      return;
    case 'create': return createRoom(c, m);
    case 'join': return joinRoom(c, m.code);
    case 'leave': leaveRoom(c); sendJson(c, { t: 'room', code: null }); return;
    case 'pad':
      if (room && !c.spectator) room.arbiter.input(c.id, m.w | 0);
      return;
    case 'spectate':
      c.spectator = !!m.on;
      if (room) { room.arbiter.remove(c.id); broadcastRoom(room); }
      return;
    case 'view':
      // Host's screen shape drives the rendered picture (any aspect from 4:3
      // to 21:9; narrower screens get a letterboxed 4:3 picture).
      if (isHost && room.game && room.state === 'running') {
        const aspect = Math.max(0.5, Math.min(4, +m.aspect || 16 / 9));
        if (await room.game.reshape({ aspect })) {
          const { w, h } = room.game.size();
          log(`room ${room.code}: picture ${w}x${h} (host screen ${aspect.toFixed(2)}:1)`);
          broadcastRoom(room);
        }
      }
      return;
    case 'quality':
      if (isHost && room.game && QUALITY[m.quality]) {
        room.quality = m.quality;
        await room.game.reshape({ quality: m.quality });
        broadcastRoom(room);
      }
      return;
    case 'turbo':
      if (isHost && room.game) { room.turbo = !!m.on; room.game.setTurbo(room.turbo); broadcastRoom(room); }
      return;
    case 'keyframe':
      c.needKey = true;
      return;
    case 'chat':
      if (room) broadcast(room, { t: 'chat', from: c.id, name: c.name, text: String(m.text || '').slice(0, 300) });
      return;
    case 'ping':
      sendJson(c, { t: 'pong', ts: m.ts });
      return;
    default:
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  const c = { id: newId(), ws, name: 'Hog', room: null, needKey: true, alive: true, spectator: false };
  clients.set(c.id, c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, bin) => {
    if (bin) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m && typeof m.t === 'string') onMessage(c, m).catch((e) => log('error', e));
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(c.id); });
});

setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; c.ws.ping();
  }
}, 15000).unref();

async function shutdown() {
  await Promise.all([...rooms.values(), ...closing].map((r) => r.game && r.game.stop()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!fs.existsSync(path.join(GAME_DIR, GAME_BIN))) {
  console.error(`Game executable not found: ${path.join(GAME_DIR, GAME_BIN)} (see README, CDG_GAME_DIR / CDG_GAME_BIN)`);
}
server.listen(PORT, HOST, () => log(`Cochons de Guerre — streaming: ${TLS ? 'https' : 'http'}://localhost:${PORT}/  (game: ${GAME_DIR})`));
