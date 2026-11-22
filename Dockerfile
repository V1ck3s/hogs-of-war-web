# syntax=docker/dockerfile:1
#
# Cochons de Guerre Online: the tools, without any game data.
#
# The image holds the build tools (Emscripten, the prebuilt psxrecomp
# recompiler, the game server) and this repository's sources. It contains no
# part of the game: on its first start the container builds the game from the
# disc mounted at /app/disc (see docker-compose.yml) and keeps everything it
# produces in the /data volume, so later starts take seconds.
FROM debian:trixie-slim

ARG EMSDK_VERSION=7.0.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git python3 cmake ninja-build clang lld make \
      nodejs npm xz-utils bzip2 \
 && rm -rf /var/lib/apt/lists/*

# Emscripten, the version start.sh expects. Its build cache (system libraries,
# SDL2 port) goes to the volume, so it is built once per volume.
RUN git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk \
 && /opt/emsdk/emsdk install "$EMSDK_VERSION" \
 && /opt/emsdk/emsdk activate "$EMSDK_VERSION" \
 && rm -rf /opt/emsdk/downloads /opt/emsdk/.git
ENV EMSDK=/opt/emsdk \
    EM_CACHE=/data/emcache

WORKDIR /app
COPY . .

# Game server dependencies, and the recompiler (built from psxrecomp's
# sources; `generate` reuses it).
RUN cd online && npm install --omit=dev --no-audit --no-fund \
 && cd /app && python3 psxrecomp/psxrecomp_cli.py ensure-emitters --project-root cochons

# Everything produced from the disc lives in the volume.
RUN set -e; \
    for link in cochons/disc:cochons-disc cochons/generated:generated cochons/build-web:build-web \
                cochons/.cache:cochons-cache online/game:game online/recordings:recordings .cache:cache; do \
      rm -rf "/app/${link%%:*}"; ln -s "/data/${link#*:}" "/app/${link%%:*}"; \
    done; \
    chmod +x /app/start.sh /app/docker/entrypoint.sh

VOLUME /data
EXPOSE 8090
ENV HOST=0.0.0.0 PORT=8090
ENTRYPOINT ["/app/docker/entrypoint.sh"]

LABEL org.opencontainers.image.title="Cochons de Guerre Online" \
      org.opencontainers.image.description="Hogs of War (Cochons de Guerre, French PS1 release) online in the browser. Bring your own disc." \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
