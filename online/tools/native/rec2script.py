#!/usr/bin/env python3
"""rec2script.py <recording.jsonl> <out prefix>

Turns a one-player session recorded by the server (online/recordings) into
what the native build's lockstep harness reads:
  <prefix>.script   "frame padword" rows (PSX_LOCKSTEP_SCRIPT), first line a
                    comment with the session's settings
  <prefix>.hashes   "frame digest" rows, the game digests the browsers
                    reported every 600 frames
Only sessions with one participant: with several, which pad the game reads
on a frame depends on whose turn it is, which the recording does not say."""
import json, sys

rec, out = sys.argv[1], sys.argv[2]
words, hashes, go = {}, {}, None
for line in open(rec):
    o = json.loads(line)
    if o.get('t') == 'go':
        go = o
    elif o.get('t') == 'hash':
        hashes[o['f']] = o['h'] & 0xFFFFFFFF
    elif 'w' in o:
        for k, w in enumerate(o['w']):
            words[o['f'] + k] = w
if not go or go.get('players') != 1:
    sys.exit('this tool needs a session with exactly one participant')
last, cur, rows = max(words), 0xFFFF, []
for f in range(last + 1):
    w = words.get(f, 0xFFFF)
    if w != cur:
        rows.append((f, w))
        cur = w
with open(out + '.script', 'w') as f:
    f.write('# ' + json.dumps(go) + '\n' + ''.join('%d %04x\n' % r for r in rows))
with open(out + '.hashes', 'w') as f:
    f.write(''.join('%d %08x\n' % kv for kv in sorted(hashes.items())))
print(f'{last + 1} frames, {len(rows)} input changes, {len(hashes)} digests; cpus={go.get("cpus")}')
