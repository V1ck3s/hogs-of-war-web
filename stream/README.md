# Cochons de Guerre — online (streaming)

**Cochons de Guerre** (*Hogs of War*, Infogrames, 2000) in its **French
PlayStation version**, played in the browser **without owning the game**:
it runs on the server and is streamed as video to the players, who play with
the keyboard (or a gamepad), alone or **together, remotely**.

## What runs on the server

This is not a PlayStation emulator. The game is the **static
recompilation** of the French PS1 version (SLES-02766), built with the same
framework and the same settings as this repository's Frontschweine project
(`psxrecomp`): the game's MIPS code is translated to C and compiled into a
native Linux program. The game logic therefore runs natively:

- **PS1 AI**, rules, physics: the PlayStation version's code (not the PC
  version's), running natively;
- **French text, briefings, voices and sounds**: those of the French disc;
- modern rendering: OpenGL, internal resolution ×1 to ×3 (480p/720p/1080p),
  widescreen (psxrecomp's "widescreen hack") adapted **to any screen shape**
  from 4:3 to 32:9 (super-ultrawide, e.g. 5120x1440);
- the code the game loads during play (battle modules, FMV player) is
  **compiled to native code in the background** (gcc) and cached.

```
browser ──WebSocket──► stream/server ──► native game (Xvfb + OpenGL, PulseAudio)
   ▲  H.264 + Opus (WebCodecs)             │ x11grab → x264 (zerolatency)
   └────────────────────────────────────── │ game SPU output → Opus 20 ms
        pad state (keyboard) ─────────────► runtime TCP control port (controller 1)
```

## Playing

1. Open the server's address, enter a name, **Start a game**.
2. Share the room code (or use the **Copy invite link** button).
3. Friends open the link: same picture, same sound, nothing to install.
4. In the game: **MULTIJOUEUR**, one **JOUEUR** slot per participant.

Cochons de Guerre is played **turn by turn on controller 1** (each team plays
its turn on the same controller, as on PlayStation). The room shares that
controller: whoever is playing keeps it; after 2 seconds without input, the
next player to press a button takes it. The panel (Esc) shows who has the
controller.

| PlayStation | Keyboard |
|---|---|
| D-pad | Arrows |
| Cross / Circle / Square / Triangle | X (or Space) / C / S / D |
| L1 / R1 / L2 / R2 | E / R / F / G |
| Start / Select | Enter / Backspace |

Keys can be remapped (**Keys** button); USB/Bluetooth gamepads are detected.
Esc: room panel · T: chat · F11: fullscreen.

**Any screen**: the picture fills the window whatever its size, resolution
or shape (16:9, 21:9, 32:9, 4:3, 16:10, portrait — letterboxed when needed),
sharp on high-density displays. The host's screen sets the field of view: on
a 21:9 or 32:9 screen the game shows a wider battlefield (no stretching; the
2D menus stay 4:3 in the centre). At 32:9, measured on this GPU-less server
at 360p: battles run at 44 Hz instead of 50 (the wider field costs more to
render). The host also picks the quality (480p, 720p, 1080p) and can **speed
up** the CPU teams' turns.

## Installing the server

Requirements (Debian/Ubuntu): `nodejs` (≥ 20), `ffmpeg`, `xvfb`, `xdotool`,
`pulseaudio`, `mesa` (or a GPU), and a build of the game:

```bash
# 1. build the French game (from your own disc, never committed)
python3 psxrecomp/psxrecomp_cli.py generate --project-root cochons --config cochons/game.toml \
        --disc "/path/Cochons de Guerre, Les (France).cue"
cmake -S cochons -B cochons/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DPSX_DEBUG_TOOLS=ON -DPSX_REWIND=OFF -DPSX_ENABLE_VULKAN=OFF -DPSXRECOMP_REQUIRE_GAME_C=ON
ninja -C cochons/build psx-runtime
ln -s ../disc cochons/build/disc

# 2. streaming server
cd stream && npm install
CDG_TLS_CERT=cert.pem CDG_TLS_KEY=key.pem PORT=8443 npm start
```

`PSX_DEBUG_TOOLS=ON` is required: the server drives controller 1 through the
runtime's local TCP control port (listening on localhost only).

**HTTPS is required** outside `localhost`: browsers only allow video
decoding (WebCodecs) in a secure context. Provide a certificate
(`CDG_TLS_CERT` / `CDG_TLS_KEY`) or put the server behind an HTTPS proxy
(Caddy, nginx) that forwards `/ws` as a WebSocket.

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | 8090, 0.0.0.0 | listen address |
| `CDG_GAME_DIR` | `../cochons/build` | directory of the game executable |
| `CDG_GAME_BIN` | `Cochons_de_Guerre` | executable name |
| `CDG_MAX_ROOMS` | 1 | concurrent games (one game ≈ 1 CPU core + ~800 MB) |
| `CDG_AUTOCOMPILE` | `../cochons/autocompile.sh` | background native compilation |
| `LIBGL_ALWAYS_SOFTWARE` | 1 | 0 to use the server's GPU |
| `CDG_SSAA` | auto | internal resolution ×1..×4 (auto: follows the quality with a GPU, ×1 with software rendering) |
| `CDG_AUDIO_SOURCE` | `spu` | `spu`: samples read directly from the game's SPU output (no silence inserted even when the server falls behind); `pulse`: sound card capture (PulseAudio) |
| `CDG_RENDERER` | `opengl` | `software`: the runtime's software PS1 renderer (server without a GPU) |
| `CDG_OVERCLOCK` | 200 | emulated CPU speed in % (100 = original); at 200 % busy-waits are short-circuited |
| `CDG_60HZ` | 1 | Frontschweine's 60 Hz mode (battles at 30 fps instead of 25); 0 = original 50 Hz PAL |

### Production mode (real time)

To go live, build the game **without debug tools and with PGO**
(profile-guided optimisation): the server then drives controller 1 with
XTest keyboard events in the virtual display (no control port) and captures
the sound through PulseAudio.

```bash
cd cochons
CC=clang CXX=clang++ cmake -S . -B build-prod -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DPSX_DEBUG_TOOLS=OFF -DPSX_PGO=generate -DPSX_REWIND=OFF -DPSX_ENABLE_VULKAN=OFF -DPSXRECOMP_REQUIRE_GAME_C=ON
ninja -C build-prod psx-runtime
ln -s ../disc build-prod/disc; ln -s ../build/extracted build-prod/extracted; ln -s ../build/cache build-prod/cache
# training: run the game (intro, menus, a battle) then quit it (Ctrl+C), LLVM_PROFILE_FILE=pgo/xxx.profraw
llvm-profdata merge -o build-prod/pgo/default.profdata build-prod/pgo/*.profraw
cmake -S . -B build-prod -DPSX_PGO=use && ninja -C build-prod psx-runtime
cc -O2 ../stream/native/xkeys.c -o ../stream/native/xkeys -lX11 -lXtst

# server
CDG_GAME_DIR=../cochons/build-prod CDG_RENDERER=software CDG_60HZ=0 CDG_OVERCLOCK=100 \
CDG_GAME_CPUS=0,1,2 CDG_AUX_CPUS=3 npm start
```

Measurements on the development machine (generic 1.8 GHz virtual CPU,
4 cores, no GPU), server-side game cadence during a streaming session with
two remote players (`tests/realtime-remote.mjs`, "Native PS1" quality
480×270):

| Phase | Cadence (50 Hz target) |
|---|---|
| Intro cutscene, training film | 49.8 – 50.1 Hz |
| Title screen, battle (demo mode) | 49.9 – 50.1 Hz |
| Main menu (keys pressed) | 47.9 – 50.0 Hz |
| **Average over 195 s** | **49.92 Hz** |

Video received at 49.9 fps, 179.8 s of sound received for 180 s. With two
real Chromium browsers (host + guest) decoding and displaying the stream on
the same machine (`tests/realtime.mjs`, 270p): 50.03 Hz on average (minimum
49.7), 50.1 fps and 181 s of sound received by the guest, 0 audio playback
underruns; the sound decoded by its browser transcribes as French
(p = 0.98). The 60 Hz mode does not reach real time on this machine (52 Hz
measured in battle out of 60): use `CDG_60HZ=0` on a modest server. Without
these optimisations (debug build, software OpenGL) the same machine topped
out at ~15 Hz in battle. With a GPU (`LIBGL_ALWAYS_SOFTWARE=0`,
`CDG_RENDERER=opengl`) the 720p/1080p qualities render the scene at ×2/×3
internal resolution.

The `e2e.mjs` and `playthrough.mjs` tests use the debug build
(`cochons/build`) to read the real controller state inside the game.

## Tests

```bash
npm test                       # H.264/Ogg parsers, controller arbiter
node tests/e2e.mjs             # Chromium: room, decoded video + sound, keyboard → game, 2 players
node tests/playthrough.mjs out # full game by keyboard through the stream (21:9), the guest plays in battle
node tests/voices.mjs player.wav 240  # sound decoded by the player's browser during the intro
```

Checking the voices on the player's side: `tests/voices.mjs` records the
Opus decoded by the browser; transcribed with whisper.cpp (`small`), detected
language **French**, for example: « La truffe c'est la force du porc qui
contrôle la truffe, contrôle le monde… nous allons regarder ensemble des
petits films très bien fichus pour mieux comprendre les enjeux de cette
guerre ! ».

```bash
# (end)
```

## Legal

Unofficial, non-commercial fan project. *Hogs of War* / *Cochons de
Guerre* belong to their rights holders. The repository contains no game
data: the server operator builds the game from **their own disc**. Keep the
server for your own use and your friends'.
