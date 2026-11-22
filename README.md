# Cochons de Guerre Online

The PlayStation game **Hogs of War** (*Cochons de Guerre*, Infogrames, 2000),
playable online with friends in the browser.

The project is based on the **French disc** of the game (PAL release, serial
**SLES-02766**), and only on that disc. Its code is translated to C by static
recompilation ([psxrecomp](https://github.com/RetroPortingToolKit/psxrecomp)),
then compiled to WebAssembly. Each player runs the game in their browser: the
PlayStation AI and the French text, voices and sounds are those of the disc.
The server sends the disc to the browsers and relays the players' inputs; the
players run in lockstep, so every browser computes exactly the same game.

On top of the original game: wide displays from 4:3 to 32:9 (each player has
their own screen shape), instant loading and a faster enemy AI.

## Getting started

You need your own copy of the **French disc**: the `.cue` file, its three
`.bin` tracks and the `.sbi` file, or a `.zip` archive that holds them. The
`.sbi` is required: the French disc is LibCrypt-protected and, without this
file, the game does not behave like the original. No other release of the
game is accepted (the disc is checked).

```bash
git clone --recurse-submodules https://github.com/V1ck3s/hogs-of-war-web.git
cd hogs-of-war-web
# put your disc in the disc/ folder
./start.sh
```

Then open **http://localhost:8090**, create a room and send the invitation
link to your friends (to play outside your network, port 8090 must be
reachable from the Internet).

`start.sh` does the rest and only redoes what is missing or has changed:

1. extracts the disc if it is in a `.zip` archive;
2. installs missing system packages (it asks before using `sudo apt-get`)
   and, once, Emscripten (about 2 GB, in `.cache/emsdk`);
3. checks the disc, makes a working copy of it in `cochons/disc/` and
   translates the game code to C (`cochons/generated/`);
4. compiles the game to WebAssembly (`cochons/build-web/`), including the code
   the game loads during play, rebuilt from the disc
   (`cochons/tools/build_caps.py`);
5. prepares the files sent to the browsers (`online/game/`) and starts the
   server.

The first run takes 20 minutes to an hour depending on the machine. If the
script is interrupted, run it again: it picks up where it stopped. After that,
it starts the server in a few seconds.

System: Linux (tested on Debian 13), at least 2 GB of memory and about 6 GB of
disk space. The packages used are `git python3 cmake ninja-build clang nodejs
npm xz-utils bzip2` (Python 3.11 and Node.js 18 or newer).

Useful variables: `PORT` (8090), `HOST` (0.0.0.0), `CDG_JOBS` (parallel
compile jobs; by default from the memory size), `EMSDK` (an Emscripten
already installed), `CDG_BUILD_ONLY=1` (prepare everything without starting
the server), `CDG_YES=1` (install packages without asking).

## Repository layout

| Folder | Role |
|---|---|
| `cochons/` | recompilation settings for the French disc (addresses, patches, mods) |
| `online/` | game server and web page (lockstep, disc streaming, tests) |
| `psxrecomp/` | the recompilation and runtime engine (submodule, `psxrecomp` branch of this repository) |
| `web/`, `stream/` | earlier experiments (in-browser emulation, video streaming), superseded by `online/` |

The `disc/`, `cochons/disc/`, `cochons/generated/`, `cochons/build*/`,
`online/game/` and `.cache/` folders are produced from your disc and are never
committed.

## Legal

This repository contains no game data: no disc image, no executable code and
no assets of the original game, and no PlayStation BIOS (the open-source
OpenBIOS bundled with psxrecomp is used). The translated code is produced on
your machine from your own disc.

*Hogs of War* and *Cochons de Guerre* are trademarks of their respective
owners; PlayStation is a trademark of Sony Interactive Entertainment. This is
an unofficial, non-commercial fan project and is not affiliated with or
endorsed by any of them.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE): you may use, change and
share this project for any non-commercial purpose. The psxrecomp framework is
licensed separately under the same terms by its author.

## Credits

- [psxrecomp](https://github.com/RetroPortingToolKit/psxrecomp) by Matthew
  Stanley and the RetroPortingToolKit team, PolyForm Noncommercial 1.0.0
