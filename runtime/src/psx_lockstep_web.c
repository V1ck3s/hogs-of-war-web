/* WebAssembly lockstep input: the browser's network layer (main thread)
 * publishes every participant's pad word for each frame into a shared ring;
 * the emulation pthread blocks at each vblank boundary until its frame is
 * complete. The pad the game sees is then chosen deterministically from the
 * frame's words (see psx_lockstep_select), so every peer runs the same
 * simulation. */
#include "psx_lockstep.h"
#include "mod_plugins.h"

#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define RING 1024u
#define MAXP 4u
#define STRIDE (MAXP + 1u)   /* + one control word per frame */

/* tag[i] = frame + 1 once words[i][*] for that frame are published.
 * words[i][MAXP] = control word: bits 0-3 host participant (drives menus),
 * bits 4-7 mask of participants who left (their team is driven by the host). */
static volatile uint32_t s_tag[RING];
static volatile uint16_t s_words[RING][STRIDE];
static volatile uint32_t s_nplayers = 1;
/* Status block read by JS: cur_frame, digest_frame, digest, wait_ms_total,
 * holder+1 (0 = nobody), [5] owner hint from the title plugin. */
static volatile uint32_t s_status[8];
#define s_cur_frame s_status[0]
#define s_last_digest_frame s_status[1]
#define s_last_digest s_status[2]
#define s_wait_ms_total s_status[3]

/* Default: the host drives the controller (menus, team setup, anything the
 * title does not assign to a participant). A pure function of the frame's
 * inputs, so every peer agrees. */
static uint32_t s_host;
static uint32_t s_gone;   /* mask of participants who left */
uint32_t psx_lockstep_host(void) { return s_host; }
uint32_t psx_lockstep_gone_mask(void) { return s_gone; }
void psx_lockstep_default_select(uint32_t frame, const uint16_t *words, uint32_t n,
                                 uint16_t pads[2]) {
    (void)frame;
    const uint32_t h = s_host < n ? s_host : 0u;
    pads[0] = n ? words[h] : 0xFFFFu;
    pads[1] = 0xFFFFu;
    s_status[4] = n ? h + 1u : 0u;
    s_status[5] = 0;
}

/* Game-specific selection hook (installed by a title plugin); default: the
 * first participant drives pad 0, the second pad 1. */
static psx_lockstep_select_fn s_select;
void psx_lockstep_set_select(psx_lockstep_select_fn fn) { s_select = fn; }

/* Shown by the page: who drives the game now (participant index, -1 none)
 * and, for turn-based titles, the turn's team number (0 = no turn). */
void psx_lockstep_set_owner(int participant, uint32_t team) {
    s_status[4] = (uint32_t)(participant + 1);
    s_status[5] = team;
}

/* Mailbox from the page (late join), polled while waiting for a frame:
 * [0] seq of a snapshot load: [1] heap pointer (malloc'd by the page, freed
 * here), [2] length, [3] frame after the snapshot, [4] player count;
 * [5] boundary frame at which to write a snapshot (0 = none);
 * [6] snapshot status (0 idle, 1 saving, 2 saved, -1 failed), [7] its frame. */
static volatile uint32_t s_mail[8];
static uint32_t s_mail_seen;

static int mailbox(void) {
    if (s_mail[5]) {
        psx_lockstep_request_snapshot(s_mail[5]);
        s_mail[5] = 0;
    }
    uint32_t sf = 0;
    const int st = psx_lockstep_snapshot_status(&sf);
    s_mail[7] = sf;
    s_mail[6] = (uint32_t)st;
    const uint32_t seq = __atomic_load_n(&s_mail[0], __ATOMIC_SEQ_CST);
    if (seq != s_mail_seen) {
        s_mail_seen = seq;
        void *blob = (void *)(uintptr_t)s_mail[1];
        if (blob) {
            s_nplayers = s_mail[4] ? s_mail[4] : s_nplayers;
            if (!psx_lockstep_load_snapshot(blob, s_mail[2], s_mail[3]))
                emscripten_log(EM_LOG_CONSOLE, "psxrecomp: snapshot load refused");
            free(blob);   /* the savestate layer keeps its own copy */
            return 1;
        }
    }
    return 0;
}

static int web_provider(uint32_t frame, uint16_t pads[2]) {
    const uint32_t i = frame % RING;
    double t0 = 0;
    if (frame < 3 || frame % 500u == 0u)
        emscripten_log(EM_LOG_CONSOLE, "psxrecomp: lockstep frame %u", (unsigned)frame);
    while (s_tag[i] != frame + 1u) {
        if (mailbox() || psx_lockstep_loading()) {
            /* A snapshot replaces this machine at the next safe point: run on
             * with neutral pads until then (the frame numbering restarts at
             * the snapshot's). */
            pads[0] = pads[1] = 0xFFFFu;
            return 1;
        }
        if (!t0) t0 = emscripten_get_now();
        emscripten_futex_wait((void *)&s_tag[i], s_tag[i], 20.0);
    }
    (void)mailbox();
    if (t0) s_wait_ms_total += (uint32_t)(emscripten_get_now() - t0);
    uint16_t words[MAXP];
    const uint32_t n = s_nplayers > MAXP ? MAXP : s_nplayers;
    for (uint32_t p = 0; p < MAXP; p++) words[p] = p < n ? s_words[i][p] : 0xFFFFu;
    {
        const uint16_t ctl = s_words[i][MAXP];
        s_host = ctl & 15u;
        s_gone = (ctl >> 4) & 15u;
    }
    if (s_select) {
        s_select(frame, words, n, pads);
    } else {
        psx_lockstep_default_select(frame, words, n, pads);
    }
    s_cur_frame = frame;
    if (frame % 120u == 0u) {
        /* Seqlock for the JS reader: [1] frame, [2] digest, [6] frame again;
         * a read is consistent when [1] == [6]. */
        const uint32_t d = psx_lockstep_ram_digest();
        s_status[6] = 0xFFFFFFFFu;
        __atomic_thread_fence(__ATOMIC_SEQ_CST);
        s_last_digest_frame = frame;
        s_last_digest = d;
        __atomic_thread_fence(__ATOMIC_SEQ_CST);
        s_status[6] = frame;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE void psx_web_lockstep_set_host(uint32_t index) { s_host = index; }
EMSCRIPTEN_KEEPALIVE void psx_web_lockstep_enable(uint32_t nplayers) {
    /* No ring reset: the page's lockstep worker may already have published
     * the first frames (the ring starts zeroed with the module). */
    s_nplayers = nplayers ? nplayers : 1;
    psx_lockstep_set_provider(web_provider);
}
EMSCRIPTEN_KEEPALIVE void psx_web_lockstep_set_players(uint32_t n) { s_nplayers = n; }
/* Layout for JS (byte offsets into the shared heap). */
EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_lockstep_tags(void) { return (uintptr_t)s_tag; }
EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_lockstep_words(void) { return (uintptr_t)s_words; }
EMSCRIPTEN_KEEPALIVE uint32_t psx_web_lockstep_ring(void) { return RING; }
EMSCRIPTEN_KEEPALIVE uint32_t psx_web_lockstep_maxp(void) { return MAXP; }
EMSCRIPTEN_KEEPALIVE uint32_t psx_web_lockstep_stride(void) { return STRIDE; }
EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_lockstep_mail(void) { return (uintptr_t)s_mail; }
EMSCRIPTEN_KEEPALIVE const char *psx_web_snapshot_path(void) {
    static char path[600];
    if (!psx_lockstep_snapshot_path(path, sizeof path)) path[0] = 0;
    return path;
}
EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_lockstep_status(void) { return (uintptr_t)s_status; }

/* Guest RAM word, for the page's diagnostics and tests (read-only). */
EMSCRIPTEN_KEEPALIVE uint32_t psx_web_peek32(uint32_t addr) { return psx_mod_read_word(addr); }
/* Tests only (single player): store a guest word from the page's thread. */
EMSCRIPTEN_KEEPALIVE void psx_web_poke32(uint32_t addr, uint32_t value) { psx_mod_write_word(addr, value); }
