// Multiplayer mode end to end, two browsers:
//   - the menus lead by themselves to "SELECTION NIVEAU MULTIJOUEUR";
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
async function browser(name, q) {
  const b = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });
  const page = await b.newPage();
  await page.setViewport({ width: 1100, height: 620 });
  page.on('console', (m) => { const t = m.text(); if (/désynchro|error|snapshot|savestate: (LOAD|SAVE)/i.test(t)) console.log(`[${name}]`, t.slice(0, 200)); });
  page.on('pageerror', (e) => console.log(`[${name} error]`, e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?q=${q}${roomCode ? '&salon=' + roomCode : ''}`);
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

const host = await browser('Alice', 1);
await host.page.click('#btn-create');
await host.page.waitForSelector('#room:not([hidden])');
roomCode = await host.page.$eval('#room-code2', (e) => e.textContent);
let guest = await browser('Bruno', 1);
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

// Nobody touches anything: the menus must reach the multiplayer level select.
await untilFrame(1300);
await host.page.screenshot({ path: path.join(out, '1_niveau_alice.png') });
await guest.page.screenshot({ path: path.join(out, '1_niveau_bruno.png') });
console.log('      menus parcourus seuls jusqu’à l’image', await frameOf(), '(capture 1_niveau_*)');

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

// Bruno leaves...
await guest.b.close();
console.log('      Bruno a fermé son navigateur');
await sleep(15000);
const a2 = await info(host.page);
check(a2.frame > a.frame + 200, `Alice continue seule (image ${a2.frame})`);

// ...and comes back.
guest = await browser('Bruno', 1);
await guest.page.click('#btn-join');
await guest.page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 180000 });
const t0 = Date.now();
let rejoined = null;
while (Date.now() - t0 < 300000) {
  const [x, y] = await Promise.all([info(host.page), info(guest.page)]);
  if (y.frame > 0 && y.hashOk >= 3 && x.frame > a2.frame) { rejoined = [x, y]; break; }
  await sleep(2000);
}
check(!!rejoined, rejoined ? `Bruno a rejoint : il est à l’image ${rejoined[1].frame}, Alice à ${rejoined[0].frame}` : 'Bruno n’a pas pu rejoindre');
await sleep(20000);
await host.page.screenshot({ path: path.join(out, '4_apres_retour_alice.png') });
await guest.page.screenshot({ path: path.join(out, '4_apres_retour_bruno.png') });
const [x, y] = await Promise.all([info(host.page), info(guest.page)]);
check(x.desyncs === 0 && y.desyncs === 0 && y.hashOk >= 3,
  `après le retour, copies identiques : ${y.hashOk} empreintes égales chez Bruno, ${x.desyncs + y.desyncs} désynchronisation`);
check(x.team === y.team && x.holder === y.holder, `même tour chez les deux : équipe ${x.team}, joueur ${x.holder + 1} (« ${x.turn} » / « ${y.turn} »)`);
await host.b.close();
await guest.b.close();
srv.kill();
console.log(failures ? `${failures} échec(s)` : 'Mode multijoueur, réglage des équipes, départ et retour : tous les contrôles sont passés.');
process.exit(failures ? 1 : 0);
