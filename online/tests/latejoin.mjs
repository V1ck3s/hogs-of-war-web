// Short late-join check: Alice starts a game alone, Bruno joins it while it
// runs; both must reload the same snapshot and then agree (digests).
//   GPU=0|1 node tests/latejoin.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
srv.stdout.on('data', (d) => process.stdout.write('[serveur] ' + d));
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let room = '';
async function browser(name) {
  const b = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });
  const page = await b.newPage();
  await page.setViewport({ width: 900, height: 500 });
  page.on('console', (m) => { const t = m.text(); if (/partie\]|lockstep|savestate: (LOAD|SAVE)|error/i.test(t) && !/GL Driver/.test(t)) console.log(`[${name}]`, t.slice(0, 200)); });
  page.on('pageerror', (e) => console.log(`[${name} error]`, e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?q=1&gpu=${process.env.GPU ?? 1}${room ? '&salon=' + room : ''}`);
  await page.waitForFunction(() => /prêt/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
  await page.type('#name', name);
  return { b, page };
}
const info = (p) => p.evaluate(() => { const s = window.__cdg.state; return { frame: (s.lastStats || {}).frame || 0, ok: s.hashOk || 0, bad: s.desyncs || 0 }; });
const A = await browser('Alice');
await A.page.click('#btn-create');
await A.page.waitForSelector('#room:not([hidden])');
room = await A.page.$eval('#room-code2', (e) => e.textContent);
await A.page.click('#btn-start');
await A.page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 180000 });
console.log('Alice joue', await info(A.page));
const B = await browser('Bruno');
await B.page.click('#btn-join');
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  await sleep(5000);
  const [a, b] = await Promise.all([info(A.page), info(B.page)]);
  console.log(`t=${Math.round((Date.now() - t0) / 1000)}s Alice ${JSON.stringify(a)} Bruno ${JSON.stringify(b)}`);
  if (b.ok >= 3) break;
}
await A.b.close(); await B.b.close(); srv.kill();
