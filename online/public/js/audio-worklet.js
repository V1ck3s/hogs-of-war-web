// Plays the game's sound straight from its ring in shared wasm memory
// (psx_sdl_audio.cpp, PSX_WEB): S16 stereo at the guest rate, written by the
// emulation thread. Keeps a small cushion; on underrun it waits for the
// cushion to refill, and drops the excess when far ahead (catch-up after a
// network stall), so latency stays low.
class PsxAudio extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.ring = new Int16Array(o.buffer, o.ring, o.frames * 2);
    this.ctl = new Uint32Array(o.buffer, o.ctl, 4);
    this.frames = o.frames;
    this.step = o.rate / sampleRate;     // guest frames per output frame
    this.pos = 0;                         // fractional read position
    this.cushion = Math.round(o.rate * 0.08);
    this.max = Math.round(o.rate * 0.35);
    this.primed = false;
    this.volume = 0.8;
    this.underruns = 0;
    this.port.onmessage = (e) => { if (e.data.volume != null) this.volume = e.data.volume; };
  }

  process(_in, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const w = Atomics.load(this.ctl, 0);
    let r = Atomics.load(this.ctl, 1);
    let avail = (w - r) >>> 0;
    if (avail > this.frames) { r = w; avail = 0; }
    if (!this.primed) {
      if (avail < this.cushion) { L.fill(0); if (R !== L) R.fill(0); return true; }
      this.primed = true;
    }
    if (avail > this.max) { r = (w - this.cushion) >>> 0; avail = this.cushion; this.pos = 0; }
    const mask = this.frames - 1;
    const need = Math.ceil(L.length * this.step) + 1;
    if (avail < need) {
      this.primed = false;
      this.underruns++;
      if (this.underruns % 50 === 1) this.port.postMessage({ underruns: this.underruns });
      L.fill(0); if (R !== L) R.fill(0);
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
      p += this.step;
    }
    const used = Math.floor(p);
    this.pos = p - used;
    Atomics.store(this.ctl, 1, (r + used) >>> 0);
    return true;
  }
}
registerProcessor('psx-audio', PsxAudio);
