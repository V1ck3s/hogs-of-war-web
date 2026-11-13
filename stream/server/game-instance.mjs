// One running copy of the recompiled game, owned by a room.
//
//   Xvfb :N  ── the game (native recompiled Cochons de Guerre, OpenGL) draws here
//   PulseAudio null sink ── the game's sound goes here
//   ffmpeg x11grab → H.264 (Annex B)  ┐
//   ffmpeg pulse   → Opus (Ogg)       ┴→ parsed → broadcast to the room's clients
//   TCP debug server ← pad word (set_input) from the room's input arbiter
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AnnexBSplitter, OggOpusParser } from './media.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, env) => new Promise((resolve) => {
  execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 10000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

export const QUALITY = {
  '480p': { h: 480, kbps: 2500, scale: 1 },
  '720p': { h: 720, kbps: 5000, scale: 2 },
  '1080p': { h: 1080, kbps: 9000, scale: 3 },
};

let displayCounter = 0;
const live = new Set(); // every child process of every instance

// Never leave a game, Xvfb or encoder behind if the server goes away.
process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });

function track(p) {
  live.add(p);
  p.on('exit', () => live.delete(p));
  return p;
}

// First display number with no X server lock and no listener on its port.
function freeDisplay() {
  for (let i = 0; i < 100; i++) {
    const n = 100 + (displayCounter++ % 100);
    if (!fs.existsSync(`/tmp/.X${n}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${n}`)) return n;
  }
  throw new Error('aucun écran virtuel libre');
}

export class GameInstance extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.gameDir   directory holding the runtime binary + game.toml + disc/
   * @param {string} o.binary    runtime executable name
   * @param {string} o.workDir   per-instance writable dir (settings, saves)
   */
  constructor({ gameDir, binary, workDir, quality = '720p', aspect = 16 / 9, fps = +(process.env.CDG_FPS || 60), log = console.log }) {
    super();
    this.gameDir = gameDir;
    this.binary = binary;
    this.workDir = workDir;
    this.quality = QUALITY[quality] ? quality : '720p';
    this.aspect = aspect;
    this.fps = fps;
    this.log = log;
    this.n = freeDisplay();
    this.display = `:${this.n}`;
    this.debugPort = 4400 + this.n;
    this.sink = `cdg_${this.n}`;
    this.procs = {};
    this.stopped = false;
    this.lastKey = null; // last keyframe AU, sent to clients joining mid-stream
    this.videoConfig = null;
    this.padWord = 0xffff;
  }

  size() {
    const q = QUALITY[this.quality];
    const a = Math.max(4 / 3, Math.min(21 / 9, this.aspect));
    const h = q.h;
    const w = Math.round((h * a) / 8) * 8;
    return { w, h };
  }

  async start() {
    fs.mkdirSync(this.workDir, { recursive: true });
    await this.startXvfb();
    await this.startAudioSink();
    await this.startGame();
    await this.connectDebug();
    await this.placeWindow();
    this.startVideo();
    this.startAudio();
    this.emit('ready');
  }

  async startXvfb() {
    // Large enough for 1080p ultrawide; we capture only the game window.
    this.procs.xvfb = track(spawn('Xvfb', [this.display, '-screen', '0', '2560x1080x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' }));
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(`/tmp/.X11-unix/X${this.n}`)) return;
      await sleep(100);
    }
    throw new Error('Xvfb ne démarre pas');
  }

  async startAudioSink() {
    await run('pulseaudio', ['--start', '--exit-idle-time=-1']);
    const out = await run('pactl', ['load-module', 'module-null-sink', `sink_name=${this.sink}`, 'rate=48000', 'channels=2']);
    this.sinkModule = out.trim();
  }

  // Per-instance mod selection (mods/state.toml): the bundled catalog is
  // shared, the choices are not. Defaults follow Frontschweine: CPU overclock
  // 200 % (with its busy-wait shortcuts), 60 Hz mode, instant loading,
  // adaptive widescreen.
  writeMods() {
    const dir = path.join(this.workDir, 'mods');
    fs.mkdirSync(dir, { recursive: true });
    const bundled = path.join(dir, 'bundled');
    if (!fs.existsSync(bundled)) fs.symlinkSync(path.join(this.gameDir, 'mods', 'bundled'), bundled);
    const oc = Math.max(100, Math.min(800, +(process.env.CDG_OVERCLOCK || 200)));
    const hz60 = (process.env.CDG_60HZ ?? '1') !== '0';
    this.fps = hz60 ? 60 : 50;
    fs.writeFileSync(path.join(dir, 'state.toml'), [
      'format_version = 2', '',
      '[[package]]', 'id = "psx.enhancement.cpu-overclock"', '',
      '[[package]]', 'id = "frontschweine.enhancement.ntsc-60hz"', '',
      '[[feature]]', 'package_id = "psx.enhancement.cpu-overclock"', 'id = "cpu-overclock"',
      `enabled = ${oc > 100}`, '[feature.values]', `percent = "${oc}"`, '',
      '[[feature]]', 'package_id = "frontschweine.enhancement.ntsc-60hz"', 'id = "ntsc-60hz"',
      `enabled = ${hz60}`, '',
    ].join('\n'));
  }

  // Internal resolution factor. With a GPU, follow the quality preset (×2 for
  // 720p, ×3 for 1080p). With software OpenGL (llvmpipe) supersampling
  // multiplies the fill cost, so render at ×1 and let the present pass scale
  // the picture to the window size. CDG_SSAA forces a value (1..4).
  ssaa() {
    if (process.env.CDG_SSAA) return Math.max(1, Math.min(4, +process.env.CDG_SSAA | 0));
    const softwareGl = (process.env.LIBGL_ALWAYS_SOFTWARE ?? '1') !== '0';
    return softwareGl ? 1 : QUALITY[this.quality].scale;
  }

  writeSettings() {
    const { w, h } = this.size();
    const q = QUALITY[this.quality];
    const num = w, den = h;
    // settings.toml lives beside the executable; we point the runtime at a
    // per-instance copy of the game directory through symlinks.
    const settings = [
      '[video]',
      `renderer = "${process.env.CDG_RENDERER || 'opengl'}"`,
      `aspect_ratio = "${reduce(num, den)}"`,
      'adaptive_view = true',
      `supersampling = ${this.ssaa()}`,
      'fullscreen = false',
      'vsync = false',
      '',
      '[audio]',
      'volume = 100',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(this.workDir, 'settings.toml'), settings);
  }

  async startGame() {
    // Per-instance directory: symlink the read-only game files, keep
    // settings/saves private to this instance.
    for (const f of fs.readdirSync(this.gameDir)) {
      if (['settings.toml', 'saves', 'mods'].includes(f)) continue;
      const dst = path.join(this.workDir, f);
      if (!fs.existsSync(dst)) fs.symlinkSync(path.join(this.gameDir, f), dst);
    }
    fs.mkdirSync(path.join(this.workDir, 'saves'), { recursive: true });
    this.writeMods();
    this.writeSettings();
    const env = {
      ...process.env,
      DISPLAY: this.display,
      SDL_AUDIO_DRIVER: 'pulseaudio',
      PULSE_SINK: this.sink,
      PSX_NO_LAUNCHER: '1',
      PSX_VSYNC: '0',
      LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE ?? '1',
      SDL_VIDEO_X11_NET_WM_BYPASS_COMPOSITOR: '0',
    };
    // Code the game loads at runtime (battle modules, FMV player) is compiled
    // to native shards in the background and cached for the next sessions.
    const ac = process.env.CDG_AUTOCOMPILE || path.resolve(this.gameDir, '../autocompile.sh');
    if (fs.existsSync(ac)) env.PSX_OVERLAY_AUTOCOMPILE_CMD = ac;
    const exe = path.join(this.workDir, this.binary);
    const args = ['--debug-port', String(this.debugPort)];
    if (process.env.CDG_GAME_ARGS) args.push(...process.env.CDG_GAME_ARGS.split(' '));
    this.procs.game = track(spawn(exe, args, { cwd: this.workDir, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    const logFile = fs.createWriteStream(path.join(this.workDir, 'game.log'));
    this.procs.game.stdout.pipe(logFile);
    this.procs.game.stderr.pipe(logFile);
    this.procs.game.on('exit', (code) => {
      if (!this.stopped) { this.log(`jeu terminé (code ${code})`); this.emit('exit', code); }
    });
  }

  // The runtime's control server answers ONE request per connection, at the
  // next vblank. Commands are therefore sent one at a time on short-lived
  // localhost connections. Every distinct pad state is delivered in order (a
  // quick tap = press then release, each held for at least one game frame);
  // only identical consecutive states are merged, and the queue is capped so
  // a stalled game never accumulates seconds of stale input.
  async connectDebug() {
    for (let i = 0; i < 200 && !this.stopped; i++) {
      const r = await this.request({ cmd: 'ping' });
      if (r && r.ok) { this.queue = []; this.sendPad(0xffff); return; }
      await sleep(250);
    }
    throw new Error('le jeu ne répond pas sur son port de contrôle');
  }

  request(obj) {
    return new Promise((resolve) => {
      let buf = '';
      const s = net.connect(this.debugPort, '127.0.0.1', () => {
        s.setNoDelay(true);
        s.write(JSON.stringify({ id: 1, ...obj }) + '\n');
      });
      const done = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(5000, () => done(null));
      s.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) { try { done(JSON.parse(buf.slice(0, nl))); } catch { done(null); } }
      });
      s.on('error', () => done(null));
      s.on('close', () => done(buf ? null : null));
    });
  }

  cmd(obj) {
    this.queue = this.queue || [];
    const last = this.queue[this.queue.length - 1];
    if (obj.cmd === 'set_input' && last && last.cmd === 'set_input' && last.buttons === obj.buttons) return;
    this.queue.push(obj);
    while (this.queue.length > 16) this.queue.shift();
    if (!this.pumping) this.pump();
  }

  async pump() {
    this.pumping = true;
    while (this.queue.length && !this.stopped) {
      const obj = this.queue.shift();
      const r = await this.request(obj);
      if (obj.cmd === 'set_input') this.padApplied = r && r.ok ? obj.buttons : this.padApplied;
    }
    this.pumping = false;
  }

  /** Active-low PS1 pad word for controller 1. */
  sendPad(word) {
    if (word === this.padWord && this.padSent) return;
    this.padWord = word;
    this.padSent = true;
    this.cmd({ cmd: 'set_input', buttons: word.toString(16).padStart(4, '0') });
  }

  setTurbo(on) { this.cmd({ cmd: 'turbo', enabled: on ? 1 : 0 }); }

  async findWindow() {
    for (let i = 0; i < 100; i++) {
      const out = await run('xdotool', ['search', '--onlyvisible', '--pid', String(this.procs.game.pid)], { DISPLAY: this.display });
      const id = out.trim().split('\n').filter(Boolean).pop();
      if (id) return id;
      await sleep(200);
    }
    throw new Error('fenêtre du jeu introuvable');
  }

  async placeWindow() {
    this.window = await this.findWindow();
    const { w, h } = this.size();
    await run('xdotool', ['windowmove', this.window, '0', '0'], { DISPLAY: this.display });
    await run('xdotool', ['windowsize', this.window, String(w), String(h)], { DISPLAY: this.display });
    await sleep(300);
  }

  startVideo() {
    const { w, h } = this.size();
    const q = QUALITY[this.quality];
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(this.fps), '-video_size', `${w}x${h}`,
      '-i', `${this.display}+0,0`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-b:v', `${q.kbps}k`, '-maxrate', `${q.kbps}k`, '-bufsize', `${Math.round(q.kbps / 2)}k`,
      '-g', String(this.fps), '-keyint_min', String(this.fps), '-bf', '0',
      '-x264-params', 'aud=1:repeat-headers=1:sliced-threads=1',
      '-f', 'h264', 'pipe:1',
    ];
    const p = track(spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    this.procs.video = p;
    this.videoConfig = { codec: 'avc1.64002a', width: w, height: h, fps: this.fps };
    this.emit('videoConfig', this.videoConfig);
    this.lastKey = null;
    const split = new AnnexBSplitter((au, key) => {
      if (key) this.lastKey = au;
      this.emit('video', au, key);
    });
    p.stdout.on('data', (d) => split.push(d));
    p.stderr.on('data', (d) => this.log('[ffmpeg vidéo] ' + String(d).trim()));
    p.on('exit', () => { if (!this.stopped && this.procs.video === p) setTimeout(() => this.startVideo(), 500); });
  }

  startAudio() {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'pulse', '-fragment_size', '1920', '-i', `${this.sink}.monitor`,
      '-ac', '2', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '128k', '-application', 'lowdelay', '-frame_duration', '20',
      '-flush_packets', '1', '-page_duration', '20000',
      '-f', 'ogg', 'pipe:1',
    ];
    const p = track(spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    this.procs.audio = p;
    const ogg = new OggOpusParser((pkt) => this.emit('audio', pkt));
    p.stdout.on('data', (d) => ogg.push(d));
    p.stderr.on('data', (d) => this.log('[ffmpeg audio] ' + String(d).trim()));
    p.on('exit', () => { if (!this.stopped && this.procs.audio === p) setTimeout(() => this.startAudio(), 500); });
  }

  /** Change picture shape/quality: resize the game window, restart the encoder. */
  async reshape({ aspect, quality }) {
    const before = this.size();
    const beforeQ = this.quality;
    if (aspect) this.aspect = aspect;
    if (quality && QUALITY[quality]) this.quality = quality;
    const after = this.size();
    if (before.w === after.w && before.h === after.h && beforeQ === this.quality) return false;
    await run('xdotool', ['windowsize', this.window, String(after.w), String(after.h)], { DISPLAY: this.display });
    await sleep(200);
    const old = this.procs.video;
    this.procs.video = null;
    if (old) old.kill('SIGKILL');
    this.startVideo();
    return true;
  }

  async stop() {
    this.stopped = true;
    const procs = ['video', 'audio', 'game', 'xvfb'].map((k) => this.procs[k]).filter((p) => p && p.exitCode === null);
    await Promise.all(procs.map((p) => new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      try { p.kill('SIGTERM'); } catch { resolve(); }
    })));
    if (this.sinkModule) await run('pactl', ['unload-module', this.sinkModule]);
  }
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function reduce(w, h) { const g = gcd(w, h); return `${w / g}:${h / g}`; }
