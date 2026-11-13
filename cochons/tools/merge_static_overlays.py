#!/usr/bin/env python3
"""Chain a second static overlay set (compiled from runtime captures) behind
the disc AOT profile's set, so both link into one binary.

The WebAssembly build cannot compile code at run time, so code the game loads
outside the AOT profile's modules must be compiled ahead of time too. This
takes a `compile_overlays.py --static` output (captures), installs it under
generated/caps/ with its dispatcher renamed (*_caps), renames the AOT
dispatcher (*_aot) and appends the combined entry points the runtime calls.

  python3 tools/merge_static_overlays.py <caps-static-dir>   (from cochons/)
Re-run after every `generate` (which rewrites generated/overlays_static.c).
"""
import re
import shutil
import sys
from pathlib import Path

SYMS = ['psx_overlay_dispatch', 'psx_overlay_static_can_dispatch', 'psx_overlay_static_get_stats',
        'psx_overlay_static_entry_count', 'psx_overlay_static_entry_stats']
MARK = '/* --- merged dispatch (tools/merge_static_overlays.py) --- */'


def rename_definitions(text, suffix):
    for s in SYMS:
        text = re.sub(rf'^((?:int|void|uint32_t)\s+){s}\(', rf'\g<1>{s}{suffix}(', text, flags=re.M)
    return text


def main():
    src = Path(sys.argv[1])
    gen = Path('generated')
    caps = gen / 'caps'
    if caps.exists():
        shutil.rmtree(caps)
    caps.mkdir(parents=True)
    for f in sorted(src.glob('overlays_static*.c')):
        name = f.name.replace('overlays_static', 'caps_overlays')
        text = f.read_text()
        if f.name == 'overlays_static.c':
            text = rename_definitions(text, '_caps')
        (caps / name).write_text(text)
    main_c = gen / 'overlays_static.c'
    text = main_c.read_text()
    if MARK in text:
        text = text[:text.index(MARK)]
        text = text.replace('_aot(', '(')  # undo a previous merge before re-applying
    text = rename_definitions(text, '_aot')
    text += f'''
{MARK}
int psx_overlay_dispatch_caps(CPUState *cpu, uint32_t addr);
int psx_overlay_static_can_dispatch_caps(uint32_t addr);
void psx_overlay_static_get_stats_caps(uint64_t *, uint64_t *, uint64_t *, uint64_t *);

int psx_overlay_dispatch(CPUState *cpu, uint32_t addr) {{
    return psx_overlay_dispatch_aot(cpu, addr) || psx_overlay_dispatch_caps(cpu, addr);
}}
int psx_overlay_static_can_dispatch(uint32_t addr) {{
    return psx_overlay_static_can_dispatch_aot(addr) || psx_overlay_static_can_dispatch_caps(addr);
}}
void psx_overlay_static_get_stats(uint64_t *checks, uint64_t *hits,
                                  uint64_t *variant_misses, uint64_t *address_misses) {{
    uint64_t a[4] = {{0}}, b[4] = {{0}};
    psx_overlay_static_get_stats_aot(&a[0], &a[1], &a[2], &a[3]);
    psx_overlay_static_get_stats_caps(&b[0], &b[1], &b[2], &b[3]);
    if (checks) *checks = a[0] + b[0];
    if (hits) *hits = a[1] + b[1];
    if (variant_misses) *variant_misses = a[2] + b[2];
    if (address_misses) *address_misses = b[3];
}}
uint32_t psx_overlay_static_entry_count(void) {{ return psx_overlay_static_entry_count_aot(); }}
int psx_overlay_static_entry_stats(uint32_t index, uint32_t *addr, uint32_t *variants, uint64_t *hits) {{
    return psx_overlay_static_entry_stats_aot(index, addr, variants, hits);
}}
'''
    main_c.write_text(text)
    print(f'{len(list(caps.glob("*.c")))} capture units chained behind the AOT dispatcher')


if __name__ == '__main__':
    main()
