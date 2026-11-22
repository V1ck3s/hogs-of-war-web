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
srv.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
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
  await page.goto(`http://127.0.0.1:${PORT}/?q=${q}${process.env.GPU === "0" ? "&gpu=0" : ""}${process.env.SKIP === "1" ? "&rasterskip=1" : ""}${process.env.MEMO === "0" ? "&memo=0" : ""}${roomCode ? '&room=' + roomCode : ''}`);
  await page.evaluate((a) => { const e = document.querySelector('#aspect'); e.value = a; e.onchange(); }, aspect);
  await page.waitForFunction(() => /ready|disc|unavailable/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
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
console.log(`      battle: frame ${a.frame}, "${a.turn}"`);
const bufs = await host.page.evaluate(() => [0x80033AC4, 0x80037B38, 0x80029194].map((x) => window.__cdg.peek(x).toString(16)));
console.log(`      drawing buffers: ${bufs[0]}, ${bufs[1]} (size ${bufs[2]})`);
await host.page.screenshot({ path: path.join(out, 'battle.png') });


const shot = (n) => host.page.screenshot({ path: path.join(out, n + '.png') });
async function hold(k, frames) { const f0 = await frameOf(); await host.page.keyboard.down(k); await untilFrame(f0 + frames); await host.page.keyboard.up(k); }
await untilFrame((await frameOf()) + 100);
await shot('m0');
await hold('Escape', 8); await untilFrame((await frameOf()) + 60); await shot('m1_pause');
await hold('Escape', 8); await untilFrame((await frameOf()) + 60); await shot('m2_after_pause');
await hold('Backspace', 20); await untilFrame((await frameOf()) + 40); await shot('m3_weapons');
await hold('KeyR', 8); await untilFrame((await frameOf()) + 60); await shot('m4');
await hold('Tab', 8); await untilFrame((await frameOf()) + 60); await shot('m5_select');
await hold('Tab', 8); await untilFrame((await frameOf()) + 60); await shot('m6');
console.log('end', await frameOf());
await host.b.close(); srv.kill(); process.exit(0);
