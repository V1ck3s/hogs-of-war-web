// One player, multiplayer mode, walks around a battle for MINUTES (default 6),
// watching that the game keeps running (freeze = no new frame for 10 s).
// Every page message is printed. ASPECT (16:9), Q (1).
// (setup part shared with join.mjs):
//   - the game boots straight into "SELECTION NIVEAU MULTIJOUEUR" (no logo,
//     title or main menu ever shown);
//   - each player, and only them, sets up their own team;
//   - in battle, Bruno leaves, then comes back: every copy reloads the same
//     snapshot and the game goes on with Bruno in his seat, copies identical.
//   node tests/join.mjs <outdir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'join-out');
fs.mkdirSync(out, { recursive: true });
const PORT = 18300 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
srv.stdout.on('data', (d) => process.stdout.write('[serveur] ' + d));
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failures++; };

let roomCode = '';
async function browser(name, q, aspect) {
  const b = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });
  const page = await b.newPage();
  await page.setViewport({ width: 1100, height: 620 });
  page.on('console', (m) => { const t = m.text(); if (!/lockstep frame|GL Driver Message/.test(t)) console.log(`[${name}]`, t.slice(0, 200)); });
  page.on('pageerror', (e) => console.log(`[${name} error]`, e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?q=${q}${process.env.GPU === "0" ? "&gpu=0" : ""}${process.env.SKIP === "1" ? "&rasterskip=1" : ""}${process.env.MEMO === "0" ? "&memo=0" : ""}${roomCode ? '&salon=' + roomCode : ''}`);
  await page.evaluate((a) => { const e = document.querySelector('#aspect'); e.value = a; e.onchange(); }, aspect);
  await page.waitForFunction(() => /prêt|indisponible/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
  await page.type('#name', name);
  return { b, page, name };
}
const info = (p) => p.evaluate(() => {
  const s = window.__cdg.state;
  const st = s.lastStats || {};
  return { frame: st.frame || 0, holder: st.holder, team: st.team || 0, turn: document.querySelector('#turn').textContent,
    hashOk: s.hashOk || 0, desyncs: s.desyncs || 0 };
});


const host = await browser('Alice', +(process.env.Q || 1), process.env.ASPECT || '16:9');
await host.page.click('#btn-create');
await host.page.waitForSelector('#room:not([hidden])');
await host.page.click('#btn-start');
await host.page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 120000 });
const frameOf = async () => (await info(host.page)).frame;
async function untilFrame(f) { while (await frameOf() < f) await sleep(300); }
async function tap(p, key, frames = 6) {
  const f0 = await frameOf();
  await p.keyboard.down(key);
  while (await frameOf() < f0 + frames) await sleep(30);
  await p.keyboard.up(key);
}
await untilFrame(700);
let a;
for (let i = 0; i < 200; i++) {
  a = await info(host.page);
  if ((a.team & 0xff) && !(a.team & 0x100) && a.frame > 2500) break;
  await tap(host.page, 'Space', 6); await sleep(600);
}
console.log(`      bataille : image ${a.frame}, « ${a.turn} »`);
const bufs = await host.page.evaluate(() => [0x80033AC4, 0x80037B38, 0x80029194].map((x) => window.__cdg.peek(x).toString(16)));
console.log(`      tampons de dessin : ${bufs[0]}, ${bufs[1]} (taille ${bufs[2]})`);
await host.page.screenshot({ path: path.join(out, 'bataille.png') });
// Walk: hold arrows in turn; cross the turn changes too.
const keys = process.env.ACTIONS
  // weapon menu, next weapon, take it, aim (L1), fire, jump, walk
  ? [['Backspace', 700], ['ArrowRight', 300], ['Space', 300], ['KeyQ', 2500], ['Space', 1500],
     ['ArrowUp', 2500], ['KeyF', 300], ['ArrowLeft', 1500], ['ArrowUp', 2000], ['Backspace', 700],
     ['ArrowRight', 300], ['ArrowRight', 300], ['Space', 300], ['Space', 2000], ['KeyR', 300]]
  : ['ArrowUp', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowUp'].map((k) => [k, 2500]);
const t0 = Date.now(); let last = await frameOf(), lastT = Date.now(), n = 0, frozen = false;
while (Date.now() - t0 < (+(process.env.MINUTES || 6)) * 60000) {
  const [k, hold] = keys[n % keys.length];
  await host.page.keyboard.down(k);
  const t1 = Date.now();
  while (Date.now() - t1 < hold) {
    await sleep(Math.min(500, hold));
    const f = await frameOf();
    if (f !== last) { last = f; lastT = Date.now(); }
    else if (Date.now() - lastT > 10000) { frozen = true; break; }
  }
  await host.page.keyboard.up(k);
  if (frozen) break;
  if (n % 6 === 0) {
    const x = await info(host.page);
    const pr = await host.page.evaluate(() => { try { return window.__cdg.state.game._swt_probe(3) >>> 0; } catch { return -1; } });
    console.log(`      t=${((Date.now() - t0) / 1000) | 0}s image ${x.frame} « ${x.turn} » relectures ${pr}`);
    await host.page.screenshot({ path: path.join(out, `w_${String(n).padStart(3, '0')}.png`) });
  }
  n++;
}
const x = await info(host.page);
await host.page.screenshot({ path: path.join(out, 'fin.png') });
check(!frozen, frozen ? `GEL : plus aucune image depuis 10 s (image ${x.frame})` : `le jeu tourne toujours (image ${x.frame})`);
if (frozen) {
  const tr = await host.page.evaluate(() => { try { return new TextDecoder().decode(window.__cdg.state.game.FS.readFile('/game/psx_cps_exit_trace.json')); } catch (e) { return 'pas de trace : ' + e.message; } });
  fs.writeFileSync(path.join(out, 'exit_trace.json'), tr);
  console.log('trace de sortie :', tr.slice(0, 200));
}
if (frozen && process.env.KEEP) { console.log('navigateur laissé ouvert'); await sleep(+process.env.KEEP * 1000); }
await host.b.close(); srv.kill(); process.exit(failures ? 1 : 0);
