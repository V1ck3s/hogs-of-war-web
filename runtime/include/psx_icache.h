#ifndef PSXRECOMP_PSX_ICACHE_H
#define PSXRECOMP_PSX_ICACHE_H

#include "cpu_state.h"

#ifdef __cplusplus
extern "C" {
#endif

extern uint32_t g_psx_icache_tv[1024];
extern int g_psx_icache_active;
extern int g_ls_replay_active;
void psx_icache_reset(void);
void psx_icache_fetch(CPUState *cpu, uint32_t addr);
void psx_icache_fetch_miss(CPUState *cpu, uint32_t addr);

/* Keep the interpreter's steady-state tag hit inside its translation unit.
 * Misses use the shared slow path, preserving exact cache evolution/timing. */
static inline void psx_icache_fetch_interp(CPUState *cpu, uint32_t addr) {
#ifdef PSX_ENABLE_BLOCK_CYCLES
    if (g_ls_replay_active) return;
    if (g_psx_icache_active < 0) {
        psx_icache_fetch(cpu, addr);
        return;
    }
    if (!g_psx_icache_active) return;
    uint32_t idx = (addr & 0xFFCu) >> 2;
    if (g_psx_icache_tv[idx] == addr) return;
    psx_icache_fetch_miss(cpu, addr);
#else
    (void)cpu;
    (void)addr;
#endif
}

/* Tag hit, inlined at every fetch site (one per cache line of generated
 * code): a line that is in the cache costs nothing and changes nothing.
 * psx_icache_fetch_miss itself returns at once on a hit, and before that test
 * only for a replay or a disabled model, which change nothing either, so
 * leaving the call out on a hit is the same in every mode. A miss goes
 * through it as before. Overlay DLLs keep their callback shim.
 * PSX_ICACHE_FETCH_CALL (a per-source compile definition) keeps the plain
 * call, for the same enormous seldom-run functions as PSX_CYC_WRITTEN_OUT
 * (psx_cyc.h): one more test per cache line is what they compile worst. */
#if defined(PSX_ENABLE_BLOCK_CYCLES) && !defined(PSX_OVERLAY_DLL_BUILD) && \
    !defined(PSX_ICACHE_FETCH_CALL)
static inline void psx_icache_fetch_inline(CPUState *cpu, uint32_t addr) {
    if (g_psx_icache_tv[(addr & 0xFFCu) >> 2] == addr) return;
    psx_icache_fetch_miss(cpu, addr);
}
#define psx_icache_fetch(cpu_, addr_) psx_icache_fetch_inline((cpu_), (addr_))
#endif

#ifdef __cplusplus
}
#endif

#endif
