#!/usr/bin/env python3
"""Build the capture units (generated/caps) from the player's disc when they
are missing or out of date. CMake runs it at configure time; it can also be
run by hand from anywhere:

  python3 cochons/tools/build_caps.py [--disc <game.cue>] [--jobs N] [--force]

Steps, each skipped when its inputs have not changed:
  1. capture_manifest.py rebuild: the captures from aot/captures.json + disc;
  2. compile_overlays.py --static: the units, in .cache/caps/static;
  3. merge_static_overlays.py: install them in generated/caps and chain them
     behind the AOT dispatcher (again after each `generate`, which rewrites
     generated/overlays_static.c).
The inputs are the manifest, game.toml and the recompiler binary.

Exit status: 0 built or up to date, 2 no disc found (nothing done), 1 error.
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

COCHONS = Path(__file__).resolve().parents[1]
ROOT = COCHONS.parent
TOOLS = COCHONS / 'tools'
MANIFEST = COCHONS / 'aot' / 'captures.json'
CACHE = COCHONS / '.cache' / 'caps'
STATIC = CACHE / 'static'
CAPS = COCHONS / 'generated' / 'caps'
AOT_C = COCHONS / 'generated' / 'overlays_static.c'
STAMP = '.inputs'
sys.path.insert(0, str(TOOLS))
from merge_static_overlays import MARK  # noqa: E402


def recompiler():
    path = os.environ.get('PSXRECOMP_GAME') or ROOT / 'psxrecomp' / 'recompiler' / 'build' / 'psxrecomp-game'
    path = Path(path)
    if not path.is_file():
        sys.exit(f'{path} not found: run `psxrecomp_cli.py generate` first (it builds the recompiler)')
    return path


def find_disc(arg):
    if arg:
        return Path(arg)
    cues = sorted((COCHONS / 'disc').glob('*.cue'))
    return cues[0] if cues else None


def inputs_hash(recomp):
    h = hashlib.sha256()
    for f in (MANIFEST, COCHONS / 'game.toml', recomp):
        h.update(f.read_bytes())
    return h.hexdigest()


def stamp_ok(folder, digest):
    try:
        return (folder / STAMP).read_text().strip() == digest
    except OSError:
        return False


def run(cmd, cwd=None):
    print('+', ' '.join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], cwd=cwd, check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--disc', help='the game .cue (default: cochons/disc/*.cue)')
    ap.add_argument('--jobs', type=int, default=max(1, min(os.cpu_count() or 1, 4)))
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    if not AOT_C.is_file():
        sys.exit(f'{AOT_C} not found: run `psxrecomp_cli.py generate` first')
    recomp = recompiler()
    digest = inputs_hash(recomp)
    merged = MARK in AOT_C.read_text()
    if not args.force and stamp_ok(CAPS, digest) and merged:
        print('capture units up to date')
        return

    if args.force or not stamp_ok(STATIC, digest):
        disc = find_disc(args.disc)
        if disc is None or not disc.is_file():
            print('no disc found (cochons/disc/*.cue): capture units not built', file=sys.stderr)
            sys.exit(2)
        print(f'building the capture units from {disc} (about a minute)', flush=True)
        captures = CACHE / 'disc_captures.json'
        run([sys.executable, TOOLS / 'capture_manifest.py', 'rebuild', '--disc', disc, '--out', captures])
        if STATIC.exists():
            shutil.rmtree(STATIC)
        run([sys.executable, ROOT / 'psxrecomp' / 'tools' / 'compile_overlays.py',
             '--captures', captures, '--game-toml', COCHONS / 'game.toml',
             '--recompiler', recomp, '--runtime-include', ROOT / 'psxrecomp' / 'runtime' / 'include',
             '--project-root', COCHONS, '--out-dir', STATIC,
             '--static', '--cps', '--jobs', args.jobs])
        (STATIC / STAMP).write_text(digest + '\n')

    run([sys.executable, TOOLS / 'merge_static_overlays.py', STATIC], cwd=COCHONS)
    (CAPS / STAMP).write_text(digest + '\n')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.exit(f'build_caps: command failed with status {e.returncode}')
