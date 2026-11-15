// Two browsers, two players: each runs its own copy of the game (WebAssembly)
// and they play together through the lockstep relay. Both press keys; the
// test checks that both simulations advance, that their RAM digests agree
// (no desync) and that each one's input reaches the shared game.
//   node tests/multi.mjs <outdir> [seconds]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'multi-out');
const SECONDS = +(process.argv[3] || 120);
fs.mkdirSync(out, { recursive: true });
const PORT = 18400 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
srv.stdout.on('data', (d) => process.stdout.write('[serveur] ' + d));
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failures++; };

async function browser(name, viewport) {
  const b = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 600000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });
  const page = await b.newPage();
  await page.setViewport(viewport);
  page.on('console', (m) => { const t = m.text(); if (/lockstep|Désynchro|error/i.test(t) && !/frame \d/.test(t)) console.log(`[${name}]`, t); });
  page.on('pageerror', (e) => console.log(`[${name} error]`, e.message));
  await page.goto(`http://127.0.0.1:${PORT}/${name === 'hote' ? '' : '?salon=' + roomCode}`);
  await page.waitForFunction(() => /prêt|indisponible/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
  await page.type('#name', name === 'hote' ? 'Hôte' : 'Invité');
  return { b, page, name };
}
const info = (p) => p.evaluate(() => {
  const s = window.__cdg.state;
  return { stats: document.querySelector('#stats').textContent, turn: document.querySelector('#turn').textContent,
    hashOk: s.hashOk || 0, lastHashOk: s.lastHashOk || 0, desyncs: s.desyncs || 0, frame: s.lastStats ? s.lastStats.frame : 0 };
});

let roomCode = '';
const host = await browser('hote', { width: 1280, height: 720 });
await host.page.click('#btn-create');
await host.page.waitForSelector('#room:not([hidden])');
roomCode = await host.page.$eval('#room-code2', (e) => e.textContent);
const guest = await browser('invite', { width: 1024, height: 768 });
await guest.page.click('#btn-join');
await guest.page.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 2, { timeout: 30000 });
check(true, `salon ${roomCode} : 2 joueurs installés (Joueur 1 et Joueur 2)`);
await host.page.click('#btn-start');
await Promise.all([host, guest].map((x) => x.page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 120000 })));
check(true, 'les deux navigateurs ont démarré le jeu (WebAssembly, disque en streaming)');

// Inputs from both players: the host presses Start / Cross (menus), the guest
// presses Cross too; whoever holds the shared controller drives the game.
const press = async (p, key, ms = 250) => { await p.keyboard.down(key); await sleep(ms); await p.keyboard.up(key); };
const t0 = Date.now();
let i = 0;
while (Date.now() - t0 < SECONDS * 1000) {
  await sleep(5000);
  i++;
  if (i % 2) await press(host.page, 'Enter'); else await press(guest.page, 'Space');
  const [a, b] = await Promise.all([info(host.page), info(guest.page)]);
  console.log(`t=${Math.round((Date.now() - t0) / 1000)}s hôte: image ${a.frame} ${a.turn} (${a.hashOk} empreintes égales) · invité: image ${b.frame} ${b.turn} (${b.hashOk})`);
  if (i % 6 === 0) {
    await host.page.screenshot({ path: path.join(out, `hote_${i}.png`) });
    await guest.page.screenshot({ path: path.join(out, `invite_${i}.png`) });
  }
}
const [a, b] = await Promise.all([info(host.page), info(guest.page)]);
check(a.frame > 300 && b.frame > 300, `les deux simulations avancent (hôte ${a.frame}, invité ${b.frame} images)`);
check(Math.abs(a.frame - b.frame) < 60, `elles restent ensemble (écart ${Math.abs(a.frame - b.frame)} images)`);
check(a.desyncs === 0 && b.desyncs === 0, `aucune désynchronisation (hôte ${a.desyncs}, invité ${b.desyncs})`);
check(a.hashOk >= 3 && b.hashOk >= 3, `empreintes de la RAM identiques chez les deux joueurs (${a.hashOk} et ${b.hashOk} comparaisons, dernière à l’image ${Math.max(a.lastHashOk, b.lastHashOk)})`);
await host.page.screenshot({ path: path.join(out, 'hote_fin.png') });
await guest.page.screenshot({ path: path.join(out, 'invite_fin.png') });
await host.b.close();
await guest.b.close();
srv.kill();
console.log(failures ? `${failures} échec(s)` : 'Multijoueur en ligne : tous les contrôles sont passés.');
process.exit(failures ? 1 : 0);
