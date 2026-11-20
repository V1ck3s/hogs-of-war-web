/* psx_lockstep_playout.h against a simulated link.
 *
 * A player produces one pad word per guest frame (20 ms at 50 Hz); words leave
 * in bursts (4 words, or 60 ms after the first one waiting), and each burst
 * takes the link's delay plus a random jitter to arrive, order kept. A peer
 * watching that player runs the frames as the runtime does at each VBlank:
 * the frame's word is waited for if it is missing, then the frame pacer (same
 * decisions as frame_pacing.c) holds the frame until its time with the pace
 * the playout asks for, then the frame is computed.
 *
 * Measured over the frames after a warm-up: how many frames started more than
 * 1.5 periods after the previous one ("late"), more than 3 periods ("hitch"),
 * how often the words ran out, and how far behind the player the peer runs.
 * The same link is also played the way the runtime did before the playout
 * existed (words taken as they come, unthrottled when four are waiting), to
 * check that the playout is what makes the difference. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "psx_lockstep_playout.h"

#define PERIOD   20.0
#define FRAMES   9000          /* three minutes of game */
#define WARMUP   500

/* made: milliseconds between two words on the player's machine (PERIOD when
 * it runs at the guest's rate, more when it cannot keep up). */
typedef struct { double delay, jitter; double outage_at, outage_len; double compute; double made; } Link;
typedef struct { int late, hitch, dry; double lag_avg, lag_max; uint32_t extra; } Result;

static uint32_t s_rng;
static double rnd01(void) {
    s_rng = s_rng * 1103515245u + 12345u;
    return (double)((s_rng >> 8) & 0xFFFFFFu) / (double)0x1000000u;
}

/* Arrival time of every frame's word on the watching peer. */
static void deliver(const Link *l, double *arrive) {
    double last = 0;
    int f = 0;
    s_rng = 12345u;
    while (f < FRAMES) {
        /* Words f.. are produced every l->made ms; the burst leaves when it
         * holds 4 words or 60 ms after its first word. */
        int n = 4;
        if (f + n > FRAMES) n = FRAMES - f;
        double made_last = (double)(f + n - 1) * l->made;
        double sent = (double)f * l->made + 60.0;
        if (made_last < sent) sent = made_last;
        if (sent < made_last) {          /* 60 ms came first: fewer words */
            n = (int)((sent - (double)f * l->made) / l->made) + 1;
        }
        double at = sent + l->delay + rnd01() * l->jitter;
        if (l->outage_len > 0 && at >= l->outage_at && at < l->outage_at + l->outage_len)
            at = l->outage_at + l->outage_len;      /* held back by the outage */
        if (at < last) at = last;                    /* order kept */
        last = at;
        for (int k = 0; k < n; k++) arrive[f + k] = at;
        f += n;
    }
}

/* frame_pacing.c frame_pacer_wait: when this frame may start. `watching`: a
 * late frame leaves no debt; *late tells that it started after its time. */
static double pacer_wait(double *next_deadline, double now, double period,
                         int hurry, int watching, int *late) {
    *late = 0;
    if (hurry) { *next_deadline = now + period; return now; }
    if (watching) {
        if (*next_deadline != 0 && now < *next_deadline) {
            const double at = *next_deadline;
            *next_deadline += period;
            return at;
        }
        *late = *next_deadline != 0 && now - *next_deadline > period / 8.0;
        *next_deadline = now + period;
        return now;
    }
    if (*next_deadline == 0 || now >= *next_deadline + period * 12.0) {
        *next_deadline = now + period;
        return now;
    }
    if (now >= *next_deadline) { *next_deadline += period; return now; }
    const double at = *next_deadline;
    *next_deadline += period;
    return at;
}

static Result run(const Link *l, int smoothed) {
    static double arrive[FRAMES], start[FRAMES];
    deliver(l, arrive);
    PsxPlayout p;
    memset(&p, 0, sizeof p);
    psx_playout_reset(&p);
    Result r;
    memset(&r, 0, sizeof r);
    double t = 0, deadline = 0, lag_sum = 0;
    int prev_waited = 0, prev_late = 0;
    for (int f = 0; f < FRAMES; f++) {
        /* The game asks for the frame's word as soon as the previous frame
         * is computed, and waits for it if it is not there. */
        int waited = 0;
        if (arrive[f] > t) { waited = 1; t = arrive[f]; }
        uint32_t have = 0;
        while (f + (int)have < FRAMES && have < 64u && arrive[f + have] <= t) have++;
        double period = PERIOD;
        int hurry, late = 0;
        if (smoothed) {
            const uint32_t pace = psx_playout_step(&p, (uint32_t)f, 0, have, prev_waited && prev_late);
            hurry = pace == PSX_PLAYOUT_UNPACED;
            if (pace > PSX_PLAYOUT_UNPACED) period = PERIOD * (double)pace / 65536.0;
        } else {
            hurry = have >= 4u;
        }
        t = pacer_wait(&deadline, t, period, hurry, smoothed, &late);
        if (!smoothed && waited && f >= WARMUP) r.dry++;
        prev_waited = waited;
        prev_late = late;
        start[f] = t;
        if (f >= WARMUP) {
            /* Late: against the rate the words are made at (a peer cannot
             * show a slow player's frames faster than they are played). */
            const double gap = start[f] - start[f - 1];
            if (gap > 1.5 * l->made) r.late++;
            if (gap > 3.0 * l->made) r.hitch++;
            const double lag = t - (double)f * l->made;
            lag_sum += lag;
            if (lag > r.lag_max) r.lag_max = lag;
        }
        t += l->compute;
    }
    r.lag_avg = lag_sum / (double)(FRAMES - WARMUP);
    if (smoothed) { r.dry = (int)p.dry; r.extra = p.extra; }
    return r;
}

static int s_failed;
static void check(int ok, const char *what) {
    if (!ok) { printf("FAIL: %s\n", what); s_failed = 1; }
}

int main(void) {
    const struct { const char *name; Link link; } cases[] = {
        { "steady link (40 ms)",                 { 40.0,  0.0,     0.0,   0.0, 6.0, PERIOD } },
        { "home link (60 ms, 0-30 ms jitter)",   { 60.0, 30.0,     0.0,   0.0, 6.0, PERIOD } },
        { "tunnel (80 ms, 0-80 ms jitter)",      { 80.0, 80.0,     0.0,   0.0, 6.0, PERIOD } },
        { "rough link (150 ms, 0-200 ms jitter)",{ 150.0, 200.0,   0.0,   0.0, 6.0, PERIOD } },
        { "tunnel with a 0.7 s outage",          { 80.0, 80.0, 60000.0, 700.0, 6.0, PERIOD } },
        { "tunnel, heavy frames (15 ms each)",   { 80.0, 80.0,     0.0,   0.0, 15.0, PERIOD } },
        /* The player's machine cannot hold 50 frames a second. */
        { "tunnel, player at 44 frames/s",       { 80.0, 80.0,     0.0,   0.0, 6.0, 22.7 } },
        { "tunnel, player at 36 frames/s",       { 80.0, 80.0,     0.0,   0.0, 6.0, 27.8 } },
    };
    const int n = (int)(sizeof cases / sizeof cases[0]);
    const int frames = FRAMES - WARMUP;
    printf("%-38s %-10s %6s %6s %5s %8s %8s\n", "link", "played", "late", "hitch", "dry", "lag avg", "lag max");
    for (int i = 0; i < n; i++) {
        const Result raw = run(&cases[i].link, 0);
        const Result smo = run(&cases[i].link, 1);
        printf("%-38s %-10s %6d %6d %5d %7.0f ms %6.0f ms\n", cases[i].name, "as it comes", raw.late, raw.hitch, raw.dry, raw.lag_avg, raw.lag_max);
        printf("%-38s %-10s %6d %6d %5d %7.0f ms %6.0f ms  (%u extra words)\n", "", "smoothed", smo.late, smo.hitch, smo.dry, smo.lag_avg, smo.lag_max, smo.extra);
        const Link *l = &cases[i].link;
        /* The buffer costs a bounded delay: the base level plus what the link
         * taught it, never more than the cap. */
        check(smo.lag_avg <= l->delay + l->jitter + 60.0 + l->made * (PSX_PLAYOUT_BASE + PSX_PLAYOUT_EXTRA_MAX + 2),
              "smoothed playout stays within its buffer of the player");
        if (l->outage_len > 0) {
            /* One outage: a handful of late frames around it, not a train. */
            check(smo.late <= 12 && smo.hitch <= 2, "an outage costs a few late frames only");
        } else if (l->jitter == 0.0) {
            check(smo.late == 0 && smo.hitch == 0 && smo.dry == 0, "a steady link plays without a single late frame");
            check(smo.extra == 0, "a steady link needs no extra words");
        } else {
            /* A jittery link settles: late frames are the exception (under
             * 1 %), where words taken as they come are late many times more. */
            check(smo.late * 100 <= frames, "under 1 % of late frames on a jittery link");
            check(smo.hitch <= 2, "no train of hitches on a jittery link");
            check(raw.late >= 5 * (smo.late + 1), "smoothing removes most of the late frames");
        }
    }
    if (s_failed) return 1;
    printf("lockstep playout: all checks passed\n");
    return 0;
}
