// Plays back a session the server recorded (online/recordings/<name>.jsonl)
// in a headless browser, until UNTIL frames (default: the recording's end +
// 600) or a crash / freeze, then compares the game digests every 600 frames
// with the recorded ones (same inputs => same game, if the build is the same).
//   node tests/replay.mjs <name.jsonl> <outdir>     env Q, ASPECT, GPU=0
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REC = path.resolve(HERE, '../recordings');
const name = process.argv[2];
const out = path.resolve(process.argv[3] || 'replay-out');
fs.mkdirSync(out, { recursive: true });
const lines = fs.readFileSync(path.join(REC, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lastF = lines.filter((l) => l.w).reduce((a, l) => Math.max(a, l.f + l.w.length - 1), 0);
const want = new Map(lines.filter((l) => l.t === 'hash').map((l) => [l.f, l.h]));
const UNTIL = +(process.env.UNTIL || lastF + 600);
console.log(`enregistrement : ${lastF + 1} images d’entrées, ${want.size} empreintes ; rejoué jusqu’à ${UNTIL}`);

const PORT = 18400 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
let recName = '';
srv.stdout.on('data', (d) => process.stdout.write('[serveur] ' + d));
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const before = new Set(fs.existsSync(REC) ? fs.readdirSync(REC) : []);

const b = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await b.newPage();
await page.setViewport({ width: 1100, height: 620 });
page.on('console', (m) => { const t = m.text(); if (!/lockstep frame|GL Driver Message/.test(t)) console.log('[page]', t.slice(0, 300)); });
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?replay=${encodeURIComponent(name)}&q=${process.env.Q || 1}${process.env.GPU === '0' ? '&gpu=0' : ''}${process.env.PREFETCH === '0' ? '&prefetch=0' : ''}`);
await page.evaluate((a) => { const e = document.querySelector('#aspect'); e.value = a; e.onchange(); }, process.env.ASPECT || '16:9');
await page.waitForFunction(() => /prêt|disque|indisponible/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
await page.click('#btn-create');
await page.waitForSelector('#room:not([hidden])');
await page.click('#btn-start');
await page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 120000 });
const frame = () => page.evaluate(() => (window.__cdg.state.lastStats || {}).frame || 0);
// DUMP_AT=f1,f2,...: guest RAM images (2 MB) once the game passes those frames.
const dumps = (process.env.DUMP_AT || '').split(',').filter(Boolean).map(Number);
async function dumpRam(tag) {
  const b64 = await page.evaluate(() => {
    const g = window.__cdg.state.game, n = 0x200000 / 4, u = new Uint32Array(n);
    for (let i = 0; i < n; i++) u[i] = g._psx_web_peek32(0x80000000 + i * 4);
    const b = new Uint8Array(u.buffer); let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fs.writeFileSync(path.join(out, `ram_${tag}.bin`), Buffer.from(b64, 'base64'));
  console.log(`      RAM enregistrée : ram_${tag}.bin`);
}
let last = 0, lastT = Date.now(), frozen = false, shot = 0;
const t0 = Date.now();
for (;;) {
  await sleep(1000);
  const f = await frame();
  if (f !== last) { last = f; lastT = Date.now(); } else if (Date.now() - lastT > 15000) { frozen = true; break; }
  while (dumps.length && f >= dumps[0]) { dumps.shift(); await dumpRam(String(await frame())); await page.screenshot({ path: path.join(out, `d_${await frame()}.png`) }); }
  if (f >= UNTIL) break;
  if (Date.now() - t0 > shot * 30000) { console.log(`      t=${((Date.now() - t0) / 1000) | 0}s image ${f}`); await page.screenshot({ path: path.join(out, `r_${String(shot).padStart(3, '0')}.png`) }); shot++; }
}
await page.screenshot({ path: path.join(out, 'fin.png') });
// Highest byte ever written in the moved packet buffer db1 (0x80200000, 8 MB
// RAM, zero at boot): the peak size of one frame's GPU packets.
const hwm = await page.evaluate(() => {
  const g = window.__cdg.state.game;
  for (let a = 0x80280000; a >= 0x80200000; a -= 4) if (g._psx_web_peek32(a) !== 0) return a - 0x80200000 + 4;
  return 0;
});
const gl = await page.evaluate(() => { const s = window.__cdg.state, g = s.game; const p = (i) => { try { return g._swt_probe(i) >>> 0; } catch { return -1; } };
  return { resyncs: p(7), shown: s.display ? s.display.frames : -1, frame: (s.lastStats || {}).frame }; });
console.log(`image GPU : ${gl.shown} images affichées pour ${gl.frame} images de jeu, ${gl.resyncs} renvois complets de la VRAM (retard de l’affichage)`);
console.log(`tampon de dessin db1 : au plus ${(hwm / 1024).toFixed(1)} Ko utilisés sur 320 Ko (l’original en avait 160)`);
console.log(frozen ? `ARRÊT/GEL à l’image ${last}` : `atteint l’image ${last}`);
if (frozen) {
  const tr = await page.evaluate(() => { try { return new TextDecoder().decode(window.__cdg.state.game.FS.readFile('/game/psx_cps_exit_trace.json')); } catch (e) { return 'pas de trace : ' + e.message; } });
  fs.writeFileSync(path.join(out, 'exit_trace.json'), tr);
  console.log('trace de sortie :', tr.slice(0, 300));
}
await b.close(); srv.kill();
await sleep(300);
recName = fs.readdirSync(REC).filter((f) => !before.has(f)).sort().pop();
if (recName) {
  const got = new Map(fs.readFileSync(path.join(REC, recName), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t === 'hash').map((l) => [l.f, l.h]));
  let same = 0, diff = [];
  for (const [f, h] of want) if (got.has(f)) { if (got.get(f) === h) same++; else diff.push(f); }
  console.log(`empreintes : ${same} identiques, ${diff.length} différentes${diff.length ? ' (première à l’image ' + Math.min(...diff) + ')' : ''}`);
  fs.unlinkSync(path.join(REC, recName));
}
process.exit(0);
