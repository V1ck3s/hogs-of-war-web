#include "psx_lockstep.h"
#include "gpu.h"
#include "crc32.h"
#include "psx_memory.h"
#include "sio.h"
#include "savestate.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern uint8_t *g_psx_ram;

static psx_lockstep_provider_fn s_provider;
static uint32_t s_frame;

void psx_lockstep_set_provider(psx_lockstep_provider_fn fn) { s_provider = fn; s_frame = 0; }
int psx_lockstep_active(void) { return s_provider != NULL; }
uint32_t psx_lockstep_frame(void) { return s_frame; }

/* The retail 2 MB only: with the 8 MB main RAM the rest holds what games
 * derive from it (e.g. GPU packets), and hashing 8 MB on the emulation
 * thread every digest would cost a frame's worth of time in the browser. */
uint32_t psx_lockstep_ram_digest(void) {
    const uint32_t n = g_psx_ram_size < 0x200000u ? g_psx_ram_size : 0x200000u;
    return g_psx_ram ? crc32_compute(g_psx_ram, n) : 0u;
}

/* ---- snapshots (late join) ---------------------------------------------- */
#define LS_SNAP_SLOT (SAVESTATE_SLOTS - 1)
static int      s_snap;                    /* 0 idle, 1 saving, 2 saved, -1 failed */
static uint32_t s_snap_at = UINT32_MAX;    /* boundary that triggers the save */
static uint32_t s_snap_frame;              /* boundary index after the snapshot */
static int      s_loading;
static uint32_t s_load_frame;

void psx_lockstep_request_snapshot(uint32_t frame) { s_snap_at = frame; s_snap = 0; }
int psx_lockstep_snapshot_status(uint32_t *frame) {
    if (frame) *frame = s_snap_frame;
    return s_snap;
}
int psx_lockstep_snapshot_path(char *out, size_t cap) {
    return savestate_slot_path(LS_SNAP_SLOT, out, cap);
}
int psx_lockstep_load_snapshot(const void *data, size_t size, uint32_t frame) {
    if (!savestate_request_load_blob_protocol(data, size)) return 0;
    (void)savestate_take_load_completed();
    (void)savestate_take_load_failed();
    s_loading = 1;
    s_load_frame = frame;
    return 1;
}
int psx_lockstep_loading(void) { return s_loading; }

/* Snapshot bookkeeping at a boundary. Returns 0 when the boundary must be
 * skipped (a staged load has not run yet: its state replaces this one). */
static int snapshot_boundary(void) {
    if (s_loading) {
        if (savestate_take_load_completed()) {
            s_loading = 0;
            s_frame = s_load_frame;   /* this boundary is the snapshot's next */
        } else if (savestate_take_load_failed()) {
            s_loading = 0;
            fprintf(stderr, "psxrecomp: lockstep snapshot load failed\n");
        } else {
            return 0;
        }
    }
    if (s_snap == 1 && !savestate_pending())
        s_snap = savestate_take_save_failed() ? -1 : 2;
    return 1;
}

void psx_lockstep_boundary(void) {
    uint16_t pads[2] = { 0xFFFFu, 0xFFFFu };
    if (!s_provider) return;
    if (!snapshot_boundary()) return;
    if (!s_provider(s_frame, pads)) { s_provider = NULL; return; }
    sio_set_pad_state_slot(0, pads[0]);
    sio_set_pad_state_slot(1, pads[1]);
    s_frame++;
    if (s_frame == s_snap_at) {
        /* Runs at the next safe point, before the next boundary: the state
         * is "pads of frame s_frame-1 applied, boundary s_frame next". */
        s_snap_at = UINT32_MAX;
        (void)savestate_take_save_failed();
        if (savestate_request_save_protocol(LS_SNAP_SLOT)) { s_snap = 1; s_snap_frame = s_frame; }
        else s_snap = -1;
    }
}

/* ---- native harness: script + digest log ------------------------------- */
typedef struct { uint32_t frame; uint16_t w0, w1; } ScriptRow;
static ScriptRow *s_rows;
static size_t s_nrows, s_row;
static uint16_t s_cur[2] = { 0xFFFFu, 0xFFFFu };
static FILE *s_digest;
static uint32_t s_digest_every = 50, s_end;
static uint32_t s_dumps[256];
static size_t s_ndumps;
static const char *s_dump_dir;

/* PSX_LOCKSTEP_SNAP_SAVE=F + PSX_LOCKSTEP_SNAP_OUT=file: snapshot at boundary
 * F, copy it to file, then reload it (as every peer does when a player
 * joins). PSX_LOCKSTEP_SNAP_LOAD=file:F: boot, load that snapshot, continue
 * from boundary F (the joining player). Same script, same digests expected. */
static const char *s_h_out, *s_h_load;
static uint32_t s_h_load_frame;
static int s_h_reloaded, s_h_loaded;

static uint8_t *read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *b = n > 0 ? (uint8_t *)malloc((size_t)n) : NULL;
    if (b && fread(b, 1, (size_t)n, f) != (size_t)n) { free(b); b = NULL; }
    fclose(f);
    *len = b ? (size_t)n : 0;
    return b;
}

static void harness_snapshots(uint32_t frame) {
    uint32_t sf = 0;
    if (s_h_load && !s_h_loaded && frame >= 10) {
        size_t n = 0;
        uint8_t *b = read_file(s_h_load, &n);
        s_h_loaded = 1;
        if (b && psx_lockstep_load_snapshot(b, n, s_h_load_frame))
            fprintf(stderr, "psxrecomp: lockstep loading %s (%zu bytes) as frame %u\n", s_h_load, n, (unsigned)s_h_load_frame);
        else
            fprintf(stderr, "psxrecomp: lockstep cannot load %s\n", s_h_load);
        free(b);
    }
    static uint32_t s_h_delay = UINT32_MAX;
    if (s_h_delay == UINT32_MAX) {
        const char *d = getenv("PSX_LOCKSTEP_SNAP_RELOAD_AFTER");   /* frames */
        s_h_delay = d ? (uint32_t)strtoul(d, NULL, 10) : 0u;
    }
    if (!s_h_reloaded && psx_lockstep_snapshot_status(&sf) == 2 && frame >= sf + s_h_delay) {
        char path[600];
        size_t n = 0;
        uint8_t *b = psx_lockstep_snapshot_path(path, sizeof path) ? read_file(path, &n) : NULL;
        s_h_reloaded = 1;
        if (b && s_h_out) { FILE *o = fopen(s_h_out, "wb"); if (o) { fwrite(b, 1, n, o); fclose(o); } }
        if (b && psx_lockstep_load_snapshot(b, n, sf))
            fprintf(stderr, "psxrecomp: lockstep snapshot of frame %u (%zu bytes) saved, reloading\n", (unsigned)sf, n);
        else
            fprintf(stderr, "psxrecomp: lockstep snapshot reload failed\n");
        free(b);
    }
}

/* PSX_LOCKSTEP_UNPACED=1: the scripted run is not held to the guest's frame
 * rate (benchmarks: how long the same frames take to compute). */
extern volatile int g_psx_lockstep_hurry;
static int s_unpaced;

static int script_provider(uint32_t frame, uint16_t pads[2]) {
    harness_snapshots(frame);
    g_psx_lockstep_hurry = s_unpaced;
    while (s_row < s_nrows && s_rows[s_row].frame <= frame) {
        s_cur[0] = s_rows[s_row].w0;
        s_cur[1] = s_rows[s_row].w1;
        s_row++;
    }
    pads[0] = s_cur[0];
    pads[1] = s_cur[1];
    if (s_digest && frame % s_digest_every == 0) {
        fprintf(s_digest, "%u %08x\n", (unsigned)frame, (unsigned)psx_lockstep_ram_digest());
        fflush(s_digest);
    }
    for (size_t d = 0; d < s_ndumps; d++) {
        if (s_dumps[d] == frame && s_dump_dir && g_psx_ram) {
            char path[512];
            snprintf(path, sizeof path, "%s/ram_%06u.bin", s_dump_dir, (unsigned)frame);
            FILE *f = fopen(path, "wb");
            if (f) { fwrite(g_psx_ram, 1, g_psx_ram_size, f); fclose(f); }
            /* VRAM too (1024x512 BGR555), to see which screen a RAM image
             * belongs to. */
            snprintf(path, sizeof path, "%s/vram_%06u.bin", s_dump_dir, (unsigned)frame);
            f = fopen(path, "wb");
            if (f) {
                static uint16_t row[1024];
                for (int y = 0; y < 512; y++) {
                    for (int x = 0; x < 1024; x++) row[x] = gpu_vram_peek(x, y);
                    fwrite(row, 2, 1024, f);
                }
                fclose(f);
            }
        }
    }
    if (s_end && frame >= s_end) {
        if (s_digest) fclose(s_digest);
        fprintf(stderr, "psxrecomp: lockstep script reached frame %u, exiting\n", (unsigned)frame);
        exit(0);
    }
    return 1;
}

#if defined(PSX_WEB)
void psx_web_lockstep_enable(uint32_t nplayers);
void psx_web_lockstep_set_host(uint32_t index);
#endif

void psx_lockstep_init_from_env(void) {
#if defined(PSX_WEB)
    /* Browser session: the page sets PSX_WEB_LOCKSTEP=<players> before main. */
    const char *web = getenv("PSX_WEB_LOCKSTEP");
    if (web && atoi(web) > 0) {
        fprintf(stderr, "psxrecomp: web lockstep, %d participant(s)\n", atoi(web));
        const char *host = getenv("PSX_WEB_LOCKSTEP_HOST");
        psx_web_lockstep_set_host(host ? (uint32_t)atoi(host) : 0u);
        psx_web_lockstep_enable((uint32_t)atoi(web));
        return;
    }
#endif
    const char *script = getenv("PSX_LOCKSTEP_SCRIPT");
    const char *digest = getenv("PSX_LOCKSTEP_DIGEST");
    const char *every = getenv("PSX_LOCKSTEP_DIGEST_EVERY");
    const char *end = getenv("PSX_LOCKSTEP_END");
    if (!script && !digest) return;
    if (script) {
        FILE *f = fopen(script, "r");
        char line[128];
        size_t cap = 0;
        if (!f) { fprintf(stderr, "psxrecomp: cannot open %s\n", script); return; }
        while (fgets(line, sizeof line, f)) {
            unsigned fr, a, b = 0xFFFFu;
            if (line[0] == '#' || sscanf(line, "%u %x %x", &fr, &a, &b) < 2) continue;
            if (s_nrows == cap) {
                cap = cap ? cap * 2 : 256;
                s_rows = (ScriptRow *)realloc(s_rows, cap * sizeof *s_rows);
            }
            s_rows[s_nrows].frame = fr;
            s_rows[s_nrows].w0 = (uint16_t)a;
            s_rows[s_nrows].w1 = (uint16_t)b;
            s_nrows++;
        }
        fclose(f);
    }
    if (digest) s_digest = fopen(digest, "w");
    if (every && atoi(every) > 0) s_digest_every = (uint32_t)atoi(every);
    if (end) s_end = (uint32_t)strtoul(end, NULL, 10);
    {
        const char *u = getenv("PSX_LOCKSTEP_UNPACED");
        s_unpaced = u && u[0] && u[0] != '0';
    }
    /* PSX_LOCKSTEP_DUMP=f1,f2,... + PSX_LOCKSTEP_DUMP_DIR: RAM images at
     * exact frames (reverse engineering by diffing deterministic runs). */
    {
        const char *dumps = getenv("PSX_LOCKSTEP_DUMP");
        s_dump_dir = getenv("PSX_LOCKSTEP_DUMP_DIR");
        while (dumps && *dumps && s_ndumps < 256) {
            char *e;
            s_dumps[s_ndumps++] = (uint32_t)strtoul(dumps, &e, 10);
            dumps = *e ? e + 1 : e;
        }
    }
    if (getenv("PSX_LOCKSTEP_SNAP_SAVE")) {
        psx_lockstep_request_snapshot((uint32_t)strtoul(getenv("PSX_LOCKSTEP_SNAP_SAVE"), NULL, 10));
        s_h_out = getenv("PSX_LOCKSTEP_SNAP_OUT");
    }
    if (getenv("PSX_LOCKSTEP_SNAP_LOAD")) {
        static char spec[600];
        snprintf(spec, sizeof spec, "%s", getenv("PSX_LOCKSTEP_SNAP_LOAD"));
        char *c = strrchr(spec, ':');
        if (c) { *c = 0; s_h_load = spec; s_h_load_frame = (uint32_t)strtoul(c + 1, NULL, 10); }
    }
    fprintf(stderr, "psxrecomp: lockstep script %s (%zu rows), digest %s every %u\n",
            script ? script : "-", s_nrows, digest ? digest : "-", (unsigned)s_digest_every);
    psx_lockstep_set_provider(script_provider);
}
