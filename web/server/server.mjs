// Cochons de Guerre Web — static file server + multiplayer lobby/relay.
//
// The server never runs the game and never sees game data except the
// savestates the host chooses to share with its room (relayed, not stored).
// Lockstep inputs are relayed verbatim between the members of a room.
//
//   PORT=8080 node server/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../public');
const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOM = 8; // up to 4 players + spectators
const MAX_PLAYERS = 4;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.resolve(PUBLIC, '.' + p);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': p.startsWith('/core/') ? 'public, max-age=3600' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
  serveStatic(req, res);
});

// ---------------------------------------------------------------- lobby
const rooms = new Map(); // code -> room
const clients = new Map(); // id -> client

const newId = () => crypto.randomBytes(4).toString('hex');
function newRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}

function send(c, obj) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
}

function roomView(room) {
  return {
    t: 'room', code: room.code, host: room.host, delay: room.delay, speed: room.speed,
    members: room.members.map((id) => {
      const c = clients.get(id);
      return { id, name: c.name, port: room.ports.get(id) ?? -1, fp: c.fp, serial: c.serial };
    }),
  };
}

function broadcastRoom(room) {
  const v = roomView(room);
  for (const id of room.members) send(clients.get(id), v);
}

function relay(room, fromId, obj) {
  const s = JSON.stringify({ ...obj, p: fromId });
  for (const id of room.members) {
    if (id === fromId) continue;
    const c = clients.get(id);
    if (c.ws.readyState === 1) c.ws.send(s);
  }
}

function leaveRoom(c) {
  const room = rooms.get(c.room);
  c.room = null;
  if (!room) return;
  room.members = room.members.filter((id) => id !== c.id);
  room.ports.delete(c.id);
  if (!room.members.length) { rooms.delete(room.code); return; }
  if (room.host === c.id) room.host = room.members[0];
  for (const id of room.members) send(clients.get(id), { t: 'left', id: c.id });
  broadcastRoom(room);
}

function onJson(c, m) {
  const room = c.room ? rooms.get(c.room) : null;
  switch (m.t) {
    case 'hello':
      c.name = String(m.name || 'Hog').slice(0, 24);
      c.fp = String(m.fp || '').slice(0, 128);
      c.serial = String(m.serial || '').slice(0, 32);
      send(c, { t: 'welcome', id: c.id });
      return;
    case 'create': {
      if (room) leaveRoom(c);
      const code = newRoomCode();
      const r = { code, host: c.id, members: [c.id], ports: new Map([[c.id, 0]]), delay: 4, speed: 1 };
      rooms.set(code, r);
      c.room = code;
      broadcastRoom(r);
      return;
    }
    case 'join': {
      const code = String(m.code || '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) { send(c, { t: 'error', code: 'no-room', message: `Room ${code} not found.` }); return; }
      if (r.members.length >= MAX_ROOM) { send(c, { t: 'error', code: 'full', message: 'Room full.' }); return; }
      const host = clients.get(r.host);
      if (host.fp && c.fp && host.fp !== c.fp) {
        send(c, { t: 'error', code: 'disc', message: 'Your disc does not match the host\'s (the same version is required).' });
        return;
      }
      if (room) leaveRoom(c);
      r.members.push(c.id);
      // Hogs of War is hot-seat: every team plays on controller 1, so all
      // players share it by default (the client arbitrates who is in control).
      r.ports.set(c.id, r.members.length <= MAX_PLAYERS ? 0 : -1);
      c.room = code;
      // The membership change makes the host send everyone a fresh sync.
      broadcastRoom(r);
      return;
    }
    case 'leave':
      leaveRoom(c);
      send(c, { t: 'room', code: null, members: [] });
      return;
    case 'setPort': {
      if (!room || room.host !== c.id || !room.members.includes(m.id)) return;
      const port = m.port | 0;
      if (port < -1 || port >= MAX_PLAYERS) return;
      room.ports.set(m.id, port);
      broadcastRoom(room);
      return;
    }
    case 'setDelay':
      if (!room || room.host !== c.id) return;
      room.delay = Math.max(1, Math.min(15, m.delay | 0));
      broadcastRoom(room);
      return;
    case 'setSpeed':
      if (!room || room.host !== c.id) return;
      room.speed = [1, 1.5, 2, 3].includes(+m.speed) ? +m.speed : 1;
      broadcastRoom(room);
      return;
    case 'needsync':
      if (room) send(clients.get(room.host), { t: 'needsync', p: c.id });
      return;
    case 'in': case 'hash': case 'chat': case 'ping': case 'pause':
      if (room) relay(room, c.id, m);
      return;
    default:
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 * 1024 });
wss.on('connection', (ws) => {
  const c = { id: newId(), ws, name: 'Hog', fp: '', serial: '', room: null, alive: true };
  clients.set(c.id, c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary = host savestate sync: relay to the rest of the room.
      const room = c.room ? rooms.get(c.room) : null;
      if (!room || room.host !== c.id) return;
      for (const id of room.members) {
        if (id === c.id) continue;
        const o = clients.get(id);
        if (o.ws.readyState === 1) o.ws.send(data, { binary: true });
      }
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m && typeof m.t === 'string') onJson(c, m);
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(c.id); });
});

setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    c.ws.ping();
  }
}, 15000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Cochons de Guerre Web : http://localhost:${PORT}/`);
});

export { server };
