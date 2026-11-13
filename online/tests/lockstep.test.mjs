import test from 'node:test';
import assert from 'node:assert/strict';
import { Lockstep, NEUTRAL } from '../public/js/lockstep.js';

// Simulates N peers exchanging batches through a perfect relay and checks
// that every peer publishes exactly the same words for every frame.
function run(n, frames, delay, jitter = 0) {
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const peers = ids.map((id) => ({ id, ls: new Lockstep({ players: ids, me: id, delay }), out: [], cur: 0, queue: [] }));
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
      p.ls.pump(p.cur + 64, (f, words) => p.out.push([f, ...words].join(',')));
      if (p.out.length > p.cur + 1) p.cur = p.out.length - 1;   // the game consumed what was published
    }
  }
  return peers;
}

test('every peer publishes the same inputs for every frame', () => {
  const peers = run(3, 400, 4, 6);
  const len = Math.min(...peers.map((p) => p.out.length));
  assert.ok(len > 300, `published ${len}`);
  for (const p of peers.slice(1)) assert.deepEqual(p.out.slice(0, len), peers[0].out.slice(0, len));
});

test('frames below the delay are neutral and need nobody', () => {
  const ls = new Lockstep({ players: ['a', 'b'], me: 'a', delay: 5 });
  const got = [];
  ls.pump(10, (f, w) => got.push([f, w]));
  assert.equal(got.length, 5);
  assert.deepEqual(got[4], [4, [NEUTRAL, NEUTRAL]]);
  assert.deepEqual(ls.waitingOn(), [0, 1]);
});

test('a dropped participant is neutral after its last relayed frame', () => {
  const ls = new Lockstep({ players: ['a', 'b'], me: 'a', delay: 2 });
  ls.local(10, 0x1234);
  ls.receive(1, 2, [0xaaaa, 0xbbbb]);
  ls.drop(1, 3);
  const got = [];
  ls.pump(10, (f, w) => got.push(w[1]));
  assert.deepEqual(got.slice(0, 6), [NEUTRAL, NEUTRAL, 0xaaaa, 0xbbbb, NEUTRAL, NEUTRAL]);
});

test('a spectator never sends and follows the players', () => {
  const ls = new Lockstep({ players: ['a'], me: 'z', delay: 3 });
  assert.equal(ls.local(50, 0), null);
  ls.receive(0, 3, [1, 2, 3]);
  const got = [];
  ls.pump(100, (f, w) => got.push(w[0]));
  assert.deepEqual(got, [NEUTRAL, NEUTRAL, NEUTRAL, 1, 2, 3]);
});
