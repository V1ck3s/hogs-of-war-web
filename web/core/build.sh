#!/usr/bin/env bash
# Builds the PS1 core + web frontend to WebAssembly.
#   Requires: emsdk activated (emcc in PATH), git, make.
#   Output:   web/public/core/psx.js + psx.wasm
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(dirname "$HERE")"
SRC="${PCSX_DIR:-$HERE/../.deps/pcsx_rearmed}"
PCSX_REPO=https://github.com/libretro/pcsx_rearmed.git
PCSX_COMMIT=${PCSX_COMMIT:-7b0e8f8fadfbce3d170d195b9d9eecaabfa08c8e}
JOBS=${JOBS:-3}

if [ ! -d "$SRC" ]; then
  git clone https://github.com/libretro/pcsx_rearmed.git "$SRC"
  git -C "$SRC" checkout "$PCSX_COMMIT"
  git -C "$SRC" submodule update --init --depth 1
fi

( cd "$SRC" && emmake make -f Makefile.libretro platform=emscripten CFLAGS_OPT="-O3 -flto" -j"$JOBS" )

OUT="$WEB/public/core"
mkdir -p "$OUT"
cp "$SRC/pcsx_rearmed_libretro_emscripten.bc" "$SRC/libpcsx_core.a"
emcc -O3 -msimd128 -I"$SRC/deps/libretro-common/include" -c "$HERE/frontend.c" -o "$SRC/web_frontend.o"
emcc -O3 -flto -msimd128 \
  "$SRC/web_frontend.o" "$SRC/libpcsx_core.a" \
  -sUSE_ZLIB=1 \
  -sMODULARIZE=1 -sEXPORT_NAME=createPSX \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=1048576 \
  -sFORCE_FILESYSTEM=1 -lworkerfs.js -lnodefs.js \
  -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,NODEFS,HEAPU8,HEAP16,HEAPU32,ccall,cwrap,stringToNewUTF8,UTF8ToString \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -o "$OUT/psx.js"
ls -la "$OUT"
