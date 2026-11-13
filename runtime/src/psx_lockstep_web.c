/* WebAssembly lockstep input: the browser's network layer (main thread)
 * publishes every participant's pad word for each frame into a shared ring;
 * the emulation pthread blocks at each vblank boundary until its frame is
 * complete. The pad the game sees is then chosen deterministically from the
 * frame's words (see psx_lockstep_select), so every peer runs the same
 * simulation. */
#include "psx_lockstep.h"

#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <stdint.h>
#include <string.h>

#define RING 1024u
#define MAXP 4u

/* tag[i] = frame + 1 once words[i][*] for that frame are published. */
static volatile uint32_t s_tag[RING];
static volatile uint16_t s_words[RING][MAXP];
static volatile uint32_t s_nplayers = 1;
/* Status block read by JS: cur_frame, digest_frame, digest, wait_ms_total,
 * holder+1 (0 = nobody), [5] owner hint from the title plugin. */
static volatile uint32_t s_status[8];
#define s_cur_frame s_status[0]
#define s_last_digest_frame s_status[1]
#define s_last_digest s_status[2]
#define s_wait_ms_total s_status[3]

/* Default: one shared controller (hot-seat games). The participant in
 * control keeps it while active; after HANDOFF idle frames the next one to
 * press a button takes it. A pure function of the input stream, so every peer
 * agrees on the holder at every frame. */
#define HANDOFF 100u
static int s_holder = -1;
static uint32_t s_holder_last;
static void default_select(uint32_t frame, const uint16_t *words, uint32_t n,
                           uint16_t pads[2]) {
    if (s_holder >= 0 && (uint32_t)s_holder < n && words[s_holder] != 0xFFFFu)
        s_holder_last = frame;
    if (s_holder < 0 || frame - s_holder_last >= HANDOFF) {
        for (uint32_t p = 0; p < n; p++) {
            if (words[p] != 0xFFFFu) { s_holder = (int)p; s_holder_last = frame; break; }
        }
    }
    pads[0] = (s_holder >= 0 && (uint32_t)s_holder < n) ? words[s_holder] : 0xFFFFu;
    pads[1] = 0xFFFFu;
    s_status[4] = (uint32_t)(s_holder + 1);
}

/* Game-specific selection hook (installed by a title plugin); default: the
 * first participant drives pad 0, the second pad 1. */
static psx_lockstep_select_fn s_select;
void psx_lockstep_set_select(psx_lockstep_select_fn fn) { s_select = fn; }

static int web_provider(uint32_t frame, uint16_t pads[2]) {
    const uint32_t i = frame % RING;
    double t0 = 0;
    if (frame < 3 || frame % 500u == 0u)
        emscripten_log(EM_LOG_CONSOLE, "psxrecomp: lockstep frame %u", (unsigned)frame);
    while (s_tag[i] != frame + 1u) {
        if (!t0) t0 = emscripten_get_now();
        emscripten_futex_wait((void *)&s_tag[i], s_tag[i], 50.0);
    }
    if (t0) s_wait_ms_total += (uint32_t)(emscripten_get_now() - t0);
    uint16_t words[MAXP];
    const uint32_t n = s_nplayers > MAXP ? MAXP : s_nplayers;
    for (uint32_t p = 0; p < MAXP; p++) words[p] = p < n ? s_words[i][p] : 0xFFFFu;
    if (s_select) {
        s_select(frame, words, n, pads);
    } else {
        default_select(frame, words, n, pads);
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
EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_lockstep_status(void) { return (uintptr_t)s_status; }
