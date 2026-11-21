#!/usr/bin/env python3
"""Rebuild the runtime overlay captures from the player's own disc.

The capture units (generated/caps, see merge_static_overlays.py) are compiled
from captures: images of the code the game had loaded in RAM while it was
played, with the addresses it executed. The images are the game's own code,
so they cannot be committed. But that code comes from the disc: the game
decompresses its modules (opcode_nibble_lz) and runs them where it loads
them. aot/captures.json therefore keeps, for every capture, only addresses
(load address, executed PCs, entry points) and where each run of its bytes
comes from on the disc (file, offset, length). The bytes are read back from
the disc and checked against the CRC-32 recorded for each run.

What the disc does not hold is runtime data the game wrote around its code
(about 1 % of the image, never an executed instruction). It is left as
zeros: the units are compiled from code only, and the runtime checks each
compiled function against live RAM over its own code ranges.

  # from the repository root
  python3 cochons/tools/capture_manifest.py rebuild --disc <game.cue> --out <captures.json>
  python3 cochons/tools/capture_manifest.py make --disc <game.cue> --captures <captures.json>
      (maintainers: rewrite aot/captures.json from new captures)
"""
import argparse
import base64
import binascii
import bisect
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'psxrecomp' / 'tools'))
from aot_overlay_pipeline import Disc  # noqa: E402
from opcode_nibble_lz import decode_exact  # noqa: E402

MANIFEST = ROOT / 'cochons' / 'aot' / 'captures.json'
SCHEMA = 'cochons capture manifest v1'
MIN_RUN = 8          # words: shorter matches are not used as a source
RAW_FILES = {'SLES_027.66'}  # the main executable is stored uncompressed


def file_body(disc, name):
    raw = disc.read(name)
    return raw if name in RAW_FILES else decode_exact(raw)


def crc(data):
    return f'{binascii.crc32(data) & 0xFFFFFFFF:08X}'


def make(args):
    disc = Disc(args.disc)
    caps = json.loads(Path(args.captures).read_text())
    # Every distinct file body (decompressed modules + the executable),
    # concatenated so a probe is one search.
    seen, names, bodies = {}, [], []
    for name in sorted(disc.files):
        try:
            body = file_body(disc, name)
        except Exception:
            continue
        if not body:
            continue
        h = hashlib.sha1(body).digest()
        if h in seen:
            continue
        seen[h] = len(names)
        names.append(name)
        bodies.append(body)
    blob, starts = bytearray(), []
    for body in bodies:
        starts.append(len(blob))
        blob += body + b'\xA5' * 64
    blob = bytes(blob)
    print(f'{len(names)} distinct disc files searched', file=sys.stderr)

    out, missing_total = [], 0
    for c in caps:
        image = base64.b64decode(c['bytes_b64'])
        load = int(c['load_addr'], 16)
        words = len(image) // 4
        pcs = sorted({int(p, 16) for p in c['executed_pcs'] + c.get('seeds', [])})
        probes = pcs[::max(1, len(pcs) // 12)] + [load + o for o in range(0, len(image) - 64, 1024)]
        cands = set()
        for pc in probes:
            off = pc - load
            probe = image[off:off + 32]
            if len(probe) < 32 or probe.count(0) > 20:
                continue
            pos, n = blob.find(probe), 0
            while pos >= 0 and n < 4:
                i = bisect.bisect_right(starts, pos) - 1
                cands.add((i, load + off - (pos - starts[i])))
                pos, n = blob.find(probe, pos + 1), n + 1
        source = [None] * words
        for i, base in sorted(cands):
            body, run = bodies[i], []
            for w in range(words + 1):
                o = load + 4 * w - base
                if w < words and 0 <= o <= len(body) - 4 and body[o:o + 4] == image[4 * w:4 * w + 4]:
                    run.append(w)
                    continue
                if len(run) >= MIN_RUN:
                    for x in run:
                        if source[x] is None:
                            source[x] = (i, base)
                run = []
        runs, w = [], 0
        while w < words:
            if source[w] is None:
                w += 1
                continue
            s = w
            while w < words and source[w] == source[s]:
                w += 1
            i, base = source[s]
            addr, length = load + 4 * s, 4 * (w - s)
            runs.append({'file': names[i], 'offset': addr - base, 'addr': f'0x{addr:08X}',
                         'length': length, 'crc32': crc(image[4 * s:4 * w])})
        code = {(p - load) // 4 for p in pcs}
        lost = [f'0x{load + 4 * w:08X}' for w in range(words) if source[w] is None and w in code]
        if lost:
            sys.exit(f'capture 0x{load:08X}: executed words not found on the disc: {lost[:8]}')
        entry = {k: v for k, v in c.items() if k != 'bytes_b64'}
        entry['runs'] = runs
        # Two captures of the same code that differed only in runtime data
        # become the same image here. With the same entry points they compile
        # to the same unit (the executed PCs do not change it), whose two
        # copies would define the same symbols: keep the first.
        def key(e):
            return {k: v for k, v in e.items() if k != 'executed_pcs'}
        if any(key(e) == key(entry) for e in out):
            continue
        missing_total += sum(1 for s in source if s is None)
        out.append(entry)
    MANIFEST.write_text(json.dumps({'schema': SCHEMA, 'game_id': 'SLES-02766', 'captures': out},
                                   indent=1) + '\n')
    print(f'{len(out)} captures -> {MANIFEST.relative_to(ROOT)} '
          f'({missing_total} runtime-data words left as zeros)', file=sys.stderr)


def rebuild(args):
    manifest = json.loads(MANIFEST.read_text())
    if manifest.get('schema') != SCHEMA:
        sys.exit(f'{MANIFEST}: unknown schema')
    disc = Disc(args.disc)
    cache, out = {}, []
    for entry in manifest['captures']:
        load = int(entry['load_addr'], 16)
        image = bytearray(int(entry['size']))
        for r in entry['runs']:
            name = r['file']
            if name not in cache:
                cache[name] = file_body(disc, name)
            part = cache[name][r['offset']:r['offset'] + r['length']]
            if len(part) != r['length'] or crc(part) != r['crc32']:
                sys.exit(f'{name}: bytes for capture 0x{load:08X} at {r["addr"]} do not match; '
                         'is this the French disc (SLES-02766)?')
            at = int(r['addr'], 16) - load
            image[at:at + r['length']] = part
        cap = {k: v for k, v in entry.items() if k != 'runs'}
        cap['bytes_b64'] = base64.b64encode(bytes(image)).decode()
        out.append(cap)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out))
    print(f'{len(out)} captures rebuilt from the disc -> {args.out}', file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    m = sub.add_parser('make')
    m.add_argument('--disc', required=True)
    m.add_argument('--captures', required=True)
    r = sub.add_parser('rebuild')
    r.add_argument('--disc', required=True)
    r.add_argument('--out', required=True)
    args = ap.parse_args()
    make(args) if args.cmd == 'make' else rebuild(args)


if __name__ == '__main__':
    main()
