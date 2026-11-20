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
 * link never slows anyone.
 * Watching: a peer that follows another participant's turn receives their
 * words in small bursts, at the mercy of the network. Played as they come,
 * every late burst is a visible stall followed by a rush. Such a peer keeps a
 * few words in hand instead (two, plus one more for each recent stall, given
 * back when the link has been steady for a while) and holds that level by
 * running a few percent faster or slower: the picture stays even, a fraction
 * of a second behind the player. Purely local pacing: which word goes to
 * which frame never changes. */
#include "psx_lockstep.h"
#include "psx_lockstep_playout.h"
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
 * waited for + 1 (0 = none); watching: [8] words in hand (low point of the
 * last frames), [9] level aimed at, [10] times the words ran out, [11] pace
 * (16.16 of the guest's period, 0 = guest's own, 1 = unthrottled);
 * [12] frames timed, [13] frames that came more than 1.5 periods after the
 * previous one, [14] more than 3 periods, [15] longest gap (ms). */
static volatile uint32_t s_status[16];
#define s_cur_frame s_status[0]
#define s_last_digest_frame s_status[1]
#define s_last_digest s_status[2]
#define s_wait_ms_total s_status[3]

static uint32_t s_host;
uint32_t psx_lockstep_host(void) { return s_host; }

static psx_lockstep_who_fn s_who;
void psx_lockstep_set_who(psx_lockstep_who_fn fn) { s_who = fn; }

/* frame_pacing.c: run the next frames unthrottled (this peer is far behind
 * the player in control: their words are already here), or at a period a few
 * percent off the guest's (watching, see the head of this file). */
extern volatile int g_psx_lockstep_hurry;
extern volatile uint32_t g_psx_lockstep_pace_q16;
extern volatile int g_psx_lockstep_watching, g_psx_lockstep_frame_late;

/* This peer's participant index (a spectator has none). Its own turns are
 * paced by the guest alone: its words are published as it goes. */
static volatile uint32_t s_me = 0xFFFFFFFFu;
/* 0: watching is played as the words come (tests, comparisons). */
static volatile uint32_t s_playout = 1;

static PsxPlayout s_play = { .who = -2 };

/* Words of participant p known from `frame` on (this frame's included). */
static uint32_t words_in_hand(uint32_t p, uint32_t frame) {
    uint32_t k = 0;
    while (k < 64u && s_tag[(frame + k) % RING][p] == frame + k + 1u) k++;
    return k;
}

/* Pace of this frame. `waited`: the word of the participant in control was
 * not there yet when the game asked for it (which is before the frame is
 * due); the words ran out only if the frame then started late. */
static int s_play_waited;
static void playout(uint32_t frame, int who, int waited) {
    if (who < 0 || (uint32_t)who == s_me || !s_playout) {
        /* Own turn (or nobody's): the guest's pace. Kept: unthrottled when
         * someone else's words are far ahead (a replay, or playout off). */
        g_psx_lockstep_pace_q16 = 0;
        g_psx_lockstep_watching = 0;
        g_psx_lockstep_hurry = who >= 0 && (uint32_t)who != s_me &&
                               s_tag[(frame + 3u) % RING][who] == frame + 4u;
        psx_playout_reset(&s_play);
        s_play_waited = 0;
        s_status[8] = s_status[9] = 0;
        s_status[11] = g_psx_lockstep_hurry ? PSX_PLAYOUT_UNPACED : PSX_PLAYOUT_OWN;
        return;
    }
    const int dry = s_play_waited && g_psx_lockstep_frame_late;
    const uint32_t pace = psx_playout_step(&s_play, frame, who,
                                           words_in_hand((uint32_t)who, frame), dry);
    s_play_waited = waited;
    g_psx_lockstep_watching = 1;
    g_psx_lockstep_hurry = pace == PSX_PLAYOUT_UNPACED;
    g_psx_lockstep_pace_q16 = pace > PSX_PLAYOUT_UNPACED ? pace : 0u;
    s_status[8] = s_play.low;
    s_status[9] = s_play.level;
    s_status[10] = s_play.dry;
    s_status[11] = pace;
}

/* How evenly the frames follow one another on this peer (wall time between
 * two frames taken by the game), for the page's reports. */
static double s_frame_at;
static void time_frame(void) {
    const double now = emscripten_get_now();
    if (s_frame_at > 0) {
        const double gap = now - s_frame_at;
        s_status[12]++;
        if (gap > 30.0) s_status[13]++;
        if (gap > 60.0) s_status[14]++;
        if (gap > (double)s_status[15]) s_status[15] = gap > 60000.0 ? 60000u : (uint32_t)gap;
    }
    s_frame_at = now;
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
    /* The word of the participant in control was not there in time. */
    const int dry = t0 != 0;
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
    playout(frame, who, dry);
    time_frame();
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
/* The page tells which participant this peer is (0xFFFFFFFF: a spectator)
 * and whether watching is smoothed (1) or played as the words come (0). */
EMSCRIPTEN_KEEPALIVE void psx_web_lockstep_set_me(uint32_t index) { s_me = index; }
EMSCRIPTEN_KEEPALIVE void psx_web_lockstep_set_playout(uint32_t on) { s_playout = on; }
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

/* Interpreted-code profile, for the page's tests (read-only, racy snapshot):
 * fills a buffer with [count, then per PC: pc, insns (low 32 bits), occ_crc,
 * occ_ok] for the dirty-RAM interpreter's busiest entry PCs, so a test can
 * diff two snapshots and name the code that still runs interpreted. */
#include "dirty_ram_interp.h"
#define DIRTY_SNAP_MAX 16384u
static uint32_t s_dirty_snap[1 + 4 * DIRTY_SNAP_MAX];
EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_dirty_pcs(void) {
    uint32_t n = 0;
    for (uint32_t i = 0; i < DIRTY_RAM_PC_TABLE_SIZE && n < DIRTY_SNAP_MAX; i++) {
        const DirtyRamPcEntry *e = &g_dirty_ram_pc_table[i];
        if (e->pc == 0 || e->insns < 1000u) continue;
        uint32_t *row = &s_dirty_snap[1 + 4 * n++];
        row[0] = e->pc;
        row[1] = (uint32_t)e->insns;
        row[2] = e->occ_crc;
        row[3] = e->occ_ok;
    }
    s_dirty_snap[0] = n;
    return (uintptr_t)s_dirty_snap;
}
