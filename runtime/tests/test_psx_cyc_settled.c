/* psx_cyc.h "Settled interlock": the inlined fast path against the interlock
 * run as written.
 *
 * The same random program is run twice from the same state: once with
 * psx_cyc_step_exact / psx_cyc_load_ram_exact (section 1, GPR_DEPRES, DO_LDS
 * and ReadMemory, every instruction), once with psx_cyc_step /
 * psx_cyc_load_ram (the settled test, the batch gate, the out-of-line full
 * versions). After every operation the five interlock fields, the published
 * clock, the deferred batch and the device-service count must be the same.
 *
 * The program mixes what the runtime mixes: non-load instructions, main-RAM
 * loads, the writers that go around the helpers (generated MFC0/CFC0, MFC2,
 * LWC2 and scratchpad ReadMemory, an I-cache miss, a mult/div stall), flushes
 * at block edges, and every mode that turns the batch gate off (leaving
 * generated code, device service, a function-local accumulator, the replay
 * clock, conservative stepping).
 *
 * The program alternates, in runs, between the two forms a build mixes: the
 * settled test (psx_cyc_step_fast / psx_cyc_load_ram_fast) and the interlock
 * written out (files compiled with PSX_CYC_WRITTEN_OUT), which must leave
 * the mark and cyc_live right for the other. */
#include "psx_cyc.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

uint64_t psx_cycle_count = 0;
uint64_t psx_next_service_cycle = 0;
uint32_t g_psx_cyc_batch = 0;
uint32_t g_psx_cyc_batch_limit = 0;
uint32_t g_psx_cyc_fast_cap = 0;
int g_psx_cyc_bb_defer = 0;
uint32_t *g_psx_cyc_local_acc = 0;
int psx_in_device_service = 0;
int g_event_step_conservative = 0;
int g_ls_replay_active = 0;
int g_ls_mode = 0;
volatile int g_ds_recording = 0;
uint8_t *g_psx_ram = 0;
int g_psx_load_delay = 1;
uint32_t g_psx_cpu_oc_q16 = 0;
uint32_t g_psx_cpu_oc_frac = 0;

static uint32_t s_services;

void psx_devices_service_to_now(void) {
    s_services++;
    psx_next_service_cycle = psx_cycle_count + 37u;
}
void psx_advance_cycles_slow(uint32_t cycles) { psx_cycle_count += cycles; }

/* As in psx_cycles.c. */
void psx_cyc_step_full(CPUState* cpu, uint32_t reg_mask) {
    psx_cyc_step_full_body(cpu, reg_mask);
}
void psx_cyc_load_ram_timing(CPUState* cpu, uint32_t rt, uint32_t reg_mask) {
    psx_cyc_load_ram_exact(cpu, rt, reg_mask);
}

static uint32_t s_rng;
static uint32_t rnd(void) {
    s_rng = s_rng * 1664525u + 1013904223u;
    return s_rng >> 8;
}

enum { OP_STEP, OP_LOAD, OP_MFC0, OP_MFC2, OP_LWC2, OP_SCRATCH, OP_ICACHE_MISS,
       OP_MULDIV, OP_FLUSH, OP_DEFER_BEGIN, OP_DEFER_END, OP_SERVICE,
       OP_LOCAL, OP_REPLAY, OP_CONSERVATIVE, OP_KINDS };
typedef struct { uint8_t kind, rt, written_out; uint32_t mask, arg; } Op;

/* Registers come from a small set so that loads and their uses collide. */
static uint32_t rnd_reg(void) {
    static const uint8_t regs[] = { 0, 2, 2, 3, 3, 4, 5, 8, 16, 29, 31 };
    return regs[rnd() % (sizeof regs / sizeof regs[0])];
}
static uint32_t rnd_mask(void) {
    uint32_t m = 0;
    for (uint32_t n = rnd() % 4u; n; n--) m |= 1u << rnd_reg();
    return m;
}
/* Generated code is where the time goes: the program stays inside it (defer
 * depth 1 or more) except for short excursions, and the modes that close the
 * batch gate come as short episodes, as they do in the runtime (a device
 * service, a replayed block, a function with a local accumulator). */
static int s_gen_depth, s_gen_episode, s_gen_episode_kind;
static Op rnd_op(void) {
    Op o;
    memset(&o, 0, sizeof o);
    o.rt = (uint8_t)rnd_reg();
    o.mask = rnd_mask();
    o.arg = rnd();
    if (s_gen_episode > 0 && --s_gen_episode == 0) {     /* the episode ends */
        o.kind = (uint8_t)s_gen_episode_kind;
        return o;
    }
    uint32_t r = rnd() % 1000u;
    if (s_gen_depth == 0 && r < 300) { s_gen_depth++; o.kind = OP_DEFER_BEGIN; return o; }
    if (r < 560) o.kind = OP_STEP;
    else if (r < 800) o.kind = OP_LOAD;
    else if (r < 810) o.kind = OP_MFC0;
    else if (r < 820) o.kind = OP_MFC2;
    else if (r < 830) o.kind = OP_LWC2;
    else if (r < 860) o.kind = OP_SCRATCH;
    else if (r < 880) o.kind = OP_ICACHE_MISS;
    else if (r < 885) o.kind = OP_MULDIV;
    else if (r < 950) o.kind = OP_FLUSH;
    else if (r < 970) {
        if (s_gen_depth < 6) { s_gen_depth++; o.kind = OP_DEFER_BEGIN; } else o.kind = OP_STEP;
    } else if (r < 990) {
        /* Leaving generated code altogether is the rare case. */
        if (s_gen_depth > 1 || (s_gen_depth == 1 && rnd() % 8u == 0u)) { s_gen_depth--; o.kind = OP_DEFER_END; }
        else o.kind = OP_STEP;
    } else if (s_gen_episode == 0) {
        static const uint8_t kinds[] = { OP_SERVICE, OP_SERVICE, OP_LOCAL, OP_REPLAY, OP_CONSERVATIVE };
        s_gen_episode_kind = kinds[rnd() % 5u];
        s_gen_episode = 2 + (int)(rnd() % 24u);
        o.kind = (uint8_t)s_gen_episode_kind;
    } else o.kind = OP_STEP;
    return o;
}

static uint32_t s_local;

/* ReadMemory as memory.c psx_cyc_readmem runs it for the scratchpad (no wait,
 * no give-back) and for LWC2 from main RAM (completion 1, nothing armed). */
static void readmem(CPUState *cpu, int scratch, uint32_t arm_rt) {
    cpu->read_absorb[cpu->read_absorb_which] = 0u;
    cpu->read_absorb_which = 0u;
    cpu->cyc_settled = 0u;
    if (scratch) {
        cpu->ld_absorb = 0u;
        cpu->ld_which_t = (uint8_t)arm_rt;
        return;
    }
    uint32_t cost = 3u + 1u;
    uint32_t fudge = (uint32_t)((cpu->read_fudge >> 4) & 2u);
    cpu->ld_absorb = cost;
    psx_advance_cycles(fudge + cost);
    cpu->ld_which_t = (uint8_t)arm_rt;
}

static void run_op(CPUState *cpu, const Op *o, int exact) {
    switch (o->kind) {
    case OP_STEP:
        if (exact || o->written_out) psx_cyc_step_exact(cpu, o->mask);
        else psx_cyc_step_fast(cpu, o->mask);
        break;
    case OP_LOAD:
        if (exact || o->written_out) psx_cyc_load_ram_exact(cpu, o->rt, o->mask);
        else psx_cyc_load_ram_fast(cpu, o->rt, o->mask);
        break;
    case OP_MFC0:           /* generated code: step, then the two fields */
        if (exact) psx_cyc_step_exact(cpu, o->mask); else psx_cyc_step(cpu, o->mask);
        cpu->ld_absorb = 0u; cpu->ld_which_t = o->rt;
        break;
    case OP_MFC2:           /* psx_gte_read */
        if (exact) psx_cyc_step_exact(cpu, o->mask); else psx_cyc_step(cpu, o->mask);
        psx_cyc_batch_flush();
        cpu->ld_absorb = o->arg % 23u;
        if (cpu->ld_absorb) psx_advance_device_cycles(cpu->ld_absorb);
        cpu->ld_which_t = o->rt;
        cpu->cyc_settled = 0u;
        break;
    case OP_LWC2:           /* psx_cyc_step(cpu, 0) then psx_cyc_lwc2_read */
        if (exact) psx_cyc_step_exact(cpu, 0u); else psx_cyc_step(cpu, 0u);
        readmem(cpu, (int)(o->arg & 1u), 0x20u);
        break;
    case OP_SCRATCH:        /* psx_cyc_load_timing for a scratchpad address */
        psx_cyc_base(cpu);
        psx_cyc_deps(cpu, o->mask);
        if (cpu->ld_which_t == o->rt) cpu->ld_which_t = 0u;
        psx_cyc_lds(cpu);
        readmem(cpu, 1, o->rt);
        break;
    case OP_ICACHE_MISS:    /* psx_icache_fetch_miss */
        cpu->read_absorb[cpu->read_absorb_which] = 0u;
        cpu->read_absorb_which = 0u;
        psx_advance_cycles(3u + o->arg % 5u);
        break;
    case OP_MULDIV: {       /* psx_muldiv_stall */
        uint32_t stall = 1u + o->arg % 9u;
        uint8_t w = cpu->read_absorb_which;
        uint32_t give = cpu->read_absorb[w];
        cpu->read_absorb[w] = (uint8_t)(give > stall ? give - stall : 0u);
        psx_advance_device_cycles(stall);
        break;
    }
    case OP_FLUSH: psx_cyc_bb_defer_flush(); break;
    case OP_DEFER_BEGIN: psx_cyc_bb_defer_begin(); break;
    case OP_DEFER_END: psx_cyc_bb_defer_end(); break;
    case OP_SERVICE:
        psx_in_device_service = !psx_in_device_service;
        psx_cyc_fast_refresh();
        break;
    case OP_LOCAL:
        if (g_psx_cyc_local_acc) psx_cyc_local_end(); else psx_cyc_local_begin(&s_local);
        break;
    case OP_REPLAY:
        g_ls_replay_active = !g_ls_replay_active;
        psx_cyc_fast_refresh();
        break;
    case OP_CONSERVATIVE:
        g_event_step_conservative = !g_event_step_conservative;
        psx_cyc_fast_refresh();
        break;
    default: break;
    }
}

typedef struct {
    uint8_t absorb[33], which, fudge, ldw;
    uint32_t lda, batch, local, services;
    uint64_t count;
} Snap;
static void snap(const CPUState *cpu, Snap *s) {
    memset(s, 0, sizeof *s);
    memcpy(s->absorb, cpu->read_absorb, 33);
    s->which = cpu->read_absorb_which; s->fudge = cpu->read_fudge; s->ldw = cpu->ld_which_t;
    s->lda = cpu->ld_absorb; s->batch = g_psx_cyc_batch; s->local = s_local;
    s->services = s_services; s->count = psx_cycle_count;
}

static void reset(CPUState *cpu) {
    memset(cpu, 0, sizeof *cpu);
    cpu->ld_which_t = 0x20u;
    psx_cycle_count = 0; psx_next_service_cycle = 0;
    g_psx_cyc_batch = 0; g_psx_cyc_batch_limit = 0; g_psx_cyc_bb_defer = 0;
    g_psx_cyc_local_acc = 0; psx_in_device_service = 0;
    g_event_step_conservative = 0; g_ls_replay_active = 0;
    s_local = 0; s_services = 0;
    psx_cyc_fast_refresh();
}

#define N_OPS 4000000

/* Optional argument: another seed for the random program. */
int main(int argc, char **argv) {
    static Op ops[N_OPS];
    static Snap want[N_OPS];
    CPUState cpu;
    uint32_t fast_steps = 0, fast_loads = 0, steps = 0, loads = 0;

    s_rng = argc > 1 ? (uint32_t)strtoul(argv[1], NULL, 0) : 20261120u;
    for (int i = 0; i < N_OPS; i++) ops[i] = rnd_op();
    /* A fifth of the program, in runs of some hundred operations, is code
     * compiled with the interlock written out. */
    for (int i = 0, wo = 0; i < N_OPS; i++) {
        if (rnd() % 100u == 0u) wo = rnd() % 5u == 0u;
        ops[i].written_out = (uint8_t)wo;
    }

    reset(&cpu);
    for (int i = 0; i < N_OPS; i++) { run_op(&cpu, &ops[i], 1); snap(&cpu, &want[i]); }

    reset(&cpu);
    for (int i = 0; i < N_OPS; i++) {
        const int fast = cpu.cyc_settled && cpu.ld_which_t == 0x20u &&
                         g_psx_cyc_batch < g_psx_cyc_fast_cap;
        /* The mark is only ever set over a settled interlock. */
        if (cpu.cyc_settled && cpu.ld_which_t == 0x20u && !psx_cyc_settled_now(&cpu)) {
            printf("FAIL: op %d: marked settled, fields are not\n", i);
            return 1;
        }
        /* Every slot holding a give-back is among the ones remembered. */
        for (int n = 0; n < 32; n++) {
            if (cpu.read_absorb[n] && !((cpu.cyc_live >> n) & 1u)) {
                printf("FAIL: op %d: slot %d holds %d, not in cyc_live %08x\n", i, n,
                       cpu.read_absorb[n], (unsigned)cpu.cyc_live);
                return 1;
            }
        }
        /* The gate is open exactly when a charge is the deferred addition. */
        {
            const uint32_t open = (g_psx_cyc_bb_defer > 0 && !g_ls_replay_active &&
                                   !g_event_step_conservative && !psx_in_device_service &&
                                   !g_psx_cyc_local_acc) ? PSX_CYC_FAST_CAP : 0u;
            if (g_psx_cyc_fast_cap != open) {
                printf("FAIL: op %d: batch gate %08x, modes say %08x\n", i,
                       (unsigned)g_psx_cyc_fast_cap, (unsigned)open);
                return 1;
            }
        }
        if (ops[i].kind == OP_STEP) { steps++; fast_steps += (uint32_t)(fast && !ops[i].written_out); }
        if (ops[i].kind == OP_LOAD) { loads++; fast_loads += (uint32_t)(fast && !ops[i].written_out); }
        run_op(&cpu, &ops[i], 0);
        Snap got;
        snap(&cpu, &got);
        if (memcmp(&got, &want[i], sizeof got) != 0) {
            printf("FAIL: op %d (kind %d rt %d mask %08x): clock %llu+%u, exact %llu+%u; "
                   "which %d/%d fudge %d/%d ldw %d/%d lda %u/%u\n",
                   i, ops[i].kind, ops[i].rt, (unsigned)ops[i].mask,
                   (unsigned long long)got.count, (unsigned)got.batch,
                   (unsigned long long)want[i].count, (unsigned)want[i].batch,
                   got.which, want[i].which, got.fudge, want[i].fudge,
                   got.ldw, want[i].ldw, (unsigned)got.lda, (unsigned)want[i].lda);
            return 1;
        }
    }
    printf("settled interlock: %d operations identical; fast path on %u of %u steps, %u of %u loads\n",
           N_OPS, (unsigned)fast_steps, (unsigned)steps, (unsigned)fast_loads, (unsigned)loads);
    /* The fast path must be taken often, or this proves nothing. (This
     * program is far rougher than a game: a load every fourth instruction,
     * registers picked at random, a mode change every hundred.) */
    if (fast_steps < steps / 10u || fast_loads < loads / 10u) {
        printf("FAIL: the fast path was hardly taken\n");
        return 1;
    }
    return 0;
}
