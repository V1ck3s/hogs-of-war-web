#include "psx_lockstep.h"
#include "crc32.h"
#include "psx_memory.h"
#include "sio.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern uint8_t *g_psx_ram;

static psx_lockstep_provider_fn s_provider;
static uint32_t s_frame;

void psx_lockstep_set_provider(psx_lockstep_provider_fn fn) { s_provider = fn; s_frame = 0; }
int psx_lockstep_active(void) { return s_provider != NULL; }
uint32_t psx_lockstep_frame(void) { return s_frame; }

uint32_t psx_lockstep_ram_digest(void) {
    return g_psx_ram ? crc32_compute(g_psx_ram, g_psx_ram_size) : 0u;
}

void psx_lockstep_boundary(void) {
    uint16_t pads[2] = { 0xFFFFu, 0xFFFFu };
    if (!s_provider) return;
    if (!s_provider(s_frame, pads)) { s_provider = NULL; return; }
    sio_set_pad_state_slot(0, pads[0]);
    sio_set_pad_state_slot(1, pads[1]);
    s_frame++;
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

static int script_provider(uint32_t frame, uint16_t pads[2]) {
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
    fprintf(stderr, "psxrecomp: lockstep script %s (%zu rows), digest %s every %u\n",
            script ? script : "-", s_nrows, digest ? digest : "-", (unsigned)s_digest_every);
    psx_lockstep_set_provider(script_provider);
}
