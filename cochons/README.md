# Cochons de Guerre Recompiled (SLES-02766)

Recompilation of the **French** PlayStation release of *Hogs of War* (*Les
Cochons de Guerre*, PAL, SLES-02766), and only of that disc: every address,
patch and hash here was measured on it. It runs the game's own code: PS1 AI,
French text, voices and sounds. The online game (`../online`) is its
WebAssembly build; `../start.sh` builds everything from the disc.

## Game-specific settings

- `overlay_region_floor = 0x18000` and the widescreen settings;
- the mods: **Instant Loading**, **CPU Overclock** (busy-waits; the FMV retry
  loop is at `0x8005BFD0`, measured in RAM), **60 Hz Mode**, **Widescreen**
  in an *adaptive* mode (the window shape sets the field of view from 4:3 to
  32:9) and **Fast Enemy AI**: the battle module `LOAD/L640V2.MGL` loads at
  `0x8005B3D0`, so the AI's terrain line walk is at `0x8006ADA0` with its
  tile table at `0x80078698`. The native hook is proven equivalent to the
  game's own routine by `tests/terrain_line_equiv.c` (real routine from the
  battle RAM run in a MIPS interpreter vs the hook: 40 000 random lines, 0
  differences in return value, registers and RAM; a deliberately wrong hook
  is caught every time);
- the AOT profile of runtime-loaded modules (`aot/overlays.json`): hashes
  from the French disc, `CHARS/ANIMS/MCAPX.MAD` and `LOAD/L640V2.MGL` entry
  points **measured** in a French battle (`dirty_ram_stats`);
- the disc is LibCrypt-protected: its `.sbi` companion is required (setup
  stops without it).

```bash
# equivalence proof of the Fast Enemy AI hook (needs a 2 MB battle RAM dump,
# e.g. the runtime's read_ram 0x80000000 0x200000 during a battle)
cc -O2 -Icochons/tests/stubs cochons/tests/terrain_line_equiv.c -o equiv && ./equiv battle_ram.bin 40000
```

The rest of the code the game loads at runtime is compiled ahead of time too
(`generated/caps/`, needed by the WebAssembly build, which cannot compile at
run time). It comes from captures of real play, but only their addresses are
committed (`aot/captures.json`): the code itself is read back from your disc
(`tools/capture_manifest.py`, CRC-checked). CMake builds these units by itself
at configure time when they are missing or out of date and the disc is in
`cochons/disc/` (`tools/build_caps.py`, about a minute). Code no unit covers is
compiled to native in the background (`autocompile.sh`, gcc) and cached in
`build/cache/`.

## Build (Linux)

```bash
# from the repository root, with your own disc
python3 psxrecomp/psxrecomp_cli.py generate --project-root cochons --config cochons/game.toml \
        --disc "/path/Cochons de Guerre, Les (France).cue"
CC=clang CXX=clang++ cmake -S cochons -B cochons/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DPSX_DEBUG_TOOLS=ON -DPSX_REWIND=OFF -DPSX_ENABLE_VULKAN=OFF -DPSXRECOMP_REQUIRE_GAME_C=ON
ninja -C cochons/build psx-runtime
ln -s ../disc cochons/build/disc && mkdir -p cochons/build/extracted
```

`generate` copies the disc into `cochons/disc/`, where the `cmake` step finds
it to build the capture units. After running `generate` again, run `cmake`
again too (it chains the units back behind the rewritten dispatcher).

Dependencies: `cmake ninja-build clang pkg-config libgl-dev libegl-dev
libx11-dev libxext-dev libxrandr-dev libxcursor-dev libxi-dev libxss-dev
libxtst-dev libxkbcommon-dev libwayland-dev libpulse-dev libasound2-dev`.
`PSX_DEBUG_TOOLS=ON` enables the local control port (localhost) the
streaming server uses to drive controller 1.

`disc/`, `generated/`, `build/` and `.cache/` come from your disc and are
never committed.
