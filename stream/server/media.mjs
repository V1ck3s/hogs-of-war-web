// Stream parsers for the encoder outputs.
//  - H.264 Annex B (x264 with aud=1): split into access units on AUD NALs.
//  - Ogg (libopus): extract raw Opus packets for WebCodecs AudioDecoder.

/** Incremental Annex B splitter. Calls onAU(Buffer au, isKey) per frame. */
export class AnnexBSplitter {
  constructor(onAU) {
    this.onAU = onAU;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Find AUD NAL starts (00 00 00 01 09 or 00 00 01 09); the bytes before
    // the second AUD form one complete access unit.
    let first = this.findAud(0);
    if (first < 0) { if (this.buf.length > 8 << 20) this.buf = Buffer.alloc(0); return; }
    for (;;) {
      const next = this.findAud(first + 4);
      if (next < 0) break;
      const au = this.buf.subarray(first, next);
      this.onAU(Buffer.from(au), isKeyframe(au));
      first = next;
    }
    this.buf = this.buf.subarray(first);
  }

  findAud(from) {
    const b = this.buf;
    for (let i = from; i + 4 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0) {
        if (b[i + 2] === 1 && (b[i + 3] & 0x1f) === 9) return i;
        if (b[i + 2] === 0 && b[i + 3] === 1 && (b[i + 4] & 0x1f) === 9) return i;
      }
    }
    return -1;
  }
}

export function isKeyframe(au) {
  for (let i = 0; i + 3 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      const t = au[i + 3] & 0x1f;
      if (t === 5) return true; // IDR slice
      if (t === 1) return false; // non-IDR slice
    }
  }
  return false;
}

/** Incremental Ogg page parser; calls onPacket(Buffer) for each Opus packet. */
export class OggOpusParser {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.buf = Buffer.alloc(0);
    this.partial = [];
    this.pageNo = 0;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 27) return;
      if (b.readUInt32BE(0) !== 0x4f676753) { // "OggS"
        const k = b.indexOf('OggS', 1);
        this.buf = k < 0 ? Buffer.alloc(0) : b.subarray(k);
        continue;
      }
      const nseg = b[26];
      if (b.length < 27 + nseg) return;
      let bodyLen = 0;
      for (let i = 0; i < nseg; i++) bodyLen += b[27 + i];
      const total = 27 + nseg + bodyLen;
      if (b.length < total) return;
      let off = 27 + nseg;
      for (let i = 0; i < nseg; i++) {
        const len = b[27 + i];
        this.partial.push(b.subarray(off, off + len));
        off += len;
        if (len < 255) {
          const pkt = Buffer.concat(this.partial);
          this.partial = [];
          // The first two packets are OpusHead / OpusTags headers.
          if (!(pkt.length >= 8 && (pkt.toString('latin1', 0, 8) === 'OpusHead' || pkt.toString('latin1', 0, 8) === 'OpusTags'))) {
            this.onPacket(pkt);
          }
        }
      }
      this.pageNo++;
      this.buf = b.subarray(total);
    }
  }
}
