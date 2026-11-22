// Picture-path diagnostic: one browser, single player, chosen quality and
// shape; prints the game's pace (guest Hz) and the page main thread's long
// tasks every 5 s, then saves a screenshot.
//   GPU=0|1 Q=4 ASPECT=32:9 SECONDS=60 SHOT=file.png node tests/gpudiag.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18700 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await b.newPage();
await page.setViewport({ width: 1600, height: 450 });
page.on('console', (m) => {
  const t = m.text();
  if (/runtime cadence/.test(t)) console.log('     ', t.match(/guest=[0-9.]+ Hz/)[0]);
  else if (/GL|WebGL|shader|error|Error/.test(t)) console.log('[page]', t.slice(0, 300));
});
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.evaluateOnNewDocument(() => {
  window.__long = 0; window.__longN = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__long += e.duration; window.__longN++; } }).observe({ entryTypes: ['longtask'] }); } catch {}
});
await page.goto(`http://127.0.0.1:${PORT}/?${(process.env.DIAG ?? '1') === '1' ? 'diag=1&' : ''}&q=${process.env.Q || 4}&gpu=${process.env.GPU ?? 1}`);
await page.waitForFunction(() => /ready/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
await page.type('#name', 'Diag');
await page.click('#btn-create');
await page.waitForSelector('#room:not([hidden])');
if (process.env.ASPECT) await page.select('#aspect', process.env.ASPECT);
await page.click('#btn-start');
const t0 = Date.now();
const N = +(process.env.SECONDS || 60);
let prof = null;
if (process.env.PROFILE) {
  prof = await page.createCDPSession();
  await prof.send('Profiler.enable');
  await prof.send('Profiler.setSamplingInterval', { interval: 1000 });
  await prof.send('Profiler.start');
}
while (Date.now() - t0 < N * 1000) {
  await sleep(5000);
  const r = await page.evaluate(() => { const o = { long: Math.round(window.__long), n: window.__longN, frame: (window.__cdg?.state.lastStats || {}).frame || 0, pics: window.__cdg?.state.display?.frames || 0 }; window.__long = 0; window.__longN = 0; return o; });
  console.log(`t=${Math.round((Date.now() - t0) / 1000)}s frame ${r.frame} · pictures shown ${r.pics} · long tasks ${r.n} (${r.long} ms)`);
}
if (process.env.STACK) {
  // Where is each worker thread right now? (pause, print the stack, resume)
  for (const t of b.targets()) {
    if (t.type() !== 'worker' && t.type() !== 'other') continue;
    try {
      const s = await t.createCDPSession();
      await s.send('Debugger.enable');
      const paused = new Promise((r) => s.once('Debugger.paused', r));
      await s.send('Debugger.pause');
      const ev = await Promise.race([paused, sleep(3000).then(() => null)]);
      if (ev) {
        console.log(`--- ${t.url().slice(-40)}`);
        for (const f of ev.callFrames.slice(0, 14)) console.log('   ', f.functionName || '(anon)');
        await s.send('Debugger.resume');
      } else console.log(`--- ${t.url().slice(-40)}: no pause (blocked outside JS?)`);
      await s.detach();
    } catch (e) { console.log('stack', e.message); }
  }
}
if (prof) {
  const { profile } = await prof.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map(); let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]); const name = n.callFrame.functionName || '(anon)';
    if (name === '(idle)' || name === '(program)') continue;
    const us = profile.timeDeltas[i] || 0; self.set(name, (self.get(name) || 0) + us); total += us;
  }
  console.log(`main thread: ${(total / 1e6).toFixed(1)} s of CPU`);
  for (const [n, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(100 * us / total).toFixed(1).padStart(5)} %  ${n}`);
}
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await b.close();
srv.kill();
