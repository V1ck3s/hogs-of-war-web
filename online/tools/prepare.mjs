// Builds online/game/ from the WebAssembly build and the operator's disc:
//   game/Cochons_de_Guerre.{js,wasm}  the recompiled game (cochons/build-web)
//   game/files.json + game/files.bin  small runtime files mounted in the
//                                      browser's in-memory filesystem
//   game/disc.json                     the disc tracks, streamed in chunks by
//                                      the server (never copied here)
//   game/<file>.br, game/<file>.gz     the same files compressed once, as the
//                                      server sends them (CDG_BROTLI=<0..11>
//                                      sets the Brotli effort, default 11 —
//                                      about two minutes; 0 skips this step
//                                      and the server compresses on the fly)
//
//   node tools/prepare.mjs [--build ../cochons/build-web] [--disc ../cochons/disc]
//                          [--out game]   (another folder: a build to try
//                                          with CDG_GAME=<folder> before it
//                                          replaces the one being served)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? path.resolve(process.argv[i + 1]) : def;
};
const BUILD = arg('--build', path.resolve(ROOT, '../cochons/build-web'));
const DISC = arg('--disc', path.resolve(ROOT, '../cochons/disc'));
const OUT = arg('--out', path.join(ROOT, 'game'));
// Streamed chunk size (CDG_CHUNK_KB, default 256).
export const CHUNK = (+(process.env.CDG_CHUNK_KB || 256) | 0) * 1024;

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
// Online: native-wide widescreen. The world is projected exactly as in 4:3
// and only drawn wider (the battle module's terrain cull is widened by the
// game.toml patches for every view), so each player may use their own
// screen shape without changing the simulation.
// The sky and other 2D backdrops drawn before the 3D world are only 4:3 wide:
// stretch them over the wider view (presentation only).
add('game.toml', Buffer.from(fs.readFileSync(path.join(BUILD, 'game.toml'), 'utf8')
  .replace(/^native_wide = false$/m,
    'native_wide = true\nnw_backdrop = true\nnw_flat_backdrop = true\nnw_phase_backdrop = true')));
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
  '[[package]]', 'id = "frontschweine.online.direct-start"', '',
  // The game boots straight into the room's mode (direct_start.c).
  '[[feature]]', 'package_id = "frontschweine.online.direct-start"', 'id = "direct-start"',
  'enabled = true', '',
  // Stock CPU speed (the default 200 % doubles the work per frame); the
  // feature stays on for its busy-wait shortcuts.
  '[[feature]]', 'package_id = "psx.enhancement.cpu-overclock"', 'id = "cpu-overclock"',
  'enabled = true', '[feature.values]', 'percent = "100"', '',
  '[[feature]]', 'package_id = "frontschweine.enhancement.ntsc-60hz"', 'id = "ntsc-60hz"',
  'enabled = false', '',
  // The player's own aspect (the page fills it in).
  '[[feature]]', 'package_id = "frontschweine.presentation.widescreen"', 'id = "widescreen"',
  'enabled = true', '[feature.values]', 'aspect = "16:9"', '',
].join('\n')));
add('settings.toml', Buffer.from([
  '[video]', 'renderer = "software"', 'adaptive_view = false', 'aspect_ratio = "16:9"', 'supersampling = 1',
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
    add(`disc/${name}.remote`, Buffer.from(`/disc/${i} ${st.size} ${CHUNK}\n`));
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
console.log(`${path.relative(ROOT, OUT) || '.'}/ prêt : version ${version}, ${files.length} fichiers (${(bin.length / 1024).toFixed(0)} Ko), ` +
  `${disc.tracks.length} pistes en streaming (${(disc.tracks.reduce((a, t) => a + t.size, 0) / 1048576).toFixed(0)} Mo)`);

// ---- what the browsers download, compressed once (the server sends these as they are)
const Q = Math.max(0, Math.min(11, +(process.env.CDG_BROTLI ?? 11) | 0));
const SENT = ['Cochons_de_Guerre.wasm', 'Cochons_de_Guerre.js', 'files.bin', 'files.json'];
for (const f of SENT) for (const ext of ['.br', '.gz']) fs.rmSync(path.join(OUT, f + ext), { force: true });
if (Q > 0) {
  const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
  const t0 = Date.now();
  let raw = 0, sent = 0;
  await Promise.all(SENT.map(async (f) => {
    const data = fs.readFileSync(path.join(OUT, f));
    const [br, gz] = await Promise.all([
      brotli(data, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: Q, [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
      gzip(data, { level: 9 }),
    ]);
    fs.writeFileSync(path.join(OUT, f + '.br'), br);
    fs.writeFileSync(path.join(OUT, f + '.gz'), gz);
    raw += data.length; sent += br.length;
  }));
  console.log(`compression : ${(raw / 1048576).toFixed(1)} Mo -> ${(sent / 1048576).toFixed(1)} Mo à télécharger (Brotli ${Q}, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
