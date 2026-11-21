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

# The main executable recompiles into a few enormous functions (one file is a
# single function of 300,000 lines) and takes about 1 % of the run time: the
# game lives in the modules it loads. With the cycle helpers' settled test at
# every instruction those files took the optimizer tens of minutes and over a
# gigabyte each; with the interlock written out (psx_cyc.h) and the I-cache
# fetch left as a call (psx_icache.h) it folds them in seconds, into less code.
file(GLOB _cochons_main_exe_c CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/generated/SLES_027.66_full_*.c")
if(_cochons_main_exe_c)
    set_source_files_properties(${_cochons_main_exe_c} PROPERTIES
        COMPILE_DEFINITIONS "PSX_CYC_WRITTEN_OUT=1;PSX_ICACHE_FETCH_CALL=1")
endif()

# Frontschweine's game-owned plugins, retargeted to the French release.
# Fast Enemy AI: French routine located at 0x8006ADA0 (battle module loaded
# 0x30 higher than in SLES-02767) and proven equivalent (tests/terrain_line_equiv.c).
target_sources(psx-runtime PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/instant_loading.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/ntsc_60hz.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/busy_waits.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/widescreen.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/terrain_line.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/direct_start.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/view_cone.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/scope_view.c")

foreach(_PSX_RUNTIME_CONFIG game.toml)
    add_custom_command(TARGET psx-runtime POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/${_PSX_RUNTIME_CONFIG}"
            "$<TARGET_FILE_DIR:psx-runtime>/${_PSX_RUNTIME_CONFIG}"
        VERBATIM)
endforeach()

# Online (WebAssembly lockstep) build: real turn ownership in battles.
if(EMSCRIPTEN)
    target_sources(psx-runtime PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/mods/plugins/turn_owner.c")
endif()

# Code the game loads outside the AOT profile's modules, compiled ahead of
# time from runtime captures and chained behind the AOT dispatcher
# (tools/merge_static_overlays.py). Needed by the WebAssembly build, which
# cannot compile at run time; harmless natively. Built here from the disc
# (cochons/disc/*.cue, or -DCOCHONS_DISC=<cue>) and aot/captures.json when
# missing or out of date: tools/build_caps.py. A later `generate` rewrites the
# generated files (which cannot be configure dependencies here): run cmake again
# after it, which re-chains the units in seconds.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/generated/overlays_static.c")
    find_program(COCHONS_PYTHON NAMES python3 python NO_CMAKE_FIND_ROOT_PATH REQUIRED)
    set(_cochons_caps_cmd "${COCHONS_PYTHON}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/build_caps.py")
    if(COCHONS_DISC)
        list(APPEND _cochons_caps_cmd --disc "${COCHONS_DISC}")
    endif()
    execute_process(COMMAND ${_cochons_caps_cmd} RESULT_VARIABLE _cochons_caps_rc)
    if(_cochons_caps_rc EQUAL 2)
        message(WARNING "No disc in cochons/disc: the capture units (generated/caps) "
                        "could not be built. The game runs, but the code they cover is "
                        "interpreted (much slower in the browser).")
    elseif(NOT _cochons_caps_rc EQUAL 0)
        message(FATAL_ERROR "tools/build_caps.py failed (${_cochons_caps_rc})")
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/aot/captures.json"
        "${CMAKE_CURRENT_SOURCE_DIR}/game.toml")
endif()
file(GLOB _cochons_caps_sources CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/generated/caps/*.c")
if(_cochons_caps_sources)
    target_sources(psx-runtime PRIVATE ${_cochons_caps_sources})
endif()
