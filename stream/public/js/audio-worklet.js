// Jitter buffer for the streamed audio (interleaved Float32 stereo chunks).
class StreamAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1 << 18; // ~5.4 s at 48 kHz
    this.buf = new Float32Array(this.size * 2);
    this.r = 0; this.w = 0;
    // Adaptive cushion: 60 ms when the server keeps real time; grows on each
    // underrun (up to 1.5 s) so a lagging server gives fewer, longer pauses
    // instead of constant crackle, then shrinks back while playback is steady.
    this.minTarget = sampleRate * 0.06;
    this.target = this.minTarget;
    this.maxTarget = sampleRate * 1.5;
    this.steady = 0;
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
    if (this.avail() > this.target * 3 + sampleRate * 0.2) this.r = (this.w - Math.floor(this.target) + this.size) % this.size;
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
        if (this.started) { // underrun: rebuild a larger cushion
          this.port.postMessage({ underrun: 1 });
          this.target = Math.min(this.maxTarget, this.target * 2);
          this.steady = 0;
        }
        this.started = false;
      }
    }
    if (this.started && ++this.steady > sampleRate / 128 * 10) { // 10 s without underrun
      this.target = Math.max(this.minTarget, this.target * 0.8);
      this.steady = 0;
    }
    return true;
  }
}
registerProcessor('stream-audio', StreamAudio);
