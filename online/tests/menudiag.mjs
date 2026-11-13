// Diagnostic: one browser, Multijoueur mode, logs the menu variables the
// automatic menu driver reads (turn_owner.c) once a second.
//   node tests/menudiag.mjs [frames]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const END = +(process.argv[2] || 3600);
const PORT = 18200 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await b.newPage();
await page.setViewport({ width: 900, height: 560 });
await page.goto(`http://127.0.0.1:${PORT}/?q=1`);
await page.waitForFunction(() => /prêt/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
await page.click('#btn-create');
await page.waitForSelector('#room:not([hidden])');
if (process.env.MODE) await page.select('#mode', process.env.MODE);
await page.click('#btn-start');
await page.waitForFunction(() => document.querySelector('#splash').hidden, { timeout: 120000 });
let last = '';
for (;;) {
  const v = await page.evaluate(() => {
    const p = window.__cdg.peek, s = window.__cdg.state.lastStats || {};
    const h = (a) => p(a).toString(16);
    return { f: s.frame || 0, line: `state=${h(0x8002AA50)} menu=${h(0x800858A4)} cur=${p(p(0x800858A4) + 12)} team=${p(0x80085960)&255} types=${[0, 1, 2, 3].map((i) => p(0x8002C9F8 + 4 * i)).join('')} tcur=${p(0x800E484C)} holder=${s.holder} team=${s.team}` };
  });
  if (v.line !== last) { console.log(v.f, v.line); last = v.line; }
  if (v.f > END) break;
  await new Promise((r) => setTimeout(r, 250));
}
await page.screenshot({ path: process.env.SHOT || '/tmp/menudiag.png' });
await b.close();
srv.kill();
