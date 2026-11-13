// Deterministic lockstep input schedule (environment-agnostic, unit-tested).
//
// Every peer runs the same game from frame 0. Frame f consumes one pad word
// (active-low, PS1 order) per participant. A participant's local input for
// frame f is decided at f - delay and broadcast; a frame is published to the
// game only once every participant's word for it is known. Frames below
// `delay` are neutral by definition, so nobody waits on them. When a
// participant leaves, the server announces the last frame it relayed for
// them; later frames are neutral for that participant on every peer.

export const NEUTRAL = 0xffff;
export const MAX_BATCH = 32;

export class Lockstep {
  /**
   * @param {object} o
   * @param {string[]} o.players  participant ids in seat order
   * @param {string} o.me         this peer's id (may be a spectator)
   * @param {number} o.delay      input delay in frames
   */
  constructor({ players, me, delay }) {
    this.players = players.slice();
    this.me = this.players.indexOf(me);
    this.delay = Math.max(1, delay | 0);
    this.words = this.players.map(() => new Map());
    this.dropped = new Map();      // index -> last relayed frame
    this.nextLocal = this.delay;   // next frame we owe the others
    this.nextPublish = 0;          // next frame to hand to the game
  }

  get isPlayer() { return this.me >= 0; }

  /** Local words for frames [nextLocal, cur + delay]; returns a batch to send. */
  local(cur, word) {
    if (!this.isPlayer) return null;
    const until = cur + this.delay;
    if (this.nextLocal > until) return null;
    const f = this.nextLocal;
    const w = [];
    while (this.nextLocal <= until && w.length < MAX_BATCH) {
      this.words[this.me].set(this.nextLocal, word & NEUTRAL);
      w.push(word & NEUTRAL);
      this.nextLocal++;
    }
    return { f, w };
  }

  receive(index, f, w) {
    if (index < 0 || index >= this.players.length || index === this.me) return;
    const m = this.words[index];
    for (let i = 0; i < w.length; i++) if (f + i >= this.nextPublish) m.set(f + i, w[i] & NEUTRAL);
  }

  drop(index, after) {
    if (index >= 0 && index < this.players.length) this.dropped.set(index, after);
  }

  wordFor(index, f) {
    if (f < this.delay) return NEUTRAL;
    const d = this.dropped.get(index);
    if (d !== undefined && f > d) return NEUTRAL;
    return this.words[index].get(f);
  }

  /** Words of frame f if complete, else null. */
  frame(f) {
    const out = new Array(this.players.length);
    for (let i = 0; i < this.players.length; i++) {
      const w = this.wordFor(i, f);
      if (w === undefined) return null;
      out[i] = w;
    }
    return out;
  }

  /** Publishes every complete frame up to `limit` through emit(f, words). */
  pump(limit, emit) {
    let n = 0;
    while (this.nextPublish <= limit) {
      const words = this.frame(this.nextPublish);
      if (!words) break;
      emit(this.nextPublish, words);
      for (const m of this.words) m.delete(this.nextPublish);
      this.nextPublish++;
      n++;
    }
    return n;
  }

  /** Who holds things up: indices whose word for the next frame is missing. */
  waitingOn() {
    const f = this.nextPublish;
    const out = [];
    for (let i = 0; i < this.players.length; i++) if (this.wordFor(i, f) === undefined) out.push(i);
    return out;
  }
}
