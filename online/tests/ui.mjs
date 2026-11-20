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
// Each player has their own browser profile (own saved name and choices).
async function open(url, w = 1280, h = 860) {
  const page = await (await b.createBrowserContext()).newPage();
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
await a.waitForFunction(() => /prêt|indisponible/.test(document.querySelector('#preload').textContent), { timeout: 180000 });
check(/prêt à jouer/.test(await text(a, '#preload')), `préchargement annoncé : « ${await text(a, '#preload')} »`);
check(await a.$eval('#preload-bar', (e) => e.parentElement.classList.contains('done')), 'barre de préchargement pleine');
check(!(await shown(a, '#invite')) && !(await shown(a, '#lobby-error')), 'accueil sans invitation ni erreur');
await shot(a, '1_accueil.png');

// A wrong code is answered on the page itself.
await a.type('#name', 'Alice');
await a.type('#code', 'zz');
await a.click('#btn-join');
check(/4 lettres/.test(await text(a, '#lobby-error')), `code trop court : « ${await text(a, '#lobby-error')} »`);
await a.type('#code', 'q9z');
check((await a.$eval('#code', (e) => e.value)) === 'ZZQZ', 'le code ne garde que 4 lettres, en capitales');
await a.click('#btn-join');
await a.waitForFunction(() => /introuvable/.test(document.querySelector('#lobby-error').textContent), { timeout: 10000 });
check(await shown(a, '#lobby-error'), `salon inconnu : « ${await text(a, '#lobby-error')} »`);
await shot(a, '2_accueil_erreur.png');

// ---- room
await a.click('#btn-create');
await a.waitForSelector('#room:not([hidden])');
const code = await text(a, '#room-code2');
check(/^[A-Z]{4}$/.test(code), `salon créé : ${code}`);
check(await shown(a, '#btn-start') && !(await a.$eval('#btn-start', (e) => e.disabled)), 'l’hôte peut lancer la partie');
check(/Alice/.test(await text(a, '#seats li.me')) && /hôte/.test(await text(a, '#seats li.me')), 'Alice est à la place 1, marquée hôte');
check(/×/.test(await text(a, '#picture-hint')), `image annoncée : « ${await text(a, '#picture-hint')} »`);
await a.select('#aspect', '32:9'); await a.select('#quality', '4');
check(/3413 × 960/.test(await text(a, '#picture-hint')), `32:9 en 4× : « ${await text(a, '#picture-hint')} »`);
await shot(a, '3_salon_hote.png');

// The room is listed on the home page of someone else.
const c = await open(BASE);
await c.waitForFunction((k) => document.querySelector('#room-list').textContent.includes(k), { timeout: 10000 }, code);
check(true, `le salon ${code} apparaît dans la liste des salons ouverts`);
await c.close();

// ---- invitation link
const g = await open(`${BASE}?salon=${code}`);
check(await shown(g, '#invite') && (await text(g, '#invite-code')) === code, 'le lien d’invitation annonce le salon');
await shot(g, '4_accueil_invite.png');
await g.type('#name', 'Bruno');
await g.keyboard.press('Enter');   // Enter in the name field joins
await g.waitForSelector('#room:not([hidden])');
await g.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 2);
check(/Bruno/.test(await text(g, '#seats li.me')), 'Bruno a pris la place 2 avec la touche Entrée');
check(!(await shown(g, '#btn-start')) && /Alice/.test(await text(g, '#room-wait')), `l’invité attend l’hôte : « ${await text(g, '#room-wait')} »`);

// Watching only, then taking a seat again.
await g.click('#seats li.me button');
await g.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 1);
check(/Bruno \(vous\)/.test(await text(g, '#spectators')), `Bruno regarde : « ${await text(g, '#spectators')} »`);
await g.click('#seats li:nth-child(3) button');
await g.waitForFunction(() => /Bruno/.test(document.querySelector('#seats li:nth-child(3)').textContent));
check(true, 'Bruno a pris la place 3');

// Discussion in the lobby.
await g.type('#room-chat-input', 'Salut !');
await g.keyboard.press('Enter');
await a.waitForFunction(() => /Bruno : Salut !/.test(document.querySelector('#room-chat-log').textContent), { timeout: 5000 });
check(true, 'le message de Bruno arrive chez Alice dans le salon');
await a.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 2);
await sleep(2500);   // readiness is announced every 2 s at most
await shot(a, '5_salon_deux_joueurs.png');
await shot(g, '6_salon_invite.png');

// Narrow and very wide windows.
await g.setViewport({ width: 390, height: 844 });
await sleep(300);
check(await fits(g), 'salon sans défilement horizontal sur un écran de téléphone');
await shot(g, '7_salon_etroit.png');
await a.setViewport({ width: 2560, height: 720 });
await sleep(300);
await shot(a, '8_salon_32_9.png');

// Leaving goes back to the home page; the host's room stays.
await g.click('#btn-leave2');
await g.waitForSelector('#lobby:not([hidden])');
check(await fits(g), 'accueil sans défilement horizontal sur un écran de téléphone');
await shot(g, '9_accueil_etroit.png');
await a.waitForFunction(() => document.querySelectorAll('#seats li:not(.empty)').length === 1);
check(true, 'la place de Bruno est libérée chez Alice');

await b.close(); srv.kill();
console.log(failures ? `${failures} échec(s)` : 'Accueil et salon : tous les contrôles sont passés.');
process.exit(failures ? 1 : 0);
