// One browser, one player: create a room, start, let the game boot in
// WebAssembly and take screenshots; prints the page console.
//   node tests/smoke.mjs <outdir> [seconds]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'smoke-out');
const SECONDS = +(process.argv[3] || 60);
fs.mkdirSync(out, { recursive: true });
const PORT = 18300 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
srv.stdout.on('data', (d) => process.stdout.write('[serveur] ' + d));
await new Promise((r) => srv.stdout.once('data', r));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 600000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const logs = [];
page.on('console', (m) => { logs.push(m.text()); if (logs.length < 400) console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?diag=1`);
await page.waitForFunction(() => /prêt|indisponible/.test(document.querySelector('#preload').textContent), { timeout: 120000 });
console.log('préchargement :', await page.$eval('#preload', (e) => e.textContent));
await page.type('#name', 'Testeur');
await page.click('#btn-create');
await page.waitForSelector('#room:not([hidden])');
await page.click('#btn-start');
const t0 = Date.now();
for (let t = 10; t <= SECONDS; t += 10) {
  await sleep(t * 1000 - (Date.now() - t0));
  const st = await page.evaluate(() => ({ stats: document.querySelector('#stats').textContent, splash: !document.querySelector('#splash').hidden }));
  console.log(`t=${t}s`, JSON.stringify(st));
  if (t === 10) console.log('mem', await page.evaluate(() => {
    const M = window.Module; const tags = M._psx_web_lockstep_tags();
    const u = new Uint32Array(M.wasmMemory.buffer);
    return { tags, t0: u[tags >> 2], t1: u[(tags >> 2) + 1], t5: u[(tags >> 2) + 5], heapSame: M.HEAPU32 && M.HEAPU32.buffer === M.wasmMemory.buffer,
      status: Array.from(u.subarray(M._psx_web_lockstep_status() >> 2, (M._psx_web_lockstep_status() >> 2) + 6)), shared: M.wasmMemory.buffer instanceof SharedArrayBuffer };
  }));
  await page.screenshot({ path: path.join(out, `t${t}.png`) });
}
fs.writeFileSync(path.join(out, 'console.txt'), logs.join('\n'));
await browser.close();
srv.kill();
