// Cochons de Guerre Web — main thread: UI, timing, audio, input, netplay.
import { Input, ACTIONS, keyLabel } from './input.js';
import { prepareDisc, fingerprint } from './disc.js';
import { kvGet, kvSet, kvDel, prefGet, prefSet } from './storage.js';
import { Lockstep, HashBook } from './lockstep.js';
import { Net } from './net.js';

const $ = (s) => document.querySelector(s);
const PLAYER_NAMES = ['Joueur 1', 'Joueur 2', 'Joueur 3', 'Joueur 4'];

// ------------------------------------------------------------ worker RPC
class Emu {
  constructor() {
    this.worker = new Worker('js/worker.js');
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'log') { console.debug('[core]', m.text); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
    };
  }
  call(msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }
}

// ------------------------------------------------------------ state
const S = {
  emu: null,
  info: null,
  disc: null, // {files, entry}
  fp: '',
  running: false,
  paused: false,
  busy: false, // a worker request is in flight
  acc: 0,
  last: 0,
  frame: 0, // solo frame counter
  turbo: false,
  audio: null,
  audioNode: null,
  sramHash: 0,
  ctx2d: null,
  imageData: null,
  mode: 'solo', // 'solo' | 'net'
  net: null,
  ls: null,
  hashes: new HashBook(),
  epoch: 0,
  pendingSync: false,
  pendingSyncIn: null,
  netReady: false, // guest: received first sync
  lastFrameMs: 0,
  fpsCount: 0,
  fpsShown: 0,
  fpsT0: 0,
  netLocalPort: 0,
  messages: [],
};

const input = new Input();

// ------------------------------------------------------------ UI helpers
function status(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.dataset.kind = kind;
}

function toast(text, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function show(id, on) { $(id).hidden = !on; }

// ------------------------------------------------------------ disc
async function chooseDisc(fileList) {
  try {
    status('Préparation du disque…');
    const disc = await prepareDisc(fileList, (p) => status(`Décompression de l’archive… ${Math.round(p * 100)} %`));
    status('Analyse du disque…');
    S.disc = disc;
    S.fp = await fingerprint(disc);
    if ($('#remember-disc').checked) {
      status('Mémorisation du disque dans le navigateur…');
      try {
        await kvSet('disc', { entry: disc.entry, files: disc.files.map((f) => ({ name: f.name, file: f.file })) });
      } catch (e) {
        console.warn(e);
        toast('Impossible de mémoriser le disque (quota du navigateur).');
      }
    }
    await boot();
  } catch (e) {
    console.error(e);
    status(e.message, 'error');
  }
}

async function restoreDisc() {
  const saved = await kvGet('disc');
  if (!saved || !saved.files) return false;
  $('#saved-disc').hidden = false;
  $('#saved-disc-name').textContent = saved.entry;
  $('#use-saved').onclick = async () => {
    try {
      S.disc = { entry: saved.entry, files: saved.files };
      status('Analyse du disque…');
      S.fp = await fingerprint(S.disc);
      await boot();
    } catch (e) { status(e.message, 'error'); }
  };
  $('#forget-saved').onclick = async () => { await kvDel('disc'); $('#saved-disc').hidden = true; };
  return true;
}

// ------------------------------------------------------------ boot
async function boot() {
  status('Démarrage de la PlayStation virtuelle…');
  await initAudio();
  S.emu = new Emu();
  const r = await S.emu.call({
    type: 'load', files: S.disc.files, entry: S.disc.entry,
    options: coreOptions(), verbose: false,
  });
  S.info = r.info;
  S.serial = r.info.serial || '';
  const sram = await kvGet(sramKey());
  if (sram) await S.emu.call({ type: 'setSram', sram });
  S.sramHash = hashBytes(sram);
  show('#setup', false);
  show('#game', true);
  show('#sidebar', true);
  if (!/^SLES02766|^SLES02767|^SLUS01195|^SLES02768/.test(S.serial)) {
    toast(`Disque ${S.serial || 'inconnu'} : ce port vise Cochons de Guerre (SLES-02766).`, 6000);
  }
  if (S.serial === 'SLES02766' && !S.disc.files.some((f) => /\.sbi$/i.test(f.name))) {
    console.info('Pas de fichier .sbi (LibCrypt) : facultatif, voir le README.');
  }
  $('#disc-label').textContent = `${S.disc.entry} · ${S.serial}`;
  S.running = true;
  S.last = performance.now();
  status('');
  requestAnimationFrame(tick);
  // rAF stops in background tabs; a worker timer keeps the console (and the
  // other players in a netplay session) running when this tab is hidden.
  const clock = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 5)'], { type: 'text/javascript' })));
  clock.onmessage = () => { if (document.hidden) { updateFps(performance.now()); pump(); } };
  setInterval(persistSram, 4000);
  // Invitation link (#salon=CODE): join as soon as the disc is running.
  const inv = location.hash.match(/salon=([A-Z]{4})/i);
  if (inv) joinRoom();
}

function coreOptions() {
  return {
    // Fixed set: every peer must emulate identically for lockstep.
    pcsx_rearmed_bios: 'HLE',
    pcsx_rearmed_region: 'auto',
    pcsx_rearmed_psxclock: prefGet('psxclock', 'auto'),
    pcsx_rearmed_multitap: 'disabled',
    pcsx_rearmed_spu_interpolation: 'simple',
    pcsx_rearmed_dithering: 'enabled',
  };
}

const sramKey = () => 'sram:' + (S.serial || 'disc');

function hashBytes(b) {
  if (!b) return 0;
  let h = 2166136261;
  const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  return h >>> 0;
}

async function persistSram() {
  // Guests in a netplay session run the host's memory card: never save it.
  if (!S.emu || S.busy || (S.mode === 'net' && !S.net.isHost)) return;
  try {
    S.busy = true;
    const r = await S.emu.call({ type: 'getSram' });
    S.busy = false;
    const h = hashBytes(r.sram);
    if (r.sram && h !== S.sramHash) {
      S.sramHash = h;
      await kvSet(sramKey(), r.sram);
    }
  } catch { S.busy = false; }
}

// ------------------------------------------------------------ audio
async function initAudio() {
  if (S.audio) return;
  try {
    S.audio = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    await S.audio.audioWorklet.addModule('js/audio-worklet.js');
    S.audioNode = new AudioWorkletNode(S.audio, 'psx-audio', { outputChannelCount: [2] });
    S.audioNode.connect(S.audio.destination);
    S.audioNode.port.postMessage({ volume: prefGet('volume', 0.8) });
    S.audioNode.port.onmessage = (e) => { S.audioAvail = e.data; };
  } catch (e) {
    console.warn('audio', e);
    toast('Audio indisponible dans ce navigateur.');
  }
}

function pushAudio(i16, rate) {
  if (!S.audioNode || !i16.length) return;
  if (S.audio.state === 'suspended') return;
  let f32;
  if (Math.abs(rate - S.audio.sampleRate) < 1) {
    f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  } else {
    // simple linear resample (rare: when the context refused 44.1 kHz)
    const ratio = rate / S.audio.sampleRate;
    const n = Math.floor((i16.length / 2) / ratio);
    f32 = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const s = Math.min((i * ratio) | 0, i16.length / 2 - 1);
      f32[i * 2] = i16[s * 2] / 32768;
      f32[i * 2 + 1] = i16[s * 2 + 1] / 32768;
    }
  }
  S.audioNode.port.postMessage(f32, [f32.buffer]);
}

// ------------------------------------------------------------ video
function draw(v) {
  const c = $('#screen');
  if (!S.ctx2d) S.ctx2d = c.getContext('2d', { alpha: false });
  if (c.width !== v.w || c.height !== v.h) {
    c.width = v.w; c.height = v.h;
    S.imageData = null;
  }
  if (!S.imageData) S.imageData = S.ctx2d.createImageData(v.w, v.h);
  S.imageData.data.set(v.rgba);
  S.ctx2d.putImageData(S.imageData, 0, 0);
}

// ------------------------------------------------------------ main loop
function localMasks() {
  const kb = input.keyboardMask();
  const pads = input.gamepadMasks();
  return { kb, pads };
}

function soloFrameMasks() {
  const { kb, pads } = localMasks();
  const masks = new Array(8).fill(0);
  masks[0] = kb | (pads[0] || 0);
  for (let i = 1; i < pads.length && i < 4; i++) masks[i] |= pads[i];
  return masks;
}

function netLocalMask() {
  const { kb, pads } = localMasks();
  return kb | pads.reduce((a, b) => a | b, 0);
}

function tick(now) {
  if (!S.running) return;
  requestAnimationFrame(tick);
  updateFps(now);
  pump();
}

// Runs whatever frames are due. Called on every animation frame and again
// as soon as the worker finishes, so a slow frame never waits for the next
// vsync before the following one starts.
function pump() {
  if (!S.running || S.busy) return;
  const now = performance.now();
  const dt = Math.min(0.25, (now - S.last) / 1000);
  S.last = now;

  if (S.pendingSyncIn) { applySync(S.pendingSyncIn); return; }
  if (S.pendingSync) { doHostSync(); return; }

  const fps = S.info.fps || 50;
  if (S.mode === 'solo') {
    if (S.paused) { S.acc = 0; return; }
    S.acc += dt * fps * (S.turbo ? 4 : 1);
    let n = Math.floor(S.acc);
    if (n <= 0) return;
    n = Math.min(n, S.turbo ? 8 : 3);
    S.acc -= n;
    if (S.acc > 3) S.acc = 0; // too far behind: drop time instead of spiralling
    const frames = [];
    const m = soloFrameMasks();
    for (let i = 0; i < n; i++) frames.push(m);
    runFrames(frames, null);
    S.frame += n;
    return;
  }

  // ---- netplay
  if (!S.ls.active) { S.acc = 0; updateNetStatus(); return; }
  S.ls.pushLocal(S.paused ? 0 : netLocalMask());
  S.acc += dt * fps * (S.net.room?.speed || 1);
  if (S.acc > 12) S.acc = 12;
  let n = Math.floor(S.acc);
  // Catch up a little if we are behind the inputs others already sent.
  if (n <= 0) return;
  const frames = [];
  let hashFrame = null;
  for (let i = 0; i < Math.min(n, 4 * (S.net.room?.speed || 1)); i++) {
    const masks = S.ls.advance();
    if (!masks) break;
    frames.push(masks);
    if (Lockstep.wantsHash(S.ls.frame)) { hashFrame = S.ls.frame; break; }
  }
  S.acc -= frames.length;
  if (!frames.length) { updateNetStatus(); return; }
  runFrames(frames, hashFrame);
  updateNetStatus();
}

async function runFrames(frames, hashFrame) {
  S.busy = true;
  try {
    const r = await S.emu.call({ type: 'run', frames, video: true, hash: hashFrame != null });
    if (r.video && !document.hidden) draw(r.video);
    pushAudio(r.audio, S.info.sampleRate);
    S.fpsCount += r.count;
    if (hashFrame != null) onLocalHash(hashFrame, r.hash);
  } catch (e) {
    console.error(e);
    status('Erreur émulateur : ' + e.message, 'error');
  } finally {
    S.busy = false;
  }
  pump();
}

function updateFps(now) {
  if (now - S.fpsT0 >= 1000) {
    S.fpsShown = S.fpsCount * 1000 / (now - S.fpsT0);
    S.fpsCount = 0;
    S.fpsT0 = now;
    $('#fps').textContent = `${S.fpsShown.toFixed(0)} img/s`;
  }
}

// ------------------------------------------------------------ netplay
function setupNet() {
  S.net = new Net();
  S.net.addEventListener('room', (e) => onRoom(e.detail));
  S.net.addEventListener('servererror', (e) => toast(e.detail.message, 5000));
  S.net.addEventListener('close', () => {
    if (S.mode === 'net') toast('Déconnecté du serveur.');
    leaveNet(true);
  });
  S.net.addEventListener('msg', (e) => onNetMsg(e.detail));
  S.net.addEventListener('sync', (e) => { S.pendingSyncIn = e.detail; });
}

async function netConnect() {
  if (!S.net) setupNet();
  if (S.net.connected) return;
  const name = $('#net-name').value.trim() || 'Cochon';
  prefSet('name', name);
  await S.net.connect({ name, fp: S.fp, serial: S.serial });
}

async function hostRoom() {
  try {
    await netConnect();
    S.net.send({ t: 'create' });
  } catch (e) { toast(e.message); }
}

async function joinRoom() {
  const code = $('#net-code').value.trim().toUpperCase();
  if (!code) { toast('Entrez le code du salon.'); return; }
  try {
    await netConnect();
    S.net.send({ t: 'join', code });
  } catch (e) { toast(e.message); }
}

function enterNetMode() {
  if (S.mode === 'net') return;
  S.mode = 'net';
  S.ls = new Lockstep({ localId: S.net.id, send: (m) => S.net.send(m) });
  S.netReady = false;
  S.turbo = false;
}

function leaveNet(fromClose = false) {
  if (S.net && S.net.connected && !fromClose) S.net.send({ t: 'leave' });
  if (S.mode !== 'net') { renderRoom(null); return; }
  S.mode = 'solo';
  S.ls = null;
  S.acc = 0;
  renderRoom(null);
  toast('Retour en partie solo (l’état actuel est conservé).');
}

let lastRoomSig = '';
function onRoom(room) {
  if (!room.code) { leaveNet(); return; }
  const wasNet = S.mode === 'net';
  enterNetMode();
  renderRoom(room);
  const sig = room.members.map((m) => `${m.id}:${m.port}`).join(',') + '|' + room.delay + '|' + room.host;
  const changed = sig !== lastRoomSig;
  lastRoomSig = sig;
  if (S.net.isHost && (changed || !wasNet)) S.pendingSync = 'salon modifié';
  if (!wasNet) toast(S.net.isHost ? `Salon ${room.code} créé. Donnez ce code à vos amis !` : `Salon ${room.code} rejoint.`);
}

function onNetMsg(m) {
  switch (m.t) {
    case 'in':
      if (S.ls) S.ls.receive(m);
      break;
    case 'hash':
      if (S.net.isHost && m.e === S.epoch) {
        S.hashes.add(m.f, m.p, m.h);
        checkHashes(m.f);
      }
      break;
    case 'needsync':
      if (S.net.isHost) S.pendingSync = 'demande de ' + nameOf(m.p);
      break;
    case 'chat':
      addChat(m.p, m.text);
      break;
    case 'left':
      break;
    default:
  }
}

function onLocalHash(frame, hash) {
  if (S.mode !== 'net') return;
  if (S.net.isHost) {
    S.hashes.add(frame, S.net.id, hash);
    checkHashes(frame);
  } else {
    S.net.send({ t: 'hash', e: S.ls.epoch, f: frame, h: hash });
  }
}

function checkHashes(frame) {
  const bad = S.hashes.check(frame, S.net.id);
  if (bad.length) {
    console.warn('désynchronisation', frame, bad);
    toast('Désynchronisation détectée : resynchronisation…');
    S.pendingSync = 'désynchronisation image ' + frame;
  }
}

async function doHostSync() {
  console.info('[netplay] synchronisation :', S.pendingSync);
  S.pendingSync = false;
  const room = S.net.room;
  if (!room || !S.net.isHost) return;
  S.busy = true;
  try {
    const st = await S.emu.call({ type: 'snapshot' });
    const sr = await S.emu.call({ type: 'getSram' });
    S.epoch = (S.ls.active ? S.ls.epoch : S.epoch) + 1;
    const frame = S.ls.active ? S.ls.frame : 0;
    const ports = {};
    for (const m of room.members) if (m.port >= 0) ports[m.id] = m.port;
    const header = { epoch: S.epoch, frame, delay: room.delay, ports };
    await S.net.sendSync(header, st.state, sr.sram);
    S.ls.begin(header);
    S.hashes = new HashBook();
    S.netReady = true;
  } catch (e) {
    console.error(e);
    toast('Échec de la synchronisation : ' + e.message);
  } finally {
    S.busy = false;
  }
}

async function applySync(sync) {
  S.pendingSyncIn = null;
  if (S.mode !== 'net' || S.net.isHost) return;
  S.busy = true;
  try {
    await S.emu.call({ type: 'loadState', state: sync.state }, [sync.state.buffer]);
    if (sync.sram) await S.emu.call({ type: 'setSram', sram: sync.sram });
    S.epoch = sync.header.epoch;
    S.ls.begin(sync.header);
    S.netReady = true;
    S.acc = 0;
    if (S.audioNode) S.audioNode.port.postMessage({ clear: true });
  } catch (e) {
    console.error(e);
    toast('Synchronisation impossible : ' + e.message);
  } finally {
    S.busy = false;
  }
}

function nameOf(id) {
  const m = S.net && S.net.room && S.net.room.members.find((x) => x.id === id);
  return m ? m.name : id;
}

function updateNetStatus() {
  const el = $('#net-status');
  if (S.mode !== 'net') { el.textContent = ''; return; }
  if (!S.ls.active) { el.textContent = S.net.isHost ? 'Synchronisation…' : 'En attente de l’hôte…'; return; }
  const w = S.ls.waitingOn().filter((id) => id !== S.net.id);
  const h = S.ls.holder[0];
  const ctl = h ? ` · Manette 1 : ${h === S.net.id ? 'vous' : nameOf(h)}` : '';
  el.textContent = (w.length ? `En attente de ${w.map(nameOf).join(', ')}…` : `Synchronisé · image ${S.ls.frame}`) + ctl;
}

function renderRoom(room) {
  show('#net-lobby', !room);
  show('#net-room', !!room);
  if (!room) { $('#net-status').textContent = ''; return; }
  $('#room-code').textContent = room.code;
  const isHost = S.net.isHost;
  const list = $('#room-members');
  list.innerHTML = '';
  for (const m of room.members) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.name + (m.id === room.host ? ' (hôte)' : '') + (m.id === S.net.id ? ' — vous' : '');
    li.appendChild(name);
    if (isHost) {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Manette de ' + m.name);
      const opts = [[-1, 'Spectateur'], ...PLAYER_NAMES.map((n, i) => [i, `Manette ${i + 1}`])];
      for (const [v, label] of opts) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label; if (v === m.port) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => S.net.send({ t: 'setPort', id: m.id, port: +sel.value });
      li.appendChild(sel);
    } else {
      const tag = document.createElement('span');
      tag.className = 'port-tag';
      tag.textContent = m.port >= 0 ? `Manette ${m.port + 1}` : 'Spectateur';
      li.appendChild(tag);
    }
    list.appendChild(li);
  }
  $('#delay-row').hidden = !isHost;
  $('#speed-row').hidden = !isHost;
  $('#net-speed').value = String(room.speed || 1);
  $('#net-delay').value = room.delay;
  $('#net-delay-val').textContent = `${room.delay} img (${Math.round(room.delay * 1000 / (S.info?.fps || 50))} ms)`;
}

function addChat(id, text) {
  const log = $('#chat-log');
  const p = document.createElement('p');
  const b = document.createElement('b');
  b.textContent = nameOf(id) + ' : ';
  p.appendChild(b);
  p.appendChild(document.createTextNode(String(text).slice(0, 300)));
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------ savestates (solo)
async function quickSave() {
  if (!S.emu) return;
  while (S.busy) await new Promise((r) => setTimeout(r, 5));
  S.busy = true;
  try {
    const r = await S.emu.call({ type: 'saveState' });
    await kvSet('state:' + S.serial, r.state);
    toast('État sauvegardé.');
  } finally { S.busy = false; }
}

async function quickLoad() {
  if (!S.emu) return;
  if (S.mode === 'net' && !S.net.isHost) { toast('Seul l’hôte peut charger un état en réseau.'); return; }
  const st = await kvGet('state:' + S.serial);
  if (!st) { toast('Aucun état sauvegardé.'); return; }
  while (S.busy) await new Promise((r) => setTimeout(r, 5));
  S.busy = true;
  try {
    await S.emu.call({ type: 'loadState', state: st });
    toast('État restauré.');
    if (S.mode === 'net') S.pendingSync = 'chargement d’un état';
  } finally { S.busy = false; }
}

// ------------------------------------------------------------ settings UI
function renderKeys() {
  const tb = $('#keymap');
  tb.innerHTML = '';
  for (const [action, label] of ACTIONS) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = label;
    const td2 = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'key';
    btn.textContent = keyLabel(input.keys[action]);
    btn.onclick = () => {
      btn.textContent = 'Appuyez sur une touche…';
      input.capture = (code) => { if (code !== 'Escape') input.setKey(action, code); renderKeys(); };
    };
    td2.appendChild(btn);
    tr.append(td1, td2);
    tb.appendChild(tr);
  }
}

function toggleFullscreen() {
  const el = $('#screen-wrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => {});
}

// ------------------------------------------------------------ wiring
function wire() {
  $('#disc-input').addEventListener('change', (e) => chooseDisc([...e.target.files]));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    chooseDisc([...e.dataTransfer.files]);
  });

  $('#net-name').value = prefGet('name', '');
  $('#btn-host').onclick = hostRoom;
  $('#btn-join').onclick = joinRoom;
  $('#net-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#btn-leave').onclick = () => leaveNet();
  $('#btn-copy').onclick = () => {
    const url = `${location.origin}${location.pathname}#salon=${S.net.room.code}`;
    navigator.clipboard?.writeText(url).then(() => toast('Lien d’invitation copié.'), () => toast(url, 8000));
  };
  $('#net-delay').oninput = (e) => S.net.send({ t: 'setDelay', delay: +e.target.value });
  $('#net-speed').onchange = (e) => S.net.send({ t: 'setSpeed', speed: +e.target.value });
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const t = $('#chat-input').value.trim();
    if (!t || !S.net?.connected) return;
    S.net.send({ t: 'chat', text: t });
    addChat(S.net.id, t);
    $('#chat-input').value = '';
  };

  $('#btn-pause').onclick = () => { S.paused = !S.paused; $('#btn-pause').textContent = S.paused ? 'Reprendre' : 'Pause'; };
  $('#btn-reset').onclick = async () => {
    if (S.mode === 'net' && !S.net.isHost) { toast('Seul l’hôte peut redémarrer la partie.'); return; }
    if (!confirm('Redémarrer la console ?')) return;
    while (S.busy) await new Promise((r) => setTimeout(r, 5));
    S.busy = true;
    await S.emu.call({ type: 'reset' });
    S.busy = false;
    if (S.mode === 'net') S.pendingSync = 'redémarrage';
  };
  $('#btn-save').onclick = quickSave;
  $('#btn-load').onclick = quickLoad;
  $('#btn-full').onclick = toggleFullscreen;
  $('#btn-keys').onclick = () => { renderKeys(); $('#dlg-keys').showModal(); };
  $('#btn-keys-reset').onclick = () => { input.resetKeys(); renderKeys(); };
  $('#volume').value = prefGet('volume', 0.8);
  $('#volume').oninput = (e) => {
    prefSet('volume', +e.target.value);
    S.audioNode?.port.postMessage({ volume: +e.target.value });
  };
  $('#smooth').checked = prefGet('smooth', false);
  const applySmooth = () => $('#screen').classList.toggle('smooth', $('#smooth').checked);
  $('#smooth').onchange = () => { prefSet('smooth', $('#smooth').checked); applySmooth(); };
  applySmooth();

  input.onRawKey((e, down) => {
    if (!down) { if (e.code === 'Tab') S.turbo = false; return; }
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Tab' && S.mode === 'solo') { e.preventDefault(); S.turbo = true; }
    if (e.code === 'F2') { e.preventDefault(); quickSave(); }
    if (e.code === 'F4') { e.preventDefault(); quickLoad(); }
    if (e.code === 'F11') { e.preventDefault(); toggleFullscreen(); }
    if (e.code === 'KeyP' && !Object.values(input.keys).includes('KeyP')) $('#btn-pause').click();
  });

  // Browsers only start audio after a user gesture.
  const resume = () => S.audio?.state === 'suspended' && S.audio.resume();
  addEventListener('pointerdown', resume);
  addEventListener('keydown', resume);

  const m = location.hash.match(/salon=([A-Z]{4})/i);
  if (m) {
    $('#net-code').value = m[1].toUpperCase();
    $('#invite-banner').hidden = false;
    $('#invite-code').textContent = m[1].toUpperCase();
  }
}

wire();
restoreDisc();
window.__cdg = S; // debugging / automated tests
