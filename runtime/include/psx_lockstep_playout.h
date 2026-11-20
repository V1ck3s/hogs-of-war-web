/* Pace of a lockstep peer that watches another participant play.
 *
 * The participant in control sends their pad words as they play; a peer that
 * follows their turn receives them in small bursts, at the mercy of the
 * network. Played as they come, every late burst is a visible stall followed
 * by a rush. This decides, frame by frame, how fast the watching peer should
 * run so as to keep a few words in hand instead: two on a steady link, one
 * more for each time the words ran out, given back one at a time when the
 * link has been steady for a while. The level is held by running a few
 * percent faster or slower than the guest's own rate, so the picture stays
 * even, a fraction of a second behind the player. When the player's own
 * machine runs below the guest's rate, the words come that much slower: the
 * level cannot be reached, each shortfall asks for more, and the pace settles
 * on the player's actual rate (down to two thirds of the guest's) -- an even
 * slow motion instead of a stall every few frames.
 *
 * Pure decision (no clock, no I/O): the caller counts the words in hand and
 * applies the pace. Which word goes to which frame is not this code's
 * business and never changes with it. Tested by tests/test_lockstep_playout.c
 * against a simulated jittery link. */
#ifndef PSX_LOCKSTEP_PLAYOUT_H
#define PSX_LOCKSTEP_PLAYOUT_H

#include <stdint.h>

#define PSX_PLAYOUT_WINDOW    8u     /* frames looked back: two bursts of words */
#define PSX_PLAYOUT_BASE      2u     /* words kept in hand on a steady link */
#define PSX_PLAYOUT_EXTRA_MAX 12u    /* at most a quarter of a second more (50 Hz) */
#define PSX_PLAYOUT_RUSH      12u    /* this far above the level: unthrottled */
#define PSX_PLAYOUT_CALM      1500u  /* frames without running dry before one word is given back */

/* Paces returned: the guest's own rate, unthrottled, or the frame period as a
 * 16.16 fraction of the guest's. */
#define PSX_PLAYOUT_OWN       0u
#define PSX_PLAYOUT_UNPACED   1u

typedef struct {
    uint8_t  hist[PSX_PLAYOUT_WINDOW];   /* words in hand at the last frames */
    uint32_t pos;
    uint32_t extra;                      /* words kept beyond the base */
    uint32_t calm_since;                 /* frame of the last change of `extra` */
    int      who;                        /* participant watched, -2: none yet */
    uint32_t dry;                        /* times the words ran out */
    uint32_t low, level;                 /* last decision's inputs, for reports */
} PsxPlayout;

static inline void psx_playout_reset(PsxPlayout *s) {
    s->who = -2;
    s->low = s->level = 0;
}

/* One frame of participant `who`'s turn on a peer that is not `who`, decided
 * when the frame's word is taken (which is before the frame is due: the
 * peer computes a frame in less than a period).
 * `have`: their words known from this frame on (this frame's included, so at
 * least 1). `dry`: the previous frame started late because its word had not
 * arrived (the words ran out). */
static inline uint32_t psx_playout_step(PsxPlayout *s, uint32_t frame, int who,
                                        uint32_t have, int dry) {
    if (have > 255u) have = 255u;
    if (who != s->who) {
        /* Another participant's turn: their buffer starts from what is here. */
        s->who = who;
        for (uint32_t i = 0; i < PSX_PLAYOUT_WINDOW; i++) s->hist[i] = (uint8_t)have;
        s->calm_since = frame;
    }
    s->hist[s->pos++ % PSX_PLAYOUT_WINDOW] = (uint8_t)have;
    uint32_t low = 255u;
    for (uint32_t i = 0; i < PSX_PLAYOUT_WINDOW; i++)
        if (s->hist[i] < low) low = s->hist[i];
    if (dry) {
        if (s->extra < PSX_PLAYOUT_EXTRA_MAX) s->extra++;
        s->calm_since = frame;
        s->dry++;
    } else if (s->extra && frame - s->calm_since >= PSX_PLAYOUT_CALM) {
        s->extra--;
        s->calm_since = frame;
    }
    const uint32_t level = PSX_PLAYOUT_BASE + s->extra;
    const int over = (int)low - (int)level;
    s->low = low;
    s->level = level;
    if (over >= (int)PSX_PLAYOUT_RUSH) return PSX_PLAYOUT_UNPACED;   /* far behind the player */
    if (over >= 6)  return 52429u;   /* 0.80 of the period */
    if (over >= 3)  return 58982u;   /* 0.90 */
    if (over == 2)  return 61604u;   /* 0.94 */
    if (over == 1)  return 63570u;   /* 0.97 */
    if (over == 0)  return PSX_PLAYOUT_OWN;
    if (over == -1) return 68813u;   /* 1.05 */
    if (over == -2) return 72090u;   /* 1.10 */
    if (over == -3) return 75366u;   /* 1.15 */
    if (over >= -5) return 81920u;   /* 1.25 */
    return 98304u;                   /* 1.50 */
}

#endif /* PSX_LOCKSTEP_PLAYOUT_H */
