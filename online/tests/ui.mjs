// Home page and lobby, without starting a game: what a player sees and can do
// before the game runs (errors shown on the page, invitation link, seats,
// watching only, discussion), with pictures of each screen.
//   node tests/ui.mjs <outdir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || 'ui-out');
fs.mkdirSync(out, { recursive: true });
const PORT = 18500 + Math.floor(Math.random() * 90);
const srv = spawn(process.execPath, [path.join(HERE, '../server/index.mjs')], { env: { ...process.env, CDG_RECORD: '0', PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) failures++; };

const b = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const BASE = `http://127.0.0.1:${PORT}/`;
// Each player has their own browser profile (own saved name and choices),
// with an English browser unless told otherwise (the page follows it).
async function open(url, w = 1280, h = 860, langs = ['en-US', 'en']) {
  const page = await (await b.createBrowserContext()).newPage();
  await page.evaluateOnNewDocument((l) => {
    Object.defineProperty(navigator, 'languages', { get: () => l });
    Object.defineProperty(navigator, 'language', { get: () => l[0] });
  }, langs);
  await page.setViewport({ width: w, height: h });
  page.on('pageerror', (e) => { console.log('[page error]', e.message); failures++; });
  // ?prefetch=0: these screens are checked without downloading the disc.
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'prefetch=0');
  return page;
}
const text = (p, s) => p.$eval(s, (e) => e.textContent.trim());
const shown = (p, s) => p.$eval(s, (e) => !e.hidden && e.getClientRects().length > 0);
const shot = async (p, name) => { await p.bringToFront(); await p.screenshot({ path: path.join(out, name), fullPage: true }); };
// No horizontal scrolling at this width.
const fits = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// ---- home
const a = await open(BASE);
await a.waitForFunction(() => /ready|unavailable/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
check(/ready to play/.test(await text(a, '#preload')), `preload announced: "${await text(a, '#preload')}"`);
check(await a.$eval('#preload-bar', (e) => e.parentElement.classList.contains('done')), 'preload bar full');
check(!(await shown(a, '#invite')) && !(await shown(a, '#lobby-error')), 'home page with no invitation and no error');
await shot(a, '1_home.png');

// ---- language: the browser's by default, then the player's choice (kept).
const f = await open(BASE, 1280, 860, ['fr-FR', 'fr']);
await f.waitForFunction(() => /prêt à jouer/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
check((await f.$eval('html', (e) => e.lang)) === 'fr' && /Créer un salon/.test(await text(f, '#btn-create')),
  `a French browser gets the page in French: "${await text(f, '#btn-create')}"`);
await shot(f, '1_home_fr.png');
await f.select('#lobby select.lang', 'en');
check(/Create a room/.test(await text(f, '#btn-create')) && /ready to play/.test(await text(f, '#preload')),
  'switching to English redraws the page');
await f.reload();
await f.waitForFunction(() => /Create a room/.test(document.querySelector('#btn-create').textContent), { timeout: 10000 });
check((await f.$eval('#lobby select.lang', (e) => e.value)) === 'en', 'the choice is kept on the next visit');
await f.close();

// A wrong code is answered on the page itself.
await a.type('#name', 'Alice');
await a.type('#code', 'zz');
await a.click('#btn-join');
check(/4 letters/.test(await text(a, '#lobby-error')), `code too short: "${await text(a, '#lobby-error')}"`);
await a.type('#code', 'q9z');
check((await a.$eval('#code', (e) => e.value)) === 'ZZQZ', 'the code keeps only 4 letters, in capitals');
await a.click('#btn-join');
await a.waitForFunction(() => /not found/.test(document.querySelector('#lobby-error').textContent), { timeout: 10000 });
check(await shown(a, '#lobby-error'), `unknown room: "${await text(a, '#lobby-error')}"`);
await shot(a, '2_home_error.png');

// ---- room
await a.click('#btn-create');
await a.waitForSelector('#room:not([hidden])');
const code = await text(a, '#room-code2');
check(/^[A-Z]{4}$/.test(code), `room created: ${code}`);
check(await shown(a, '#btn-start') && !(await a.$eval('#btn-start', (e) => e.disabled)), 'the host can start the game');
check(/Alice/.test(await text(a, '#seats li.me')) && /host/.test(await text(a, '#seats li.me')), 'Alice is in seat 1, marked host');
check(/×/.test(await text(a, '#picture-hint')), `picture announced: "${await text(a, '#picture-hint')}"`);
await a.select('#aspect', '32:9'); await a.select('#quality', '4');
check(/3413 × 960/.test(await text(a, '#picture-hint')), `32:9 at 4×: "${await text(a, '#picture-hint')}"`);
await shot(a, '3_room_host.png');
await a.select('#room select.lang', 'fr');
check(/hôte/.test(await text(a, '#seats li.me')) && /Lancer la partie/.test(await text(a, '#btn-start'))
  && /Image calculée/.test(await text(a, '#picture-hint')), `the room page switches to French: "${await text(a, '#start-hint')}"`);
await shot(a, '3_room_host_fr.png');
await a.select('#room select.lang', 'en');

// The room is listed on the home page of someone else.
const c = await open(BASE);
await c.waitForFunction((k) => document.querySelector('#room-list').textContent.includes(k), { timeout: 10000 }, code);
check(true, `room ${code} appears in the list of open rooms`);
await c.close();

// ---- invitation link
const g = await open(`${BASE}?room=${code}`);
check(await shown(g, '#invite') && (await text(g, '#invite-code')) === code, 'the invitation link announces the room');
await shot(g, '4_home_invited.png');
await g.type('#name', 'Bruno');
await g.keyboard.press('Enter');   // Enter in the name field joins
await g.waitForSelector('#room:not([hidden])');
await g.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 2);
check(/Bruno/.test(await text(g, '#seats li.me')), 'Bruno took seat 2 with the Enter key');
check(!(await shown(g, '#btn-start')) && /Alice/.test(await text(g, '#room-wait')), `the guest waits for the host: "${await text(g, '#room-wait')}"`);

// Watching only, then taking a seat again.
await g.click('#seats li.me button');
await g.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 1);
check(/Bruno \(you\)/.test(await text(g, '#spectators')), `Bruno watches: "${await text(g, '#spectators')}"`);
await g.click('#seats li:nth-child(3) button');
await g.waitForFunction(() => /Bruno/.test(document.querySelector('#seats li:nth-child(3)').textContent));
check(true, 'Bruno took seat 3');

// Discussion in the lobby.
await g.type('#room-chat-input', 'Hi!');
await g.keyboard.press('Enter');
await a.waitForFunction(() => /Bruno: Hi!/.test(document.querySelector('#room-chat-log').textContent), { timeout: 5000 });
check(true, 'Bruno’s message reaches Alice in the room');
await a.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 2);
await sleep(2500);   // readiness is announced every 2 s at most
await shot(a, '5_room_two_players.png');
await shot(g, '6_room_guest.png');

// Narrow and very wide windows.
await g.setViewport({ width: 390, height: 844 });
await sleep(300);
check(await fits(g), 'room page without horizontal scrolling on a phone screen');
await shot(g, '7_room_narrow.png');
await a.setViewport({ width: 2560, height: 720 });
await sleep(300);
await shot(a, '8_room_32_9.png');

// Leaving goes back to the home page; the host's room stays.
await g.click('#btn-leave2');
await g.waitForSelector('#lobby:not([hidden])');
check(await fits(g), 'home page without horizontal scrolling on a phone screen');
await shot(g, '9_home_narrow.png');
await a.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 1);
check(true, 'Bruno’s seat is freed on Alice’s side');

await b.close(); srv.kill();
console.log(failures ? `${failures} failure(s)` : 'Home page and room: all checks passed.');
process.exit(failures ? 1 : 0);
