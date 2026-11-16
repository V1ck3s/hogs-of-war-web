// Deterministic lockstep input schedule (environment-agnostic, unit-tested).
//
// Every peer runs the same game from frame 0. Frame f has one pad word
// (active-low, PS1 order) per participant. A participant's local input for
// frame f is decided at f - lead and broadcast. Each participant's words are
// handed to the game as soon as they are known, independently of the others:
// the game reads only one participant's word per frame (whoever is in
// control, psx_lockstep_web.c) and waits for that one alone. Frames below
// `delay` are neutral by definition. When a participant leaves, the server
// announces the last frame it relayed for them; nothing is published for
// them after it, and the game falls back to the host for their turns.

export const NEUTRAL = 0xffff;
export const MAX_BATCH = 32;

export class Lockstep {
  /**
   * @param {object} o
   * @param {string[]} o.players  participant ids in seat order
   * @param {string} o.me         this peer's id (may be a spectator)
   * @param {number} o.delay      input delay in frames
   * @param {number} [o.start]    first frame (a snapshot's, after a join)
   * @param {number} [o.host]     participant index driving the menus
   */
  constructor({ players, me, delay, start = 0, host = 0 }) {
    this.players = players.slice();
    this.me = this.players.indexOf(me);
    this.delay = Math.max(1, delay | 0);
    this.start = start | 0;
    this.host = host | 0;
    this.words = this.players.map(() => new Map());
    this.dropped = new Map();      // index -> last relayed frame
    this.lead = this.delay;                      // how far ahead we send (>= delay)
    this.nextLocal = this.start + this.delay;   // next frame we owe the others
    this.nextPub = this.players.map(() => this.start);   // per participant: next word for the game
  }

  /** Lowest frame not yet handed to the game for every participant still there. */
  get nextPublish() {
    let m = Infinity;
    for (let i = 0; i < this.players.length; i++) if (!this.gone(i, this.nextPub[i])) m = Math.min(m, this.nextPub[i]);
    return m === Infinity ? Math.max(...this.nextPub) : m;
  }

  gone(index, f) {
    const d = this.dropped.get(index);
    return d !== undefined && f > d;
  }

  get isPlayer() { return this.me >= 0; }

  /** Sends local input `n` frames ahead of the game (never less than the
   * session delay). Purely local: a longer lead only makes our words arrive
   * earlier; it hides a slow link at the cost of input latency. */
  setLead(n) { this.lead = Math.max(this.delay, Math.min(60, n | 0)); }

  /** Local words for frames [nextLocal, cur + lead]; returns a batch to send. */
  local(cur, word) {
    if (!this.isPlayer) return null;
    const until = cur + this.lead;
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
    for (let i = 0; i < w.length; i++) if (f + i >= this.nextPub[index]) m.set(f + i, w[i] & NEUTRAL);
  }

  drop(index, after) {
    if (index >= 0 && index < this.players.length) this.dropped.set(index, after);
  }

  wordFor(index, f) {
    if (this.gone(index, f)) return undefined;   // never published: the game falls back
    if (f < this.start + this.delay) return NEUTRAL;
    return this.words[index].get(f);
  }

  /** Hands every known word up to frame `limit` to the game through
   * emit(index, f, word), each participant on its own. */
  pump(limit, emit) {
    let n = 0;
    for (let i = 0; i < this.players.length; i++) {
      while (this.nextPub[i] <= limit) {
        const f = this.nextPub[i];
        const w = this.wordFor(i, f);
        if (w === undefined) break;
        emit(i, f, w);
        this.words[i].delete(f);
        this.nextPub[i]++;
        n++;
      }
    }
    return n;
  }

  /** Participants whose word for frame f is not known yet. */
  waitingOn(f = this.nextPublish) {
    const out = [];
    for (let i = 0; i < this.players.length; i++) if (!this.gone(i, f) && this.nextPub[i] <= f) out.push(i);
    return out;
  }
}
