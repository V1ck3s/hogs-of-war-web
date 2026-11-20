// Plays the game's sound straight from its ring in shared wasm memory
// (psx_sdl_audio.cpp, PSX_WEB): S16 stereo at the guest rate, written by the
// emulation thread.
//
// The ring is filled on the game's clock and emptied on the sound card's,
// which never agree exactly (a few hundredths of a percent), and the game
// stalls now and then (network waits) and then makes up for it. Instead of
// throwing sound away when the cushion grows (a whole shot could vanish), the
// read speed follows the fill level: within ±0.5 % around the target, up to
// +6 % while there is a backlog to absorb. Only a backlog of more than a
// second is cut. On underrun it waits for the cushion to refill.
class PsxAudio extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.ring = new Int16Array(o.buffer, o.ring, o.frames * 2);
    this.ctl = new Uint32Array(o.buffer, o.ctl, 4);
    this.frames = o.frames;
    this.base = o.rate / sampleRate;      // guest frames per output frame
    this.pos = 0;                         // fractional read position
    this.cushion = Math.round(o.rate * 0.08);
    this.target = Math.round(o.rate * 0.12);
    this.max = Math.round(o.rate * 1.0);
    this.fill = this.target;              // smoothed fill level
    this.primed = false;
    this.volume = 0.8;
    // Counters sent to the page every second: underruns (silences), guest
    // frames cut, smoothed fill (frames), current speed ratio.
    this.underruns = 0;
    this.cut = 0;
    this.ratio = 1;
    this.lastReport = 0;
    this.port.onmessage = (e) => { if (e.data.volume != null) this.volume = e.data.volume; };
  }

  report() {
    if (currentTime - this.lastReport < 1) return;
    this.lastReport = currentTime;
    this.port.postMessage({ stats: { underruns: this.underruns, cut: this.cut, fill: Math.round(this.fill), ratio: this.ratio } });
  }

  process(_in, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const w = Atomics.load(this.ctl, 0);
    let r = Atomics.load(this.ctl, 1);
    let avail = (w - r) >>> 0;
    if (avail > this.frames) { r = w; avail = 0; }
    if (!this.primed) {
      if (avail < this.cushion) { L.fill(0); if (R !== L) R.fill(0); this.report(); return true; }
      this.primed = true;
      this.fill = avail;
    }
    if (avail > this.max) {
      this.cut += avail - this.target;
      r = (w - this.target) >>> 0; avail = this.target; this.pos = 0; this.fill = avail;
    }
    this.fill += (avail - this.fill) * 0.02;
    const err = (this.fill - this.target) / this.target;
    const adj = err > 1 ? 0.005 + (err - 1) * 0.03 : err * 0.005;
    const ratio = 1 + Math.max(-0.005, Math.min(0.06, adj));
    this.ratio = ratio;
    const step = this.base * ratio;
    const mask = this.frames - 1;
    const need = Math.ceil(L.length * step) + 1;
    if (avail < need) {
      this.primed = false;
      this.underruns++;
      L.fill(0); if (R !== L) R.fill(0);
      this.report();
      return true;
    }
    const v = this.volume / 32768;
    let p = this.pos;
    for (let i = 0; i < L.length; i++) {
      const k = Math.floor(p);
      const f = p - k;
      const a = ((r + k) & mask) * 2, b = ((r + k + 1) & mask) * 2;
      L[i] = (this.ring[a] * (1 - f) + this.ring[b] * f) * v;
      if (R !== L) R[i] = (this.ring[a + 1] * (1 - f) + this.ring[b + 1] * f) * v;
      p += step;
    }
    const used = Math.floor(p);
    this.pos = p - used;
    Atomics.store(this.ctl, 1, (r + used) >>> 0);
    this.report();
    return true;
  }
}
registerProcessor('psx-audio', PsxAudio);
