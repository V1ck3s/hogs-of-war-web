import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnexBSplitter, OggOpusParser } from '../server/media.mjs';
import { Arbiter, HANDOFF_MS } from '../server/arbiter.mjs';

const aud = Buffer.from([0, 0, 0, 1, 0x09, 0xf0]);
const idr = Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
const p = Buffer.from([0, 0, 0, 1, 0x41, 4, 5]);

test('Annex B splitter cuts access units on AUD, flags keyframes, survives chunking', () => {
  const out = [];
  const s = new AnnexBSplitter((au, key) => out.push([au.length, key]));
  const stream = Buffer.concat([aud, idr, aud, p, aud, p, aud]);
  for (let i = 0; i < stream.length; i += 3) s.push(stream.subarray(i, i + 3));
  assert.deepEqual(out, [[aud.length + idr.length, true], [aud.length + p.length, false], [aud.length + p.length, false]]);
});

function oggPage(packets) {
  const segs = [];
  for (const pk of packets) { let n = pk.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n); }
  const h = Buffer.alloc(27);
  h.write('OggS', 0); h[26] = segs.length;
  return Buffer.concat([h, Buffer.from(segs), ...packets]);
}

test('Ogg parser yields Opus packets and skips headers', () => {
  const got = [];
  const o = new OggOpusParser((pk) => got.push(pk.length));
  const big = Buffer.alloc(600, 7);
  const data = Buffer.concat([oggPage([Buffer.from('OpusHead1234567890')]), oggPage([Buffer.from('OpusTags....')]), oggPage([Buffer.alloc(100, 1), big])]);
  o.push(data.subarray(0, 50)); o.push(data.subarray(50));
  assert.deepEqual(got, [100, 600]);
});

test('arbiter: holder keeps the shared pad, hands off after idle', () => {
  let t = 0; const words = [];
  const a = new Arbiter({ onWord: (w) => words.push(w), now: () => t });
  a.input('a', 1 << 14); // Cross
  assert.equal(a.holder, 'a');
  assert.equal(words.at(-1), 0xffff & ~(1 << 14), 'active-low word');
  t = 500; a.input('b', 1 << 4);
  assert.equal(a.holder, 'a', 'b ignored while a is active');
  t = 600; a.input('a', 0);
  t = 600 + HANDOFF_MS + 1; a.input('b', 1 << 4);
  assert.equal(a.holder, 'b');
  assert.equal(words.at(-1), 0xffff & ~(1 << 4));
  a.remove('b');
  assert.equal(a.holder, null);
  assert.equal(words.at(-1), 0xffff);
});
