// Production check at real speed: optimized build (no debug port, PGO),
// 50 Hz PAL, two remote players. Measures the game's cadence on the server
// while it streams, audio underruns at the player, records the audio the
// guest's browser decodes, then the host navigates the menus by keyboard
// (XTest path).   node tests/realtime.mjs <outdir> [seconds]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || 'realtime-out';
const SECONDS = +(process.argv[3] || 180);
fs.mkdirSync(out, { recursive: true });
const PORT = 19000 + Math.floor(Math.random() * 90);
const env = {
  ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
  CDG_GAME_DIR: path.resolve(HERE, '../../cochons/build-prod'),
  CDG_RENDERER: 'software', CDG_60HZ: '0', CDG_OVERCLOCK: '100',
  PSX_RUNTIME_PERF_DIAG: '1', PSX_RUNTIME_PERF_DIAG_MS: '5000',
  CDG_GAME_CPUS: process.env.RT_GAME_CPUS || '0,1,2', CDG_AUX_CPUS: process.env.RT_AUX_CPUS || '3',
};
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (d) => { log += d; if (!/ffmpeg/.test(d)) process.stdout.write('[serveur] ' + d); });
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failures++; };
// Players normally run on their own machines: keep the two test browsers at
// the lowest CPU priority so they do not steal the server's time.
fs.writeFileSync(path.join(os.tmpdir(), 'chromium-nice.sh'), '#!/bin/sh\nexec chrt --idle 0 /usr/bin/chromium "$@"\n', { mode: 0o755 });
const browser = await puppeteer.launch({
  executablePath: path.join(os.tmpdir(), 'chromium-nice.sh'), headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const host = await browser.newPage();
await host.setViewport({ width: 1280, height: 720 });
await host.goto(`http://localhost:${PORT}/`);
await host.$eval('#name', (el) => { el.value = 'Hôte'; });
await host.select('#lobby-quality', process.env.RT_QUALITY || '480p');
await host.click('#btn-create');
await host.waitForFunction(() => window.__cdg.room?.state === 'running', { timeout: 180000 });
const code = await host.evaluate(() => window.__cdg.room.code);
check(/entrées : XTest/.test(log), 'build de production : entrées clavier par XTest, sans port de contrôle');
const guest = await browser.newPage();
await guest.setViewport({ width: 1280, height: 800 });
await guest.goto(`http://localhost:${PORT}/#salon=${code}`);
await guest.evaluate(() => { window.__cdgRecord = true; });
await guest.$eval('#name', (el) => { el.value = 'Invité'; });
await guest.click('#btn-join');
await guest.waitForFunction(() => window.__cdg.stats.videoTotal > 10, { timeout: 120000 });
const t0 = Date.now();
await sleep(SECONDS * 1000);
const wall = (Date.now() - t0) / 1000;
const g = await guest.evaluate(() => ({ video: window.__cdg.stats.videoTotal, under: window.__cdg.stats.underruns || 0,
  audio: (window.__cdg.recorded || []).reduce((a, c) => a + c.length / 2, 0) }));
// Game cadence on the server during the session (runtime perf lines).
const glog = fs.readFileSync(`/tmp/cochons-stream/${code}/game.log`, 'utf8');
const hz = [...glog.matchAll(/runtime cadence: guest=([0-9.]+) Hz/g)].map((m) => +m[1]).slice(2);
const avg = hz.reduce((a, b) => a + b, 0) / hz.length;
console.log(`      cadence du jeu (Hz, toutes les 5 s) : ${hz.map((h) => h.toFixed(1)).join(' ')}`);
check(hz.length > 5 && Math.min(...hz) >= 47 && avg >= 49.5, `le jeu tient le temps réel en streaming : moyenne ${avg.toFixed(2)} Hz, minimum ${Math.min(...hz).toFixed(1)} Hz (50 Hz PAL)`);
const audioSec = g.audio / 48000;
check(audioSec >= wall * 0.95, `son reçu par l’invité : ${audioSec.toFixed(1)} s pour ${wall.toFixed(1)} s écoulées`);
check(g.under <= 3, `lecture audio de l’invité sans coupure (${g.under} sous-alimentation(s))`);
console.log(`      vidéo reçue par l’invité : ${(g.video / wall).toFixed(1)} img/s`);
// Audio as WAV for the language check.
const b64 = await guest.evaluate(() => {
  const chunks = window.__cdg.recorded || [];
  let n = 0; for (const c of chunks) n += c.length;
  const i16 = new Int16Array(n); let o = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++) i16[o++] = Math.max(-32768, Math.min(32767, c[i] * 32767));
  let s = ''; const u8 = new Uint8Array(i16.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
});
const data = Buffer.from(b64, 'base64');
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(192000, 28);
h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
fs.writeFileSync(path.join(out, 'son_invite.wav'), Buffer.concat([h, data]));
// Keyboard through XTest: the host presses Start until the main menu shows.
await host.bringToFront();
await host.screenshot({ path: path.join(out, 'avant_start.png') });
for (let i = 0; i < 6; i++) { await host.keyboard.down('Enter'); await sleep(200); await host.keyboard.up('Enter'); await sleep(2500); }
await host.screenshot({ path: path.join(out, 'hote_apres_start.png') });
await guest.screenshot({ path: path.join(out, 'invite_apres_start.png') });
await browser.close();
srv.kill('SIGTERM');
await sleep(4000);
console.log(failures ? `${failures} échec(s)` : 'Tous les contrôles temps réel sont passés.');
process.exit(failures ? 1 : 0);
