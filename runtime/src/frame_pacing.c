/*
 * frame_pacing.c — race-free wall-clock frame pacing.
 * See frame_pacing.h for the Bug B history this replaces.
 */
#include "frame_pacing.h"

/* FRAME_PACING_PURE_ONLY: tests compile only the SDL-free decision
 * function (tests/test_frame_pacing.c includes this file directly). */
#ifndef FRAME_PACING_PURE_ONLY
#include "psx_sdl.h"
#include "host_time.h"
#endif

uint32_t frame_pacing_sleep_ms(uint64_t now, uint64_t deadline,
                               uint64_t freq, uint64_t period) {
    if (now >= deadline) return 0;            /* compare BEFORE subtract */
    uint64_t remaining = deadline - now;       /* cannot underflow */
    if (remaining > period) remaining = period;/* hard cap: one frame max */
    if (freq == 0) return 0;
    /* remaining <= period (~one frame of ticks), so *1000 cannot overflow. */
    uint64_t ms = (remaining * 1000u) / freq;
    if (ms < 2) return 0;                      /* sub-2ms: spin instead */
    return (uint32_t)(ms - 1);                 /* undershoot; spin covers rest */
}

#ifndef FRAME_PACING_PURE_ONLY

/* Bounded catch-up window, in periods. A transient stall (heavy frame, CD
 * burst) leaves next_deadline in the past; KEEPING that debt and running
 * unpaced until it is repaid preserves the long-term rate at exactly one
 * period per frame — which the audio pipeline depends on (the SPU produces
 * 768 guest cycles per output sample; every re-anchor that forgives debt
 * permanently starves the audio ring by the forgiven amount. Measured on
 * MMX5: forgiving all >1-period debt averaged 59.80 Hz against a 59.94
 * target = -0.4% chronic audio underrun). Only debt beyond this window —
 * sustained sub-realtime emulation, not a hiccup — is forgiven, else the
 * pacer would demand unbounded catch-up. */
/* Vigilante 8's streamed FMV transitions have measured host stalls near
 * 140 ms. Eight 60 Hz periods are only 133.3 ms, so the old bound classified
 * those finite transitions as sustained slowness and permanently forgave the
 * guest/audio debt. Keep a bounded 12-period (200 ms at 60 Hz) window: enough
 * to repay the observed transition without turning a real hang, suspend, or
 * sub-realtime workload into an unbounded catch-up burst. */
#define FRAME_PACER_CATCHUP_MAX_PERIODS 12u

/* Set by the browser's lockstep (psx_lockstep_web.c) while this peer is far
 * behind the player in control: frames run unthrottled until it has caught
 * up. */
volatile int g_psx_lockstep_hurry = 0;
/* Set by the same while this peer watches another participant play (see
 * psx_lockstep_playout.h): the frame period as a 16.16 fraction of the
 * guest's (0 = the guest's own), and "watching", under which a late frame
 * leaves no debt -- it is not made up for by a burst of unpaced frames; the
 * peer simply runs that much further behind the player, and the playout
 * brings it back a few percent at a time. g_psx_lockstep_frame_late tells
 * the playout that the frame just paced started after its time. */
volatile uint32_t g_psx_lockstep_pace_q16 = 0;
volatile int g_psx_lockstep_watching = 0;
volatile int g_psx_lockstep_frame_late = 0;

static void pacer_sleep_until(uint64_t deadline, uint64_t freq, uint64_t period) {
    for (;;) {
        uint64_t now = SDL_GetPerformanceCounter();     /* ONE read per iteration */
        uint32_t ms = frame_pacing_sleep_ms(now, deadline, freq, period);
        if (ms == 0) break;
        /* Waitable timer on Win32; usleep on Unix — not coarse Sleep/SDL_Delay. */
        psx_host_sleep_ms(ms);
    }
    while (SDL_GetPerformanceCounter() < deadline) {
        /* final sub-ms spin */
    }
}

void frame_pacer_wait(FramePacer *p, double period_ms) {
    uint64_t freq = SDL_GetPerformanceFrequency();
    uint64_t period = (uint64_t)((double)freq * (period_ms / 1000.0));
    uint64_t now = SDL_GetPerformanceCounter();
    const uint32_t pace = g_psx_lockstep_pace_q16;
    if (pace) period = (period * (uint64_t)pace) >> 16;

    if (g_psx_lockstep_hurry) {
        p->next_deadline = now + period;   /* no debt: pacing resumes from here */
        g_psx_lockstep_frame_late = 0;
        return;
    }
    if (g_psx_lockstep_watching) {
        if (p->next_deadline != 0 && now < p->next_deadline) {
            pacer_sleep_until(p->next_deadline, freq, period);
            p->next_deadline += period;
            g_psx_lockstep_frame_late = 0;
            return;
        }
        /* Late (beyond an eighth of a period: not timer noise), or the first
         * frame: it runs now and the next one is due a period from now. */
        g_psx_lockstep_frame_late =
            p->next_deadline != 0 && now - p->next_deadline > period / 8u;
        p->next_deadline = now + period;
        return;
    }
    if (p->next_deadline == 0 ||
        now >= p->next_deadline + period * FRAME_PACER_CATCHUP_MAX_PERIODS) {
        /* First frame, or sustained slowness beyond the catch-up window:
         * re-anchor (forgive the debt). */
        p->next_deadline = now + period;
        return;
    }
    if (now >= p->next_deadline) {
        /* In debt from a recent stall: run this frame unpaced and advance
         * the deadline, repaying one period of debt per fast frame. */
        p->next_deadline += period;
        return;
    }

    pacer_sleep_until(p->next_deadline, freq, period);
    p->next_deadline += period;
}
#endif /* FRAME_PACING_PURE_ONLY */
