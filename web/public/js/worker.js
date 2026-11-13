// Emulation worker: hosts the wasm PS1 core. The main thread owns timing,
// input and netplay; this worker only executes frames on request.
/* global createPSX, WORKERFS */
importScripts('../core/psx.js');

let M = null;
let loaded = false;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);

function bytesFromHeap(ptr, len) {
  return M.HEAPU8.slice(ptr, ptr + len);
}

async function ensureModule() {
  if (M) return;
  M = await createPSX({
    locateFile: (p) => '../core/' + p,
    print: (t) => post({ type: 'log', text: t }),
    printErr: (t) => post({ type: 'log', text: t }),
  });
  for (const d of ['/disc', '/system', '/save']) M.FS.mkdir(d);
  M._fe_init();
}

function setOptions(options) {
  for (const [k, v] of Object.entries(options || {})) {
    M.ccall('fe_set_option', null, ['string', 'string'], [k, String(v)]);
  }
}

// files: [{name, file}] where file is a File/Blob. cue is the entry point.
async function loadDisc({ files, entry, options, verbose }) {
  await ensureModule();
  M._fe_set_verbose(verbose ? 1 : 0);
  M.FS.mount(M.WORKERFS, { blobs: files.map((f) => ({ name: f.name, data: f.file })) }, '/disc');
  setOptions(options);
  const ok = M.ccall('fe_load', 'number', ['string'], ['/disc/' + entry]);
  if (!ok) throw new Error('Le cœur n’a pas pu charger le disque.');
  loaded = true;
  return {
    fps: M._fe_fps(), sampleRate: M._fe_sample_rate(), aspect: M._fe_aspect(),
    serial: M.UTF8ToString(M._fe_cdrom_id()),
  };
}

function runFrames(frames, wantVideo, wantHash) {
  // frames: array of arrays of per-port masks (one entry per emulated frame)
  const audioChunks = [];
  let total = 0;
  for (const masks of frames) {
    for (let p = 0; p < 8; p++) M._fe_set_input(p, masks[p] | 0);
    M._fe_run_frame();
    const n = M._fe_audio_frames();
    if (n) {
      const ptr = M._fe_audio_ptr() >> 1;
      audioChunks.push(M.HEAP16.slice(ptr, ptr + n * 2));
      total += n;
    }
  }
  const audio = new Int16Array(total * 2);
  let o = 0;
  for (const c of audioChunks) { audio.set(c, o); o += c.length; }
  const msg = { type: 'frames', audio, count: frames.length };
  const transfer = [audio.buffer];
  if (wantVideo) {
    const w = M._fe_fb_w(), h = M._fe_fb_h();
    const rgba = bytesFromHeap(M._fe_fb_ptr(), w * h * 4);
    msg.video = { w, h, rgba };
    transfer.push(rgba.buffer);
  }
  if (wantHash) msg.hash = M._fe_ram_hash() >>> 0;
  return [msg, transfer];
}

function saveState() {
  const n = M._fe_state_size();
  const p = M._malloc(n);
  const ok = M._fe_state_save(p, n);
  const out = bytesFromHeap(p, n);
  M._free(p);
  if (!ok) throw new Error('échec de la sauvegarde d’état');
  return out;
}

function loadState(buf) {
  const u8 = new Uint8Array(buf);
  const p = M._malloc(u8.length);
  M.HEAPU8.set(u8, p);
  const ok = M._fe_state_load(p, u8.length);
  M._free(p);
  if (!ok) throw new Error('échec du chargement d’état');
}

const RETRO_MEMORY_SAVE_RAM = 0;

function getSram() {
  const n = M._fe_mem_size(RETRO_MEMORY_SAVE_RAM);
  return n ? bytesFromHeap(M._fe_mem_ptr(RETRO_MEMORY_SAVE_RAM), n) : null;
}

function setSram(buf) {
  const n = M._fe_mem_size(RETRO_MEMORY_SAVE_RAM);
  const u8 = new Uint8Array(buf);
  if (n && u8.length === n) M.HEAPU8.set(u8, M._fe_mem_ptr(RETRO_MEMORY_SAVE_RAM));
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'load': {
        const info = await loadDisc(m);
        post({ type: 'loaded', id: m.id, info });
        break;
      }
      case 'run': {
        if (!loaded) break;
        const [msg, transfer] = runFrames(m.frames, m.video, m.hash);
        msg.id = m.id;
        post(msg, transfer);
        break;
      }
      case 'saveState': {
        const s = saveState();
        post({ type: 'state', id: m.id, state: s }, [s.buffer]);
        break;
      }
      case 'snapshot': {
        // Netplay sync point: the savestate does not capture every bit of
        // emulator state (e.g. in-flight CD reads), so the host restarts from
        // the very bytes it sends; host and guests then run identically.
        const s = saveState();
        loadState(s);
        post({ type: 'state', id: m.id, state: s }, [s.buffer]);
        break;
      }
      case 'loadState':
        loadState(m.state);
        post({ type: 'ok', id: m.id });
        break;
      case 'getSram': {
        const s = getSram();
        post({ type: 'sram', id: m.id, sram: s }, s ? [s.buffer] : []);
        break;
      }
      case 'setSram':
        setSram(m.sram);
        post({ type: 'ok', id: m.id });
        break;
      case 'reset':
        M._fe_reset();
        post({ type: 'ok', id: m.id });
        break;
      case 'hash':
        post({ type: 'hash', id: m.id, hash: M._fe_ram_hash() >>> 0 });
        break;
      case 'setOptions':
        setOptions(m.options);
        post({ type: 'ok', id: m.id });
        break;
      default:
        throw new Error('message inconnu ' + m.type);
    }
  } catch (e) {
    post({ type: 'error', id: m.id, message: String(e && e.message || e) });
  }
};
