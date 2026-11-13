# Cochons de Guerre Recompiled (SLES-02766)

Native Linux recompilation of the **French** PlayStation release of *Hogs of
War* (*Les Cochons de Guerre*, SLES-02766), built on the same `psxrecomp`
framework as Frontschweine (the German release) and running its game code
natively: PS1 AI, French text, voices and sounds. It is the program the
streaming server (`../stream`) runs.

## What comes from Frontschweine

The French and German EXEs are identical up to `0x80046000`, then shifted by
`+0x30` / `+0x60` (comparison of the JAL-target seed lists). So the
following are reused as-is:

- `overlay_region_floor = 0x18000` and the widescreen settings (addresses below
  the shift);
- the mods: **Instant Loading**, **CPU Overclock** (busy-waits), **60 Hz Mode**,
  **Widescreen** — here in an *adaptive* mode (the window shape sets the field
  of view from 4:3 to 21:9, which the streaming server uses). *Fast Enemy AI* is
  not ported (its battle-module address differs in the French version);
- the AOT profile of runtime-loaded modules (`aot/overlays.json`): hashes
  recomputed from the French disc, `CHARS/ANIMS/MCAPX.MAD` entry points
  **measured** in a French battle (`dirty_ram_stats`), front-end module entries
  relocated (`tools_rehash_aot.py`).

The rest of the code the game loads at runtime is compiled to native in the
background (`autocompile.sh`, gcc) and cached in `build/cache/`.

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

Dependencies: `cmake ninja-build clang pkg-config libgl-dev libegl-dev
libx11-dev libxext-dev libxrandr-dev libxcursor-dev libxi-dev libxss-dev
libxtst-dev libxkbcommon-dev libwayland-dev libpulse-dev libasound2-dev`.
`PSX_DEBUG_TOOLS=ON` enables the local control port (localhost) the
streaming server uses to drive controller 1.

`disc/`, `generated/`, `build/` and `.cache/` come from your disc and are
never committed.
