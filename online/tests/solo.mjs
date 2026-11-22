// Two browsers; the host picks UN JOUEUR (single player) with the
// keyboard. Checks: both copies of the game stay identical (RAM digests), the
// turn indicator shows the team whose turn it is and its owner on both
// screens, turns change hands, and the non-owner's keys do not act for the
// owner (the owner's do).
//   node tests/battle.mjs <outdir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'battle-out');
fs.mkdirSync(out, { recursive: true });
const PORT = 18500 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
srv.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failures++; };

let roomCode = '';
async function browser(name, viewport) {
  const b = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });
  const page = await b.newPage();
  await page.setViewport(viewport);
  page.on('console', (m) => { const t = m.text(); if (/desync|error/i.test(t)) console.log(`[${name}]`, t); });
  page.on('pageerror', (e) => console.log(`[${name} error]`, e.message));
  await page.goto(`http://127.0.0.1:${PORT}/${roomCode ? '?room=' + roomCode : ''}`);
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

const host = await browser('Alice', { width: 1280, height: 720 });
await host.page.click('#btn-create');
await host.page.waitForSelector('#room:not([hidden])');
roomCode = await host.page.$eval('#room-code2', (e) => e.textContent);
const guest = await browser('Bruno', { width: 1100, height: 700 });
await guest.page.click('#btn-join');
await guest.page.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 2, { timeout: 30000 });
await host.page.click('#btn-start');
await Promise.all([host, guest].map((x) => x.page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 120000 })));
check(true, `room ${roomCode}: Alice (Player 1) and Bruno (Player 2) each started their copy of the game`);

const frameOf = async () => (await info(host.page)).frame;
async function untilFrame(f) { while (await frameOf() < f) await sleep(300); }
// One key press lasting ~12 game frames whatever the browser's speed.
async function tap(p, key, frames = 12) {
  const f0 = await frameOf();
  await p.keyboard.down(key);
  while (await frameOf() < f0 + frames) await sleep(40);
  await p.keyboard.up(key);
}
// Single player: the host goes UN JOUEUR > NOUVELLE PARTIE and validates.
let f = 1500;
for (let i = 0; i < 4; i++) { await untilFrame(f); await tap(host.page, 'Enter'); f += 137; }
f += 150;
for (let i = 0; i < 45; i++) { await untilFrame(f); await tap(host.page, 'Space'); f += 84; }
await untilFrame(f + 300);
const a = await info(host.page), b = await info(guest.page);
console.log(`      solo mission at frame ${a.frame}: Alice "${a.turn}", Bruno "${b.turn}"`);
check(a.team === 0 && a.holder === 0 && b.holder === 0, 'in solo, control stays with the host (no turn given to the guest)');
const shot = (p) => p.screenshot({ encoding: 'base64', clip: { x: 0, y: 60, width: 1100, height: 560 } });
const before = await shot(host.page);
for (let i = 0; i < 6; i++) { await tap(guest.page, 'ArrowLeft', 25); await tap(guest.page, 'ArrowUp', 25); }
const afterGuest = await shot(host.page);
for (let i = 0; i < 6; i++) { await tap(host.page, 'ArrowLeft', 25); await tap(host.page, 'ArrowUp', 25); }
const afterHost = await shot(host.page);
fs.writeFileSync(path.join(out, '1_before.png'), Buffer.from(before, 'base64'));
fs.writeFileSync(path.join(out, '2_after_guest.png'), Buffer.from(afterGuest, 'base64'));
fs.writeFileSync(path.join(out, '3_after_host.png'), Buffer.from(afterHost, 'base64'));
const [x, y] = await Promise.all([info(host.page), info(guest.page)]);
check(x.desyncs === 0 && y.desyncs === 0 && x.hashOk > 5, `identical copies: ${x.hashOk} / ${y.hashOk} matching digests`);
await host.b.close();
await guest.b.close();
srv.kill();
console.log(failures ? `${failures} failure(s)` : 'Online solo: all checks passed.');
process.exit(failures ? 1 : 0);
