import test from 'node:test';
import assert from 'node:assert/strict';
import { Lockstep, NEUTRAL } from '../public/js/lockstep.js';

// Owner-only lockstep: each participant's words reach the game on their own.
// Simulates N peers exchanging batches through a jittery relay; every peer
// must hand the game exactly the same word for every (participant, frame).
function run(n, frames, delay, jitter = 0) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const peers = ids.map((id) => ({ id, ls: new Lockstep({ players: ids, me: id, delay }), out: ids.map(() => []), cur: 0, queue: [] }));
  let rnd = 7;
  const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let step = 0; step < frames * 4; step++) {
    for (const p of peers) {
      const word = (~(1 << ((step + p.ls.me) % 16))) & NEUTRAL;
      const b = p.ls.local(p.cur, word);
      if (b) for (const q of peers) if (q !== p) q.queue.push({ at: step + Math.floor(rand() * jitter), i: p.ls.me, ...b });
    }
    for (const p of peers) {
      p.queue = p.queue.filter((m) => { if (m.at <= step) { p.ls.receive(m.i, m.f, m.w); return false; } return true; });
      p.ls.pump(p.cur + 64, (i, f, w) => { assert.equal(f, p.out[i].length); p.out[i].push(w); });
      // The game reads participant (frame mod n): it advances while that word is known.
      while (p.out[p.cur % n].length > p.cur + 1) p.cur++;
    }
  }
  return peers;
}

test('every peer hands the game the same word for every participant and frame', () => {
  const peers = run(3, 400, 4, 6);
  for (let i = 0; i < 3; i++) {
    const len = Math.min(...peers.map((p) => p.out[i].length));
    assert.ok(len > 300, `participant ${i}: ${len} words`);
    for (const p of peers.slice(1)) assert.deepEqual(p.out[i].slice(0, len), peers[0].out[i].slice(0, len));
  }
});

test('a participant is published without waiting for the others', () => {
  const ls = new Lockstep({ players: ['a', 'b'], me: 'a', delay: 2 });
  ls.local(10, 0x1234);
  const got = [[], []];
  ls.pump(20, (i, f, w) => got[i].push([f, w]));
  // Mine: neutral below the delay, then my word up to cur + lead; b: only the neutral frames.
  assert.deepEqual(got[0].slice(0, 3), [[0, NEUTRAL], [1, NEUTRAL], [2, 0x1234]]);
  assert.equal(got[0].length, 13);
  assert.deepEqual(got[1], [[0, NEUTRAL], [1, NEUTRAL]]);
  assert.deepEqual(ls.waitingOn(2), [1]);
});

test('nothing is published for a dropped participant after its last relayed frame', () => {
  const ls = new Lockstep({ players: ['a', 'b'], me: 'a', delay: 2 });
  ls.receive(1, 2, [0xaaaa, 0xbbbb, 0xcccc]);
  ls.drop(1, 3);
  const got = [];
  ls.pump(10, (i, f, w) => { if (i === 1) got.push([f, w]); });
  assert.deepEqual(got, [[0, NEUTRAL], [1, NEUTRAL], [2, 0xaaaa], [3, 0xbbbb]]);
});

test('a spectator never sends and follows the players', () => {
  const ls = new Lockstep({ players: ['a'], me: 'z', delay: 3 });
  assert.equal(ls.local(50, 0), null);
  ls.receive(0, 3, [1, 2, 3]);
  const got = [];
  ls.pump(100, (i, f, w) => got.push(w));
  assert.deepEqual(got, [NEUTRAL, NEUTRAL, NEUTRAL, 1, 2, 3]);
});
