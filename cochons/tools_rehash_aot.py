"""Re-derive the AOT overlay profile for the French disc (SLES-02766) from the
German Frontschweine profile (SLES-02767).

The modules the game decompresses at runtime differ between the two releases
(text/data shifts). For each file of the German profile: decode the French
file, record its SHA-256, and relocate the German entry points by the shift
that maps the most of them onto MIPS function prologues (addiu sp,sp,-N) in
the French image. Entries that land on nothing plausible are dropped (the
runtime then interprets / autocompiles those paths).
"""
import hashlib, json, sys
from collections import Counter
sys.path.insert(0, 'psxrecomp/tools')
from aot_overlay_pipeline import Disc
from opcode_nibble_lz import decode_exact

def word(body, off):
    return int.from_bytes(body[off:off + 4], 'little') if 0 <= off <= len(body) - 4 else None

def prologue(body, off):
    w = word(body, off)
    return w is not None and (w >> 16) == 0x27BD and (w & 0x8000) != 0

src, dst, cue = sys.argv[1:4]
prof = json.load(open(src))
disc = Disc(cue)
prof['game_id'] = 'SLES-02766'
prof['disc_hashes'] = {'sha1': 'ccd4b6ea6fa454fa367ae871a7879e31f87f75a8'}
for img in prof['images']:
    for item in img['files']:
        body = decode_exact(disc.read(item['file'].upper()))
        item['decoded_sha256'] = hashlib.sha256(body).hexdigest()
        base = int(item['load_addr'], 16)
        ents = [int(e, 16) for e in item.get('entries', [])]
        if not ents:
            print(f"{item['file']}: {len(body)} B, pas de points d'entrée"); continue
        votes = Counter()
        for e in ents:
            for d in range(-0x400, 0x401, 4):
                if prologue(body, e - base + d):
                    votes[d] += 1
        best, n = votes.most_common(1)[0] if votes else (0, 0)
        kept = [f"0x{e + best:08X}" for e in ents if prologue(body, e - base + best)]
        print(f"{item['file']}: {len(body)} B, décalage {best:+#x}, {len(kept)}/{len(ents)} points d'entrée")
        item['entries'] = kept
json.dump(prof, open(dst, 'w'), indent=2)
