/* LD_PRELOAD sampler: histogram of the program counters interrupted by a
 * CPU-time timer (per thread), written at exit to $PROF_OUT with the process
 * memory map, for sym.py. No privilege needed (where perf is not allowed).
 * The kernel delivers at most one signal per scheduler tick: with a 4 ms tick,
 * one sample stands for 4 ms of CPU whatever PROF_US asks. */
#define _GNU_SOURCE
#include <signal.h>
#include <sys/time.h>
#include <ucontext.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/mman.h>

#define CAP (1u << 22)
typedef struct { uintptr_t pc; uint32_t tid; uint32_t n; } Slot;
static Slot *tab;
static volatile uint64_t lost;

static void on_prof(int sig, siginfo_t *si, void *ctx) {
    (void)sig; (void)si;
    ucontext_t *uc = (ucontext_t *)ctx;
    uintptr_t pc = (uintptr_t)uc->uc_mcontext.gregs[REG_RIP];
    uint32_t tid = (uint32_t)syscall(SYS_gettid);
    uint64_t h = (pc * 0x9E3779B97F4A7C15ull) ^ ((uint64_t)tid << 20);
    uint32_t i = (uint32_t)(h >> 40) & (CAP - 1);
    for (int k = 0; k < 256; k++, i = (i + 1) & (CAP - 1)) {
        uintptr_t cur = __atomic_load_n(&tab[i].pc, __ATOMIC_RELAXED);
        if (cur == 0) {
            uintptr_t z = 0;
            if (__atomic_compare_exchange_n(&tab[i].pc, &z, pc, 0, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {
                tab[i].tid = tid; __atomic_add_fetch(&tab[i].n, 1, __ATOMIC_RELAXED); return;
            }
            cur = z;
        }
        if (cur == pc && (tab[i].tid == tid || tab[i].tid == 0)) { __atomic_add_fetch(&tab[i].n, 1, __ATOMIC_RELAXED); return; }
    }
    lost++;
}

static void dump(void) {
    struct itimerval off = {{0, 0}, {0, 0}};
    setitimer(ITIMER_PROF, &off, NULL);
    const char *out = getenv("PROF_OUT");
    if (!out || !tab) return;
    char path[1024];
    snprintf(path, sizeof path, "%s.samples", out);
    FILE *f = fopen(path, "w");
    if (f) {
        for (uint32_t i = 0; i < CAP; i++) if (tab[i].pc) fprintf(f, "%lx %u %u\n", (unsigned long)tab[i].pc, tab[i].tid, tab[i].n);
        fprintf(f, "# lost %llu\n", (unsigned long long)lost);
        fclose(f);
    }
    snprintf(path, sizeof path, "%s.maps", out);
    FILE *m = fopen("/proc/self/maps", "r"), *o = fopen(path, "w");
    if (m && o) { char buf[4096]; size_t n; while ((n = fread(buf, 1, sizeof buf, m)) > 0) fwrite(buf, 1, n, o); }
    if (m) fclose(m);
    if (o) fclose(o);
}

__attribute__((constructor)) static void init(void) {
    if (!getenv("PROF_OUT")) return;
    tab = mmap(NULL, sizeof(Slot) * CAP, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (tab == MAP_FAILED) { tab = NULL; return; }
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = on_prof;
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGPROF, &sa, NULL);
    long us = getenv("PROF_US") ? atol(getenv("PROF_US")) : 997;
    struct itimerval it = {{0, us}, {0, us}};
    setitimer(ITIMER_PROF, &it, NULL);
    atexit(dump);
}
