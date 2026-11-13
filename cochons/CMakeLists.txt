cmake_minimum_required(VERSION 3.20)
# Cochons de Guerre (French PS1 release, SLES-02766) built on the same
# psxrecomp framework and Frontschweine project tuning as the German build.
set(PSXRECOMP_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/psxrecomp" CACHE PATH "Path to psxrecomp")
project(CochonsDeGuerreRecomp LANGUAGES C CXX)

set(PSX_RECOMP_UI OFF CACHE BOOL "Headless server build: no launcher UI" FORCE)
include("${PSXRECOMP_ROOT}/runtime/runtime.cmake")

set(PSX_PRELOADED_MODS "${CMAKE_CURRENT_SOURCE_DIR}/mods/preloaded")
if(NOT IS_DIRECTORY "${PSX_PRELOADED_MODS}")
    set(PSX_PRELOADED_MODS "NONE")
endif()

psxrecomp_add_game_runtime(psx-runtime
    PRELOADED_MODS_DIR "${PSX_PRELOADED_MODS}"
    WINDOW_TITLE "Cochons de Guerre"
    DEFAULT_GAME_CONFIG_PATH "game.toml"
    MAX_PLAYERS 2
    # Battle modules the game decompresses at runtime, compiled ahead of time
    # from the disc by `generate` (aot/overlays.json, French profile).
    GAME_OVERLAY_STATIC_C "${CMAKE_CURRENT_SOURCE_DIR}/generated/overlays_static.c"
    GEN_MARKER "generated/SLES_027.66_dispatch.c"
    # Instant Loading takes over every data load (as in Frontschweine).
    EXCLUDE_BUILTIN_MODS
        psx.enhancement.cd-speed
        psx.enhancement.fast-loading
    GEN_FULL_GLOB "generated/SLES_027.66_full_*.c"
)

# Frontschweine's game-owned plugins, retargeted to the French release.
# (Fast Enemy AI is not ported: its battle-module address differs in SLES-02766.)
target_sources(psx-runtime PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/instant_loading.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/ntsc_60hz.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/busy_waits.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/widescreen.c")

foreach(_PSX_RUNTIME_CONFIG game.toml)
    add_custom_command(TARGET psx-runtime POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/${_PSX_RUNTIME_CONFIG}"
            "$<TARGET_FILE_DIR:psx-runtime>/${_PSX_RUNTIME_CONFIG}"
        VERBATIM)
endforeach()
