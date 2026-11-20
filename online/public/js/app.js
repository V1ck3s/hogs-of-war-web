// Cochons de Guerre en ligne — page logic.
//
// Lobby over WebSocket; on « Lancer la partie » every member's browser boots
// the recompiled game (WebAssembly, provided by the server, disc streamed on
// demand) from frame 0, and the lockstep worker feeds it every participant's
// inputs frame by frame. Each player has their own running copy of the game.
import { Input, ACTIONS, keyLabel } from './input.js';
import { Display, GpuDisplay } from './display.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const params = new URLSearchParams(location.search);
const store = {
  get(k) { try { return localStorage.getItem(`cdg.online.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`cdg.online.${k}`, v); } catch { /* private mode */ } },
};
const state = {
  ws: null, id: null, room: null, version: null, game: null, worker: null,
  audio: null, session: null, players: [], names: new Map(), lastStats: null,
};
const input = new Input();

// ------------------------------------------------------------------ UI basics
function show(section) {
  for (const s of ['#lobby', '#room', '#play']) $(s).hidden = s !== section;
  // The game page is fixed to the window; the others scroll.
  document.documentElement.style.overflow = section === '#play' ? 'hidden' : '';
}
function toast(text, ms = 4000) {
  const d = el('div', 'toast', text);
  d.style.setProperty('--life', `${ms}ms`);
  $('#toasts').append(d);
  setTimeout(() => d.remove(), ms);
}
// Problems on the home page stay written under the title until the next try.
function lobbyError(text) {
  $('#lobby-error').textContent = text || '';
  $('#lobby-error').hidden = !text;
}
function inviteLink() { return `${location.origin}${location.pathname}?salon=${state.room.code}`; }
async function copyInvite(e) {
  const b = e && e.currentTarget;
  try {
    await navigator.clipboard.writeText(inviteLink());
    if (b) {
      b.dataset.label ||= b.textContent;
      b.textContent = 'Lien copié ✓';
      clearTimeout(b.timer);
      b.timer = setTimeout(() => { b.textContent = b.dataset.label; }, 2000);
    } else toast('Lien copié.');
  } catch { prompt('Lien d’invitation :', inviteLink()); }
}

const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
const invited = cleanCode(params.get('salon'));
$('#name').value = store.get('name') || '';
if (invited.length === 4) {
  $('#invite').hidden = false;
  $('#invite-code').textContent = invited;
  $('#code').value = invited;
  $('#btn-invite-join').textContent = `Rejoindre le salon ${invited}`;
  $('#btn-create').classList.remove('primary');   // the invitation is what the page puts forward
}
if (!$('#name').value) $('#name').focus();

// ------------------------------------------------------------------ preload
// The game is fetched (and kept by the browser cache) while players gather in
// the lobby, so starting a game is immediate.
async function compileGame(url) {
  // Compiled while it downloads; the browser keeps the compiled code with the
  // cached file, so the next visits skip most of the compilation.
  if (WebAssembly.compileStreaming) {
    try { return await WebAssembly.compileStreaming(fetch(url)); } catch { /* e.g. a proxy changed the type: plain way below */ }
  }
  return WebAssembly.compile(await (await fetch(url)).arrayBuffer());
}
const preload = (async () => {
  const info = await (await fetch('/game/info.json')).json();
  if (!info.ready) throw new Error('Le serveur n’a pas encore préparé le jeu.');
  state.version = info.version;
  $('#build').textContent = `· version ${String(info.version).slice(0, 8)}`;
  const v = `?v=${info.version}`;
  const [manifest, files, module] = await Promise.all([
    fetch(`/game/files.json${v}`).then((r) => r.json()),
    fetch(`/game/files.bin${v}`).then((r) => r.arrayBuffer()),
    compileGame(`/game/Cochons_de_Guerre.wasm${v}`),
    // The game's loader script, read again by its threads: into the cache now.
    fetch(`/game/Cochons_de_Guerre.js${v}`).then((r) => r.arrayBuffer()).catch(() => null),
  ]);
  return { manifest, files: new Uint8Array(files), module, v };
})();
// Preload shown in the lobby and to the room: the game (~3 MB), then the disc
// chunks games read (boot, menus, battles; ~20-40 MB). With everything in the
// browser cache, a slow connection only costs the time of this preload.
const loadState = { game: false, failed: '', disc: null };
function showLoad() {
  const d = loadState.disc;
  const discPart = d && d.total ? d.done / d.total : (d ? 1 : 0);
  const pct = Math.floor(((loadState.game ? 15 : 0) + 85 * discPart));
  let text;
  if (loadState.failed) text = `Jeu indisponible : ${loadState.failed}`;
  else if (!loadState.game) text = 'Préchargement : le jeu…';
  else if (d && d.total && d.done < d.total) text = `Préchargement du disque : ${(d.done * d.chunk / 1048576).toFixed(0)} / ${(d.total * d.chunk / 1048576).toFixed(0)} Mo (${pct} %) — vous pouvez lancer avant la fin, le reste arrivera pendant la partie.`;
  else text = 'Jeu et disque préchargés : prêt à jouer.';
  for (const [t, b] of [['#preload', '#preload-bar'], ['#preload2', '#preload-bar2']]) {
    $(t).textContent = text;
    $(b).style.width = `${loadState.failed ? 100 : Math.max(pct, 3)}%`;
    $(b).parentElement.className = `bar${loadState.failed ? ' failed' : pct >= 100 ? ' done' : ''}`;
  }
  if (pct !== state.readySent && (!state.readyAt || Date.now() - state.readyAt > 2000 || pct === 100)) {
    if (state.ws && state.ws.readyState === 1) {
      state.readySent = pct; state.readyAt = Date.now();
      state.ws.send(JSON.stringify({ t: 'ready', pct }));
    }
  }
}
preload.then(() => { loadState.game = true; showLoad(); })
  .catch((e) => { loadState.failed = e.message; showLoad(); });
showLoad();
// Disc prefetch into the browser cache (lobby first, then read-ahead in game).
// ?prefetch=0 (tests): no prefetcher, the disc is read only as the game needs it.
if (params.get('prefetch') !== '0') {
  try {
    const dw = new Worker('js/disc-worker.js');
    dw.onmessage = (e) => { if (e.data && e.data.t === 'progress') { loadState.disc = e.data; showLoad(); } };
  } catch { /* streaming still works */ }
} else loadState.disc = { done: 0, total: 0, chunk: 0 };

// ------------------------------------------------------------------ socket
const myName = () => $('#name').value.trim() || 'Cochon';
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => { state.helloName = myName(); ws.send(JSON.stringify({ t: 'hello', name: state.helloName })); };
    ws.onerror = () => reject(new Error('Connexion au serveur impossible. Vérifiez le lien, puis réessayez.'));
    ws.onclose = () => {
      clearInterval(ws.pinger);
      if (state.ws !== ws || !state.room) return;
      if (state.game) { toast('Connexion au serveur perdue.', 8000); return; }
      state.room = null;
      show('#lobby');
      lobbyError('La connexion au serveur a été perdue. Rejoignez le salon à nouveau.');
    };
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { onSnapshot(e.data); return; }
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') { state.id = m.id; state.key = m.key; resolve(); state.readySent = -1; state.readyAt = 0; setTimeout(showLoad, 0); }
      onMessage(m);
    };
    ws.pinger = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 2000);
  });
}
const sendWs = (o) => state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify(o));

function onMessage(m) {
  switch (m.t) {
    case 'room': onRoom(m); break;
    case 'go': startGame(m); break;
    case 'snapreq': takeSnapshot(m); break;
    case 'resync': state.resyncMeta = m; break;   // the snapshot bytes follow
    case 'ended': stopGame(); show('#room'); toast('Partie terminée par l’hôte.'); break;
    case 'in':
      // A player joining receives inputs while their game is still starting:
      // keep them for the lockstep worker.
      if (m.s !== state.session) break;
      if (state.worker) state.worker.postMessage(m); else (state.inQueue ||= []).push(m);
      break;
    case 'drop':
      if (state.worker) state.worker.postMessage(m);
      toast(`${state.names.get(m.id) || 'Un joueur'} a quitté la partie : son équipe n’a plus de joueur.`);
      break;
    case 'hash': if (state.worker) state.worker.postMessage(m); break;
    case 'chat': chatLine(m.name, m.text); break;
    case 'pong':
      // The lockstep worker's lane measures the game's real path once open.
      if (!state.laneRtt) noteRtt(performance.now() - m.ts);
      break;
    case 'net': state.roomRtt = m.maxRtt; updateLead(); break;
    case 'error':
      if (!$('#lobby').hidden) lobbyError(m.message); else toast(m.message, 6000);
      break;
    default:
  }
}

function noteRtt(rtt) {
  state.rtt = rtt;
  (state.rtts ||= []).push(rtt);
  if (state.rtts.length > 8) state.rtts.shift();
  sendWs({ t: 'rtt', rtt: Math.max(...state.rtts) });
  updateLead();
}

// Input lead: the game waits only for the player in control (owner-only
// lockstep), so that player never waits for the others and needs no lead for
// their sake: the session's minimum (a frame or two), whatever the pings.
// The others watch a little behind and catch up (psx_lockstep_web.c).
function updateLead() {
  state.lead = 0;
  if (state.worker) state.worker.postMessage({ t: 'lead', n: 0 });
}

// ------------------------------------------------------------------ lobby / room
let entering = false;
async function enter(action) {
  if (entering) return;
  entering = true;
  lobbyError('');
  store.set('name', $('#name').value.trim());
  try {
    if (!state.ws || state.ws.readyState !== 1) await connect();
    // A name changed since the connection was opened.
    else if (state.helloName !== myName()) { state.helloName = myName(); sendWs({ t: 'hello', name: state.helloName }); }
    sendWs(action);
  } catch (e) { lobbyError(e.message); } finally { entering = false; }
}
const joinTyped = () => {
  const code = cleanCode($('#code').value);
  if (code.length !== 4) { lobbyError('Le code d’un salon fait 4 lettres.'); $('#code').focus(); return; }
  enter({ t: 'join', code });
};
$('#btn-create').onclick = () => enter({ t: 'create' });
$('#btn-join').onclick = joinTyped;
$('#btn-invite-join').onclick = () => enter({ t: 'join', code: invited });
$('#code').oninput = () => { $('#code').value = cleanCode($('#code').value); };
$('#code').onkeydown = (e) => { if (e.key === 'Enter') joinTyped(); };
// Enter in the name field does what the page puts forward.
$('#name').onkeydown = (e) => { if (e.key === 'Enter') (invited.length === 4 ? $('#btn-invite-join') : $('#btn-create')).click(); };
$('#btn-copy').onclick = copyInvite;
$('#btn-copy2').onclick = copyInvite;
$('#btn-leave2').onclick = leave;
$('#btn-leave').onclick = leave;
$('#btn-start').onclick = () => sendWs({ t: 'start' });
{ const a = store.get('aspect'); if (a) $('#aspect').value = a; }
$('#aspect').onchange = () => { store.set('aspect', $('#aspect').value); pictureHint(); };
$('#mode').onchange = $('#cpus').onchange = () => sendWs({ t: 'mode', mode: $('#mode').value, cpus: +$('#cpus').value });

// Open rooms, refreshed while the lobby is on screen (redrawn only when the
// list changes, so a button being reached with the keyboard stays in place).
let roomsShown = '';
async function refreshRooms() {
  if ($('#lobby').hidden || document.hidden) return;
  let text = '[]';
  try { text = await (await fetch('/rooms', { cache: 'no-store' })).text(); } catch { return; }
  if (text === roomsShown) return;
  let list;
  try { list = JSON.parse(text); } catch { return; }
  roomsShown = text;
  const ul = $('#room-list');
  ul.textContent = '';
  for (const x of list) {
    const li = el('li');
    const what = el('span', 'what');
    const running = x.state === 'running';
    const sm = el('small');
    sm.append(el('span', `dot${running ? ' busy' : ''}`),
      `${x.mode === 'solo' ? 'Solo' : 'Multijoueur'} · ${x.players} joueur${x.players > 1 ? 's' : ''} · ${running ? 'partie en cours' : 'en attente'}`);
    what.append(el('b', '', `${x.code} — salon de ${x.host}`), sm);
    const btn = el('button', '', running ? 'Regarder' : 'Rejoindre');
    btn.type = 'button';
    btn.onclick = () => enter({ t: 'join', code: x.code });
    li.append(what, btn);
    ul.append(li);
  }
}
refreshRooms();
setInterval(refreshRooms, 3000);
document.addEventListener('visibilitychange', refreshRooms);
$('#btn-end').onclick = () => sendWs({ t: 'end' });
function leave() { stopGame(); sendWs({ t: 'leave' }); state.room = null; show('#lobby'); history.replaceState(null, '', location.pathname); roomsShown = ''; refreshRooms(); }

// Internal rendering resolution: the software renderer draws the picture N
// times finer than the PS1 (the game's own VRAM stays at 1x, so each player
// may pick a different quality without breaking the lockstep).
function quality() {
  const q = +$('#quality').value;
  return Math.max(1, Math.min(4, Math.round(q) || 2));
}
{ const q = params.get('q') || store.get('quality'); if (q) $('#quality').value = q; }
$('#quality').onchange = () => { store.set('quality', $('#quality').value); pictureHint(); };

// Picture drawn by the graphics card (WebGL 2) unless ?gpu=0 or unavailable.
function gpuPicture() {
  if (params.get('gpu') === '0') return false;
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

function chosenAspect() {
  const v = $('#aspect').value;
  if (v !== 'auto') { const [a, b] = v.split(':').map(Number); return a / b; }
  return Math.max(4 / 3, Math.min(32 / 9, innerWidth / innerHeight));
}
// What the two picture choices amount to on this screen.
function pictureHint() {
  const a = aspectRatioText(chosenAspect()), q = quality();
  const [x, y] = a.split(':').map(Number);
  $('#aspect').options[0].textContent = `Celui de mon écran (${aspectRatioText(Math.max(4 / 3, Math.min(32 / 9, innerWidth / innerHeight)))})`;
  $('#picture-hint').textContent = `Image calculée en ${Math.round(240 * q * x / y)} × ${240 * q} points (${a}, ${q}×).` +
    (q >= 3 && !gpuPicture() ? ' Sans carte graphique utilisable par le navigateur, préférez 1× ou 2×.' : '');
}
addEventListener('resize', () => { if (!$('#room').hidden) pictureHint(); });

function onRoom(m) {
  if (!m.code) { state.room = null; return; }
  state.room = m;
  for (const x of m.members) state.names.set(x.id, x.name);
  const isHost = m.host === state.id;
  const lobbyState = m.state === 'lobby';
  document.body.classList.toggle('is-host', isHost);
  $('#room-code').textContent = m.code;
  $('#room-code2').textContent = m.code;
  history.replaceState(null, '', `?salon=${m.code}`);
  if (m.mode) $('#mode').value = m.mode;
  $('#cpus').value = String(m.cpus | 0);
  $('#cpus-label').hidden = m.mode === 'solo';
  const seated = m.members.filter((x) => x.seat >= 0);
  const players = seated.length;
  const hostName = (m.members.find((x) => x.id === m.host) || {}).name || '?';
  $('#mode-line').textContent = isHost ? '' : (m.mode === 'solo'
    ? 'Mode : Solo — campagne « Un joueur » ; l’hôte joue, les autres regardent.'
    : `Mode : Multijoueur — ${players} équipe${players > 1 ? 's' : ''} de joueurs` + ((m.cpus | 0) ? ` et ${m.cpus} de l’ordinateur` : '') +
      ' ; chaque joueur règle et commande son équipe.');
  // Seats
  const seats = $('#seats');
  seats.textContent = '';
  for (let s = 0; s < 4; s++) {
    const who = m.members.find((x) => x.seat === s);
    const mine = who && who.id === state.id;
    const li = el('li', (who ? '' : 'empty') + (mine ? ' me' : ''));
    const label = el('span', 'who');
    const name = el('b', '', who ? who.name : 'Place libre');
    if (who && who.id === m.host) name.append(el('span', 'tag host', 'hôte'));
    if (mine) name.append(el('span', 'tag', 'vous'));
    label.append(name);
    if (who && lobbyState && who.ready >= 0) {
      label.append(el('small', who.ready >= 100 ? 'ready' : '', who.ready >= 100 ? 'Prêt' : `Préchargement ${who.ready} %`));
      const prog = el('i', `prog${who.ready >= 100 ? ' full' : ''}`);
      prog.style.width = `${who.ready}%`;
      li.append(prog);
    } else if (!who) label.append(el('small', '', lobbyState ? 'En attente d’un joueur' : ''));
    li.append(el('span', 'badge', `J${s + 1}`), label);
    if (lobbyState && (!who || mine)) {
      const b = el('button', mine ? 'link' : '', mine ? 'Regarder seulement' : 'Prendre');
      b.type = 'button';
      b.onclick = () => sendWs({ t: 'seat', seat: mine ? -1 : s });
      li.append(b);
    }
    seats.append(li);
  }
  $('#seat-count').textContent = `${players} / 4`;
  const watchers = m.members.filter((x) => x.seat < 0);
  $('#spectators').textContent = watchers.length
    ? `Spectateur${watchers.length > 1 ? 's' : ''} : ${watchers.map((x) => x.name + (x.id === state.id ? ' (vous)' : '')).join(', ')}` : '';
  // Start: the host's button, everyone else's waiting line.
  const late = seated.filter((x) => x.ready >= 0 && x.ready < 100);
  $('#btn-start').disabled = !players || !lobbyState;
  $('#start-hint').textContent = !players ? 'Il faut au moins un joueur assis à une place.'
    : m.mode === 'solo' ? 'Solo : vous jouez la campagne, les autres regardent.'
      : (players + (m.cpus | 0) < 2 ? 'Une seule équipe : ajoutez une équipe de l’ordinateur ou invitez un ami. '
        : players + (m.cpus | 0) > 4 ? 'Quatre équipes au plus : les dernières seront ignorées. ' : '') +
        (late.length ? `${late.map((x) => `${x.name} (${x.ready} %)`).join(', ')} précharge${late.length > 1 ? 'nt' : ''} encore : vous pouvez lancer, la suite arrivera pendant la partie.`
          : 'Tout le monde est prêt.');
  $('#room-wait').textContent = !lobbyState ? 'Une partie est en cours : vous jouerez à la prochaine.'
    : isHost ? '' : `En attente de ${hostName}, qui lance la partie.`;
  // Members panel (in game)
  const ul = $('#members');
  ul.textContent = '';
  for (const x of m.members) {
    ul.append(el('li', '', `${x.seat >= 0 ? `Joueur ${x.seat + 1}` : 'Spectateur'} — ${x.name}${x.id === m.host ? ' (hôte)' : ''}` +
      (x.rtt ? ` · ${x.rtt} ms` : '')));
  }
  if (!state.game) {
    if ($('#room').hidden) { show('#room'); scrollTo(0, 0); }
    pictureHint();
  }
}

// ------------------------------------------------------------------ game
function aspectRatioText(a) {
  const known = [[4, 3], [16, 10], [16, 9], [21, 9], [32, 9]];
  let best = known[0];
  for (const k of known) if (Math.abs(k[0] / k[1] - a) < Math.abs(best[0] / best[1] - a)) best = k;
  return `${best[0]}:${best[1]}`;
}

// Problem reports: a crash or a stall is shown to the player and written to
// the server's log with what this page last saw (the lockstep worker reports
// a stall even if this page's thread no longer runs).
const recentLog = [];
function noteLog(t) {
  recentLog.push(`${Math.round(performance.now())} ${String(t).slice(0, 300)}`);
  if (recentLog.length > 40) recentLog.shift();
  if (/execution completed|abort|fatal|Aborted/i.test(t)) reportProblem('arret', { line: String(t).slice(0, 300) });
}
let problemShown = false;
function pageInfo() {
  const M = state.game;
  const info = { gpu: !!state.gpu, q: quality(), aspect: aspectRatioText(chosenAspect()), shown: state.display ? state.display.frames : -1,
    lastPump: state.display && state.display.lastPumpAt ? Math.round(performance.now() - state.display.lastPumpAt) : -1,
    ua: navigator.userAgent.slice(0, 160) };
  try { if (M && M._swt_probe) info.probe = [0, 1, 2, 3, 4, 7, 8, 9].map((i) => M._swt_probe(i) >>> 0); } catch { /* ignore */ }
  return info;
}
function exitTrace() {
  // Written by the game when its CPU leaves through a null address.
  try {
    const t = JSON.parse(new TextDecoder().decode(state.game.FS.readFile('/game/psx_cps_exit_trace.json')));
    return { final_pc: t.final_pc, final_ra: t.final_ra, final_sp: t.final_sp,
      tail: t.tail.slice(-40).map((e) => `${e.frame} ${e.target} ra=${e.ra} a0=${e.a0}`) };
  } catch { return null; }
}
function reportProblem(kind, extra) {
  const d = { ...extra, page: pageInfo(), log: recentLog.slice(-25) };
  if (kind === 'arret') d.exit = exitTrace();
  if (state.worker) state.worker.postMessage({ t: 'diag', kind, extra: d });
  else sendWs({ t: 'diag', kind, d });
  if (!problemShown && !['reprise', 'reprise-image', 'webgl-retabli', 'image-figee', 'webgl-perdu'].includes(kind)) {
    problemShown = true;
    toast('Le jeu s’est arrêté de façon inattendue. Le détail a été envoyé au serveur.', 20000);
  }
}
addEventListener('error', (e) => { if (state.game) reportProblem('erreur', { msg: String(e.message).slice(0, 300), at: `${e.filename}:${e.lineno}` }); });
addEventListener('unhandledrejection', (e) => { if (state.game) reportProblem('erreur', { msg: String(e.reason && (e.reason.stack || e.reason)).slice(0, 500) }); });
setInterval(() => { if (state.worker) state.worker.postMessage({ t: 'beat', info: pageInfo() }); }, 1000);
// Picture watchdog: the game goes on but nothing new is drawn for 3 s.
let lastShown = -1, lastShownAt = 0, lastShownFrame = 0, pictureSent = false;
setInterval(() => {
  if (!state.display || !state.game) return;
  const shown = state.display.frames, f = (state.lastStats || {}).frame || 0, now = performance.now();
  if (shown !== lastShown) {
    if (pictureSent) reportProblem('reprise-image', { stalledMs: Math.round(now - lastShownAt) });
    lastShown = shown; lastShownAt = now; lastShownFrame = f; pictureSent = false;
  } else if (!pictureSent && now - lastShownAt > 3000 && f > lastShownFrame + 60) {
    pictureSent = true;
    const c = $('#canvas');
    let gl = null;
    try { const x = c.getContext('webgl2'); gl = x ? { lost: x.isContextLost(), err: x.getError() } : 'none'; } catch (e) { gl = String(e); }
    reportProblem('image-figee', { gameFramesSince: f - lastShownFrame, gl, contextLost: !!state.glLost,
      canvas: [c.width, c.height], hidden: document.hidden });
  }
}, 1000);

// ?replay=<name>: this page plays back the inputs the server recorded for an
// earlier session (operator's own debugging, on the server's machine): the
// game gets the recorded participants and their words, nobody's keys count.
async function loadReplay(go) {
  const name = params.get('replay');
  if (!name || go.snapshot) return go;
  const text = await (await fetch(`/replay/${encodeURIComponent(name)}`, { cache: 'no-store' })).text();
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const head = lines.find((l) => l.t === 'go');
  if (!head) throw new Error(`enregistrement ${name} illisible`);
  const ids = Array.from({ length: head.players }, (_, i) => `replay-${i}`);
  state.replay = lines.filter((l) => l.t !== 'go').map((l) => (l.t === 'drop'
    ? { t: 'drop', id: ids[l.i], after: l.after }
    : { t: 'in', p: ids[l.i], f: l.f, w: l.w }));
  const v = (await (await fetch('/game/info.json')).json()).version;
  console.log(`[replay] ${name} : ${head.players} joueur(s), ${state.replay.length} paquets, version ${head.version}` +
    (head.version !== v ? ` (ATTENTION : jeu actuel ${v})` : ''));
  return { ...go, players: ids, hostIndex: head.hostIndex, delay: head.delay, mode: head.mode, cpus: head.cpus };
}

async function startGame(go) {
  try { go = await loadReplay(go); } catch (e) { console.warn('[replay]', e.message); }
  show('#play');
  $('#splash').hidden = false;
  $('#splash-text').textContent = 'Démarrage du jeu…';
  state.session = go.session;
  state.players = go.players;
  let pre;
  try { pre = await preload; } catch (e) { $('#splash-text').textContent = e.message; return; }
  // Each player's own picture shape: the game runs native-wide (the world is
  // simulated the same whatever the view), so peers may differ.
  const aspect = aspectRatioText(chosenAspect());
  const gpu = gpuPicture();
  state.gpu = gpu;
  const Module = {
    canvas: $('#sdl'),   // SDL's own surface stays hidden; Display draws the game
    arguments: [],
    print: (t) => { console.log(t); noteLog(t); },
    printErr: (t) => { console.warn(t); noteLog(t); },
    onAbort: (what) => reportProblem('arret', { what: String(what).slice(0, 500) }),
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
            .replace(/aspect_ratio = "[^"]*"/, `aspect_ratio = "${aspect}"`)
            .replace(/supersampling = \d+/, `supersampling = ${quality()}`));
        }
        FS.writeFile(p, data);
      }
      FS.mkdirTree(`${root}/saves`);
      FS.chdir(root);
      Object.assign(Module.ENV, {
        PSX_WEB_LOCKSTEP: String(go.players.length),
        // The host drives the menus (spectating host: first player).
        PSX_WEB_LOCKSTEP_HOST: String(Math.max(0, go.players.indexOf(go.host))),
        PSX_WEB_MODE: go.mode || 'multi',
        PSX_WEB_PLAYERS: String(go.players.length),
        PSX_WEB_CPUS: String(go.cpus | 0),
        ...(gpu ? { PSX_WEB_GL: '1' } : {}),
        // The emulation thread keeps rasterizing into the authoritative VRAM:
        // the game reads VRAM back during battles (tens of times in a game),
        // and skipping left those reads with stale pixels. Same for every
        // participant (what the game reads must match: lockstep).
        // (?rasterskip=1: tests only, every peer of a room must use the same.)
        PSX_WEB_SKIP_NATIVE_RASTER: params.get('rasterskip') === '1' ? '1' : '0',
        ...(params.get('memo') === '0' ? { PSX_OVERLAY_MEMO: '0' } : {}),
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

// ------------------------------------------------------------------ late join
// A player (re)joining a running game: the server asks one peer for a
// snapshot of its game a few frames ahead; then every peer, that one
// included, reloads it and the new schedule (with the newcomer) starts there.
function heapU32(Module) { return new Uint32Array(Module.wasmMemory.buffer); }

function stageSnapshot(Module, blob, frame, nplayers) {
  const bytes = new Uint8Array(blob);
  const ptr = Module._malloc(bytes.length);
  new Uint8Array(Module.wasmMemory.buffer).set(bytes, ptr);
  const mail = Module._psx_web_lockstep_mail() >> 2;
  const u32 = heapU32(Module);
  u32[mail + 1] = ptr; u32[mail + 2] = bytes.length; u32[mail + 3] = frame; u32[mail + 4] = nplayers;
  Atomics.add(u32, mail, 1);
}

async function takeSnapshot() {
  const Module = state.game;
  if (!Module || !Module._psx_web_lockstep_mail) return;
  const u32 = heapU32(Module);
  const mail = Module._psx_web_lockstep_mail() >> 2;
  const cur = Atomics.load(u32, Module._psx_web_lockstep_status() >> 2);
  const f = cur + 20;
  u32[mail + 6] = 0;
  Atomics.store(u32, mail + 5, f);
  const t0 = performance.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 50));
    const v = heapU32(Module);
    const st = v[mail + 6] | 0;
    if (st === 2 && v[mail + 7] === f) break;
    if (st === -1 || performance.now() - t0 > 20000) { sendWs({ t: 'snapfail' }); return; }
  }
  const data = Module.FS.readFile(Module.UTF8ToString(Module._psx_web_snapshot_path()));
  sendWs({ t: 'snap', f, size: data.length });
  state.ws.send(data);
}

function onSnapshot(buf) {
  const m = state.resyncMeta;
  state.resyncMeta = null;
  console.log(`[partie] instantané reçu (${buf.byteLength} octets, image ${m ? m.f : '?'})`);
  if (!m) return;
  state.session = m.session;
  state.players = m.players;
  if (state.game && state.worker) {
    toast(m.joined ? `${m.joined} rejoint la partie : synchronisation…` : 'Synchronisation de la partie…');
    state.resyncBlob = buf;
    state.worker.postMessage({ t: 'resync', session: state.session, players: m.players, me: state.id, delay: m.delay, start: m.f, host: m.hostIndex | 0, dropped: m.dropped });
  } else {
    startGame({ ...m, snapshot: buf });
  }
}

// The game boots straight into the mode's screen (direct_start.c); the few
// seconds it spends loading that screen's data stay behind the splash. A
// player joining a running game sees it once the snapshot is loaded.
const MENU_PTR = 0x800858A4, HOME_SCREEN = { multi: 0x800E4BA0, solo: 0x800E47B0 };
function revealWhenReady(Module, go) {
  $('#splash-text').textContent = 'Préparation de la partie…';
  const t0 = performance.now();
  const target = HOME_SCREEN[go.mode || 'multi'];
  const check = () => {
    const f = (state.lastStats || {}).frame || 0;
    const ready = go.snapshot ? f > go.f + 1 : (Module._psx_web_peek32(MENU_PTR) >>> 0) === target;
    if (ready || performance.now() - t0 > 90000) { $('#splash').hidden = true; return; }
    setTimeout(check, 100);
  };
  check();
}

// Which participant this page is (none: it watches every turn), so that the
// game paces its own turns by itself and smooths the others' (?playout=0:
// the others' turns played as their inputs arrive, for comparisons).
function tellWho(Module) {
  if (!Module._psx_web_lockstep_set_me) return;
  Module._psx_web_lockstep_set_me(state.players.indexOf(state.id) >>> 0);
  Module._psx_web_lockstep_set_playout(params.get('playout') === '0' ? 0 : 1);
}

async function attach(Module, go) {
  const memory = Module.wasmMemory;
  tellWho(Module);
  // Lockstep worker: writes every participant's inputs into the game's ring.
  const w = new Worker('js/net-worker.js', { type: 'module' });
  state.worker = w;
  w.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'send') sendWs({ ...m.msg, s: state.session });
    else if (m.t === 'stats') onStats(m);
    else if (m.t === 'rtt') { if (!state.laneRtt) state.rtts = []; state.laneRtt = true; noteRtt(m.rtt); }
    else if (m.t === 'log') console.log('[lockstep]', m.text);
    else if (m.t === 'resync-ready' && state.resyncBlob) {
      console.log(`[partie] rechargement de l’instantané à l’image ${m.start}`);
      tellWho(Module);
      stageSnapshot(Module, state.resyncBlob, m.start, state.players.length);
      state.resyncBlob = null;
    }
    else if (m.t === 'hashok') { state.hashOk = (state.hashOk || 0) + 1; state.lastHashOk = m.f; }
    else if (m.t === 'desync') console.warn(`[lockstep] désynchronisation image ${m.f}`), state.desyncs = (state.desyncs || 0) + 1, toast(`Désynchronisation détectée à l’image ${m.f} avec ${state.names.get(m.from) || 'un joueur'}.`, 10000);
  };
  w.onerror = (e) => console.warn('[lockstep] worker error', e.message);
  w.postMessage({
    t: 'start', memory,
    session: state.session,
    lane: state.key ? { url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, id: state.id, key: state.key } : null,
    tags: Module._psx_web_lockstep_tags(), words: Module._psx_web_lockstep_words(),
    status: Module._psx_web_lockstep_status(), ring: Module._psx_web_lockstep_ring(),
    maxp: Module._psx_web_lockstep_maxp(), stride: Module._psx_web_lockstep_stride(),
    gone: Module._psx_web_lockstep_gone(),
    players: go.players, me: state.id, delay: go.delay,
    start: go.snapshot ? go.f : 0, host: go.hostIndex | 0,
  });
  if (state.lead) w.postMessage({ t: 'lead', n: state.lead });
  for (const m of state.replay || []) w.postMessage(m);
  for (const q of state.inQueue || []) if (q.s === state.session) w.postMessage(q);
  state.inQueue = [];
  if (go.snapshot) {
    // Joining a running game: load the snapshot every peer reloads too.
    for (const [i, after] of go.dropped || []) w.postMessage({ t: 'drop', id: go.players[i], after });
    stageSnapshot(Module, go.snapshot, go.f, go.players.length);
  }
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
    if (state.gpu) {
      $('#canvas').addEventListener('webglcontextlost', (e) => { state.glLost = true; reportProblem('webgl-perdu', {}); });
      $('#canvas').addEventListener('webglcontextrestored', () => { state.glLost = false; reportProblem('webgl-retabli', {}); });
      state.display = new GpuDisplay($('#canvas'), Module, quality(), () => {
        toast('La carte graphique n’a pas pu être utilisée : rechargez la page avec ?gpu=0.', 15000);
      });
    } else {
      const b0 = Module._psx_web_frame_buffer(0), b1 = Module._psx_web_frame_buffer(1);
      state.display = new Display($('#canvas'), memory, Module._psx_web_frame_header(), (i) => (i ? b1 : b0));
    }
  } catch (e) { toast(`Affichage impossible : ${e.message}`, 10000); }
  revealWhenReady(Module, go);
  canvas_focus();
}

function canvas_focus() { $('#canvas').focus(); }

// Game speed as this player gets it, shown next to the ping: frames of the
// game per second (50 is the game's own pace) over the last second or two.
const speed = { at: 0, frame: 0, fps: 0 };
function onStats(m) {
  const now = performance.now();
  if (m.frame < speed.frame || !speed.at) { speed.at = now; speed.frame = m.frame; }
  else if (now - speed.at >= 1000) {
    speed.fps = (m.frame - speed.frame) * 1000 / (now - speed.at);
    speed.at = now; speed.frame = m.frame;
    perfNote(speed.fps);
  }
  state.lastStats = m;
  const holder = m.holder >= 0 ? state.names.get(state.players[m.holder]) : null;
  const mine = m.holder >= 0 && state.players[m.holder] === state.id;
  // team: battle turn's team number; 0x100 | n while team n is being set up.
  const setup = m.team & 0x100, team = m.team & 0xff;
  $('#turn').textContent = setup
    ? (mine ? `Réglez votre équipe (équipe ${team})` : `${holder || '?'} règle son équipe (équipe ${team})`)
    : team
      ? (mine ? `À vous de jouer (équipe ${team})` : `Tour de ${holder || '?'} (équipe ${team})`)
      : (holder ? `${holder} a la main` : '');
  $('#turn').classList.toggle('mine', !!(team && mine));
  const waiting = m.waiting.length ? ` · attente de ${m.waiting.map((i) => state.names.get(state.players[i]) || '?').join(', ')}` : '';
  $('#stats').textContent = `image ${m.frame}${speed.fps ? ` · ${Math.round(speed.fps)} img/s` : ''}${state.rtt ? ` · ${Math.round(state.rtt)} ms` : ''}${waiting}`;
}

// Every half minute of game, what this player's machine achieved goes to the
// server's log (numbers only): game frames per second (average and worst
// second), drawing cost per screen refresh, network waits, and how evenly
// the frames followed one another. This is how a slow machine or a rough
// link shows up without anyone having to describe it.
const perf = { n: 0, sum: 0, min: Infinity, since: 0, wait: 0, even: null };
function perfNote(fps) {
  const m = state.lastStats;
  if (!state.worker || !m) return;
  if (!perf.n) { perf.since = performance.now(); perf.wait = m.waitMs; perf.even = m.even; }
  perf.n++; perf.sum += fps; perf.min = Math.min(perf.min, fps);
  if (performance.now() - perf.since < 30000) return;
  const e0 = perf.even || {}, e1 = m.even || {};
  const d = {
    fps: +(perf.sum / perf.n).toFixed(1), fpsMin: +perf.min.toFixed(1), seconds: perf.n,
    waitMs: m.waitMs - perf.wait, mine: m.holder >= 0 && state.players[m.holder] === state.id,
    frames: (e1.n || 0) - (e0.n || 0), late: (e1.late || 0) - (e0.late || 0), hitch: (e1.hitch || 0) - (e0.hitch || 0), gapMaxMs: e1.maxMs || 0,
    play: m.play, hidden: document.hidden,
    ...(state.display && state.display.takePerf ? state.display.takePerf() : {}),
  };
  perf.n = 0; perf.sum = 0; perf.min = Infinity;
  state.lastPerf = d;
  state.worker.postMessage({ t: 'diag', kind: 'perf', extra: d });
  state.worker.postMessage({ t: 'gap-reset' });
}

function stopGame() {
  state.laneRtt = false;
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
  if (e.code === 'F1') { $('#panel').hidden = !$('#panel').hidden; e.preventDefault(); }
  else if (e.code === 'KeyT' && $('#panel').hidden && !/INPUT/.test(e.target.tagName)) {
    $('#panel').hidden = false; setTimeout(() => $('#chat-input').focus(), 0); e.preventDefault();
  } else if (e.code === 'F11') { e.preventDefault(); toggleFull(); }
});
// Fullscreen with the keyboard locked (Chrome, Edge): Escape then reaches the
// game (pause) instead of leaving fullscreen; holding it still leaves.
function toggleFull() {
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  $('#play').requestFullscreen().then(() => navigator.keyboard && navigator.keyboard.lock && navigator.keyboard.lock().catch(() => {})).catch(() => {});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); });
$('#btn-full').onclick = toggleFull;
$('#btn-panel').onclick = () => { $('#panel').hidden = !$('#panel').hidden; };
$('#btn-panel-close').onclick = () => { $('#panel').hidden = true; $('#canvas').focus(); };

// One discussion for the room, shown in the lobby and in the game's panel.
function chatLine(name, text) {
  for (const log of [$('#chat-log'), $('#room-chat-log')]) {
    const d = el('div');
    d.append(el('b', '', `${name} : `), document.createTextNode(text));
    log.append(d);
    while (log.childElementCount > 200) log.firstElementChild.remove();
    log.scrollTop = 1e9;
  }
  if (state.game && $('#panel').hidden) toast(`${name} : ${text}`);
}
function chatForm(form, field, after) {
  $(form).onsubmit = (e) => {
    e.preventDefault();
    const text = $(field).value.trim();
    if (!text) return;
    sendWs({ t: 'chat', text });
    chatLine('Moi', text);
    $(field).value = '';
    after();
  };
}
chatForm('#chat-form', '#chat-input', () => $('#chat-input').blur());
chatForm('#room-chat-form', '#room-chat-input', () => {});

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
window.__cdg = { state, input, peek: (a) => (state.game && state.game._psx_web_peek32 ? state.game._psx_web_peek32(a) >>> 0 : 0) };
