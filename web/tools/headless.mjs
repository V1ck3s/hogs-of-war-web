// Headless runner for the wasm PS1 core (Node). Used by tests and for
// debugging: boots a disc, feeds scripted input, writes PNG screenshots.
//
//   node web/tools/headless.mjs <disc.cue> [--frames N] [--shot-every N]
//        [--out dir] [--script file.json]
//
// A script is a JSON array of {"at": frame, "port": 0, "buttons": ["start"], "hold": frames}.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BUTTONS = {
  b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7,
  a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13, l3: 14, r3: 15,
};
// PlayStation naming: cross=b, square=y, circle=a, triangle=x
export const PSX = { cross: 'b', square: 'y', circle: 'a', triangle: 'x' };

export function maskOf(names) {
  let m = 0;
  for (const n of names) {
    const k = PSX[n] || n;
    if (!(k in BUTTONS)) throw new Error('unknown button ' + n);
    m |= 1 << BUTTONS[k];
  }
  return m;
}

export async function createCore({ discPath, options = {}, verbose = false } = {}) {
  const createPSX = require(path.join(HERE, '../public/core/psx.js'));
  const M = await createPSX({ print: verbose ? console.log : () => {}, printErr: verbose ? console.error : () => {} });
  const discDir = path.dirname(path.resolve(discPath));
  M.FS.mkdir('/disc');
  M.FS.mount(M.NODEFS, { root: discDir }, '/disc');
  for (const d of ['/system', '/save']) M.FS.mkdir(d);
  const api = {
    M,
    setOption: (k, v) => M.ccall('fe_set_option', null, ['string', 'string'], [k, v]),
    init: () => M._fe_init(),
    load: (p) => M.ccall('fe_load', 'number', ['string'], [p]),
    runFrame: () => M._fe_run_frame(),
    setInput: (port, mask) => M._fe_set_input(port, mask),
    ramHash: () => M._fe_ram_hash() >>> 0,
    fps: () => M._fe_fps(),
    frame() {
      const w = M._fe_fb_w(), h = M._fe_fb_h();
      const p = M._fe_fb_ptr();
      return { w, h, rgba: M.HEAPU8.slice(p, p + w * h * 4) };
    },
    audio() {
      const n = M._fe_audio_frames();
      const p = M._fe_audio_ptr() >> 1;
      return M.HEAP16.slice(p, p + n * 2);
    },
    ram() {
      const p = M._fe_mem_ptr(2), n = M._fe_mem_size(2);
      return M.HEAPU8.slice(p, p + n);
    },
    saveState() {
      const n = M._fe_state_size();
      const p = M._malloc(n);
      const ok = M._fe_state_save(p, n);
      const out = M.HEAPU8.slice(p, p + n);
      M._free(p);
      if (!ok) throw new Error('state save failed');
      return out;
    },
    loadState(buf) {
      const p = M._malloc(buf.length);
      M.HEAPU8.set(buf, p);
      const ok = M._fe_state_load(p, buf.length);
      M._free(p);
      return !!ok;
    },
  };
  M._fe_set_verbose(verbose ? 1 : 0);
  api.init();
  for (const [k, v] of Object.entries(options)) api.setOption(k, v);
  if (!api.load('/disc/' + path.basename(discPath))) throw new Error('load failed');
  return api;
}

export function writePNG(file, { w, h, rgba }) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : def;
  };
  const disc = args[0];
  const frames = +opt('frames', 600);
  const every = +opt('shot-every', 100);
  const out = opt('out', 'shots');
  const scriptFile = opt('script', null);
  const loadFrom = opt('load-state', null);
  const saveTo = opt('save-state', null);
  const ramEvery = +opt('ram-every', 0);
  const wavFile = opt('wav', null);
  const wavFrom = +opt('wav-from', 0);
  const wavChunks = [];
  const script = scriptFile ? JSON.parse(fs.readFileSync(scriptFile, 'utf8')) : [];
  fs.mkdirSync(out, { recursive: true });
  const core = await createCore({ discPath: disc, verbose: !!opt('verbose', '') });
  if (loadFrom) core.loadState(fs.readFileSync(loadFrom));
  console.log('fps', core.fps());
  const t0 = Date.now();
  let audioSamples = 0;
  for (let f = 0; f < frames; f++) {
    const masks = new Array(8).fill(0);
    for (const s of script) {
      if (f >= s.at && f < s.at + (s.hold || 3)) masks[s.port || 0] |= maskOf(s.buttons);
    }
    masks.forEach((m, p) => core.setInput(p, m));
    core.runFrame();
    const au = core.audio();
    audioSamples += au.length / 2;
    if (wavFile && f >= wavFrom) wavChunks.push(au);
    if (ramEvery && (f + 1) % ramEvery === 0) fs.writeFileSync(path.join(out, `ram${String(f + 1).padStart(6, '0')}.bin`), core.ram());
    if ((f + 1) % every === 0) {
      const fr = core.frame();
      writePNG(path.join(out, `f${String(f + 1).padStart(6, '0')}.png`), fr);
    }
  }
  const dt = (Date.now() - t0) / 1000;
  console.log(`${frames} frames in ${dt.toFixed(1)}s (${(frames / dt).toFixed(1)} fps), audio frames ${audioSamples}, ramhash ${core.ramHash().toString(16)}`);
  if (saveTo) fs.writeFileSync(saveTo, core.saveState());
  if (wavFile) {
    const n = wavChunks.reduce((a, c) => a + c.length, 0);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + n * 2, 4); h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(44100, 24); h.writeUInt32LE(44100 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(n * 2, 40);
    fs.writeFileSync(wavFile, Buffer.concat([h, ...wavChunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length * 2))]));
  }
}
