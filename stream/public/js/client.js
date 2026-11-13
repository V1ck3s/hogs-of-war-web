// Cochons de Guerre — client de streaming (navigateur).
// Receives H.264 + Opus from the server, decodes with WebCodecs, draws the
// picture letterboxed into whatever screen shape the player has, and sends
// the pad state back.
import { Input, ACTIONS, keyLabel } from './input.js';

const $ = (s) => document.querySelector(s);
const S = {
  ws: null, id: null, room: null, name: '',
  vdec: null, adec: null, vcfg: null, needKey: true,
  actx: null, anode: null,
  canvas: null, ctx: null, lastFrame: null,
  stats: { audioFrames: 0, videoTotal: 0, frames: 0, bytes: 0, t0: performance.now(), fps: 0, kbps: 0, rtt: 0, decodeQueue: 0 },
  padSent: -1, padLastSend: 0,
};
const input = new Input();
window.__cdg = S;

// ------------------------------------------------------------------ ui
function toast(text, ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function show(screen) {
  for (const id of ['#lobby', '#play']) $(id).hidden = id !== screen;
}

const nameOf = (id) => S.room?.members.find((m) => m.id === id)?.name || '—';

function renderRoom() {
  const r = S.room;
  if (!r || !r.code) { show('#lobby'); return; }
  show('#play');
  $('#room-code').textContent = r.code;
  const isHost = r.host === S.id;
  document.body.classList.toggle('is-host', isHost);
  const ul = $('#members');
  ul.innerHTML = '';
  for (const m of r.members) {
    const li = document.createElement('li');
    li.textContent = m.name + (m.id === r.host ? ' ★' : '') + (m.id === S.id ? ' (vous)' : '') + (m.spectator ? ' — spectateur' : '');
    if (m.id === r.holder) li.classList.add('holder');
    ul.appendChild(li);
  }
  $('#holder').textContent = r.holder ? (r.holder === S.id ? 'Vous avez la manette' : `Manette : ${nameOf(r.holder)}`) : 'Manette libre';
  $('#quality').value = r.quality;
  $('#turbo').checked = !!r.turbo;
  const st = { starting: 'Démarrage du jeu sur le serveur…', running: '', stopped: r.error || 'Jeu arrêté.' }[r.state] || '';
  $('#splash').hidden = r.state === 'running' && !S.needKey;
  $('#splash-text').textContent = st || 'Réception de l’image…';
}

function addChat(name, text) {
  const p = document.createElement('p');
  const b = document.createElement('b');
  b.textContent = name + ' : ';
  p.append(b, document.createTextNode(text));
  $('#chat-log').appendChild(p);
  $('#chat-log').scrollTop = 1e9;
  if ($('#panel').hidden) toast(`${name} : ${text}`);
}

// ------------------------------------------------------------------ network
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    S.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: S.name }));
    ws.onerror = () => reject(new Error('Serveur injoignable.'));
    ws.onclose = () => { toast('Connexion au serveur perdue.'); S.room = null; renderRoom(); };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { onBinary(ev.data); return; }
      const m = JSON.parse(ev.data);
      switch (m.t) {
        case 'welcome': S.id = m.id; renderRooms(m.rooms, m.maxRooms); resolve(); break;
        case 'room': S.room = m.code ? m : null; renderRoom(); if (m.code) sendView(); break;
        case 'video': configureVideo(m); break;
        case 'chat': addChat(m.name, m.text); break;
        case 'pong': S.stats.rtt = performance.now() - m.ts; break;
        case 'error': toast(m.message, 6000); break;
        default:
      }
    };
  });
}

const send = (o) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify(o));

function renderRooms(list, max) {
  const el = $('#room-list');
  el.innerHTML = '';
  for (const r of list || []) {
    const b = document.createElement('button');
    b.textContent = `Rejoindre ${r.code} (${r.members} joueur${r.members > 1 ? 's' : ''})`;
    b.onclick = () => join(r.code);
    el.appendChild(b);
  }
  $('#capacity').textContent = `Parties simultanées sur ce serveur : ${max}`;
}

// ------------------------------------------------------------------ media
function onBinary(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  S.stats.bytes += buf.byteLength;
  if (u8[0] === 1) {
    const key = u8[1] === 1;
    const ts = dv.getFloat64(2, true);
    if (!S.vdec || S.vdec.state !== 'configured') return;
    if (S.needKey && !key) return;
    if (S.vdec.decodeQueueSize > 6 && !key) return; // decoder behind: skip to the next keyframe
    S.needKey = false;
    try {
      S.vdec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round(ts * 1000), data: u8.subarray(10) }));
    } catch (e) { resetVideo(e); }
  } else if (u8[0] === 2) {
    if (!S.adec || S.adec.state !== 'configured') return;
    const ts = dv.getFloat64(1, true);
    try { S.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(ts * 1000), data: u8.subarray(9) })); } catch { /* skip */ }
  }
}

function resetVideo(err) {
  if (err) console.warn('vidéo', err);
  S.needKey = true;
  send({ t: 'keyframe' });
  if (S.vcfg) configureVideo(S.vcfg);
}

function configureVideo(cfg) {
  S.vcfg = cfg;
  if (!('VideoDecoder' in window)) {
    $('#splash').hidden = false;
    $('#splash-text').textContent = 'Votre navigateur ne gère pas WebCodecs : utilisez Chrome, Edge, Firefox récent ou Safari 17+.';
    return;
  }
  try { if (S.vdec && S.vdec.state !== 'closed') S.vdec.close(); } catch { /* ignore */ }
  S.vdec = new VideoDecoder({
    output: (frame) => {
      if (S.lastFrame) S.lastFrame.close();
      S.lastFrame = frame;
      S.stats.frames++;
      S.stats.videoTotal++;
      requestDraw();
      if (!$('#splash').hidden && S.room?.state === 'running') $('#splash').hidden = true;
    },
    error: (e) => setTimeout(() => resetVideo(e), 100),
  });
  S.vdec.configure({ codec: cfg.codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  S.needKey = true;
}

async function initAudio() {
  if (S.actx) return;
  try {
    S.actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await S.actx.audioWorklet.addModule('js/audio-worklet.js');
    S.anode = new AudioWorkletNode(S.actx, 'stream-audio', { outputChannelCount: [2] });
    S.anode.connect(S.actx.destination);
    S.anode.port.postMessage({ volume: +($('#volume').value || 0.8) });
    if (!('AudioDecoder' in window)) { toast('Son indisponible : AudioDecoder non pris en charge par ce navigateur.'); return; }
    S.adec = new AudioDecoder({
      output: (data) => {
        const n = data.numberOfFrames, ch = data.numberOfChannels;
        const planes = [];
        for (let c = 0; c < ch; c++) {
          const p = new Float32Array(n);
          data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
          planes.push(p);
        }
        data.close();
        S.stats.audioFrames += n;
        const out = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) { out[i * 2] = planes[0][i]; out[i * 2 + 1] = planes[ch > 1 ? 1 : 0][i]; }
        if (window.__cdgRecord) (S.recorded ||= []).push(out.slice());
        S.anode.port.postMessage(out, [out.buffer]);
      },
      error: (e) => console.warn('audio', e),
    });
    S.adec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
  } catch (e) { console.warn(e); toast('Audio indisponible.'); }
}

// ------------------------------------------------------------------ drawing
let drawPending = false;
function requestDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(draw);
}

function fitCanvas() {
  const c = S.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
}

function draw() {
  drawPending = false;
  const f = S.lastFrame;
  if (!f) return;
  fitCanvas();
  const c = S.canvas, ctx = S.ctx;
  // Letterbox / pillarbox: the picture keeps its own aspect inside any screen.
  const fw = f.displayWidth, fh = f.displayHeight;
  const scale = Math.min(c.width / fw, c.height / fh);
  const dw = Math.round(fw * scale), dh = Math.round(fh * scale);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(f, (c.width - dw) >> 1, (c.height - dh) >> 1, dw, dh);
}

// The host's screen shape decides the rendered field of view.
let viewTimer = 0;
function sendView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    const r = S.canvas.getBoundingClientRect();
    const w = r.width || innerWidth, h = r.height || innerHeight;
    if (w && h) send({ t: 'view', aspect: w / h });
  }, 400);
}

// ------------------------------------------------------------------ input loop
function inputLoop() {
  const now = performance.now();
  const m = S.room && S.room.state === 'running' && !S.panelFocus ? input.mask() : 0;
  // Re-send while held so the server knows the holder is still active.
  if (m !== S.padSent || (m && now - S.padLastSend > 250)) {
    send({ t: 'pad', w: m });
    S.padSent = m;
    S.padLastSend = now;
  }
  requestAnimationFrame(inputLoop);
}

setInterval(() => {
  const now = performance.now();
  const dt = (now - S.stats.t0) / 1000;
  S.stats.fps = S.stats.frames / dt;
  S.stats.kbps = (S.stats.bytes * 8) / 1000 / dt;
  S.stats.frames = 0; S.stats.bytes = 0; S.stats.t0 = now;
  send({ t: 'ping', ts: now });
  $('#stats').textContent = `${S.stats.fps.toFixed(0)} img/s · ${(S.stats.kbps / 1000).toFixed(1)} Mb/s · ${S.stats.rtt.toFixed(0)} ms`;
}, 1000);

// ------------------------------------------------------------------ actions
async function ensureConnected() {
  S.name = $('#name').value.trim() || 'Cochon';
  try { localStorage.setItem('cdg.stream.name', S.name); } catch { /* ignore */ }
  await initAudio();
  if (S.actx?.state === 'suspended') S.actx.resume();
  if (!S.ws || S.ws.readyState !== 1) await connect();
}

async function create() {
  try {
    await ensureConnected();
    const r = $('#screen').getBoundingClientRect();
    send({ t: 'create', quality: $('#lobby-quality').value, aspect: innerWidth / innerHeight || r.width / r.height });
  } catch (e) { toast(e.message); }
}

async function join(code) {
  code = (code || $('#code').value).trim().toUpperCase();
  if (!code) { toast('Entrez le code du salon.'); return; }
  try { await ensureConnected(); send({ t: 'join', code }); } catch (e) { toast(e.message); }
}

function togglePanel(force) {
  const p = $('#panel');
  p.hidden = force === undefined ? !p.hidden : !force;
  input.enabled = p.hidden || document.activeElement === document.body;
}

function renderKeys() {
  const tb = $('#keymap');
  tb.innerHTML = '';
  for (const [a, label] of ACTIONS) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.textContent = label;
    const td2 = document.createElement('td');
    const b = document.createElement('button');
    b.className = 'key';
    b.textContent = (input.keys[a] || []).map(keyLabel).join(' / ') || '—';
    b.onclick = () => { b.textContent = 'Appuyez sur une touche…'; input.capture = (code) => { if (code !== 'Escape') input.setKey(a, code); renderKeys(); }; };
    td2.appendChild(b);
    tr.append(td, td2);
    tb.appendChild(tr);
  }
}

function wire() {
  S.canvas = $('#screen');
  S.ctx = S.canvas.getContext('2d', { alpha: false });
  const onShape = () => { requestDraw(); if (S.room?.host === S.id) sendView(); };
  new ResizeObserver(onShape).observe(S.canvas);
  addEventListener('resize', onShape);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onShape(); });

  try { $('#name').value = localStorage.getItem('cdg.stream.name') || ''; } catch { /* ignore */ }
  const m = location.hash.match(/salon=([A-Z]{4})/i);
  if (m) { $('#code').value = m[1].toUpperCase(); $('#invite').hidden = false; $('#invite-code').textContent = m[1].toUpperCase(); }

  $('#btn-create').onclick = create;
  $('#btn-join').onclick = () => join();
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('#btn-panel').onclick = () => togglePanel();
  $('#btn-leave').onclick = () => { send({ t: 'leave' }); togglePanel(false); };
  $('#btn-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
  $('#btn-copy').onclick = () => {
    const url = `${location.origin}${location.pathname}#salon=${S.room.code}`;
    navigator.clipboard?.writeText(url).then(() => toast('Lien d’invitation copié.'), () => toast(url, 10000));
  };
  $('#quality').onchange = (e) => send({ t: 'quality', quality: e.target.value });
  $('#turbo').onchange = (e) => send({ t: 'turbo', on: e.target.checked });
  $('#spectate').onchange = (e) => send({ t: 'spectate', on: e.target.checked });
  $('#volume').oninput = (e) => S.anode?.port.postMessage({ volume: +e.target.value });
  $('#btn-keys').onclick = () => { renderKeys(); $('#dlg-keys').showModal(); };
  $('#btn-keys-reset').onclick = () => { input.reset(); renderKeys(); };
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const t = $('#chat-input').value.trim();
    if (t) send({ t: 'chat', text: t });
    $('#chat-input').value = '';
    $('#chat-input').blur();
  };
  $('#chat-input').addEventListener('focus', () => { S.panelFocus = true; });
  $('#chat-input').addEventListener('blur', () => { S.panelFocus = false; });

  addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && S.room) { e.preventDefault(); togglePanel(); }
    if (e.code === 'F11') { e.preventDefault(); $('#btn-full').click(); }
    if (e.code === 'KeyT' && S.room && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
      e.preventDefault(); togglePanel(true); $('#chat-input').focus();
    }
  });
  addEventListener('pointerdown', () => S.actx?.state === 'suspended' && S.actx.resume());
  requestAnimationFrame(inputLoop);
}

wire();
