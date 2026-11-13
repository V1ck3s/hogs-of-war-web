// Shared controller 1 (Cochons de Guerre is hot-seat: every team plays its
// turn on controller 1). The player in control keeps it while active; after
// HANDOFF_MS without input, the next player who presses a button takes it.
//
// Pad words from clients are ACTIVE-HIGH bit masks in PS1 bit order
// (bit 0 Select … bit 15 Square); the game receives the active-low word.
export const HANDOFF_MS = 2000;

export class Arbiter {
  constructor({ onWord, onHolder, now = () => Date.now() }) {
    this.onWord = onWord;
    this.onHolder = onHolder || (() => {});
    this.now = now;
    this.holder = null;
    this.lastActive = 0;
    this.masks = new Map();
  }

  input(id, mask) {
    mask &= 0xffff;
    this.masks.set(id, mask);
    const t = this.now();
    if (id === this.holder) {
      if (mask) this.lastActive = t;
    } else if (mask && (this.holder === null || t - this.lastActive > HANDOFF_MS || !this.masks.has(this.holder))) {
      this.holder = id;
      this.lastActive = t;
      this.onHolder(id);
    }
    this.emit();
  }

  remove(id) {
    this.masks.delete(id);
    if (this.holder === id) { this.holder = null; this.onHolder(null); this.emit(); }
  }

  emit() {
    const m = this.holder ? this.masks.get(this.holder) || 0 : 0;
    this.onWord((~m) & 0xffff);
  }
}
