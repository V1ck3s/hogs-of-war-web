// What a remote player hears: open a room, let the intro play (the general's
// speech), record the Opus audio decoded by the browser, write it as WAV.
//   node tests/voices.mjs <out.wav> [seconds]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outFile = process.argv[2] || 'player_sound.wav';
const SECONDS = +(process.argv[3] || 240);
const PORT = 18900 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => { if (!/ffmpeg/.test(d)) process.stdout.write('[server] ' + d); });
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => { window.__cdgRecord = true; });
await page.click('#btn-create');
await page.waitForFunction(() => window.__cdg.room?.state === 'running', { timeout: 180000 });
await sleep(SECONDS * 1000);
const b64 = await page.evaluate(() => {
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
fs.writeFileSync(outFile, Buffer.concat([h, data]));
console.log(`sound decoded by the player's browser: ${(data.length / 192000).toFixed(1)} s → ${outFile}`);
await browser.close();
srv.kill('SIGTERM');
await sleep(3000);
process.exit(0);
