#!/usr/bin/env bash
# Cochons de Guerre online: everything, from the disc alone.
#
#   1. put your disc (the .cue, its .bin tracks and its .sbi, or a .zip
#      archive that holds them) in the disc/ folder;
#   2. run ./start.sh
#
# The script does the rest and only redoes what is missing or has changed:
# tools (Emscripten), translation of the game code from the disc, WebAssembly
# build, preparation of the served files, then it starts the server
# (http://localhost:8090). Run it again after an interruption: it picks up
# where it stopped.
#
# Variables: PORT (8090), HOST (0.0.0.0), CDG_JOBS (parallel compile jobs,
# from the memory size by default), EMSDK (an Emscripten already installed),
# CDG_BUILD_ONLY=1 (prepare everything without starting the server),
# CDG_YES=1 (install missing packages without asking).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
EMSDK_VERSION=7.0.0
COCHONS=$ROOT/cochons
BUILD=$COCHONS/build-web
MARKER=$COCHONS/generated/SLES_027.66_dispatch.c

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- the disc
mkdir -p disc
find_cue() { find "$1" -maxdepth 2 -iname '*.cue' -print 2>/dev/null | sort | head -n 1; }
find_sbi() { find "$1" -maxdepth 2 -iname '*.sbi' -print 2>/dev/null | sort | head -n 1; }
CUE=$(find_cue disc)
if [ -z "$CUE" ] || [ -z "$(find_sbi disc)" ]; then
    # Archives (.zip): the disc and its .sbi, in one archive or several.
    for ZIP in disc/*.zip disc/*.ZIP; do
        [ -f "$ZIP" ] || continue
        say "Extracting $ZIP"
        python3 - "$ZIP" disc <<'EOF'
import os, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    for m in z.infolist():
        if m.filename.lower().endswith(('.cue', '.bin', '.sbi')) and \
           not os.path.exists(os.path.join(sys.argv[2], m.filename)):
            z.extract(m, sys.argv[2])
EOF
    done
    CUE=$(find_cue disc)
fi
[ -n "$CUE" ] || fail "no disc found. Put the French Cochons de Guerre disc (SLES-02766) in disc/:
the .cue file, its .bin tracks and its .sbi, or a .zip archive that holds them."

# The French disc is LibCrypt-protected: the .sbi (subchannel data that comes
# with copies of the disc) is required; without it the game does not behave
# like the original. It must carry the .cue's name.
SBI="${CUE%.*}.sbi"
if [ ! -f "$SBI" ]; then
    other=$(find_sbi "$(dirname "$CUE")")
    [ -n "$other" ] || fail "the disc's .sbi file is missing. The French disc is LibCrypt-protected:
put the .sbi file of your copy of the disc in disc/, next to \"$(basename "$CUE")\"."
    cp "$other" "$SBI"
fi

# ---------------------------------------------------------------- system packages
need=()
have() { command -v "$1" >/dev/null 2>&1; }
have git     || need+=(git)
have python3 || need+=(python3)
have cmake   || need+=(cmake)
have ninja   || need+=(ninja-build)
have clang   || need+=(clang)
have node    || need+=(nodejs)
have npm     || need+=(npm)
have xz      || need+=(xz-utils)
have bzip2   || need+=(bzip2)
if [ ${#need[@]} -gt 0 ]; then
    if have apt-get; then
        say "Missing packages: ${need[*]}"
        if [ "${CDG_YES:-}" != 1 ]; then
            read -r -p "Install them with sudo apt-get? [Y/n] " r
            case "$r" in [nN]*) fail "install them, then run ./start.sh again";; esac
        fi
        sudo apt-get update && sudo apt-get install -y "${need[@]}"
    else
        fail "install these first: ${need[*]}"
    fi
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || fail "Python 3.11 or newer is required"
node -e 'process.exit(+process.versions.node.split(".")[0] < 18 ? 1 : 0)' || fail "Node.js 18 or newer is required"

if [ -z "${CDG_JOBS:-}" ]; then
    mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    CDG_JOBS=$(( mem_mb / 900 )); [ "$CDG_JOBS" -ge 1 ] || CDG_JOBS=1
    [ "$CDG_JOBS" -le "$(nproc)" ] || CDG_JOBS=$(nproc)
fi

# ---------------------------------------------------------------- sources
if [ ! -f psxrecomp/psxrecomp_cli.py ] || [ ! -f psxrecomp/lib/recomp-net/CMakeLists.txt ]; then
    say "Fetching the submodules (psxrecomp engine)"
    git submodule update --init --recursive
fi

# ---------------------------------------------------------------- Emscripten
if ! have emcc; then
    if [ -z "${EMSDK:-}" ]; then
        EMSDK=$ROOT/.cache/emsdk
        if [ ! -f "$EMSDK/upstream/.emsdk_version" ]; then
            say "Installing Emscripten $EMSDK_VERSION (once, about 2 GB)"
            [ -d "$EMSDK/.git" ] || git clone https://github.com/emscripten-core/emsdk.git "$EMSDK"
            "$EMSDK/emsdk" install "$EMSDK_VERSION"
            "$EMSDK/emsdk" activate "$EMSDK_VERSION" >/dev/null
        fi
    fi
    # shellcheck disable=SC1091
    EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh"
fi

# ---------------------------------------------------------------- game code
# generate checks the disc (French release only), makes a working copy of it
# in cochons/disc/ and translates the game code to C in cochons/generated/.
# Redone when the disc or the game configuration changes.
stale_generate() {
    [ -f "$MARKER" ] || return 0
    [ -f "$COCHONS/disc/SLES_027.66" ] || return 0
    for f in "$COCHONS/game.toml" "$COCHONS/aot/overlays.json" "$COCHONS/symbols.toml"; do
        [ "$f" -nt "$MARKER" ] && return 0
    done
    return 1
}
if stale_generate; then
    say "Translating the game code from the disc (a few minutes the first time)"
    python3 psxrecomp/psxrecomp_cli.py generate --project-root cochons \
        --config cochons/game.toml --disc "$ROOT/$CUE"
fi

# The working copy of the disc keeps its .sbi (a copy made before the .sbi was
# provided has none: generate reuses it as it is).
WORK_CUE=$(find_cue "$COCHONS/disc")
[ -n "$WORK_CUE" ] || fail "generate did not prepare a copy of the disc in cochons/disc/"
cmp -s "$SBI" "${WORK_CUE%.*}.sbi" || cp "$SBI" "${WORK_CUE%.*}.sbi"

# ---------------------------------------------------------------- build
# Configuring also compiles, from the disc, the code the game loads at run
# time (cochons/tools/build_caps.py) when it is missing. It only runs here the
# first time and after a new translation: otherwise the build reconfigures
# itself when its inputs change (configuring every time would relink).
if [ ! -f "$BUILD/build.ninja" ] || [ "$MARKER" -nt "$BUILD/build.ninja" ]; then
    say "Configuring the WebAssembly build"
    mkdir -p .cache
    emcmake cmake -S cochons -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DPSX_SDL_BACKEND=SDL2 -DPSX_DEBUG_TOOLS=OFF -DPSX_REWIND=OFF \
        -DPSX_VULKAN=OFF -DPSX_NETPLAY=OFF > "$ROOT/.cache/configure-web.log" 2>&1 \
        || { tail -n 40 "$ROOT/.cache/configure-web.log"; fail "configuration failed (log: .cache/configure-web.log)"; }
    grep -E '^(capture units|building the capture)|CMake Warning.*capture' "$ROOT/.cache/configure-web.log" || true
fi

say "Building the game ($CDG_JOBS jobs; 20 to 60 minutes the first time)"
cmake --build "$BUILD" -j "$CDG_JOBS"

# ---------------------------------------------------------------- served files
cd online
if [ ! -d node_modules/ws ]; then
    say "Server dependencies"
    npm install --omit=dev --no-audit --no-fund
fi
if [ ! -f game/files.json ] || [ "$BUILD/Cochons_de_Guerre.wasm" -nt game/files.json ] \
   || [ "$BUILD/game.toml" -nt game/files.json ] \
   || [ -n "$(find "$COCHONS/disc" -newer game/files.json -print -quit)" ]; then
    say "Preparing the files sent to browsers"
    node tools/prepare.mjs
fi

[ "${CDG_BUILD_ONLY:-}" = 1 ] && { say "Ready. Start the server with ./start.sh"; exit 0; }
say "Server: http://localhost:${PORT:-8090}  (Ctrl+C to stop it)"
exec node server/index.mjs
