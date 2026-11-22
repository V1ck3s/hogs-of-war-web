// End-to-end browser test: boots the disc in headless Chromium, then runs a
// two-browser netplay session (host + guest) and checks they stay in sync.
//
//   CHROME=/usr/bin/chromium node web/tests/e2e.mjs <dir-with-cue-and-bins> [outdir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const discDir = process.argv[2];
const out = process.argv[3] || 'e2e-out';
const SOLO_ONLY = process.env.SOLO_ONLY === '1';
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(discDir).filter((f) => /\.(cue|bin|sbi)$/i.test(f)).map((f) => path.join(discDir, f));

const PORT = 18000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [path.join(HERE, '../server/server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => srv.stdout.once('data', r));
const URL = `http://127.0.0.1:${PORT}/`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-dev-shm-usage'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) failures++; };

async function openGame(tag) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.text().startsWith('[netplay]')) console.log(`[${tag}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
  await page.goto(URL);
  await page.$eval('#remember-disc', (el) => { el.checked = false; });
  await page.$eval('#net-name', (el) => { el.value = ''; });
  const input = await page.$('#disc-input');
  await input.uploadFile(...files);
  await page.waitForFunction(() => window.__cdg && window.__cdg.running, { timeout: 60000 });
  return page;
}

const shot = (page, name) => page.$eval('#screen', (c) => c.toDataURL('image/png'))
  .then((d) => fs.writeFileSync(path.join(out, name), Buffer.from(d.split(',')[1], 'base64')));

try {
  // ---------------- solo boot
  const host = await openGame('host');
  const serial = await host.evaluate(() => window.__cdg.serial);
  check(serial === 'SLES02766', `French disc detected (${serial})`);
  await sleep(25000);
  const fps = await host.evaluate(() => window.__cdg.fpsShown);
  check(fps > 20, `emulation running in the browser (${fps.toFixed(1)} fps)`);
  await shot(host, 'solo.png');

  if (!SOLO_ONLY) {
    // ---------------- netplay
    await host.type('#net-name', 'Host');
    await host.click('#btn-host');
    await host.waitForFunction(() => window.__cdg.net?.room?.code, { timeout: 10000 });
    const code = await host.evaluate(() => window.__cdg.net.room.code);
    check(/^[A-Z]{4}$/.test(code), `room created (${code})`);

    await sleep(5000);
    console.log('host alone, frame', await host.evaluate(() => window.__cdg.ls.frame));
    const guest = await openGame('guest');
    console.log('after the guest loaded, host frame', await host.evaluate(() => window.__cdg.ls.frame));
    await guest.type('#net-name', 'Guest');
    await guest.type('#net-code', code);
    await guest.click('#btn-join');
    try {
      await guest.waitForFunction(() => window.__cdg.ls?.active, { timeout: 60000 });
    } catch (e) {
      const dump = (p) => p.evaluate(() => {
        const S = window.__cdg;
        return { mode: S.mode, busy: S.busy, ps: S.pendingSync, psi: !!S.pendingSyncIn, room: S.net?.room, id: S.net?.id,
          ls: S.ls && { epoch: S.ls.epoch, frame: S.ls.frame, ports: [...S.ls.ports] } };
      });
      console.log('host', JSON.stringify(await dump(host)));
      console.log('guest', JSON.stringify(await dump(guest)));
      throw e;
    }
    check(true, 'guest in sync (state received)');
    await host.waitForFunction(() => window.__cdg.ls?.ports?.size === 2, { timeout: 30000 });
    check(true, 'host now waits for both players\' inputs');

    const snap = () => Promise.all([host, guest].map((p) => p.evaluate(() => {
      const S = window.__cdg;
      return `f=${S.ls.frame} e=${S.ls.epoch} stalls=${S.ls.stats.stalls} fps=${S.fpsShown.toFixed(0)} wait=${S.ls.waitingOn().length} hidden=${document.hidden}`;
    })));
    for (let i = 0; i < 3; i++) { await sleep(3000); console.log('  ', (await snap()).join(' | ')); }
    // The guest presses Start a few times: its input must reach both consoles.
    for (let i = 0; i < 4; i++) {
      await guest.keyboard.down('Enter'); await sleep(200); await guest.keyboard.up('Enter');
      await sleep(3000);
    }
    await sleep(15000);
    const st = await Promise.all([host, guest].map((p) => p.evaluate(() => ({
      frame: window.__cdg.ls.frame, epoch: window.__cdg.ls.epoch, stalls: window.__cdg.ls.stats.stalls,
    }))));
    console.log('host', st[0], 'guest', st[1]);
    check(st[0].epoch === st[1].epoch, 'same sync epoch');
    check(Math.abs(st[0].frame - st[1].frame) <= 15, `frames close together (${st[0].frame} / ${st[1].frame})`);
    check(st[0].frame > 1000, 'the network game is progressing');
    // Desync detection: the host compares RAM hashes every 250 frames and
    // bumps the epoch on mismatch. Epoch 1 = initial host sync, 2 = guest join.
    check(st[0].epoch <= 2, `no desync (epoch ${st[0].epoch})`);
    await shot(host, 'net-host.png');
    await shot(guest, 'net-guest.png');
  }
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser.close();
  srv.kill();
}
console.log(failures ? `${failures} failure(s)` : 'All e2e tests passed.');
process.exit(failures ? 1 : 0);
