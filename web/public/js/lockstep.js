// Deterministic lockstep input engine (environment-agnostic ES module).
//
// Every peer runs the same emulator from the same savestate. Each emulated
// frame consumes one input mask per participant. A peer's local input for
// frame f is scheduled at f + delay and broadcast, so all peers apply the
// exact same inputs on the exact same frames. A frame only runs once every
// participant's input for it is known.
//
// Session boundaries ("epochs") come from the host's sync: a savestate taken
// at frame F plus the participant/port table. For frames [F, F + delay) all
// inputs are neutral (0) by definition, so nobody waits on them.

export const HASH_INTERVAL = 250; // frames between desync checks
// Shared controller (the game is hot-seat: every team plays on controller 1).
// The player in control keeps it while active; after HANDOFF idle frames the
// next player to press a button takes it. Computed from the shared input
// stream, so every peer agrees on the holder at every frame.
export const HANDOFF = 100;

export class Lockstep {
  /**
   * @param {object} o
   * @param {string} o.localId   this peer's id
   * @param {(msg: object) => void} o.send  broadcast to the other peers
   */
  constructor({ localId, send }) {
    this.localId = localId;
    this.send = send;
    this.epoch = -1;
    this.frame = 0;
    this.delay = 4;
    this.ports = new Map(); // participant id -> controller port (0..7)
    this.inputs = new Map(); // id -> Map(frame -> mask)
    this.localNext = 0;
    this.syncFrame = 0;
    this.future = []; // messages of an epoch we have not started yet
    this.stats = { stalls: 0 };
    this.holder = new Array(8).fill(null); // port -> id in control
    this.lastActive = new Array(8).fill(0);
  }

  get active() { return this.epoch >= 0; }
  get isParticipant() { return this.ports.has(this.localId); }

  /** Start (or restart) an epoch. ports: {id: port}. */
  begin({ epoch, frame, delay, ports }) {
    this.epoch = epoch;
    this.frame = frame;
    this.syncFrame = frame;
    this.delay = delay;
    this.ports = new Map(Object.entries(ports).map(([id, p]) => [id, p | 0]));
    this.inputs = new Map([...this.ports.keys()].map((id) => [id, new Map()]));
    this.localNext = frame + delay;
    this.holder.fill(null);
    this.lastActive.fill(frame);
    // Inputs for this epoch may have overtaken the (slower to decode) sync.
    const early = this.future.filter((m) => m.e === epoch);
    this.future = this.future.filter((m) => m.e > epoch);
    for (const m of early) this.receive(m);
  }

  end() {
    this.epoch = -1;
    this.ports.clear();
    this.inputs.clear();
  }

  /** Network message from another peer. */
  receive(msg) {
    if (msg.e > this.epoch) {
      if (this.future.length < 4096) this.future.push(msg);
      return;
    }
    if (msg.e !== this.epoch) return; // stale epoch
    if (msg.t === 'in') {
      const m = this.inputs.get(msg.p);
      if (!m) return;
      const masks = Array.isArray(msg.m) ? msg.m : [msg.m];
      masks.forEach((mask, i) => m.set(msg.f + i, mask | 0));
    }
  }

  /**
   * Schedule local input. Call once per host tick with the current pad mask;
   * it fills every frame up to frame + delay that has not been sent yet.
   */
  pushLocal(mask) {
    if (!this.active || !this.isParticipant) return;
    const mine = this.inputs.get(this.localId);
    const target = this.frame + this.delay;
    if (this.localNext > target) return;
    const start = this.localNext;
    const batch = [];
    for (; this.localNext <= target; this.localNext++) {
      mine.set(this.localNext, mask | 0);
      batch.push(mask | 0);
    }
    this.send({ t: 'in', e: this.epoch, f: start, m: batch });
  }

  inputFor(id, f) {
    if (f < this.syncFrame + this.delay) return 0;
    const m = this.inputs.get(id);
    return m ? m.get(f) : undefined;
  }

  /** Raw inputs of every participant for the next frame, or null if someone is late. */
  peekFrame() {
    const raw = [];
    for (const [id, port] of this.ports) {
      const v = this.inputFor(id, this.frame);
      if (v === undefined) return null;
      raw.push([id, port, v]);
    }
    return raw;
  }

  /** Arbitrate shared ports and build the per-port masks (mutates holders). */
  resolve(raw, f) {
    const masks = new Array(8).fill(0);
    const byPort = new Map();
    for (const [id, port, v] of raw) {
      if (!byPort.has(port)) byPort.set(port, []);
      byPort.get(port).push([id, v]);
    }
    for (const [port, list] of byPort) {
      if (list.length === 1) { masks[port] = list[0][1]; this.holder[port] = list[0][0]; continue; }
      list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      let h = this.holder[port];
      const cur = h && list.find(([id]) => id === h);
      if (cur && cur[1]) this.lastActive[port] = f;
      if (!cur || f - this.lastActive[port] > HANDOFF) {
        const next = list.find(([id, v]) => v && id !== h);
        if (next) { h = next[0]; this.holder[port] = h; this.lastActive[port] = f; }
        else if (!cur) h = null;
      }
      const hv = list.find(([id]) => id === h);
      masks[port] = hv ? hv[1] : 0;
    }
    return masks;
  }

  /** Consume the next frame's inputs: returns masks or null (stall). */
  advance() {
    const raw = this.peekFrame();
    if (!raw) { this.stats.stalls++; return null; }
    const masks = this.resolve(raw, this.frame);
    const f = this.frame++;
    for (const m of this.inputs.values()) m.delete(f);
    return masks;
  }

  /** Waiting on which participants (for UI). */
  waitingOn() {
    const out = [];
    for (const id of this.ports.keys()) if (this.inputFor(id, this.frame) === undefined) out.push(id);
    return out;
  }

  /** Should the frame just executed (number f) be hashed? */
  static wantsHash(f) { return f > 0 && f % HASH_INTERVAL === 0; }
}

/** Host-side desync detector: collects hashes, reports mismatching frames. */
export class HashBook {
  constructor() { this.byFrame = new Map(); }
  add(frame, id, hash) {
    let m = this.byFrame.get(frame);
    if (!m) { m = new Map(); this.byFrame.set(frame, m); }
    m.set(id, hash >>> 0);
    // keep the book small
    if (this.byFrame.size > 32) this.byFrame.delete(this.byFrame.keys().next().value);
  }
  /** Returns ids whose hash differs from refId's at frame (or []). */
  check(frame, refId) {
    const m = this.byFrame.get(frame);
    if (!m || !m.has(refId)) return [];
    const ref = m.get(refId);
    return [...m].filter(([, h]) => h !== ref).map(([id]) => id);
  }
}
