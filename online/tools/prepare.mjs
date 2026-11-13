// Builds online/game/ from the WebAssembly build and the operator's disc:
//   game/Cochons_de_Guerre.{js,wasm}  the recompiled game (cochons/build-web)
//   game/files.json + game/files.bin  small runtime files mounted in the
//                                      browser's in-memory filesystem
//   game/disc.json                     the disc tracks, streamed in chunks by
//                                      the server (never copied here)
//
//   node tools/prepare.mjs [--build ../cochons/build-web] [--disc ../cochons/disc]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? path.resolve(process.argv[i + 1]) : def;
};
const BUILD = arg('--build', path.resolve(ROOT, '../cochons/build-web'));
const DISC = arg('--disc', path.resolve(ROOT, '../cochons/disc'));
const OUT = path.join(ROOT, 'game');
export const CHUNK = 256 * 1024;

fs.mkdirSync(OUT, { recursive: true });
for (const f of ['Cochons_de_Guerre.js', 'Cochons_de_Guerre.wasm']) {
  fs.copyFileSync(path.join(BUILD, f), path.join(OUT, f));
}

// ---- small files mounted at /game in the browser
const files = [];
const blobs = [];
let offset = 0;
function add(dest, data) {
  files.push({ path: dest, offset, size: data.length });
  blobs.push(data);
  offset += data.length;
}
function addTree(srcDir, destDir) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name);
    const d = `${destDir}/${e.name}`;
    if (e.isDirectory()) addTree(s, d);
    else if (e.isFile() || e.isSymbolicLink()) add(d, fs.readFileSync(s));
  }
}
add('game.toml', fs.readFileSync(path.join(BUILD, 'game.toml')));
add('psx_game_version.txt', fs.readFileSync(path.join(BUILD, 'psx_game_version.txt')));
addTree(path.join(BUILD, 'mods/bundled'), 'mods/bundled');
addTree(path.join(BUILD, 'bios'), 'bios');
addTree(path.join(BUILD, 'assets'), 'assets');
// Same mod choices on every peer (lockstep): Frontschweine defaults, 50 Hz PAL
// like the original French release, adaptive widescreen.
add('mods/state.toml', Buffer.from([
  'format_version = 2', '',
  '[[package]]', 'id = "psx.enhancement.cpu-overclock"', '',
  '[[package]]', 'id = "frontschweine.enhancement.ntsc-60hz"', '',
  '[[package]]', 'id = "frontschweine.presentation.widescreen"', '',
  // Stock CPU speed (the default 200 % doubles the work per frame); the
  // feature stays on for its busy-wait shortcuts.
  '[[feature]]', 'package_id = "psx.enhancement.cpu-overclock"', 'id = "cpu-overclock"',
  'enabled = true', '[feature.values]', 'percent = "100"', '',
  '[[feature]]', 'package_id = "frontschweine.enhancement.ntsc-60hz"', 'id = "ntsc-60hz"',
  'enabled = false', '',
  // Fixed field of view, the session's aspect (the page fills it in): the
  // projection is part of the simulation, so it must not follow each window.
  '[[feature]]', 'package_id = "frontschweine.presentation.widescreen"', 'id = "widescreen"',
  'enabled = true', '[feature.values]', 'aspect = "16:9"', '',
].join('\n')));
add('settings.toml', Buffer.from([
  '[video]', 'renderer = "software"', 'adaptive_view = false', 'aspect_ratio = "16:9"',
  'fullscreen = 0', 'vsync = "off"', '', '[audio]', 'volume = 100', '',
].join('\n')));

// ---- disc: cue + small files inline, BIN tracks streamed
const disc = { chunk: CHUNK, tracks: [] };
const discFiles = fs.readdirSync(DISC);
for (const name of discFiles) {
  const p = path.join(DISC, name);
  const st = fs.statSync(p);
  if (!st.isFile()) continue;
  if (/\.bin$/i.test(name)) {
    const i = disc.tracks.length;
    disc.tracks.push({ name, size: st.size });
    add(`disc/${name}.remote`, Buffer.from(`/disc/${i} ${st.size}\n`));
  } else if (st.size < 2 * 1024 * 1024 && !/\.json$/i.test(name)) {
    add(`disc/${name}`, fs.readFileSync(p));
  }
}
if (!disc.tracks.length) throw new Error(`aucune piste .bin dans ${DISC}`);

const bin = Buffer.concat(blobs);
const version = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(OUT, 'Cochons_de_Guerre.wasm'))).update(bin)
  .digest('hex').slice(0, 16);
fs.writeFileSync(path.join(OUT, 'files.bin'), bin);
fs.writeFileSync(path.join(OUT, 'files.json'), JSON.stringify({ version, files }, null, 1));
fs.writeFileSync(path.join(OUT, 'disc.json'), JSON.stringify({ ...disc, dir: DISC }, null, 1));
console.log(`game/ prêt : version ${version}, ${files.length} fichiers (${(bin.length / 1024).toFixed(0)} Ko), ` +
  `${disc.tracks.length} pistes en streaming (${(disc.tracks.reduce((a, t) => a + t.size, 0) / 1048576).toFixed(0)} Mo)`);
