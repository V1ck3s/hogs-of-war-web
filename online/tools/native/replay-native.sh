#!/bin/bash
# Replays a recorded one-player online session in the NATIVE build, in the
# online configuration (native-wide, direct start, the same mods as
# tools/prepare.mjs), and compares the game digests with the ones the
# browsers reported. The native build and the WebAssembly build compute the
# same game: equal digests are the reference when the runtime is changed, and
# the native run is where a profiler can look at single instructions.
#
#   replay-native.sh <build dir> <recording.jsonl> <work dir> [last frame]
#
#   UNPACED=1   not held to 50 frames/s (benchmark: CPU time is printed)
#   PROF=1      sample the run with prof.c (see sym.py); gcc must be there
#   ASPECT=32:9 picture shape (does not change the digests)
#   EXTRA="K=V ..." more environment for the game
#
# The build dir is a cochons/ native build without the debug tools (they are
# off in the browser too): cmake -DPSX_DEBUG_TOOLS=OFF, as cochons/build-prod.
# An X display is needed even though nothing is shown (DISPLAY, e.g. Xvfb).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
G=$(cd "$1" && pwd); REC=$2; W=$3; END=${4:-}
rm -rf "$W"; mkdir -p "$W/wd/mods" "$W/wd/saves"
python3 "$HERE/rec2script.py" "$REC" "$W/session" || exit 1
[ -n "$END" ] || END=$(( $(tail -1 "$W/session.script" | cut -d' ' -f1) / 600 * 600 ))
CPUS=$(head -1 "$W/session.script" | sed 's/.*"cpus": \([0-9]*\).*/\1/')
# The game's own files, linked; its settings, mods and saves are this run's.
for f in "$G"/*; do
  b=$(basename "$f")
  case $b in settings.toml|saves|mods|game.toml|cache|extracted|CMakeFiles|_deps|pgo|*.ninja|*.log|*.json|*.cmake|*.c) ;;
    *) ln -s "$f" "$W/wd/$b";; esac
done
ln -s "$G/mods/bundled" "$W/wd/mods/bundled"
sed 's/^native_wide = false$/native_wide = true\nnw_backdrop = true\nnw_flat_backdrop = true\nnw_phase_backdrop = true/' "$G/game.toml" > "$W/wd/game.toml"
A=${ASPECT:-32:9}
cat > "$W/wd/mods/state.toml" <<T
format_version = 2

[[package]]
id = "psx.enhancement.cpu-overclock"

[[package]]
id = "frontschweine.enhancement.ntsc-60hz"

[[package]]
id = "frontschweine.presentation.widescreen"

[[package]]
id = "frontschweine.online.direct-start"

[[feature]]
package_id = "frontschweine.online.direct-start"
id = "direct-start"
enabled = true

[[feature]]
package_id = "psx.enhancement.cpu-overclock"
id = "cpu-overclock"
enabled = true
[feature.values]
percent = "100"

[[feature]]
package_id = "frontschweine.enhancement.ntsc-60hz"
id = "ntsc-60hz"
enabled = false

[[feature]]
package_id = "frontschweine.presentation.widescreen"
id = "widescreen"
enabled = true
[feature.values]
aspect = "$A"
T
printf '[video]\nrenderer = "software"\nadaptive_view = false\naspect_ratio = "%s"\nsupersampling = 1\nfullscreen = 0\nvsync = "off"\n\n[audio]\nvolume = 100\n' "$A" > "$W/wd/settings.toml"
PRELOAD=
if [ -n "${PROF:-}" ]; then
  gcc -O2 -shared -fPIC -o "$W/libprof.so" "$HERE/prof.c" || exit 1
  PRELOAD="LD_PRELOAD=$W/libprof.so PROF_OUT=$W/prof"
fi
cd "$W/wd" || exit 1
TIMEFORMAT='%U %S'
{ time env PSX_NO_LAUNCHER=1 PSX_HEADLESS=1 SDL_AUDIO_DRIVER=dummy PSX_OVERLAY_AUTOCOMPILE_OFF=1 \
    PSX_WEB_MODE=multi PSX_WEB_PLAYERS=1 PSX_WEB_CPUS="$CPUS" \
    PSX_LOCKSTEP_SCRIPT="$W/session.script" PSX_LOCKSTEP_DIGEST="$W/digest.txt" \
    PSX_LOCKSTEP_DIGEST_EVERY=600 PSX_LOCKSTEP_END="$END" \
    ${UNPACED:+PSX_LOCKSTEP_UNPACED=1} ${EXTRA:-} $PRELOAD \
    ./"$(cat "$G"/psxrecomp_exe_name-psx-runtime.txt 2>/dev/null || echo Cochons_de_Guerre)" > "$W/log.txt" 2>&1 ; } 2> "$W/time.txt"
rc=$?
same=0; diff=0; first=
while read -r f h; do
  g=$(awk -v f="$f" '$1==f {print $2}' "$W/digest.txt" 2>/dev/null)
  [ -z "$g" ] && continue
  if [ "$g" = "$h" ]; then same=$((same+1)); else diff=$((diff+1)); [ -z "$first" ] && first=$f; fi
done < "$W/session.hashes"
echo "exit $rc, $END frames, CPU $(awk '{printf "%.1f", $1+$2}' "$W/time.txt") s; digests: $same equal to the recording, $diff different${first:+ (first at frame $first)}"
[ -n "${PROF:-}" ] && echo "profile: python3 $HERE/sym.py $W/prof $G/<binary> [--func NAME]"
[ "$rc" = 0 ] && [ "$diff" = 0 ] && [ "$same" -gt 0 ]
