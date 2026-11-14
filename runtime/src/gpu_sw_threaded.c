/*
 * gpu_sw_threaded.c — software renderer with presentation on its own thread.
 *
 * The plain software backend rasterizes every primitive up to three times on
 * the emulation thread: into native VRAM (what the game reads back), into the
 * supersampled mirror and into the native-wide surface. At 4x in 32:9 the two
 * presentation copies cost far more than the game itself, and in a lockstep
 * session the slowest participant sets everybody's pace.
 *
 * This backend splits the work:
 *   - emulation thread: the native rasterizer (gpu_sw_renderer.c) at 1x and
 *     without wide surfaces, on the authoritative VRAM — exactly the native
 *     VRAM of the plain backend, so guest state never depends on the picture
 *     quality;
 *   - presentation thread: a second rasterizer instance (gpu_sw_renderer_hr.c)
 *     with its own VRAM copy, replaying every state change, primitive and
 *     VRAM transfer from a command ring at the requested scale with the wide
 *     surfaces, then reading the finished picture out at each present.
 * Reads (VRAM→CPU transfers, single-pixel reads, draw area) are answered by
 * the native instance at once. The ring applies back-pressure when the
 * presentation thread falls a whole ring behind.
 *
 * Presents are deferred: render_display_hires / render_wide_display queue a
 * read-out and the page receives the picture from the presentation thread
 * (psx_web_publish_frame → swt_publish). Browser build only.
 */
#include "gpu_render.h"
#include "gpu_sw_renderer.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ---- presentation instance (gpu_sw_renderer_hr.c) ---------------------- */
void swhr_renderer_init(uint16_t *vram);
void swhr_renderer_set_scale(int scale);
void swhr_set_precise_triangle(int e, int32_t, int32_t, int32_t, int32_t, int32_t, int32_t);
void swhr_set_perspective_triangle(int e, float, float, float);
void swhr_set_texture_filter(int bilinear);
void swhr_set_semi_transparency(int enabled, int mode);
void swhr_set_mask_bits(int set_bit, int check_bit);
void swhr_set_texture_window(uint32_t raw);
void swhr_set_color_modulation(int r, int g, int b, int raw_texture);
void swhr_fill_rect(int x, int y, int w, int h, uint16_t color);
void swhr_copy_rect(int sx, int sy, int dx, int dy, int w, int h);
void swhr_draw_flat_triangle(int, int, int, int, int, int, uint16_t);
void swhr_draw_gouraud_triangle(int, int, uint16_t, int, int, uint16_t, int, int, uint16_t);
void swhr_draw_textured_triangle(int, int, int, int, int, int, int, int, int, int, int, int,
                                 uint16_t, uint16_t, uint16_t);
void swhr_draw_shaded_textured_triangle(int, int, int, int, uint32_t, int, int, int, int, uint32_t,
                                        int, int, int, int, uint32_t, uint16_t, uint16_t, uint16_t, int);
void swhr_draw_flat_rect(int x, int y, int w, int h, uint16_t color);
void swhr_draw_textured_rect(int, int, int, int, int, int, uint16_t, uint16_t, uint16_t);
void swhr_draw_textured_rect_scaled(int, int, int, int, int, int, int, int, uint16_t, uint16_t, uint16_t);
void swhr_draw_line(int, int, int, int, uint16_t);
void swhr_draw_shaded_line(int, int, uint16_t, int, int, uint16_t);
int  swhr_render_display_hires(uint32_t *out, int pitch, int dx, int dy, int dw, int dh);
void swhr_vram_write(int x, int y, uint16_t pixel);
void swhr_vram_transfer_in(int x, int y, int w, int h, const uint16_t *data);
void swhr_set_draw_area(int x1, int y1, int x2, int y2);
void swhr_set_draw_offset(int x, int y);
void swhr_wide_configure(int wide_w, int offset);
void swhr_wide_set_target(int base_x);
void swhr_wide_disable_target(void);
void swhr_wide_clear(int base_x, int y, int h, uint16_t color);
void swhr_wide_clear_margins(int base_x, int y, int h, uint16_t color, int sides);
int  swhr_render_wide_display(uint32_t *out, int pitch, int base_x, int disp_y, int disp_h);
int  swhr_wide_dump_full(uint32_t *out, int cap, int *ow, int *oh, int base_x);
void swhr_set_present_skip(int on);

/* Backdrop decision replayed into the presentation instance. */
int g_swhr_bd_on = 0;
int g_swhr_bd_pct = 0;
int swhr_prim_in_backdrop(void) { return 1; }   /* g_swhr_bd_on carries it */
extern int psx_ws_prim_in_backdrop(void);
extern int g_ws_bd_stretch_on, g_ws_bd_stretch_pct;

/* Page side (web_present.c). */
uint32_t *psx_web_back_buffer(size_t *cap_pixels);
void psx_web_commit_frame(int w, int h, int logical_w, int dst_w, int dst_h,
                          int content_h, int nearest);

/* ---- command ring (single producer, single consumer) ------------------ */
enum {
    OP_WRAP = 1, OP_SCALE, OP_FILTER, OP_SEMI, OP_MASK, OP_TW, OP_MOD, OP_PRECISE,
    OP_PERSP, OP_FILL, OP_COPY, OP_FLAT_TRI, OP_GOUR_TRI, OP_TEX_TRI, OP_STEX_TRI,
    OP_FLAT_RECT, OP_TEX_RECT, OP_TEX_RECT_SCALED, OP_LINE, OP_SLINE, OP_PIXEL,
    OP_XFER_IN, OP_AREA, OP_OFFSET, OP_WIDE_CONF, OP_WIDE_TARGET, OP_WIDE_OFF,
    OP_WIDE_CLEAR, OP_WIDE_MARGINS, OP_BD, OP_READ_HIRES, OP_READ_WIDE,
    OP_PUBLISH, OP_PUBLISH_PIXELS,
};

#define RING_BYTES (24u << 20)
typedef struct { uint32_t op, bytes; } RecHdr;   /* bytes: whole record, 8-aligned */

static uint8_t        *s_ring;
static _Atomic uint32_t s_head;      /* producer position (monotonic, wraps at 2^32) */
static _Atomic uint32_t s_tail;      /* consumer position */
static _Atomic int      s_cons_sleep, s_prod_sleep;
static pthread_mutex_t  s_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t   s_cv_data = PTHREAD_COND_INITIALIZER;
static pthread_cond_t   s_cv_space = PTHREAD_COND_INITIALIZER;
static pthread_t        s_thread;
static int              s_started;

static uint32_t rec_reserve_pos;
static uint32_t rec_reserve_size;

static void wait_space(uint32_t need) {
    for (;;) {
        uint32_t used = atomic_load(&s_head) - atomic_load(&s_tail);
        if (RING_BYTES - used >= need) return;
        pthread_mutex_lock(&s_mu);
        atomic_store(&s_prod_sleep, 1);
        used = atomic_load(&s_head) - atomic_load(&s_tail);
        if (RING_BYTES - used < need) pthread_cond_wait(&s_cv_space, &s_mu);
        atomic_store(&s_prod_sleep, 0);
        pthread_mutex_unlock(&s_mu);
    }
}

/* Reserves a record with `payload` bytes after the header; returns the
 * payload pointer. Must be followed by rec_commit(). */
static void *rec_begin(uint32_t op, uint32_t payload) {
    uint32_t size = (uint32_t)((sizeof(RecHdr) + payload + 7u) & ~7u);
    uint32_t head = atomic_load_explicit(&s_head, memory_order_relaxed);
    uint32_t pos = head % RING_BYTES;
    uint32_t contig = RING_BYTES - pos;
    if (contig < size) {                     /* pad to the start of the ring */
        wait_space(contig);
        RecHdr *w = (RecHdr *)(s_ring + pos);
        w->op = OP_WRAP; w->bytes = contig;
        head += contig;
        atomic_store(&s_head, head);
        if (atomic_load(&s_cons_sleep)) {
            pthread_mutex_lock(&s_mu); pthread_cond_signal(&s_cv_data); pthread_mutex_unlock(&s_mu);
        }
        pos = 0;
    }
    wait_space(size);
    RecHdr *h = (RecHdr *)(s_ring + pos);
    h->op = op; h->bytes = size;
    rec_reserve_pos = head;
    rec_reserve_size = size;
    return h + 1;
}

static void rec_commit(void) {
    atomic_store(&s_head, rec_reserve_pos + rec_reserve_size);
    if (atomic_load(&s_cons_sleep)) {
        pthread_mutex_lock(&s_mu); pthread_cond_signal(&s_cv_data); pthread_mutex_unlock(&s_mu);
    }
}

static void rec_args(uint32_t op, int n, const int32_t *a) {
    int32_t *p = (int32_t *)rec_begin(op, (uint32_t)n * 4u);
    memcpy(p, a, (size_t)n * 4u);
    rec_commit();
}
#define REC(op, ...) do { const int32_t a_[] = { __VA_ARGS__ }; \
    rec_args(op, (int)(sizeof a_ / sizeof a_[0]), a_); } while (0)

/* ---- presentation thread ------------------------------------------------ */
static uint16_t *s_hr_vram;
static int       s_read_w, s_read_h;  /* last read-out size (pixels) */
static int       s_read_ok;
/* Frames (present read-outs) queued by the emulation thread / run here. When
 * another whole frame is already waiting at the end of one, the presentation
 * thread is behind: it runs the next frame for native VRAM only (cheap) and
 * does not show it, so a slow picture never slows the game. */
static _Atomic uint32_t s_frames_queued;
static uint32_t         s_frames_done;
static int              s_skipping;

static void run_record(const RecHdr *h) {
    const int32_t *a = (const int32_t *)(h + 1);
    switch (h->op) {
    case OP_SCALE:   swhr_renderer_set_scale(a[0]); break;
    case OP_FILTER:  swhr_set_texture_filter(a[0]); break;
    case OP_SEMI:    swhr_set_semi_transparency(a[0], a[1]); break;
    case OP_MASK:    swhr_set_mask_bits(a[0], a[1]); break;
    case OP_TW:      swhr_set_texture_window((uint32_t)a[0]); break;
    case OP_MOD:     swhr_set_color_modulation(a[0], a[1], a[2], a[3]); break;
    case OP_PRECISE: swhr_set_precise_triangle(a[0], a[1], a[2], a[3], a[4], a[5], a[6]); break;
    case OP_PERSP: {
        float q[3]; memcpy(q, a + 1, sizeof q);
        swhr_set_perspective_triangle(a[0], q[0], q[1], q[2]);
        break;
    }
    case OP_FILL:    swhr_fill_rect(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_COPY:    swhr_copy_rect(a[0], a[1], a[2], a[3], a[4], a[5]); break;
    case OP_FLAT_TRI:
        swhr_draw_flat_triangle(a[0], a[1], a[2], a[3], a[4], a[5], (uint16_t)a[6]); break;
    case OP_GOUR_TRI:
        swhr_draw_gouraud_triangle(a[0], a[1], (uint16_t)a[2], a[3], a[4], (uint16_t)a[5],
                                   a[6], a[7], (uint16_t)a[8]); break;
    case OP_TEX_TRI:
        swhr_draw_textured_triangle(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7],
                                    a[8], a[9], a[10], a[11],
                                    (uint16_t)a[12], (uint16_t)a[13], (uint16_t)a[14]); break;
    case OP_STEX_TRI:
        swhr_draw_shaded_textured_triangle(a[0], a[1], a[2], a[3], (uint32_t)a[4],
                                           a[5], a[6], a[7], a[8], (uint32_t)a[9],
                                           a[10], a[11], a[12], a[13], (uint32_t)a[14],
                                           (uint16_t)a[15], (uint16_t)a[16], (uint16_t)a[17],
                                           a[18]); break;
    case OP_FLAT_RECT: swhr_draw_flat_rect(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_TEX_RECT:
        swhr_draw_textured_rect(a[0], a[1], a[2], a[3], a[4], a[5],
                                (uint16_t)a[6], (uint16_t)a[7], (uint16_t)a[8]); break;
    case OP_TEX_RECT_SCALED:
        swhr_draw_textured_rect_scaled(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7],
                                       (uint16_t)a[8], (uint16_t)a[9], (uint16_t)a[10]); break;
    case OP_LINE:  swhr_draw_line(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_SLINE: swhr_draw_shaded_line(a[0], a[1], (uint16_t)a[2], a[3], a[4], (uint16_t)a[5]); break;
    case OP_PIXEL: swhr_vram_write(a[0], a[1], (uint16_t)a[2]); break;
    case OP_XFER_IN:
        swhr_vram_transfer_in(a[0], a[1], a[2], a[3], (const uint16_t *)(a + 4)); break;
    case OP_AREA:   swhr_set_draw_area(a[0], a[1], a[2], a[3]); break;
    case OP_OFFSET: swhr_set_draw_offset(a[0], a[1]); break;
    case OP_WIDE_CONF:   swhr_wide_configure(a[0], a[1]); break;
    case OP_WIDE_TARGET: swhr_wide_set_target(a[0]); break;
    case OP_WIDE_OFF:    swhr_wide_disable_target(); break;
    case OP_WIDE_CLEAR:  if (!s_skipping) swhr_wide_clear(a[0], a[1], a[2], (uint16_t)a[3]); break;
    case OP_WIDE_MARGINS: if (!s_skipping) swhr_wide_clear_margins(a[0], a[1], a[2], (uint16_t)a[3], a[4]); break;
    case OP_BD: g_swhr_bd_on = a[0]; g_swhr_bd_pct = a[1]; break;
    case OP_READ_HIRES:
    case OP_READ_WIDE: {
        /* a: pitch, then the read-out's own arguments; rows = a[last] * scale */
        size_t cap = 0;
        uint32_t *dst = psx_web_back_buffer(&cap);
        const int pitch = a[0];
        const int rows = h->op == OP_READ_WIDE ? a[3] * a[4] : a[4] * a[5];
        s_read_ok = 0;
        const int was_skipped = s_skipping;
        s_frames_done++;
        s_skipping = atomic_load(&s_frames_queued) - s_frames_done >= 1u;
        swhr_set_present_skip(s_skipping);
        if (was_skipped) break;
        if (!dst || pitch <= 0 || rows <= 0 || (size_t)(pitch / 4) * (size_t)rows > cap) break;
        int n = h->op == OP_READ_WIDE
            ? swhr_render_wide_display(dst, pitch, a[1], a[2], a[3])
            : swhr_render_display_hires(dst, pitch, a[1], a[2], a[3], a[4]);
        s_read_ok = n > 0;
        s_read_w = pitch / 4; s_read_h = rows;
        break;
    }
    case OP_PUBLISH:
        if (s_read_ok) psx_web_commit_frame(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
        s_read_ok = 0;
        break;
    case OP_PUBLISH_PIXELS: {
        size_t cap = 0;
        uint32_t *dst = psx_web_back_buffer(&cap);
        const size_t n = (size_t)a[0] * (size_t)a[1];
        if (dst && n <= cap) {
            memcpy(dst, a + 7, n * 4u);
            psx_web_commit_frame(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
        }
        s_read_ok = 0;
        break;
    }
    default: break;
    }
}

static void *present_thread(void *arg) {
    (void)arg;
    for (;;) {
        uint32_t tail = atomic_load(&s_tail);
        uint32_t head = atomic_load(&s_head);
        if (tail == head) {
            pthread_mutex_lock(&s_mu);
            atomic_store(&s_cons_sleep, 1);
            if (atomic_load(&s_head) == tail) pthread_cond_wait(&s_cv_data, &s_mu);
            atomic_store(&s_cons_sleep, 0);
            pthread_mutex_unlock(&s_mu);
            continue;
        }
        const RecHdr *h = (const RecHdr *)(s_ring + tail % RING_BYTES);
        if (h->op != OP_WRAP) run_record(h);
        atomic_store(&s_tail, tail + h->bytes);
        if (atomic_load(&s_prod_sleep)) {
            pthread_mutex_lock(&s_mu); pthread_cond_signal(&s_cv_space); pthread_mutex_unlock(&s_mu);
        }
    }
    return NULL;
}

/* Waits until the presentation thread has run every queued record. */
static void drain(void) {
    while (atomic_load(&s_tail) != atomic_load(&s_head)) {
        if (atomic_load(&s_cons_sleep) && atomic_load(&s_tail) != atomic_load(&s_head)) {
            pthread_mutex_lock(&s_mu); pthread_cond_signal(&s_cv_data); pthread_mutex_unlock(&s_mu);
        }
        sched_yield();
    }
}

/* ---- emulation-thread side ---------------------------------------------- */
static uint16_t *s_vram;
static int s_scale = 1, s_filter = 0;
static int s_wide_w = 0, s_wide_target = 0;
static int s_wide_bases[4], s_wide_nbases = 0;
static int s_bd_sent_on = 0, s_bd_sent_pct = 0;
static int s_pending_read = 0;

static void note_base(int base) {
    for (int i = 0; i < s_wide_nbases; i++) if (s_wide_bases[i] == base) return;
    if (s_wide_nbases < 4) s_wide_bases[s_wide_nbases++] = base;
}

/* Per-primitive backdrop decision, taken where the plain backend takes it
 * (only for primitives mirrored into a wide surface). */
static void bd_sync(void) {
    if (!s_wide_w || !s_wide_target) return;
    int on = 0, pct = g_ws_bd_stretch_pct;
    if (g_ws_bd_stretch_on) on = psx_ws_prim_in_backdrop() ? 1 : 0;
    if (on != s_bd_sent_on || pct != s_bd_sent_pct) {
        s_bd_sent_on = on; s_bd_sent_pct = pct;
        REC(OP_BD, on, pct);
    }
}

static void t_init(uint16_t *vram) {
    s_vram = vram;
    sw_renderer_init(vram);
    if (!s_started) {
        s_ring = (uint8_t *)malloc(RING_BYTES);
        s_hr_vram = (uint16_t *)calloc(1024u * 512u, sizeof(uint16_t));
        memcpy(s_hr_vram, vram, 1024u * 512u * 2u);
        swhr_renderer_init(s_hr_vram);
        s_started = s_ring && s_hr_vram && pthread_create(&s_thread, NULL, present_thread, NULL) == 0;
    }
}
static void t_set_scale(int scale) {
    if (scale < 1) scale = 1;
    if (scale > SW_MAX_INTERNAL_SCALE) scale = SW_MAX_INTERNAL_SCALE;
    s_scale = scale;
    REC(OP_SCALE, scale);
}
static int  t_scale(void) { return s_scale; }
static void t_set_filter(int b) { s_filter = b; sw_set_texture_filter(b); REC(OP_FILTER, b); }
static int  t_filter(void) { return s_filter; }
static void t_semi(int e, int m) { sw_set_semi_transparency(e, m); REC(OP_SEMI, e, m); }
static void t_mask(int s, int c) { sw_set_mask_bits(s, c); REC(OP_MASK, s, c); }
static void t_tw(uint32_t raw) { sw_set_texture_window(raw); REC(OP_TW, (int32_t)raw); }
static void t_mod(int r, int g, int b, int raw) { sw_set_color_modulation(r, g, b, raw); REC(OP_MOD, r, g, b, raw); }
static void t_precise(int e, int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t x2, int32_t y2) {
    sw_set_precise_triangle(e, x0, y0, x1, y1, x2, y2);
    REC(OP_PRECISE, e, x0, y0, x1, y1, x2, y2);
}
static void t_persp(int e, float q0, float q1, float q2) {
    sw_set_perspective_triangle(e, q0, q1, q2);
    int32_t a[4] = { e, 0, 0, 0 };
    float q[3] = { q0, q1, q2 };
    memcpy(a + 1, q, sizeof q);
    rec_args(OP_PERSP, 4, a);
}
static void t_fill(int x, int y, int w, int h, uint16_t c) { sw_fill_rect(x, y, w, h, c); REC(OP_FILL, x, y, w, h, c); }
static void t_copy(int sx, int sy, int dx, int dy, int w, int h) { sw_copy_rect(sx, sy, dx, dy, w, h); REC(OP_COPY, sx, sy, dx, dy, w, h); }
static void t_flat_tri(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c) {
    sw_draw_flat_triangle(x0, y0, x1, y1, x2, y2, c);
    bd_sync(); REC(OP_FLAT_TRI, x0, y0, x1, y1, x2, y2, c);
}
static void t_gour_tri(int x0, int y0, uint16_t c0, int x1, int y1, uint16_t c1, int x2, int y2, uint16_t c2) {
    sw_draw_gouraud_triangle(x0, y0, c0, x1, y1, c1, x2, y2, c2);
    bd_sync(); REC(OP_GOUR_TRI, x0, y0, c0, x1, y1, c1, x2, y2, c2);
}
static void t_tex_tri(int x0, int y0, int u0, int v0, int x1, int y1, int u1, int v1,
                      int x2, int y2, int u2, int v2, uint16_t cx, uint16_t cy, uint16_t tp) {
    sw_draw_textured_triangle(x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2, cx, cy, tp);
    bd_sync(); REC(OP_TEX_TRI, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2, cx, cy, tp);
}
static void t_stex_tri(int x0, int y0, int u0, int v0, uint32_t c0, int x1, int y1, int u1, int v1, uint32_t c1,
                       int x2, int y2, int u2, int v2, uint32_t c2, uint16_t cx, uint16_t cy, uint16_t tp, int raw) {
    sw_draw_shaded_textured_triangle(x0, y0, u0, v0, c0, x1, y1, u1, v1, c1, x2, y2, u2, v2, c2, cx, cy, tp, raw);
    bd_sync();
    REC(OP_STEX_TRI, x0, y0, u0, v0, (int32_t)c0, x1, y1, u1, v1, (int32_t)c1,
        x2, y2, u2, v2, (int32_t)c2, cx, cy, tp, raw);
}
static void t_flat_rect(int x, int y, int w, int h, uint16_t c) {
    sw_draw_flat_rect(x, y, w, h, c);
    bd_sync(); REC(OP_FLAT_RECT, x, y, w, h, c);
}
static void t_tex_rect(int x, int y, int w, int h, int u, int v, uint16_t cx, uint16_t cy, uint16_t tp) {
    sw_draw_textured_rect(x, y, w, h, u, v, cx, cy, tp);
    bd_sync(); REC(OP_TEX_RECT, x, y, w, h, u, v, cx, cy, tp);
}
static void t_tex_rect_scaled(int x, int y, int w, int h, int u0, int v0, int u1, int v1,
                              uint16_t cx, uint16_t cy, uint16_t tp) {
    sw_draw_textured_rect_scaled(x, y, w, h, u0, v0, u1, v1, cx, cy, tp);
    bd_sync(); REC(OP_TEX_RECT_SCALED, x, y, w, h, u0, v0, u1, v1, cx, cy, tp);
}
static void t_line(int x0, int y0, int x1, int y1, uint16_t c) {
    sw_draw_line(x0, y0, x1, y1, c);
    bd_sync(); REC(OP_LINE, x0, y0, x1, y1, c);
}
static void t_sline(int x0, int y0, uint16_t c0, int x1, int y1, uint16_t c1) {
    sw_draw_shaded_line(x0, y0, c0, x1, y1, c1);
    bd_sync(); REC(OP_SLINE, x0, y0, c0, x1, y1, c1);
}
static void t_pixel(int x, int y, uint16_t p) { sw_vram_write(x, y, p); REC(OP_PIXEL, x, y, p); }
static uint16_t t_read(int x, int y) { return sw_vram_read(x, y); }
static void t_xfer_in(int x, int y, int w, int h, const uint16_t *d) {
    sw_vram_transfer_in(x, y, w, h, d);
    if (w <= 0 || h <= 0) return;
    const uint32_t px = (uint32_t)w * (uint32_t)h;
    int32_t *p = (int32_t *)rec_begin(OP_XFER_IN, 16u + px * 2u);
    p[0] = x; p[1] = y; p[2] = w; p[3] = h;
    memcpy(p + 4, d, px * 2u);
    rec_commit();
}
static void t_xfer_out(int x, int y, int w, int h, uint16_t *d) { sw_vram_transfer_out(x, y, w, h, d); }
static void t_area(int x1, int y1, int x2, int y2) { sw_set_draw_area(x1, y1, x2, y2); REC(OP_AREA, x1, y1, x2, y2); }
static void t_get_area(int *x1, int *y1, int *x2, int *y2) { sw_get_draw_area(x1, y1, x2, y2); }
static void t_offset(int x, int y) { sw_set_draw_offset(x, y); REC(OP_OFFSET, x, y); }

static void t_wide_conf(int w, int off) {
    if (w <= 0 || w != s_wide_w) s_wide_nbases = 0;
    s_wide_w = w > 0 ? w : 0;
    if (!s_wide_w) s_wide_target = 0;
    REC(OP_WIDE_CONF, w, off);
}
static void t_wide_target(int base) {
    if (s_wide_w) { note_base(base); s_wide_target = 1; }
    REC(OP_WIDE_TARGET, base);
}
static void t_wide_off(void) { s_wide_target = 0; REC(OP_WIDE_OFF, 0); }
static void t_wide_clear(int base, int y, int h, uint16_t c) {
    if (s_wide_w) note_base(base);
    REC(OP_WIDE_CLEAR, base, y, h, c);
}
static void t_wide_margins(int base, int y, int h, uint16_t c, int sides) {
    if (s_wide_w) note_base(base);
    REC(OP_WIDE_MARGINS, base, y, h, c, sides);
}

/* Present read-outs: queued, run by the presentation thread into the page's
 * back buffer, then made visible by psx_web_publish_frame → swt_publish. */
static int t_render_display(uint32_t *o, int p, int dx, int dy, int dw, int dh) {
    return sw_render_display(o, p, dx, dy, dw, dh);       /* native VRAM */
}
static int t_render_hires(uint32_t *o, int p, int dx, int dy, int dw, int dh) {
    (void)o;
    atomic_fetch_add(&s_frames_queued, 1u);
    REC(OP_READ_HIRES, p, dx, dy, dw, dh, s_scale);
    s_pending_read = 1;
    return dw * dh * s_scale * s_scale;
}
static int t_render_wide(uint32_t *o, int p, int base, int dy, int dh) {
    (void)o;
    if (!s_wide_w) return 0;
    int known = 0;
    for (int i = 0; i < s_wide_nbases; i++) if (s_wide_bases[i] == base) known = 1;
    if (!known) return 0;
    atomic_fetch_add(&s_frames_queued, 1u);
    REC(OP_READ_WIDE, p, base, dy, dh, s_scale);
    s_pending_read = 1;
    return s_wide_w * s_scale * dh * s_scale;
}
static int t_wide_dump(uint32_t *o, int cap, int *ow, int *oh, int base) {
    drain();
    return swhr_wide_dump_full(o, cap, ow, oh, base);
}

/* psx_web_publish_frame: 1 if the frame went through the presentation thread
 * (a queued read-out, or the pixels themselves to keep frames in order). */
int swt_publish(const uint32_t *px, int w, int h, int logical_w, int dst_w,
                int dst_h, int content_h, int nearest) {
    if (!s_started) return 0;
    if (s_pending_read) {
        s_pending_read = 0;
        REC(OP_PUBLISH, w, h, logical_w, dst_w, dst_h, content_h, nearest);
        return 1;
    }
    const uint32_t n = (uint32_t)w * (uint32_t)h;
    int32_t *p = (int32_t *)rec_begin(OP_PUBLISH_PIXELS, 28u + n * 4u);
    p[0] = w; p[1] = h; p[2] = logical_w; p[3] = dst_w; p[4] = dst_h; p[5] = content_h; p[6] = nearest;
    memcpy(p + 7, px, (size_t)n * 4u);
    rec_commit();
    return 1;
}

/* The authoritative VRAM was replaced (savestate load): copy it whole. */
static void t_vram_restored(void) {
    t_xfer_in(0, 0, 1024, 512, s_vram);
}

const GpuRenderBackend SWT_BACKEND = {
    .name = "software (threaded present)",
    .init = t_init, .set_scale = t_set_scale, .scale = t_scale,
    .set_texture_filter = t_set_filter, .texture_filter = t_filter,
    .set_semi_transparency = t_semi, .set_mask_bits = t_mask,
    .set_texture_window = t_tw, .set_color_modulation = t_mod,
    .set_precise_triangle = t_precise, .set_perspective_triangle = t_persp,
    .fill_rect = t_fill, .copy_rect = t_copy,
    .draw_flat_triangle = t_flat_tri, .draw_gouraud_triangle = t_gour_tri,
    .draw_textured_triangle = t_tex_tri, .draw_shaded_textured_triangle = t_stex_tri,
    .draw_flat_rect = t_flat_rect, .draw_textured_rect = t_tex_rect,
    .draw_textured_rect_scaled = t_tex_rect_scaled,
    .draw_line = t_line, .draw_shaded_line = t_sline,
    .render_display = t_render_display, .render_display_hires = t_render_hires,
    .vram_write = t_pixel, .vram_read = t_read,
    .vram_transfer_in = t_xfer_in, .vram_transfer_out = t_xfer_out,
    .set_draw_area = t_area, .get_draw_area = t_get_area, .set_draw_offset = t_offset,
    .wide_configure = t_wide_conf, .wide_set_target = t_wide_target,
    .wide_disable_target = t_wide_off, .wide_clear = t_wide_clear,
    .wide_clear_margins = t_wide_margins, .render_wide_display = t_render_wide,
    .wide_dump_full = t_wide_dump,
    .vram_restored = t_vram_restored,
};
