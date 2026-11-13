// Full game through the stream: the host (21:9 screen) drives the native game
// with the browser keyboard from boot to a multiplayer battle; a guest watches.
// Records the audio the player received (for language checking) and frames.
//   node tests/playthrough.mjs <outdir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || 'playthrough-out';
fs.mkdirSync(out, { recursive: true });
const PORT = 18700 + Math.floor(Math.random() * 200);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => { if (!/ffmpeg/.test(d)) process.stdout.write('[serveur] ' + d); });
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});

// Frame counter of the running game (runtime's local control port) — read only.
function gameFrame(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('{"id":1,"cmd":"frame"}\n'));
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); try { resolve(JSON.parse(buf).frame); } catch { resolve(-1); } } });
    s.on('error', () => resolve(-1));
  });
}

let serverLog = '';
srv.stdout.on('data', (d) => { serverLog += d; });
async function displayOf(code) {
  for (let i = 0; i < 100; i++) {
    const m = serverLog.match(new RegExp(`salon ${code} : jeu lancé \\(:(\\d+)`));
    if (m) return m[1];
    await sleep(200);
  }
  throw new Error('display inconnu');
}
const host = await browser.newPage();
await host.setViewport({ width: 1680, height: 720 }); // 21:9 screen
await host.goto(`http://localhost:${PORT}/`);
await host.$eval('#name', (el) => { el.value = 'Hôte'; });
await host.evaluate(() => { window.__cdgRecord = true; });
await host.click('#btn-create');
await host.waitForFunction(() => window.__cdg.room?.state === 'running', { timeout: 180000 });
const code = await host.evaluate(() => window.__cdg.room.code);
// Control port of this room's game (display :N → port 4400 + N), from the server log.
const port = 4400 + +(await displayOf(code));
const guest = await browser.newPage();
await guest.setViewport({ width: 1280, height: 800 }); // 16:10 laptop
await guest.goto(`http://localhost:${PORT}/#salon=${code}`);
await guest.$eval('#name', (el) => { el.value = 'Invité'; });
await guest.click('#btn-join');
await host.bringToFront();

const tap = async (key) => { await host.keyboard.down(key); await sleep(120); await host.keyboard.up(key); };
// Boot → main menu (Start), MULTIJOUEUR (Down, Cross), then confirm defaults.
// Start skips the intro and the title (3 presses reach the main menu at
// ~frame 1050); one more Start in the main menu would pick UN JOUEUR.
const script = [[600, 'Enter'], [800, 'Enter'], [1000, 'Enter']];
script.push([1350, 'ArrowDown'], [1450, 'KeyX']);
for (let i = 0; i < 40; i++) script.push([1550 + i * 85, 'KeyX']);
const END = 1550 + 40 * 85 + 3000;
// During the battle: the guest takes the shared controller (host idle).
const GUEST_AT = 1550 + 40 * 85 + 1500;
let next = 0, shot = 0, guestDone = false;
for (;;) {
  const f = await gameFrame(port);
  if (f < 0) { await sleep(500); continue; }
  while (next < script.length && f >= script[next][0]) { await tap(script[next][1]); next++; }
  if (f >= shot) {
    await host.screenshot({ path: path.join(out, `hote_${String(f).padStart(6, '0')}.png`) });
    shot = f + 400;
  }
  if (!guestDone && f >= GUEST_AT) {
    guestDone = true;
    await guest.bringToFront();
    for (let i = 0; i < 6; i++) { await guest.keyboard.down('ArrowLeft'); await sleep(400); await guest.keyboard.up('ArrowLeft'); await sleep(200); }
    const g = await guest.evaluate(() => ({ holder: window.__cdg.room.holder, id: window.__cdg.id }));
    console.log(g.holder === g.id ? 'OK   l’invité joue (manette 1) pendant la bataille' : 'FAIL l’invité n’a pas pris la manette');
    await guest.screenshot({ path: path.join(out, 'invite_joue.png') });
    await host.bringToFront();
  }
  if (f >= END) break;
  await sleep(50);
}
await guest.screenshot({ path: path.join(out, 'invite_bataille.png') });
await host.screenshot({ path: path.join(out, 'hote_bataille.png') });
const stats = await host.evaluate(() => ({ vcfg: window.__cdg.vcfg, video: window.__cdg.stats.videoTotal }));
console.log('flux hôte', stats);
// Audio the player actually received, as 48 kHz stereo WAV.
const pcm = await host.evaluate(() => {
  const chunks = window.__cdg.recorded || [];
  let n = 0; for (const c of chunks) n += c.length;
  const i16 = new Int16Array(n); let o = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++) i16[o++] = Math.max(-32768, Math.min(32767, c[i] * 32767));
  let s = ''; const u8 = new Uint8Array(i16.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
});
const data = Buffer.from(pcm, 'base64');
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(192000, 28);
h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
fs.writeFileSync(path.join(out, 'son_recu.wav'), Buffer.concat([h, data]));
console.log(`son reçu par le joueur : ${(data.length / 192000).toFixed(0)} s`);
await browser.close();
srv.kill('SIGTERM');
await sleep(3000);
process.exit(0);
