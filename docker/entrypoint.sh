#!/bin/sh
# Container start: the volume's folders, then start.sh (build from the disc
# in /app/disc if needed, then the server).
set -e
for d in cochons-disc generated build-web cochons-cache game recordings cache emcache; do
    mkdir -p "/data/$d"
done
if [ -z "$(find /app/disc -maxdepth 2 \( -iname '*.cue' -o -iname '*.zip' \) -print -quit 2>/dev/null)" ]; then
    echo "No disc found. Put your French Cochons de Guerre disc (SLES-02766: the .cue, its .bin" >&2
    echo "tracks and its .sbi, or a .zip that holds them) in the disc/ folder next to" >&2
    echo "docker-compose.yml, then start the container again." >&2
    exit 1
fi
exec /app/start.sh "$@"
