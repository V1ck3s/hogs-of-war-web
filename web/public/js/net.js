// WebSocket client for the lobby/relay server + savestate sync packets.

export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.id = null;
    this.room = null; // last room view
  }

  get connected() { return this.ws && this.ws.readyState === 1; }
  get isHost() { return !!(this.room && this.room.code && this.room.host === this.id); }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  connect({ name, fp, serial, url }) {
    return new Promise((resolve, reject) => {
      const wsUrl = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => this.send({ t: 'hello', name, fp, serial });
      ws.onerror = () => reject(new Error('Connexion au serveur impossible.'));
      ws.onclose = () => { this.room = null; this.emit('close'); };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') { this.onBinary(ev.data); return; }
        const m = JSON.parse(ev.data);
        switch (m.t) {
          case 'welcome': this.id = m.id; resolve(m.id); break;
          case 'room': this.room = m; this.emit('room', m); break;
          case 'error': this.emit('servererror', m); break;
          default: this.emit('msg', m);
        }
      };
    });
  }

  close() { if (this.ws) this.ws.close(); }

  send(obj) { if (this.connected) this.ws.send(JSON.stringify(obj)); }

  async onBinary(buf) {
    try { this.emit('sync', await unpackSync(buf)); } catch (e) { this.emit('servererror', { message: String(e.message || e) }); }
  }

  async sendSync(header, state, sram) {
    if (!this.connected) return;
    this.ws.send(await packSync(header, state, sram));
  }
}

// [u32 header-len][header json][u32 state-len][gzip state][u32 sram-len][sram]
export async function packSync(header, state, sram) {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const z = await gzip(state);
  const s = sram || new Uint8Array(0);
  const out = new Uint8Array(12 + h.length + z.length + s.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, h.length, true); o += 4; out.set(h, o); o += h.length;
  dv.setUint32(o, z.length, true); o += 4; out.set(z, o); o += z.length;
  dv.setUint32(o, s.length, true); o += 4; out.set(s, o);
  return out.buffer;
}

export async function unpackSync(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let o = 0;
  const hl = dv.getUint32(o, true); o += 4;
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(o, o + hl))); o += hl;
  const zl = dv.getUint32(o, true); o += 4;
  const state = await gunzip(u8.subarray(o, o + zl)); o += zl;
  const sl = dv.getUint32(o, true); o += 4;
  const sram = sl ? u8.slice(o, o + sl) : null;
  return { header, state, sram };
}

async function pipe(data, stream) {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}
export const gzip = (d) => pipe(d, new CompressionStream('gzip'));
export const gunzip = (d) => pipe(d, new DecompressionStream('gzip'));
