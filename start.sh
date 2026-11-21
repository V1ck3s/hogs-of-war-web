#!/usr/bin/env bash
# Cochons de Guerre en ligne : tout, à partir du seul CD.
#
#   1. mettez votre CD (le .cue et ses .bin, ou une archive .zip qui les
#      contient) dans le dossier disc/ ;
#   2. lancez ./start.sh
#
# Le script fait le reste et ne refait que ce qui manque ou a changé : outils
# (Emscripten), traduction du code du jeu à partir du CD, compilation
# WebAssembly, préparation des fichiers servis, puis il démarre le serveur
# (http://localhost:8090). Relancez-le après une interruption : il reprend où
# il s'était arrêté.
#
# Variables : PORT (8090), HOST (0.0.0.0), CDG_JOBS (compilations en
# parallèle, d'après la mémoire par défaut), EMSDK (un Emscripten déjà
# installé), CDG_BUILD_ONLY=1 (tout préparer sans démarrer le serveur),
# CDG_YES=1 (installer les paquets manquants sans demander).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
EMSDK_VERSION=7.0.0
COCHONS=$ROOT/cochons
BUILD=$COCHONS/build-web
MARKER=$COCHONS/generated/SLES_027.66_dispatch.c

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- le CD
mkdir -p disc
find_cue() { find "$1" -maxdepth 2 -iname '*.cue' -print 2>/dev/null | sort | head -n 1; }
find_sbi() { find "$1" -maxdepth 2 -iname '*.sbi' -print 2>/dev/null | sort | head -n 1; }
CUE=$(find_cue disc)
if [ -z "$CUE" ] || [ -z "$(find_sbi disc)" ]; then
    # Archives (.zip) : le CD et son .sbi, dans une seule archive ou plusieurs.
    for ZIP in disc/*.zip disc/*.ZIP; do
        [ -f "$ZIP" ] || continue
        say "Extraction de $ZIP"
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
[ -n "$CUE" ] || fail "aucun CD trouvé. Mettez dans disc/ le CD français de Cochons de Guerre
(SLES-02766) : le fichier .cue, ses pistes .bin et son .sbi, ou une archive .zip qui les contient."

# Le CD français est protégé (LibCrypt) : le .sbi (données de sous-canal
# fournies avec les copies du disque) est indispensable, sans lui le jeu ne se
# comporte pas comme l'original. Il doit porter le nom du .cue.
SBI="${CUE%.*}.sbi"
if [ ! -f "$SBI" ]; then
    other=$(find_sbi "$(dirname "$CUE")")
    [ -n "$other" ] || fail "le fichier .sbi du CD manque. Le CD français est protégé (LibCrypt) :
mettez dans disc/, à côté de « $(basename "$CUE") », le fichier .sbi de votre copie du disque."
    cp "$other" "$SBI"
fi

# ---------------------------------------------------------------- paquets système
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
        say "Paquets manquants : ${need[*]}"
        if [ "${CDG_YES:-}" != 1 ]; then
            read -r -p "Les installer avec sudo apt-get ? [O/n] " r
            case "$r" in [nN]*) fail "installez-les puis relancez ./start.sh";; esac
        fi
        sudo apt-get update && sudo apt-get install -y "${need[@]}"
    else
        fail "installez d'abord : ${need[*]}"
    fi
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || fail "Python 3.11 ou plus récent est nécessaire"
node -e 'process.exit(+process.versions.node.split(".")[0] < 18 ? 1 : 0)' || fail "Node.js 18 ou plus récent est nécessaire"

if [ -z "${CDG_JOBS:-}" ]; then
    mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    CDG_JOBS=$(( mem_mb / 900 )); [ "$CDG_JOBS" -ge 1 ] || CDG_JOBS=1
    [ "$CDG_JOBS" -le "$(nproc)" ] || CDG_JOBS=$(nproc)
fi

# ---------------------------------------------------------------- sources
if [ ! -f psxrecomp/psxrecomp_cli.py ] || [ ! -f psxrecomp/lib/recomp-net/CMakeLists.txt ]; then
    say "Récupération des sous-modules (moteur psxrecomp)"
    git submodule update --init --recursive
fi

# ---------------------------------------------------------------- Emscripten
if ! have emcc; then
    if [ -z "${EMSDK:-}" ]; then
        EMSDK=$ROOT/.cache/emsdk
        if [ ! -f "$EMSDK/upstream/.emsdk_version" ]; then
            say "Installation d'Emscripten $EMSDK_VERSION (une seule fois, environ 2 Go)"
            [ -d "$EMSDK/.git" ] || git clone https://github.com/emscripten-core/emsdk.git "$EMSDK"
            "$EMSDK/emsdk" install "$EMSDK_VERSION"
            "$EMSDK/emsdk" activate "$EMSDK_VERSION" >/dev/null
        fi
    fi
    # shellcheck disable=SC1091
    EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh"
fi

# ---------------------------------------------------------------- code du jeu
# generate vérifie le CD (version française uniquement), en fait une copie de
# travail dans cochons/disc/ et traduit le code du jeu en C dans
# cochons/generated/. À refaire quand le CD ou la configuration du jeu change.
stale_generate() {
    [ -f "$MARKER" ] || return 0
    [ -f "$COCHONS/disc/SLES_027.66" ] || return 0
    for f in "$COCHONS/game.toml" "$COCHONS/aot/overlays.json" "$COCHONS/symbols.toml"; do
        [ "$f" -nt "$MARKER" ] && return 0
    done
    return 1
}
if stale_generate; then
    say "Traduction du code du jeu à partir du CD (quelques minutes la première fois)"
    python3 psxrecomp/psxrecomp_cli.py generate --project-root cochons \
        --config cochons/game.toml --disc "$ROOT/$CUE"
fi

# La copie de travail du CD garde son .sbi (une copie faite avant que le .sbi
# soit fourni n'en a pas : generate la réutilise telle quelle).
WORK_CUE=$(find_cue "$COCHONS/disc")
[ -n "$WORK_CUE" ] || fail "generate n'a pas préparé de copie du CD dans cochons/disc/"
cmp -s "$SBI" "${WORK_CUE%.*}.sbi" || cp "$SBI" "${WORK_CUE%.*}.sbi"

# ---------------------------------------------------------------- compilation
# La configuration compile aussi, depuis le CD, le code que le jeu charge en
# cours de partie (cochons/tools/build_caps.py), s'il manque. Elle n'est
# lancée ici que la première fois et après une nouvelle traduction : ensuite,
# la compilation se reconfigure d'elle-même quand ses entrées changent (la
# relancer à chaque fois referait l'édition de liens).
if [ ! -f "$BUILD/build.ninja" ] || [ "$MARKER" -nt "$BUILD/build.ninja" ]; then
    say "Configuration de la compilation WebAssembly"
    mkdir -p .cache
    emcmake cmake -S cochons -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DPSX_SDL_BACKEND=SDL2 -DPSX_DEBUG_TOOLS=OFF -DPSX_REWIND=OFF \
        -DPSX_VULKAN=OFF -DPSX_NETPLAY=OFF > "$ROOT/.cache/configure-web.log" 2>&1 \
        || { tail -n 40 "$ROOT/.cache/configure-web.log"; fail "la configuration a échoué (journal : .cache/configure-web.log)"; }
    grep -E '^(capture units|building the capture)|CMake Warning.*capture' "$ROOT/.cache/configure-web.log" || true
fi

say "Compilation du jeu ($CDG_JOBS en parallèle ; 20 à 60 minutes la première fois)"
cmake --build "$BUILD" -j "$CDG_JOBS"

# ---------------------------------------------------------------- fichiers servis
cd online
if [ ! -d node_modules/ws ]; then
    say "Dépendances du serveur"
    npm install --omit=dev --no-audit --no-fund
fi
if [ ! -f game/files.json ] || [ "$BUILD/Cochons_de_Guerre.wasm" -nt game/files.json ] \
   || [ "$BUILD/game.toml" -nt game/files.json ] \
   || [ -n "$(find "$COCHONS/disc" -newer game/files.json -print -quit)" ]; then
    say "Préparation des fichiers envoyés aux navigateurs"
    node tools/prepare.mjs
fi

[ "${CDG_BUILD_ONLY:-}" = 1 ] && { say "Prêt. Démarrez le serveur avec ./start.sh"; exit 0; }
say "Serveur : http://localhost:${PORT:-8090}  (Ctrl+C pour l'arrêter)"
exec node server/index.mjs
