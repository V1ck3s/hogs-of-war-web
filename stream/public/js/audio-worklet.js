// Jitter buffer for the streamed audio (interleaved Float32 stereo chunks).
class StreamAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1 << 16;
    this.buf = new Float32Array(this.size * 2);
    this.r = 0; this.w = 0;
    this.target = sampleRate * 0.06; // ~60 ms of buffering
    this.max = sampleRate * 0.2;
    this.started = false;
    this.volume = 1;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.volume !== undefined) { this.volume = d.volume; return; }
      this.push(d);
    };
  }
  avail() { return (this.w - this.r + this.size) % this.size; }
  push(s) {
    const n = s.length >> 1;
    for (let i = 0; i < n; i++) {
      this.buf[this.w * 2] = s[i * 2];
      this.buf[this.w * 2 + 1] = s[i * 2 + 1];
      this.w = (this.w + 1) % this.size;
    }
    // Too much latency accumulated (network burst): skip ahead.
    if (this.avail() > this.max) this.r = (this.w - Math.floor(this.target) + this.size) % this.size;
  }
  process(_in, outputs) {
    const L = outputs[0][0], R = outputs[0][1] || L;
    if (!this.started && this.avail() >= this.target) this.started = true;
    for (let i = 0; i < L.length; i++) {
      if (this.started && this.r !== this.w) {
        L[i] = this.buf[this.r * 2] * this.volume;
        R[i] = this.buf[this.r * 2 + 1] * this.volume;
        this.r = (this.r + 1) % this.size;
      } else {
        L[i] = R[i] = 0;
        this.started = false; // underrun: rebuild the cushion
      }
    }
    return true;
  }
}
registerProcessor('stream-audio', StreamAudio);
