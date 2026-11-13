// Unit tests for the lockstep input engine (no emulator needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lockstep } from '../public/js/lockstep.js';

// Two peers wired through an in-memory "server" with optional reordering.
function pair({ delay = 3 } = {}) {
  const wire = [];
  const a = new Lockstep({ localId: 'a', send: (m) => wire.push(['b', { ...m, p: 'a' }]) });
  const b = new Lockstep({ localId: 'b', send: (m) => wire.push(['a', { ...m, p: 'b' }]) });
  const peers = { a, b };
  const flush = () => { while (wire.length) { const [to, m] = wire.shift(); peers[to].receive(m); } };
  return { a, b, wire, flush, delay };
}

test('both peers see identical per-port inputs', () => {
  const { a, b, flush } = pair();
  const sync = { epoch: 1, frame: 100, delay: 3, ports: { a: 0, b: 1 } };
  a.begin(sync); b.begin(sync);
  const seenA = [], seenB = [];
  for (let i = 0; i < 200; i++) {
    a.pushLocal(i & 0xff); b.pushLocal((i * 7) & 0xff);
    flush();
    const ma = a.advance(), mb = b.advance();
    assert.ok(ma && mb, 'no stall with instant delivery');
    assert.deepEqual(ma, mb);
    seenA.push(ma.join()); seenB.push(mb.join());
  }
  assert.deepEqual(seenA, seenB);
  // first `delay` frames are neutral
  assert.equal(seenA[0], '0,0,0,0,0,0,0,0');
});

test('a peer stalls until the other peer input arrives', () => {
  const { a, b, flush } = pair();
  const sync = { epoch: 1, frame: 0, delay: 2, ports: { a: 0, b: 1 } };
  a.begin(sync); b.begin(sync);
  for (let i = 0; i < 3; i++) { a.pushLocal(1); a.advance(); } // frames 0,1 free, 2 needs b
  assert.equal(a.frame, 2);
  assert.deepEqual(a.waitingOn(), ['b']);
  b.pushLocal(4); flush();
  assert.ok(a.advance());
});

test('inputs that overtake the sync are kept (regression)', () => {
  const { a, b, wire } = pair();
  const s1 = { epoch: 1, frame: 0, delay: 2, ports: { a: 0, b: 1 } };
  a.begin(s1); b.begin(s1);
  const s2 = { epoch: 2, frame: 50, delay: 2, ports: { a: 0, b: 1 } };
  a.begin(s2);
  a.pushLocal(8); // host input for epoch 2 reaches b before b applied the sync
  for (const [, m] of wire.splice(0)) b.receive(m);
  b.begin(s2);
  b.pushLocal(0);
  for (let i = 0; i < 3; i++) assert.ok(b.peekFrame() !== null || i < 2);
  b.advance(); b.advance();
  const m = b.advance();
  assert.ok(m, 'frame 52 must be runnable with a input buffered early');
  assert.equal(m[0], 8);
});

test('spectators never block', () => {
  const { a, b, flush } = pair();
  const sync = { epoch: 3, frame: 0, delay: 1, ports: { a: 0 } }; // b spectates
  a.begin(sync); b.begin(sync);
  for (let i = 0; i < 10; i++) { a.pushLocal(i); b.pushLocal(99); flush(); assert.ok(a.advance()); assert.ok(b.advance()); }
});

test('shared controller: holder keeps control, hands off after idle', () => {
  const { a, b, flush } = pair();
  // delay 0: the input pushed at a step applies to that very frame
  const sync = { epoch: 1, frame: 0, delay: 0, ports: { a: 0, b: 0 } };
  a.begin(sync); b.begin(sync);
  const step = (ia, ib) => {
    a.pushLocal(ia); b.pushLocal(ib); flush();
    const ma = a.advance(), mb = b.advance();
    assert.deepEqual(ma, mb, 'peers agree');
    return ma[0];
  };
  assert.equal(step(16, 0), 16);
  assert.equal(a.holder[0], 'a');
  assert.equal(step(16, 32), 16, 'b is ignored while a is active');
  for (let i = 0; i < 50; i++) assert.equal(step(0, 32), 0, 'a idle but still holds');
  for (let i = 0; i < 60; i++) step(0, 32);
  assert.equal(b.holder[0], 'b', 'b took over after the handoff delay');
  assert.equal(step(16, 32), 32);
  assert.equal(step(16, 0), 0, 'a must now wait for b to idle');
});

test('stale-epoch inputs are ignored', () => {
  const { a } = pair();
  a.begin({ epoch: 5, frame: 0, delay: 1, ports: { a: 0, b: 1 } });
  a.receive({ t: 'in', e: 4, p: 'b', f: 1, m: [3] });
  a.pushLocal(0); a.advance();
  assert.equal(a.advance(), null);
});
