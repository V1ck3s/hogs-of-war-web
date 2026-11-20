// Bad connection: Bruno's link is slowed by the server (CDG_SLOW, default
// 300 ms + up to 300 ms each way: a 0.6-1.2 s round trip, jittery). In
// battle, measures how long each player's game waits for the network during
// their own turn (owner-only lockstep: should be ~0 whatever Bruno's link),
// how far the other one watches behind, and that the copies stay identical.
//   node tests/badnet.mjs <outdir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'join-out');
fs.mkdirSync(out, { recursive: true });
const PORT = 18300 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { CDG_SLOW: 'Bruno:300:300', ...process.env, CDG_RECORD: '0', PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  page.on('console', (m) => { const t = m.text(); if (/désynchro|error|snapshot|savestate: (LOAD|SAVE)|\[partie\]|\[lockstep\]/i.test(t)) console.log(`[${name}]`, t.slice(0, 200)); });
  page.on('pageerror', (e) => console.log(`[${name} error]`, e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?q=${q}${process.env.GPU === "0" ? "&gpu=0" : ""}${process.env.PLAYOUT === '0' ? '&playout=0' : ''}${roomCode ? '&salon=' + roomCode : ''}`);
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

const host = await browser('Alice', 1, '16:9');
await host.page.click('#btn-create');
await host.page.waitForSelector('#room:not([hidden])');
roomCode = await host.page.$eval('#room-code2', (e) => e.textContent);
let guest = await browser('Bruno', Number(process.env.QB || 1), process.env.AB || '32:9');
// THROTTLE_B=n: Bruno's machine n times slower (CPU throttling, workers included where the browser applies it).
if (process.env.THROTTLE_B) { const cdp = await guest.page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE_B) }); }
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

// Turn by turn: the owner walks; the game's network wait over the turn.
const waitOf = (p) => p.evaluate(() => (window.__cdg.state.lastStats || {}).waitMs || 0);
// How evenly a page's game takes its frames (counted by the game itself).
const evenOf = (p) => p.evaluate(() => { const s = window.__cdg.state.lastStats || {}; return { ...(s.even || { n: 0, late: 0, hitch: 0 }), play: s.play || { low: 0, level: 0, dry: 0 } }; });
async function measureTurn(team, who, other) {
  for (let i = 0; i < 180; i++) { const x = await info(host.page); if ((x.team & 0xff) === team && !(x.team & 0x100)) break; await sleep(1000); }
  // The watcher's buffer settles during the first second of the turn.
  await sleep(1500);
  const w0 = await waitOf(who.page), f0 = (await info(who.page)).frame, t0 = Date.now();
  const e0 = await evenOf(other.page);
  let behind = 0;
  for (const k of ['ArrowUp', 'ArrowLeft', 'ArrowUp', 'ArrowRight']) {
    await who.page.keyboard.down(k); await sleep(3000); await who.page.keyboard.up(k);
    const [x, y] = await Promise.all([info(who.page), info(other.page)]);
    behind = Math.max(behind, x.frame - y.frame);
  }
  const w1 = await waitOf(who.page), f1 = (await info(who.page)).frame, secs = (Date.now() - t0) / 1000;
  const e1 = await evenOf(other.page);
  const late = e1.late - e0.late, hitch = e1.hitch - e0.hitch, n = e1.n - e0.n;
  console.log(`      tour de ${who.name} : ${f1 - f0} images en ${secs.toFixed(1)} s, attente réseau ${w1 - w0} ms ; ${other.name} regarde jusqu’à ${behind} images derrière, ` +
    `${late} image(s) en retard et ${hitch} à-coup(s) sur ${n} (tampon ${e1.play.low}/${e1.play.level}, à sec ${e1.play.dry - e0.play.dry} fois)`);
  return { wait: w1 - w0, frames: f1 - f0, secs, late, hitch, n };
}
const total0 = await Promise.all([host, guest].map((x) => waitOf(x.page)));
const ta = await measureTurn(1, host, guest);
check(ta.wait < 500, `pendant son tour, Alice attend le réseau ${ta.wait} ms (Bruno a une mauvaise connexion)`);
const tb = await measureTurn(2, guest, host);
check(tb.wait < 500, `pendant son tour, Bruno attend le réseau ${tb.wait} ms malgré sa connexion`);
// Back to Alice: the turn change waits for Bruno at most the drift bound.
const tc = await measureTurn(1, host, guest);
const total1 = await Promise.all([host, guest].map((x) => waitOf(x.page)));
console.log(`      attente réseau sur toute la bataille : Alice ${total1[0] - total0[0]} ms, Bruno ${total1[1] - total0[1]} ms`);
check(tc.wait < 1500, `au retour de son tour, Alice attend ${tc.wait} ms`);
await sleep(5000);
const [x, y] = await Promise.all([info(host.page), info(guest.page)]);
check(x.desyncs === 0 && y.desyncs === 0 && (x.hashOk + y.hashOk) > 0, `copies identiques : ${x.hashOk}/${y.hashOk} empreintes égales, ${x.desyncs + y.desyncs} désynchronisation`);
await host.b.close(); await guest.b.close(); srv.kill();
console.log(failures ? `${failures} échec(s)` : 'Mauvaise connexion : tous les contrôles sont passés.');
process.exit(failures ? 1 : 0);
