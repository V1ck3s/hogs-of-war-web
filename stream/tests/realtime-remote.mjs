// Real-speed check of the server with remote players.
//
// Two lightweight WebSocket clients (host + guest) join a room on the
// production build (no debug port, PGO, 50 Hz PAL) exactly like browsers do,
// but they only *record* what they receive, so the measurement is not skewed
// by decoding/rendering on the server machine (real players run elsewhere).
// The guest's H.264 and Opus are written to files and analysed afterwards;
// the host then drives the menus with the keyboard protocol (XTest path).
//
//   node tests/realtime-remote.mjs <outdir> [seconds]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'realtime-remote-out');
const SECONDS = +(process.argv[3] || 180);
fs.mkdirSync(out, { recursive: true });
const PORT = 19100 + Math.floor(Math.random() * 90);
const env = {
  ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
  CDG_GAME_DIR: path.resolve(HERE, '../../cochons/build-prod'),
  CDG_RENDERER: 'software', CDG_60HZ: '0', CDG_OVERCLOCK: '100',
  CDG_GAME_CPUS: process.env.RT_GAME_CPUS ?? '0,1,2', CDG_AUX_CPUS: process.env.RT_AUX_CPUS ?? '3',
  PSX_RUNTIME_PERF_DIAG: '1', PSX_RUNTIME_PERF_DIAG_MS: '5000',
};
// Server-side helpers (Node relay, PulseAudio daemon) and this test client
// run on the auxiliary core(s), like the encoders.
const AUX = env.CDG_AUX_CPUS;
const srv = AUX
  ? spawn('taskset', ['-c', AUX, process.execPath, path.join(HERE, '../server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
if (AUX) {
  try { execFileSync('taskset', ['-pc', AUX, String(process.pid)]); } catch { /* best effort */ }
  try { for (const pid of execFileSync('pgrep', ['-x', 'pulseaudio']).toString().trim().split('\n')) execFileSync('taskset', ['-apc', AUX, pid]); } catch { /* best effort */ }
}
let log = '';
srv.stdout.on('data', (d) => { log += d; if (!/ffmpeg/.test(d)) process.stdout.write('[serveur] ' + d); });
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failures++; };

// ---- minimal Ogg Opus writer (to decode the received packets offline)
const crcTable = new Uint32Array(256).map((_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
  return r >>> 0;
});
function oggCrc(buf) { let c = 0; for (const b of buf) c = ((c << 8) ^ crcTable[((c >>> 24) ^ b) & 0xff]) >>> 0; return c; }
class OggWriter {
  constructor(file) { this.fd = fs.openSync(file, 'w'); this.seq = 0; this.gran = 0n; }
  page(data, flags, gran) {
    const segs = []; let n = data.length;
    while (n >= 255) { segs.push(255); n -= 255; } segs.push(n);
    const h = Buffer.alloc(27 + segs.length);
    h.write('OggS', 0); h[4] = 0; h[5] = flags; h.writeBigInt64LE(gran, 6);
    h.writeUInt32LE(0x43444721, 14); h.writeUInt32LE(this.seq++, 18); h[26] = segs.length;
    Buffer.from(segs).copy(h, 27);
    const page = Buffer.concat([h, data]); page.writeUInt32LE(oggCrc(page), 22);
    fs.writeSync(this.fd, page);
  }
  start() {
    const head = Buffer.alloc(19); head.write('OpusHead', 0); head[8] = 1; head[9] = 2;
    head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
    this.page(head, 2, 0n);
    const vendor = Buffer.from('cdg'); const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0); tags.writeUInt32LE(vendor.length, 8); vendor.copy(tags, 12);
    this.page(tags, 0, 0n);
  }
  packet(p) { this.gran += 960n; this.page(p, 0, this.gran); }   // 20 ms frames
  close() { fs.closeSync(this.fd); }
}

function client(name, onBinary) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const c = { ws, msgs: [], send: (o) => ws.send(JSON.stringify(o)) };
    ws.on('open', () => c.send({ t: 'hello', name }));
    ws.on('message', (data, bin) => {
      if (bin) { onBinary && onBinary(data); return; }
      const m = JSON.parse(data); c.msgs.push(m);
      if (m.t === 'welcome') { c.id = m.id; resolve(c); }
      if (m.t === 'room') c.room = m;
    });
  });
}

const host = await client('Hôte');
host.send({ t: 'create', quality: process.env.RT_QUALITY || '360p', aspect: +(process.env.RT_ASPECT || 16 / 9) });
for (let i = 0; i < 600 && !(host.room && host.room.state === 'running'); i++) await sleep(250);
check(host.room && host.room.state === 'running', 'jeu lancé sur le serveur (build de production)');
check(/entrées : XTest/.test(log), 'entrées clavier par XTest (aucun port de debug)');

const h264 = fs.openSync(path.join(out, 'invite.h264'), 'w');
const ogg = new OggWriter(path.join(out, 'invite.ogg')); ogg.start();
let vFrames = 0, aPackets = 0, keyframes = 0;
const guest = await client('Invité', (buf) => {
  if (buf[0] === 1) { vFrames++; if (buf[1]) keyframes++; fs.writeSync(h264, buf.subarray(10)); }
  else if (buf[0] === 2) { aPackets++; ogg.packet(buf.subarray(9)); }
});
guest.send({ t: 'join', code: host.room.code });
const t0 = Date.now();
await sleep(SECONDS * 1000);
const wall = (Date.now() - t0) / 1000;
const vf = vFrames, ap = aPackets;

// Keyboard (pad protocol -> XTest): Start until the main menu, then
// MULTIJOUEUR (Down, Cross) and Cross through the setup into a battle.
const tap = async (c, bit, hold = 250) => { c.send({ t: 'pad', w: 1 << bit }); await sleep(hold); c.send({ t: 'pad', w: 0 }); };
const START = 3, DOWN = 6, LEFT = 7, CROSS = 14;
for (let i = 0; i < 4; i++) { await tap(host, START); await sleep(2500); }
await sleep(3000);
await tap(host, DOWN); await sleep(1500);
await tap(host, CROSS); await sleep(1500);
for (let i = 0; i < 40; i++) { await tap(host, CROSS); await sleep(1450); }
const battleT0 = Date.now();
await sleep(20000);
// The guest (remote, no game files) takes the shared controller and moves.
for (let i = 0; i < 10; i++) { await tap(guest, LEFT, 500); await sleep(300); }
await sleep(25000);
const battleSecs = (Date.now() - battleT0) / 1000;
host.ws.close(); guest.ws.close();
fs.closeSync(h264); ogg.close();
const glog = fs.readFileSync(`/tmp/cochons-stream/${host.room.code}/game.log`, 'utf8');
srv.kill('SIGTERM');
await sleep(4000);

const hzAll = [...glog.matchAll(/runtime cadence: guest=([0-9.]+) Hz/g)].map((m) => +m[1]);
const hz = hzAll.slice(2, 2 + Math.floor(SECONDS / 5) + 1);           // intro / title / demo window
const hzBattle = hzAll.slice(-Math.floor(battleSecs / 5));             // multiplayer battle window
const avg = hz.reduce((a, b) => a + b, 0) / hz.length;
console.log(`      cadence du jeu (Hz, toutes les 5 s) : ${hz.map((x) => x.toFixed(1)).join(' ')}`);
check(hz.length > 5 && avg >= 49.5 && Math.min(...hz) >= 48, `temps réel (intro, titre, démo) : moyenne ${avg.toFixed(2)} Hz, minimum ${Math.min(...hz).toFixed(1)} Hz (50 Hz PAL)`);
const avgB = hzBattle.reduce((a, b) => a + b, 0) / hzBattle.length;
console.log(`      cadence en bataille multijoueur : ${hzBattle.map((x) => x.toFixed(1)).join(' ')}`);
check(hzBattle.length >= 6 && avgB >= 49.5 && Math.min(...hzBattle) >= 48, `temps réel en bataille multijoueur : moyenne ${avgB.toFixed(2)} Hz, minimum ${Math.min(...hzBattle).toFixed(1)} Hz`);
const holderGuest = host.msgs.some((m) => m.t === 'room' && m.holder && m.holder === guest.id);
check(holderGuest, 'le joueur distant a pris la manette partagée pendant la bataille');
check(vf / wall >= 49, `vidéo reçue : ${(vf / wall).toFixed(1)} img/s (${keyframes} images clés)`);
check(ap * 0.02 >= wall * 0.98, `son reçu : ${(ap * 0.02).toFixed(1)} s de son pour ${wall.toFixed(1)} s écoulées`);

// Offline analysis of what the guest received.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(out, 'invite.ogg'), '-ar', '16000', '-ac', '1', path.join(out, 'invite16.wav')]);
const pcm = fs.readFileSync(path.join(out, 'invite16.wav')).subarray(44);
let silent = 0, windows = 0;
for (let o = 0; o + 3200 <= pcm.length; o += 3200) {          // 100 ms windows
  let e = 0; for (let i = o; i < o + 3200; i += 2) { const v = pcm.readInt16LE(i); e += v * v; }
  windows++; if (Math.sqrt(e / 1600) < 30) silent++;
}
console.log(`      son décodé : ${(pcm.length / 32000).toFixed(1)} s, ${(100 * silent / windows).toFixed(1)} % de fenêtres de 100 ms silencieuses`);
const frames = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', path.join(out, 'invite.h264')]).toString().trim();
console.log(`      vidéo décodée (largeur,hauteur,images) : ${frames}`);
const total = +frames.split(',')[2] / 50;
for (const t of [40, Math.floor(SECONDS) + 25, Math.floor(total) - 30, Math.floor(total) - 3]) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-r', '50', '-i', path.join(out, 'invite.h264'), '-vf', `select=eq(n\\,${t * 50})`, '-frames:v', '1', path.join(out, `invite_${t}s.png`)]);
}
console.log(failures ? `${failures} échec(s)` : 'Tous les contrôles temps réel sont passés.');
process.exit(failures ? 1 : 0);
