// Cochons de Guerre en ligne — page logic.
//
// Lobby over WebSocket; on « Lancer la partie » every member's browser boots
// the recompiled game (WebAssembly, provided by the server, disc streamed on
// demand) from frame 0, and the lockstep worker feeds it every participant's
// inputs frame by frame. Each player has their own running copy of the game.
import { Input, ACTIONS, keyLabel } from './input.js';
import { Display } from './display.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const state = {
  ws: null, id: null, room: null, version: null, game: null, worker: null,
  audio: null, session: null, players: [], names: new Map(), lastStats: null,
};
const input = new Input();

// ------------------------------------------------------------------ UI basics
function show(section) {
  for (const s of ['#lobby', '#room', '#play']) $(s).hidden = s !== section;
}
function toast(text, ms = 4000) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = text;
  $('#toasts').append(d);
  setTimeout(() => d.remove(), ms);
}
function inviteLink() { return `${location.origin}${location.pathname}?salon=${state.room.code}`; }
async function copyInvite() {
  try { await navigator.clipboard.writeText(inviteLink()); toast('Lien copié.'); } catch { prompt('Lien d’invitation :', inviteLink()); }
}

$('#name').value = localStorage.getItem('cdg.online.name') || '';
if (params.get('salon')) {
  $('#invite').hidden = false;
  $('#invite-code').textContent = params.get('salon').toUpperCase();
  $('#code').value = params.get('salon').toUpperCase();
}

// ------------------------------------------------------------------ preload
// The game is fetched (and kept by the browser cache) while players gather in
// the lobby, so starting a game is immediate.
const preload = (async () => {
  const info = await (await fetch('/game/info.json')).json();
  if (!info.ready) throw new Error('Le serveur n’a pas encore préparé le jeu.');
  state.version = info.version;
  const v = `?v=${info.version}`;
  const [manifest, files, wasm] = await Promise.all([
    fetch(`/game/files.json${v}`).then((r) => r.json()),
    fetch(`/game/files.bin${v}`).then((r) => r.arrayBuffer()),
    fetch(`/game/Cochons_de_Guerre.wasm${v}`).then((r) => r.arrayBuffer()),
  ]);
  const module = await WebAssembly.compile(wasm);
  return { manifest, files: new Uint8Array(files), module, v };
})();
preload.then(() => { $('#preload').textContent = 'Jeu chargé : prêt à jouer.'; })
  .catch((e) => { $('#preload').textContent = `Jeu indisponible : ${e.message}`; });
$('#preload').textContent = 'Chargement du jeu en arrière-plan…';

// ------------------------------------------------------------------ socket
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: $('#name').value.trim() || 'Cochon' }));
    ws.onerror = () => reject(new Error('Connexion au serveur impossible.'));
    ws.onclose = () => { if (state.room) toast('Connexion au serveur perdue.', 8000); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') { state.id = m.id; resolve(); }
      onMessage(m);
    };
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 2000);
  });
}
const sendWs = (o) => state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify(o));

function onMessage(m) {
  switch (m.t) {
    case 'room': onRoom(m); break;
    case 'go': startGame(m); break;
    case 'ended': stopGame(); show('#room'); toast('Partie terminée par l’hôte.'); break;
    case 'in': if (state.worker && m.s === state.session) state.worker.postMessage(m); break;
    case 'drop':
      if (state.worker) state.worker.postMessage(m);
      toast(`${state.names.get(m.id) || 'Un joueur'} a quitté la partie : son équipe n’a plus de joueur.`);
      break;
    case 'hash': if (state.worker) state.worker.postMessage(m); break;
    case 'chat': chatLine(m.name, m.text); break;
    case 'pong': sendWs({ t: 'rtt', rtt: performance.now() - m.ts }); state.rtt = performance.now() - m.ts; break;
    case 'error': toast(m.message, 6000); break;
    default:
  }
}

// ------------------------------------------------------------------ lobby / room
async function enter(action) {
  localStorage.setItem('cdg.online.name', $('#name').value.trim());
  try {
    if (!state.ws || state.ws.readyState !== 1) await connect();
    sendWs(action);
  } catch (e) { toast(e.message, 6000); }
}
$('#btn-create').onclick = () => enter({ t: 'create' });
$('#btn-join').onclick = () => enter({ t: 'join', code: $('#code').value });
$('#code').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-join').click(); };
$('#btn-copy').onclick = copyInvite;
$('#btn-copy2').onclick = copyInvite;
$('#btn-leave2').onclick = leave;
$('#btn-leave').onclick = leave;
$('#btn-start').onclick = () => sendWs({ t: 'start', aspect: chosenAspect() });
$('#btn-end').onclick = () => sendWs({ t: 'end' });
function leave() { stopGame(); sendWs({ t: 'leave' }); state.room = null; show('#lobby'); history.replaceState(null, '', location.pathname); }

function chosenAspect() {
  const v = $('#aspect').value;
  if (v !== 'auto') { const [a, b] = v.split(':').map(Number); return a / b; }
  return Math.max(4 / 3, Math.min(32 / 9, innerWidth / innerHeight));
}

function onRoom(m) {
  if (!m.code) { state.room = null; return; }
  state.room = m;
  for (const x of m.members) state.names.set(x.id, x.name);
  const isHost = m.host === state.id;
  document.body.classList.toggle('is-host', isHost);
  $('#room-code').textContent = m.code;
  $('#room-code2').textContent = m.code;
  history.replaceState(null, '', `?salon=${m.code}`);
  // Seats
  const seats = $('#seats');
  seats.textContent = '';
  for (let s = 0; s < 4; s++) {
    const who = m.members.find((x) => x.seat === s);
    const li = document.createElement('li');
    li.className = (who ? '' : 'empty') + (who && who.id === state.id ? ' me' : '');
    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = `Joueur ${s + 1} : ${who ? who.name + (who.id === m.host ? ' (hôte)' : '') : 'libre'}`;
    li.append(label);
    if (!who && m.state === 'lobby') {
      const b = document.createElement('button');
      b.textContent = 'Prendre';
      b.onclick = () => sendWs({ t: 'seat', seat: s });
      li.append(b);
    }
    seats.append(li);
  }
  const watchers = m.members.filter((x) => x.seat < 0);
  $('#room-wait').textContent = m.state === 'running'
    ? 'Une partie est en cours : vous jouerez à la prochaine.'
    : (watchers.length ? `Spectateurs : ${watchers.map((x) => x.name).join(', ')}` : '');
  // Members panel (in game)
  const ul = $('#members');
  ul.textContent = '';
  for (const x of m.members) {
    const li = document.createElement('li');
    li.textContent = `${x.seat >= 0 ? `Joueur ${x.seat + 1}` : 'Spectateur'} — ${x.name}${x.id === m.host ? ' (hôte)' : ''}` +
      (x.rtt ? ` · ${x.rtt} ms` : '');
    ul.append(li);
  }
  if (!state.game) show('#room');
}

// ------------------------------------------------------------------ game
function aspectRatioText(a) {
  const known = [[4, 3], [16, 10], [16, 9], [21, 9], [32, 9]];
  let best = known[0];
  for (const k of known) if (Math.abs(k[0] / k[1] - a) < Math.abs(best[0] / best[1] - a)) best = k;
  return `${best[0]}:${best[1]}`;
}

async function startGame(go) {
  show('#play');
  $('#splash').hidden = false;
  $('#splash-text').textContent = 'Démarrage du jeu…';
  state.session = go.session;
  state.players = go.players;
  let pre;
  try { pre = await preload; } catch (e) { $('#splash-text').textContent = e.message; return; }
  const aspect = aspectRatioText(go.aspect || 16 / 9);
  const Module = {
    canvas: $('#sdl'),   // SDL's own surface stays hidden; Display draws the game
    arguments: [],
    print: (t) => console.log(t),
    printErr: (t) => console.warn(t),
    locateFile: (p) => `/game/${p}${pre.v}`,
    mainScriptUrlOrBlob: `/game/Cochons_de_Guerre.js${pre.v}`,
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(pre.module, imports).then((inst) => done(inst, pre.module));
      return {};
    },
    preRun: [() => {
      const FS = Module.FS;
      const root = '/game';
      for (const f of pre.manifest.files) {
        const p = `${root}/${f.path}`;
        FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
        let data = pre.files.subarray(f.offset, f.offset + f.size);
        if (f.path === 'mods/state.toml') {
          data = new TextEncoder().encode(new TextDecoder().decode(data)
            .replace(/aspect = "[^"]*"/, `aspect = "${aspect}"`));
        }
        if (f.path === 'settings.toml') {
          data = new TextEncoder().encode(new TextDecoder().decode(data)
            .replace(/aspect_ratio = "[^"]*"/, `aspect_ratio = "${aspect}"`));
        }
        FS.writeFile(p, data);
      }
      FS.mkdirTree(`${root}/saves`);
      FS.chdir(root);
      Object.assign(Module.ENV, {
        PSX_WEB_LOCKSTEP: String(go.players.length),
        PSX_NO_LAUNCHER: '1',
        PSX_OVERLAY_AUTOCOMPILE_OFF: '1',
        ...(params.get('diag') ? { PSX_RUNTIME_PERF_DIAG: '1', PSX_RUNTIME_PERF_DIAG_MS: '5000' } : {}),
      });
    }],
    onRuntimeInitialized() { setTimeout(() => attach(Module, go), 0); },
  };
  window.Module = Module;
  state.game = Module;
  const s = document.createElement('script');
  s.src = `/game/Cochons_de_Guerre.js${pre.v}`;
  s.onerror = () => { $('#splash-text').textContent = 'Le jeu n’a pas pu être chargé.'; };
  document.body.append(s);
}

async function attach(Module, go) {
  const memory = Module.wasmMemory;
  // Lockstep worker: writes every participant's inputs into the game's ring.
  const w = new Worker('js/net-worker.js', { type: 'module' });
  state.worker = w;
  w.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'send') sendWs({ ...m.msg, s: state.session });
    else if (m.t === 'stats') onStats(m);
    else if (m.t === 'log') console.log('[lockstep]', m.text);
    else if (m.t === 'hashok') { state.hashOk = (state.hashOk || 0) + 1; state.lastHashOk = m.f; }
    else if (m.t === 'desync') console.warn(`[lockstep] désynchronisation image ${m.f}`), state.desyncs = (state.desyncs || 0) + 1, toast(`Désynchronisation détectée à l’image ${m.f} avec ${state.names.get(m.from) || 'un joueur'}.`, 10000);
  };
  w.onerror = (e) => console.warn('[lockstep] worker error', e.message);
  w.postMessage({
    t: 'start', memory,
    tags: Module._psx_web_lockstep_tags(), words: Module._psx_web_lockstep_words(),
    status: Module._psx_web_lockstep_status(), ring: Module._psx_web_lockstep_ring(),
    maxp: Module._psx_web_lockstep_maxp(),
    players: go.players, me: state.id, delay: go.delay,
  });
  // Sound: the worklet reads the game's ring directly from shared memory.
  try {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('js/audio-worklet.js');
    const ctl = Module._psx_web_audio_ctl();
    const node = new AudioWorkletNode(ctx, 'psx-audio', {
      numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { buffer: memory.buffer, ring: Module._psx_web_audio_ring(), ctl, frames: 65536, rate: 44100 },
    });
    node.connect(ctx.destination);
    node.port.postMessage({ volume: +$('#volume').value });
    $('#volume').oninput = () => node.port.postMessage({ volume: +$('#volume').value });
    state.audio = ctx;
    const resume = () => { if (ctx.state !== 'running') ctx.resume(); };
    addEventListener('keydown', resume);
    addEventListener('pointerdown', resume);
    resume();
  } catch (e) { console.warn('audio', e); }
  try {
    const b0 = Module._psx_web_frame_buffer(0), b1 = Module._psx_web_frame_buffer(1);
    state.display = new Display($('#canvas'), memory, Module._psx_web_frame_header(), (i) => (i ? b1 : b0));
  } catch (e) { toast(`Affichage impossible : ${e.message}`, 10000); }
  $('#splash').hidden = true;
  canvas_focus();
}

function canvas_focus() { $('#canvas').focus(); }

function onStats(m) {
  state.lastStats = m;
  const holder = m.holder >= 0 ? state.names.get(state.players[m.holder]) : null;
  const mine = m.holder >= 0 && state.players[m.holder] === state.id;
  $('#turn').textContent = m.team
    ? (mine ? `À vous de jouer (équipe ${m.team})` : `Tour de ${holder || '?'} (équipe ${m.team})`)
    : (holder ? `Manette : ${holder}` : '');
  $('#turn').classList.toggle('mine', !!(m.team && mine));
  const waiting = m.waiting.length ? ` · attente de ${m.waiting.map((i) => state.names.get(state.players[i]) || '?').join(', ')}` : '';
  $('#stats').textContent = `image ${m.frame}${state.rtt ? ` · ${Math.round(state.rtt)} ms` : ''}${waiting}`;
}

function stopGame() {
  if (state.worker) { state.worker.postMessage({ t: 'stop' }); state.worker.terminate(); state.worker = null; }
  if (state.audio) { state.audio.close(); state.audio = null; }
  if (state.game) {
    // The emulation threads cannot be torn down in place: reload the page.
    state.game = null;
    location.reload();
  }
}

// ------------------------------------------------------------------ input
let lastMask = -1;
function pollInput() {
  const mask = state.worker ? input.mask() : 0;
  if (mask !== lastMask && state.worker) { state.worker.postMessage({ t: 'mask', mask }); lastMask = mask; }
}
addEventListener('keydown', () => setTimeout(pollInput, 0));
addEventListener('keyup', () => setTimeout(pollInput, 0));
setInterval(pollInput, 8);

addEventListener('keydown', (e) => {
  if (!state.game || input.capture) return;
  if (e.code === 'Escape') { $('#panel').hidden = !$('#panel').hidden; e.preventDefault(); }
  else if (e.code === 'KeyT' && $('#panel').hidden && !/INPUT/.test(e.target.tagName)) {
    $('#panel').hidden = false; setTimeout(() => $('#chat-input').focus(), 0); e.preventDefault();
  } else if (e.code === 'F11') { e.preventDefault(); toggleFull(); }
});
function toggleFull() { if (document.fullscreenElement) document.exitFullscreen(); else $('#play').requestFullscreen(); }
$('#btn-full').onclick = toggleFull;
$('#btn-panel').onclick = () => { $('#panel').hidden = !$('#panel').hidden; };

function chatLine(name, text) {
  const d = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = `${name} : `;
  d.append(b, document.createTextNode(text));
  $('#chat-log').append(d);
  $('#chat-log').scrollTop = 1e9;
  if ($('#panel').hidden) toast(`${name} : ${text}`);
}
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chat-input').value.trim();
  if (!text) return;
  sendWs({ t: 'chat', text });
  chatLine('Moi', text);
  $('#chat-input').value = '';
  $('#chat-input').blur();
};

// Key remapping dialog
$('#btn-keys').onclick = () => { renderKeys(); $('#dlg-keys').showModal(); };
$('#btn-keys-reset').onclick = () => { input.reset(); renderKeys(); };
function renderKeys() {
  const tb = $('#keymap');
  tb.textContent = '';
  for (const [a, label] of ACTIONS) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = label;
    const td2 = document.createElement('td');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = (input.keys[a] || []).map(keyLabel).join(' / ') || '—';
    b.onclick = () => { b.textContent = 'Appuyez…'; input.capture = (code) => { input.setKey(a, code); renderKeys(); }; };
    td2.append(b);
    tr.append(td1, td2);
    tb.append(tr);
  }
}

// Test hooks (automated end-to-end tests)
window.__cdg = { state, input };
