/* WebAssembly lockstep input, owner-only. The page's lockstep worker
 * publishes each participant's pad word for each frame into a shared ring as
 * soon as it knows it (its own words a frame or two ahead, the others' when
 * they arrive). At each vblank boundary the emulation pthread asks the title
 * plugin whose pad the game reads now (a pure function of guest state) and
 * waits for that participant's word only: a turn-based game never waits for a
 * player who is not playing, so a slow or distant peer slows nobody but
 * themselves, and the player in control needs no input delay for the others'
 * sake. Every peer reads the same word on the same frame: same simulation.
 * One bound keeps it fair: a peer runs at most DRIFT frames ahead of any
 * other participant still there. A machine a little slower than the others
 * would otherwise fall behind for a whole round and make everyone wait for
 * it for many seconds when its turn comes; bounded, the session runs at the
 * pace of the slowest machine and a turn change waits at most DRIFT frames.
 * DRIFT is well above a word's travel time, so a distant peer on a working
 * link never slows anyone. */
#include "psx_lockstep.h"
#include "mod_plugins.h"

#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define RING 1024u
#define MAXP 4u
#define STRIDE MAXP
#define PRESENT 0xFFFFFFFFu
#define DRIFT 60u

/* s_tag[f % RING][p] = f + 1 once s_words[f % RING][p] is participant p's
 * word for frame f. s_gone_after[p]: last frame of a participant who left
 * (the server relays their words up to it, never after), PRESENT otherwise. */
static volatile uint32_t s_tag[RING][MAXP];
static volatile uint16_t s_words[RING][STRIDE];
static volatile uint32_t s_gone_after[MAXP] = { PRESENT, PRESENT, PRESENT, PRESENT };
static volatile uint32_t s_nplayers = 1;
/* Status block read by JS: cur_frame, digest_frame, digest, wait_ms_total,
 * holder+1 (0 = nobody), [5] team shown, [6] digest seqlock, [7] participant
 * waited for + 1 (0 = none). */
static volatile uint32_t s_status[8];
#define s_cur_frame s_status[0]
#define s_last_digest_frame s_status[1]
#define s_last_digest s_status[2]
#define s_wait_ms_total s_status[3]

static uint32_t s_host;
uint32_t psx_lockstep_host(void) { return s_host; }

static psx_lockstep_who_fn s_who;
void psx_lockstep_set_who(psx_lockstep_who_fn fn) { s_who = fn; }

/* frame_pacing.c: run the next frames unthrottled (this peer is behind the
 * player in control: their words are already here). */
extern volatile int g_psx_lockstep_hurry;

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

static int gone_at(uint32_t p, uint32_t frame) {
    const uint32_t a = s_gone_after[p];
    return a != PRESENT && a < frame;
}

/* First frame of this run of consecutive frames (0, or a snapshot's frame):
 * no participant's words exist before it. */
static uint32_t s_base, s_prev = 0xFFFFFFFFu;

/* Wait until participant p's word for frame g is here (or p has left).
 * Returns 1 when a snapshot load interrupts the wait. */
static int wait_word(uint32_t p, uint32_t g, double *t0) {
    const uint32_t i = g % RING;
    while (s_tag[i][p] < g + 1u && !gone_at(p, g)) {
        s_status[7] = p + 1u;
        if (mailbox() || psx_lockstep_loading()) return 1;
        if (!*t0) *t0 = emscripten_get_now();
        emscripten_futex_wait((void *)&s_tag[i][p], s_tag[i][p], 20.0);
    }
    return 0;
}

static int web_provider(uint32_t frame, uint16_t pads[2]) {
    const uint32_t i = frame % RING;
    if (frame != s_prev + 1u) s_base = frame;
    s_prev = frame;
    const uint32_t n = s_nplayers > MAXP ? MAXP : (s_nplayers ? s_nplayers : 1u);
    if (frame < 3 || frame % 500u == 0u)
        emscripten_log(EM_LOG_CONSOLE, "psxrecomp: lockstep frame %u", (unsigned)frame);
    uint32_t team = 0;
    const int pref = s_who ? s_who(frame, n, &team) : -1;
    /* Who drives: the named participant, else the host, else the first one
     * still there. One that left is known as such to every peer (the server
     * announces the last frame it relayed for them): same choice everywhere. */
    uint32_t chain[2 + MAXP], nc = 0;
    if (pref >= 0 && (uint32_t)pref < n) chain[nc++] = (uint32_t)pref;
    chain[nc++] = s_host < n ? s_host : 0u;
    for (uint32_t p = 0; p < n; p++) chain[nc++] = p;
    double t0 = 0;
    uint16_t word = 0xFFFFu;
    int who = -1;
    for (uint32_t k = 0; k < nc && who < 0; k++) {
        const uint32_t p = chain[k];
        if (wait_word(p, frame, &t0)) goto loading;
        if (s_tag[i][p] == frame + 1u) { word = s_words[i][p]; who = (int)p; }
    }
    /* Never more than DRIFT frames ahead of anyone still there. */
    if (frame >= s_base + DRIFT)
        for (uint32_t p = 0; p < n; p++)
            if ((int)p != who && wait_word(p, frame - DRIFT, &t0)) goto loading;
    s_status[7] = 0;
    (void)mailbox();
    if (t0) s_wait_ms_total += (uint32_t)(emscripten_get_now() - t0);
    pads[0] = word;
    pads[1] = 0xFFFFu;
    s_status[4] = (uint32_t)(who + 1);
    s_status[5] = team;
    /* Behind the player in control (their words for the next frames are
     * already here): catch up unthrottled. */
    g_psx_lockstep_hurry = who >= 0 && s_tag[(frame + 3u) % RING][who] == frame + 4u;
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
loading:
    /* A snapshot replaces this machine at the next safe point: run on with
     * neutral pads until then (the frame numbering restarts at the
     * snapshot's). */
    s_status[7] = 0;
    pads[0] = pads[1] = 0xFFFFu;
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
EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_lockstep_gone(void) { return (uintptr_t)s_gone_after; }

/* Guest RAM word, for the page's diagnostics and tests (read-only). */
EMSCRIPTEN_KEEPALIVE uint32_t psx_web_peek32(uint32_t addr) { return psx_mod_read_word(addr); }
/* Tests only (single player): store a guest word from the page's thread. */
EMSCRIPTEN_KEEPALIVE void psx_web_poke32(uint32_t addr, uint32_t value) { psx_mod_write_word(addr, value); }
