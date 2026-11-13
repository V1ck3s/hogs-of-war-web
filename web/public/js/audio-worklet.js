// Ring-buffer audio output. Receives interleaved Float32 stereo chunks via
// the port; trims latency when the buffer grows too large (fast-forward,
// timing drift) and plays silence on underrun.
class PsxAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1 << 16; // stereo frames
    this.buf = new Float32Array(this.size * 2);
    this.r = 0;
    this.w = 0;
    this.maxLatency = sampleRate * 0.15; // frames
    this.volume = 1;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.volume !== undefined) { this.volume = d.volume; return; }
      if (d.clear) { this.r = this.w = 0; return; }
      this.push(d);
    };
  }

  avail() { return (this.w - this.r + this.size) % this.size; }

  push(samples) {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      const w2 = this.w * 2;
      this.buf[w2] = samples[i * 2];
      this.buf[w2 + 1] = samples[i * 2 + 1];
      this.w = (this.w + 1) % this.size;
      if (this.w === this.r) this.r = (this.r + 1) % this.size;
    }
    const a = this.avail();
    if (a > this.maxLatency) this.r = (this.r + (a - (this.maxLatency >> 1))) % this.size;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const v = this.volume;
    for (let i = 0; i < L.length; i++) {
      if (this.r !== this.w) {
        L[i] = this.buf[this.r * 2] * v;
        R[i] = this.buf[this.r * 2 + 1] * v;
        this.r = (this.r + 1) % this.size;
      } else {
        L[i] = 0; R[i] = 0;
      }
    }
    this.port.postMessage(this.avail());
    return true;
  }
}

registerProcessor('psx-audio', PsxAudio);
