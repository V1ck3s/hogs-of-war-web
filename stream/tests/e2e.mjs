// End-to-end: real server + real native game + two Chromium players.
//   node tests/e2e.mjs [outdir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import puppeteer from 'puppeteer-core';
const out = process.argv[2] || 'e2e-out';
fs.mkdirSync(out, { recursive: true });
const PORT = 18100 + Math.floor(Math.random() * 500);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CDG_MAX_ROOMS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => {
  process.stdout.write('[serveur] ' + d);
  const m = String(d).match(/jeu lancé \(:(\d+)/);
  if (m) ctlPort = 4400 + +m[1];
});
srv.stderr.on('data', (d) => process.stdout.write('[serveur] ' + d));
await new Promise((r) => srv.stdout.once('data', r));
const URL = `http://localhost:${PORT}/`;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true, protocolTimeout: 600000,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failures++; };
const state = (p) => p.evaluate(() => ({ room: window.__cdg.room, id: window.__cdg.id, vcfg: window.__cdg.vcfg,
  video: window.__cdg.stats.videoTotal, audio: window.__cdg.stats.audioFrames }));
// Read-only look at the game's controller port through the runtime's local
// control server (first instance = display :100 → port 4500).
let ctlPort = 4500;
const padStatus = () => new Promise((resolve) => {
  let buf = '';
  const sock = net.connect(ctlPort, '127.0.0.1', () => sock.write('{"id":1,"cmd":"pad_status"}\n'));
  sock.on('data', (d) => { buf += d; if (buf.includes('\n')) { sock.destroy(); try { resolve(JSON.parse(buf)); } catch { resolve(null); } } });
  sock.on('error', () => resolve(null));
});
const shot = (p, name) => p.screenshot({ path: path.join(out, name) });

async function player(name, viewport) {
  const p = await browser.newPage();
  await p.setViewport(viewport);
  p.on('pageerror', (e) => console.log(`[${name}] erreur: ${e.message}`));
  await p.goto(URL);
  await p.$eval('#name', (el) => { el.value = ''; });
  await p.type('#name', name);
  return p;
}

try {
  // Host on a 16:9 screen creates the game.
  const host = await player('Hôte', { width: 1280, height: 720 });
  await host.click('#btn-create');
  await host.waitForFunction(() => window.__cdg.room?.state === 'running', { timeout: 180000 });
  check(true, 'jeu natif lancé sur le serveur');
  await host.waitForFunction(() => window.__cdg.stats.videoTotal > 30, { timeout: 120000 });
  let s = await state(host);
  check(s.video > 30, `vidéo H.264 reçue et décodée (${s.video} images)`);
  check(Math.abs(s.vcfg.width / s.vcfg.height - 16 / 9) < 0.05, `image rendue au format de l'écran de l'hôte (${s.vcfg.width}x${s.vcfg.height})`);
  await sleep(4000);
  s = await state(host);
  check(s.audio > 48000, `son Opus reçu et décodé (${s.audio} échantillons)`);
  await shot(host, 'hote-16x9.png');

  // Keyboard: host presses Start → host holds controller 1.
  await host.keyboard.down('Enter'); await sleep(250); await host.keyboard.up('Enter');
  await sleep(800);
  s = await state(host);
  check(s.room.holder === s.id, 'le clavier de l’hôte pilote la manette 1');
  await host.keyboard.down('KeyX');
  await sleep(1200);
  const pad = await padStatus();
  await host.keyboard.up('KeyX');
  console.log('      pad_status pendant Croix :', JSON.stringify(pad));
  const word = pad && parseInt(String(pad.pad ?? pad.slot0 ?? pad.override ?? 'ffff'), pad && typeof pad.pad === 'string' ? 16 : 10);
  check(pad && ((word >> 14) & 1) === 0, 'la touche X du navigateur arrive dans le jeu (Croix enfoncée sur la manette 1)');

  // A friend joins from a phone-shaped portrait screen.
  const guest = await player('Invité', { width: 600, height: 900 });
  await guest.type('#code', s.room.code);
  await guest.click('#btn-join');
  await guest.waitForFunction(() => window.__cdg.stats.videoTotal > 20, { timeout: 120000 });
  check(true, 'l’invité reçoit le flux sans posséder le jeu');
  await sleep(2500); // host idle > 2 s: the controller can change hands
  await guest.keyboard.down('Enter'); await sleep(250); await guest.keyboard.up('Enter');
  await sleep(800);
  const g = await state(guest);
  check(g.room.holder === g.id, 'l’invité prend la manette après l’inactivité de l’hôte');
  await shot(guest, 'invite-portrait.png');

  // Any screen: the guest's window takes many sizes / densities / shapes; the
  // canvas must use the full device resolution and show the picture
  // letterboxed (game pixels present, black only outside the picture).
  const screens = [
    [3840, 2160, 1, '4K 16:9'], [1920, 1080, 2, '1080p HiDPI ×2'], [2560, 1080, 1, '21:9'],
    [1024, 768, 1, '4:3'], [1440, 900, 1.5, '16:10 ×1.5'], [390, 844, 3, 'téléphone portrait ×3'],
    [844, 390, 3, 'téléphone paysage ×3'], [800, 600, 1, 'SVGA'],
  ];
  for (const [w, h, dpr, label] of screens) {
    await guest.bringToFront();
    await guest.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
    await sleep(1500);
    const r = await guest.evaluate(() => {
      const c = document.querySelector('#screen');
      const ctx = c.getContext('2d');
      const f = window.__cdg.lastFrame;
      const fw = f ? f.displayWidth : 0, fh = f ? f.displayHeight : 0;
      const sc = Math.min(c.width / fw, c.height / fh);
      const dw = Math.round(fw * sc), dh = Math.round(fh * sc);
      // Redraw the current frame, then compare an 8x8 grid of the on-screen
      // picture with the same grid of the decoded frame itself.
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(f, (c.width - dw) >> 1, (c.height - dh) >> 1, dw, dh);
      const ref = new OffscreenCanvas(fw, fh).getContext('2d');
      ref.drawImage(f, 0, 0);
      let diff = 0, n = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const px = ((c.width - dw) >> 1) + Math.floor((x + 0.5) * dw / 8);
        const py = ((c.height - dh) >> 1) + Math.floor((y + 0.5) * dh / 8);
        const a = ctx.getImageData(px, py, 1, 1).data;
        const b = ref.getImageData(Math.floor((x + 0.5) * fw / 8), Math.floor((y + 0.5) * fh / 8), 1, 1).data;
        diff += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); n++;
      }
      return { cw: c.width, ch: c.height, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, fw, fh, dw, dh, err: diff / n / 3 };
    });
    const full = Math.abs(r.cw - Math.round(r.vw * Math.min(r.dpr, 3))) <= 2 && Math.abs(r.ch - Math.round(r.vh * Math.min(r.dpr, 3))) <= 2;
    const fits = r.dw <= r.cw && r.dh <= r.ch && (r.dw >= r.cw - 2 || r.dh >= r.ch - 2);
    check(full && fits && r.fw > 0 && r.err < 24, `écran ${label} (${w}x${h} ×${dpr}) : toile ${r.cw}x${r.ch}, image ${r.dw}x${r.dh} ajustée, écart moyen à l'image décodée ${r.err.toFixed(1)}/255`);
    await shot(guest, `invite-${w}x${h}.png`);
  }
  await guest.setViewport({ width: 600, height: 900 });

  // Host switches to an ultrawide window: the game re-renders at 21:9.
  await host.bringToFront();
  await host.setViewport({ width: 1680, height: 720 });
  await host.waitForFunction(() => window.__cdg.vcfg && window.__cdg.vcfg.width / window.__cdg.vcfg.height > 2.2, { timeout: 60000 });
  await host.waitForFunction((n) => window.__cdg.stats.videoTotal > n + 20, { timeout: 60000 }, (await state(host)).video);
  s = await state(host);
  check(true, `format ultra-large appliqué (${s.vcfg.width}x${s.vcfg.height})`);
  await sleep(1500);
  await shot(host, 'hote-21x9.png');
  await shot(guest, 'invite-apres-21x9.png');
} catch (e) {
  console.error(e); failures++;
} finally {
  await browser.close();
  srv.kill('SIGTERM');
  await sleep(3000);
}
console.log(failures ? `${failures} échec(s)` : 'Tous les tests e2e sont passés.');
process.exit(failures ? 1 : 0);
