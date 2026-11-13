#!/bin/sh
# Background compiler for code the game loads at runtime (Linux server).
# The runtime runs this (PSX_OVERLAY_AUTOCOMPILE_CMD) with PSX_OVERLAY_CAPTURES
# set; native shards land in build/cache/ and are picked up live.
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
exec python3 "$ROOT/psxrecomp/tools/compile_overlays.py" \
  --captures "${PSX_OVERLAY_CAPTURES:-$HERE/build/overlay_captures.json}" \
  --game-toml "$HERE/game.toml" \
  --recompiler "$ROOT/psxrecomp/recompiler/build/psxrecomp-game" \
  --runtime-include "$ROOT/psxrecomp/runtime/include" \
  --out-dir "$HERE/build/cache" \
  --gcc "${CC_FOR_OVERLAYS:-gcc}" --cps --jobs 1
