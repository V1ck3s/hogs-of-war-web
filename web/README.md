# Cochons de Guerre — Web

Web port with online multiplayer of **Cochons de Guerre** (*Hogs of War*,
Infogrames, 2000), French PlayStation version (SLES-02766).

The browser runs the **original PS1 game code** in a virtual PlayStation
compiled to WebAssembly ([PCSX-ReARMed](https://github.com/libretro/pcsx_rearmed)
core and a custom frontend, `core/frontend.c`). Everything that makes the PS1
game is therefore kept exactly as it was:

- the PlayStation version's **artificial intelligence**;
- the **French text, briefings, voices and sounds** of the French disc;
- the music (CD audio tracks) and the cutscenes.

No game data is provided: each player loads **their own copy** of the disc,
which stays on their computer (the server never receives it).

## Quick start

```bash
cd web
npm install
npm start            # http://localhost:8080
```

Open the page, drop the disc files (`.cue` + `.bin`, a `.chd` image, or the
`.zip` archive directly) and play. The disc can be remembered in the browser
for later sessions.

The prebuilt WebAssembly core ships in `public/core/`. To rebuild it
(Emscripten required):

```bash
source /path/to/emsdk/emsdk_env.sh
npm run build:core   # clones PCSX-ReARMed (pinned commit) and produces psx.js/psx.wasm
```

## Online multiplayer

Multiplayer uses **deterministic lockstep**: each player runs their own
console from the same state, and only controller inputs travel over the
network (a few bytes per frame). Picture and sound therefore stay perfect
for everyone, even on a modest connection.

1. The host clicks **Create a room** and shares the 4-letter code (or the
   link from "Copy link").
2. Each friend loads their disc, then **Join** with the code. The host sends
   the state of their console to the newcomer (about 1 MB compressed) and
   everyone resumes in sync, even in the middle of a game.
3. In the game: **MULTIJOUEUR**, set one **JOUEUR 1…4** slot per
   participant (the others on CPU or OFF).

Cochons de Guerre is played **turn by turn on controller 1** (verified: on
player 2's turn, controller 1 is in command). All participants therefore
share controller 1 by default, with deterministic arbitration: whoever is
playing keeps it, and after 2 seconds without input the next player to press
a button takes it. The host can also assign other controllers or make
someone a spectator.

Host settings:

- **Network delay** (1 to 12 frames, 4 by default = 80 ms): raise it if the
  game stutters with distant players. Since the game is turn-based, a high
  delay stays comfortable.
- **Game speed**: ×1.5 to ×3 for the whole room, handy during the AI's long
  thinking.

At each sync, the host reloads the very state it sends: PCSX-ReARMed
savestates do not record everything (in-flight CD reads, for example), so
everyone restarts from exactly the same bytes.

Desync safety net: every 250 frames, each console sends a hash of its RAM to
the host; on a mismatch, the host automatically resyncs the whole room.

Requirement: all players must have **the same version of the disc**
(fingerprint checked when joining the room).

## Controls

| PlayStation | Keyboard (default) |
|---|---|
| Cross / Circle / Square / Triangle | X / C / S / D |
| L1 / R1 / L2 / R2 | E / R / F / G |
| Start / Select | Enter / Backspace |
| D-pad | Arrows |

Keys can be remapped (**Keys** button). USB or Bluetooth gamepads are
detected automatically. Solo: hold **Tab** = fast-forward (useful during AI
turns), **F2/F4** = save/load state, **F11** = fullscreen. The memory card
is saved automatically in the browser.

## LibCrypt protection (optional)

The PAL disc is protected by LibCrypt. If you have the `.sbi` file matching
your disc, add it to the selection (it is renamed automatically to go with
the `.cue`). Without it the game boots and plays normally in our tests.

## Deployment

The server (`server/server.mjs`) serves the static files and relays room
messages over WebSocket (`/ws`). Variables: `PORT` (8080), `HOST`
(0.0.0.0). Behind an HTTPS proxy, forward the `Upgrade` header for `/ws`;
the page automatically uses `wss://` over HTTPS.

```bash
docker build -t cochons-web web/
docker run -p 8080:8080 cochons-web
```

## Tests

```bash
npm test                                          # lockstep engine (unit tests)
node tests/determinism.mjs "../disc-fr/<game>.cue" # 2 consoles, same inputs => same RAM
node tests/sync-sweep.mjs "../disc-fr/<game>.cue" 1 # fidelity of sync states
node tests/netplay-sim.mjs "../disc-fr/<game>.cue" [state] # simulated lockstep, random latency
node tests/e2e.mjs ../disc-fr                     # Chromium: solo + 2-player network game
node tools/headless.mjs "<game>.cue" --frames 3000 --shot-every 100 --out captures
node tools/headless.mjs "<game>.cue" --frames 4200 --out captures --wav intro.wav --wav-from 1400  # audio
```

Voice check: the intro cutscene audio recorded this way (then converted to
16 kHz mono) was transcribed with whisper.cpp (`small` model): detected
language **French (p = 0.98)**, for example « La truffe, c'est la force du
porc qui contrôle la truffe, contrôle le monde ! ». In battle: « Tiens !
Mouille le maillot ! ».

```bash
# (end of examples)
```

## Architecture

```
public/
  index.html, css/            user interface
  js/app.js                   main loop, audio, video, room
  js/worker.js                Web Worker: PS1 core (the disc is mounted with WORKERFS, no copy)
  js/lockstep.js              lockstep input engine + shared controller arbitration
  js/net.js                   WebSocket client, sync packets (gzip)
  js/disc.js                  CUE/BIN, CHD, ZIP (streamed decompression), disc fingerprint
  js/input.js                 keyboard (physical positions, AZERTY/QWERTY) and gamepads
  js/audio-worklet.js         44.1 kHz audio output
  core/psx.js, psx.wasm       virtual PlayStation (generated by core/build.sh)
server/server.mjs             static files + rooms + relay
core/frontend.c               minimal libretro frontend exported to JavaScript
tools/headless.mjs            browserless run (Node): screenshots, states, RAM
```

## Legal

Unofficial, non-commercial fan project. *Hogs of War* / *Cochons de
Guerre* are trademarks of their rights holders; PlayStation is a trademark
of Sony Interactive Entertainment. PCSX-ReARMed is distributed under the
GPLv2; the compiled core `public/core/psx.wasm` derives from it and remains
under that licence (sources: <https://github.com/libretro/pcsx_rearmed>,
plus `core/frontend.c`).
