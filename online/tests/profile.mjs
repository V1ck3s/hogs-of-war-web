// CPU profile of the game's WebAssembly threads in a 3D scene: one browser,
// UN JOUEUR mission (reached by the keyboard), then Chromium's sampling
// profiler on every worker for N seconds; prints the hottest functions by
// self time. Needs a wasm linked with --profiling-funcs.
//   node tests/profile.mjs [seconds]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECONDS = +(process.argv[2] || 20);
const PORT = 18600 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await b.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:${PORT}/?diag=1`);
page.on('console', (m) => { const t = m.text(); if (/runtime cadence/.test(t)) console.log('     ', t.match(/guest=[0-9.]+ Hz/)[0], t.match(/work guest=[0-9.]+/)[0]); });
await page.waitForFunction(() => /prêt/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
await page.click('#btn-create');
await page.waitForSelector('#room:not([hidden])');
if (process.env.ASPECT) await page.select('#aspect', process.env.ASPECT);
await page.click('#btn-start');
await page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 120000 });
const frame = () => page.evaluate(() => (window.__cdg.state.lastStats || {}).frame || 0);
async function untilFrame(f) { while (await frame() < f) await sleep(300); }
async function tap(key) { const f0 = await frame(); await page.keyboard.down(key); while (await frame() < f0 + 12) await sleep(40); await page.keyboard.up(key); }
let f = 1500;
for (let i = 0; i < 4; i++) { await untilFrame(f); await tap('Enter'); f += 137; }
f += 150;
for (let i = 0; i < 45; i++) { await untilFrame(f); await tap('KeyX'); f += 84; }
await untilFrame(f + 200);
console.log('mission à l’image', await frame(), '— profil sur', SECONDS, 's');

const sessions = [];
for (const t of b.targets()) {
  if (t.type() !== 'worker' && t.type() !== 'other') continue;
  try {
    const s = await t.createCDPSession();
    await s.send('Profiler.enable');
    await s.send('Profiler.setSamplingInterval', { interval: 500 });
    await s.send('Profiler.start');
    sessions.push(s);
  } catch { /* not a JS target */ }
}
await sleep(SECONDS * 1000);
const self = new Map();
let total = 0;
for (const s of sessions) {
  const { profile } = await s.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0));
  for (const [id, us] of dt) {
    const n = byId.get(id);
    const name = n.callFrame.functionName || '(anonymous)';
    if (name === '(idle)' || name === '(program)') continue;
    self.set(name, (self.get(name) || 0) + us);
    total += us;
  }
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
console.log(`total ${(total / 1e6).toFixed(1)} s de CPU échantillonnés sur ${sessions.length} threads`);
for (const [n, us] of top) console.log(`${(100 * us / total).toFixed(1).padStart(5)} %  ${n}`);
await b.close();
srv.kill();
