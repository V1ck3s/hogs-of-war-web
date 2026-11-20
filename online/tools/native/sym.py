#!/usr/bin/env python3
"""sym.py <prof prefix> <binary> [--top N] [--func NAME] : symbolize libprof samples.
--func prints the hottest instruction offsets of one function with its disassembly."""
import sys, subprocess, bisect, collections, re
pre, binary = sys.argv[1], sys.argv[2]
top = 45; func = None
a = sys.argv[3:]
while a:
    k = a.pop(0)
    if k == '--top': top = int(a.pop(0))
    elif k == '--func': func = a.pop(0)
base = None; maps = []
for l in open(pre + '.maps'):
    p = l.split()
    lo, hi = [int(x, 16) for x in p[0].split('-')]
    name = p[5] if len(p) > 5 else ''
    off = int(p[2], 16)
    maps.append((lo, hi, off, name))
    if name.endswith(binary.split('/')[-1]) and off == 0 and base is None: base = lo
syms = []
for l in subprocess.run(['nm', '-n', '--defined-only', binary], capture_output=True, text=True).stdout.splitlines():
    p = l.split()
    if len(p) == 3 and p[1] in 'tTwW': syms.append((int(p[0], 16), p[2]))
addrs = [s[0] for s in syms]
def lookup(pc):
    for lo, hi, off, name in maps:
        if lo <= pc < hi:
            if name.endswith(binary.split('/')[-1]):
                v = pc - base
                i = bisect.bisect_right(addrs, v) - 1
                return (syms[i][1], v - syms[i][0]) if i >= 0 else ('?', 0)
            return ('[' + (name.split('/')[-1] or 'anon') + ']', pc - lo + off)
    return ('[unmapped]', pc)
per_tid = collections.defaultdict(lambda: collections.Counter())
offs = collections.Counter(); total = 0
for l in open(pre + '.samples'):
    if l.startswith('#'): continue
    pc, tid, n = l.split(); pc = int(pc, 16); n = int(n)
    name, off = lookup(pc)
    per_tid[tid][name] += n; total += n
    if func and name == func: offs[off] += n
tids = sorted(per_tid, key=lambda t: -sum(per_tid[t].values()))
print(f'{total} samples, {len(tids)} threads')
for t in tids[:4]:
    c = per_tid[t]; tt = sum(c.values())
    if tt < total * 0.02: continue
    print(f'\n== thread {t}: {tt} samples ({100*tt/total:.1f}%)')
    for name, n in c.most_common(top): print(f'{100*n/tt:6.2f}%  {name}')
if func:
    ftot = sum(offs.values())
    start = next(a for a, n in syms if n == func)
    i = addrs.index(start); end = addrs[i + 1] if i + 1 < len(addrs) else start + 4096
    dis = subprocess.run(['objdump', '-d', '--no-show-raw-insn', f'--start-address={start}', f'--stop-address={end}', binary], capture_output=True, text=True).stdout
    print(f'\n== {func}: {ftot} samples, {end-start} bytes')
    for l in dis.splitlines():
        m = re.match(r'\s*([0-9a-f]+):\s+(.*)', l)
        if not m: continue
        off = int(m.group(1), 16) - start
        n = offs.get(off, 0)
        mark = f'{100*n/ftot:5.1f}%' if n and 100*n/ftot >= 0.4 else '      '
        print(f'{mark} {off:5x}: {m.group(2)}')
