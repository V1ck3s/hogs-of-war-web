// Multiplayer mode end to end, two browsers with different screen shapes
// (both 32:9, Alice at Q, default 4x), then idle through several turns,
// logging the render probes and a screenshot every 10 s (MINUTES, RASTER=1).
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
  page.on('console', (m) => { const t = m.text(); if (name === 'Alice' || /désynchro|error|snapshot|savestate: (LOAD|SAVE)|\[partie\]|\[lockstep\]/i.test(t)) console.log(`[${name}]`, t.slice(0, 200)); });
  page.on('pageerror', (e) => console.log(`[${name} error]`, e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?q=${q}${process.env.GPU === "0" ? "&gpu=0" : ""}${process.env.RASTER === "1" ? "&raster=1" : ""}${roomCode ? '&salon=' + roomCode : ''}`);
  await page.evaluate((a) => { const e = document.querySelector('#aspect'); e.value = a; e.onchange(); }, aspect);
  await page.waitForFunction(() => /prêt|disque|indisponible/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
  await page.type('#name', name);
  return { b, page, name };
}
const info = (p) => p.evaluate(() => {
  const s = window.__cdg.state;
  const st = s.lastStats || {};
  return { frame: st.frame || 0, holder: st.holder, team: st.team || 0, turn: document.querySelector('#turn').textContent,
    hashOk: s.hashOk || 0, desyncs: s.desyncs || 0 };
});

const host = await browser('Alice', +(process.env.Q || 4), '32:9');
await host.page.click('#btn-create');
await host.page.waitForSelector('#room:not([hidden])');
roomCode = await host.page.$eval('#room-code2', (e) => e.textContent);
let guest = await browser('Bruno', 1, '32:9');
await guest.page.click('#btn-join');
await guest.page.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 2, { timeout: 30000 });
await host.page.click('#btn-start');
await Promise.all([host, guest].map((x) => x.page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 120000 })));
check(true, `salon ${roomCode} en mode Multijoueur : Alice et Bruno ont lancé leur copie`);

const frameOf = async () => (await info(host.page)).frame;
async function untilFrame(f) { while (await frameOf() < f) await sleep(300); }
async function tap(p, key, frames = 6) {
  const f0 = await frameOf();
  await p.keyboard.down(key);
  while (await frameOf() < f0 + frames) await sleep(30);
  await p.keyboard.up(key);
}

// Nobody touches anything: the first picture shown is the level select.
const MENU_PTR = 0x800858A4, LEVEL = 0x800E4BA0;
const seen = new Set();
for (;;) {
  const v = await host.page.evaluate((a) => ({ m: window.__cdg.peek(a), f: (window.__cdg.state.lastStats || {}).frame || 0 }), MENU_PTR);
  if (v.m) seen.add(v.m.toString(16));
  if (v.m === LEVEL) break;
  if (v.f > 6000) break;
  await sleep(100);
}
check([...seen].every((m) => m === LEVEL.toString(16)), `aucun autre menu avant la sélection de niveau (menus vus : ${[...seen].join(', ')})`);
await untilFrame((await frameOf()) + 60);
await host.page.screenshot({ path: path.join(out, '1_niveau_alice.png') });
await guest.page.screenshot({ path: path.join(out, '1_niveau_bruno.png') });
console.log('      sélection de niveau atteinte à l’image', await frameOf(), '(capture 1_niveau_*)');

// Back is refused on that screen.
await tap(host.page, 'Backspace', 10); await tap(host.page, 'KeyR', 10);
await sleep(1500);
await host.page.screenshot({ path: path.join(out, '2_retour_refuse.png') });

// Alice picks the level, then each team is set up by its owner ("JOUEUR
// SUIVANT" is preselected: one validation per team). While Bruno sets up his
// team, Alice's key must do nothing.
let sawAliceSetup = false, sawBrunoSetup = false, aliceIgnored = null;
for (let i = 0; i < 120; i++) {
  const x = await info(host.page);
  const setup = x.team & 0x100;
  if (!setup && (x.team & 0xff) && x.frame > 3000) break;          // battle
  if (setup && x.holder === 0) sawAliceSetup = true;
  if (setup && x.holder === 1) {
    sawBrunoSetup = true;
    if (aliceIgnored === null) {
      await tap(host.page, 'Space', 6); await sleep(1500);
      const y = await info(host.page);
      aliceIgnored = (y.team === x.team && y.holder === 1);
      await host.page.screenshot({ path: path.join(out, '2b_reglage_bruno.png') });
    }
  }
  await tap(setup && x.holder === 1 ? guest.page : host.page, 'Space', 6);
  await sleep(700);
}
check(sawAliceSetup && sawBrunoSetup, `réglage des équipes : Alice puis Bruno ont eu la main sur leur propre équipe`);
check(aliceIgnored === true, 'pendant que Bruno règle son équipe, la touche d’Alice ne fait rien');

// Battle
let a;
for (let i = 0; i < 400; i++) { a = await info(host.page); if ((a.team & 0xff) && !(a.team & 0x100)) break; await sleep(1000); }
await host.page.screenshot({ path: path.join(out, '3_bataille_alice.png') });
console.log(`      bataille : image ${a.frame}, « ${a.turn} »`);
check(a.team > 0, `la bataille a commencé (équipe ${a.team} joue)`);


await host.page.evaluate(() => {
  const c = document.querySelector('#canvas');
  c.addEventListener('webglcontextlost', () => console.log('WEBGL CONTEXT LOST'));
});
const probe = (p) => p.evaluate(() => { const M = window.__cdg.state.game; try { return [0,1,2,3,4,7,8,9,10].map((i) => M._swt_probe(i) >>> 0); } catch (e) { return String(e); } });
const t0 = Date.now(); let n = 0; let lastTurn = '';
while (Date.now() - t0 < (+(process.env.MINUTES || 8)) * 60000) {
  const [x, y] = await Promise.all([info(host.page), info(guest.page)]);
  const pr = await probe(host.page);
  if (x.turn !== lastTurn) { lastTurn = x.turn; console.log(`      tour : « ${x.turn} » image ${x.frame}`); }
  console.log(`      t=${((Date.now()-t0)/1000)|0}s A:${x.frame} B:${y.frame} hash ${y.hashOk} desync ${x.desyncs+y.desyncs} probe ${JSON.stringify(pr)}`);
  await host.page.screenshot({ path: path.join(out, `t_${String(n++).padStart(3, '0')}.png`) });
  await sleep(10000);
}
await host.b.close(); await guest.b.close(); srv.kill(); process.exit(0);
