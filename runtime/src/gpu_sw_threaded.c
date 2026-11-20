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
 *
 * GPU mode (PSX_WEB_GL=1, the page has WebGL 2): there is no presentation
 * thread. The page's main thread drains the ring once per display refresh
 * (swt_gl_pump) into the OpenGL renderer built for WebGL 2 (gpu_gl_web.c),
 * which draws at the requested scale on the graphics card and presents
 * straight onto a canvas. The emulation thread never waits for it: when the
 * ring is full (page hidden, no refresh) records are dropped, and once the
 * page has caught up the whole VRAM and drawing state are sent again.
 *
 * Native rasterizer thread (PSX_WEB_RASTER_THREAD=1, set by the page): the
 * native rasterizer itself leaves the emulation thread. Its calls go, in
 * order, through a second ring that never drops anything, to a thread that
 * owns the rasterizer; the game no longer waits for its own picture to be
 * drawn at 1x. Whatever READS the authoritative VRAM first waits until that
 * thread has run everything queued (native_sync): VRAM->CPU transfers,
 * single-pixel reads, the native read-out, a GPU-mode resync, a CPU->VRAM
 * transfer, a savestate, and gpu.c's own direct accesses (gr_vram_sync). The
 * rasterizer therefore sees exactly the calls it saw on the emulation thread,
 * in the same order, and every read sees all of them done: what the game
 * reads back does not depend on how fast that thread is.
 */
#include "gpu_render.h"
#include "gpu_sw_renderer.h"
#include <emscripten/emscripten.h>
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

/* GPU replay (gpu_gl_renderer.c, browser build). */
const GpuRenderBackend *glweb_backend_get(void);
int  gl_web_init(const char *canvas, uint16_t *vram, int scale);
int  gl_web_present(int kind, int dx, int dy, int dw, int dh,
                    int cw, int ch, int vx, int vy, int vw, int vh, int linear);
int  gl_web_present_pixels(const uint32_t *px, int w, int h,
                           int cw, int ch, int vx, int vy, int vw, int vh, int linear);
void gl_web_set_prim_gate(int in_backdrop, int tagged);

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

static int s_gl_mode;               /* GPU replay on the page's main thread */
static _Atomic int s_dropping;      /* GPU mode: ring overflowed, records dropped */
static _Atomic int s_resync_ready;  /* GPU mode: the page drained the ring since */
static uint32_t s_resyncs, s_gl_xfers, s_gl_big_xfers, s_gl_last_xfer;   /* probes */

/* 1 when `need` bytes are free. GPU mode never waits: a full ring starts
 * dropping records until the page catches up (then everything is resent). */
static int wait_space(uint32_t need) {
    if (s_gl_mode) {
        uint32_t used = atomic_load(&s_head) - atomic_load(&s_tail);
        if (RING_BYTES - used >= need) return 1;
        atomic_store(&s_resync_ready, 0);
        atomic_store(&s_dropping, 1);
        return 0;
    }
    for (;;) {
        uint32_t used = atomic_load(&s_head) - atomic_load(&s_tail);
        if (RING_BYTES - used >= need) return 1;
        pthread_mutex_lock(&s_mu);
        atomic_store(&s_prod_sleep, 1);
        used = atomic_load(&s_head) - atomic_load(&s_tail);
        if (RING_BYTES - used < need) pthread_cond_wait(&s_cv_space, &s_mu);
        atomic_store(&s_prod_sleep, 0);
        pthread_mutex_unlock(&s_mu);
    }
}

static void resync(void);

/* Reserves a record with `payload` bytes after the header; returns the
 * payload pointer, to be followed by rec_commit(), or NULL when the record is
 * dropped (GPU mode, ring full). */
static void *rec_begin(uint32_t op, uint32_t payload) {
    uint32_t size = (uint32_t)((sizeof(RecHdr) + payload + 7u) & ~7u);
    if (s_gl_mode && atomic_load(&s_dropping)) {
        if (!atomic_load(&s_resync_ready)) return NULL;
        atomic_store(&s_dropping, 0);
        resync();
        if (atomic_load(&s_dropping)) return NULL;
    }
    uint32_t head = atomic_load_explicit(&s_head, memory_order_relaxed);
    uint32_t pos = head % RING_BYTES;
    uint32_t contig = RING_BYTES - pos;
    if (contig < size) {                     /* pad to the start of the ring */
        if (!wait_space(contig)) return NULL;
        RecHdr *w = (RecHdr *)(s_ring + pos);
        w->op = OP_WRAP; w->bytes = contig;
        head += contig;
        atomic_store(&s_head, head);
        if (atomic_load(&s_cons_sleep) && atomic_exchange(&s_cons_sleep, 0)) {
            pthread_mutex_lock(&s_mu); pthread_cond_signal(&s_cv_data); pthread_mutex_unlock(&s_mu);
        }
        pos = 0;
    }
    if (!wait_space(size)) return NULL;
    RecHdr *h = (RecHdr *)(s_ring + pos);
    h->op = op; h->bytes = size;
    rec_reserve_pos = head;
    rec_reserve_size = size;
    return h + 1;
}

static void rec_commit(void) {
    atomic_store(&s_head, rec_reserve_pos + rec_reserve_size);
    /* The flag is taken, not just read: one signal per sleep of the consumer,
     * not one per record written while it wakes up. */
    if (atomic_load(&s_cons_sleep) && atomic_exchange(&s_cons_sleep, 0)) {
        pthread_mutex_lock(&s_mu); pthread_cond_signal(&s_cv_data); pthread_mutex_unlock(&s_mu);
    }
}

static int rec_args(uint32_t op, int n, const int32_t *a) {
    int32_t *p = (int32_t *)rec_begin(op, (uint32_t)n * 4u);
    if (!p) return 0;
    memcpy(p, a, (size_t)n * 4u);
    rec_commit();
    return 1;
}
/* A present read-out: counted as a queued frame before the consumer can see
 * it, and only if it is recorded at all. */
static _Atomic uint32_t s_frames_queued;   /* defined with the presentation side below */
static void rec_frame(uint32_t op, int n, const int32_t *a) {
    int32_t *p = (int32_t *)rec_begin(op, (uint32_t)n * 4u);
    if (!p) return;
    memcpy(p, a, (size_t)n * 4u);
    atomic_fetch_add(&s_frames_queued, 1u);
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

/* ---- GPU mode: replay on the page's main thread ------------------------- */
static const GpuRenderBackend *G;
static int g_inited, g_init_failed;
static int g_kind = -1, g_args[4];          /* last read-out queued (kind 0 hires, 1 wide) */
static int g_have_frame;                    /* something presented since start */
static int g_last_pub[7];                   /* last OP_PUBLISH geometry */
static int g_last_was_pixels;
static int g_cw, g_ch;

/* The game's frame occupies logical_w x dst_h (the session's shape); its
 * picture is dst_w wide inside it and content_h/240 tall, centred, letterboxed
 * into the canvas (same layout as the page's software display). */
static void layout(const int *pub, int cw, int ch, int *vx, int *vy, int *vw, int *vh) {
    const double logical_w = pub[2] > 0 ? pub[2] : 1, dst_w = pub[3] > 0 ? pub[3] : 1;
    const double dst_h = pub[4] > 0 ? pub[4] : 1, content_h = pub[5] > 0 ? pub[5] : 240;
    const double aspect = logical_w / dst_h;
    double fw = cw, fh = cw / aspect;
    if (fh > ch) { fh = ch; fw = ch * aspect; }
    const double pw = fw * (dst_w / logical_w), ph = fh * (content_h / 240.0);
    *vw = (int)(pw + 0.5); *vh = (int)(ph + 0.5);
    *vx = (int)((cw - pw) / 2 + 0.5); *vy = (int)((ch - ph) / 2 + 0.5);
}

static int gl_present_last(void) {
    if (g_kind < 0 || g_last_was_pixels) return 0;
    int vx, vy, vw, vh;
    layout(g_last_pub, g_cw, g_ch, &vx, &vy, &vw, &vh);
    return gl_web_present(g_kind, g_args[0], g_args[1], g_args[2], g_args[3],
                          g_cw, g_ch, vx, vy, vw, vh, !g_last_pub[6]);
}

static void run_record_gl(const RecHdr *h, int *presented) {
    const int32_t *a = (const int32_t *)(h + 1);
    switch (h->op) {
    case OP_SCALE:   G->set_scale(a[0]); break;
    case OP_FILTER:  G->set_texture_filter(a[0]); break;
    case OP_SEMI:    G->set_semi_transparency(a[0], a[1]); break;
    case OP_MASK:    G->set_mask_bits(a[0], a[1]); break;
    case OP_TW:      G->set_texture_window((uint32_t)a[0]); break;
    case OP_MOD:     G->set_color_modulation(a[0], a[1], a[2], a[3]); break;
    case OP_PRECISE: G->set_precise_triangle(a[0], a[1], a[2], a[3], a[4], a[5], a[6]); break;
    case OP_PERSP: {
        float q[3]; memcpy(q, a + 1, sizeof q);
        G->set_perspective_triangle(a[0], q[0], q[1], q[2]);
        break;
    }
    case OP_FILL:    G->fill_rect(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_COPY:    G->copy_rect(a[0], a[1], a[2], a[3], a[4], a[5]); break;
    case OP_FLAT_TRI:
        G->draw_flat_triangle(a[0], a[1], a[2], a[3], a[4], a[5], (uint16_t)a[6]); break;
    case OP_GOUR_TRI:
        G->draw_gouraud_triangle(a[0], a[1], (uint16_t)a[2], a[3], a[4], (uint16_t)a[5],
                                 a[6], a[7], (uint16_t)a[8]); break;
    case OP_TEX_TRI:
        G->draw_textured_triangle(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7],
                                  a[8], a[9], a[10], a[11],
                                  (uint16_t)a[12], (uint16_t)a[13], (uint16_t)a[14]); break;
    case OP_STEX_TRI:
        G->draw_shaded_textured_triangle(a[0], a[1], a[2], a[3], (uint32_t)a[4],
                                         a[5], a[6], a[7], a[8], (uint32_t)a[9],
                                         a[10], a[11], a[12], a[13], (uint32_t)a[14],
                                         (uint16_t)a[15], (uint16_t)a[16], (uint16_t)a[17],
                                         a[18]); break;
    case OP_FLAT_RECT: G->draw_flat_rect(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_TEX_RECT:
        G->draw_textured_rect(a[0], a[1], a[2], a[3], a[4], a[5],
                              (uint16_t)a[6], (uint16_t)a[7], (uint16_t)a[8]); break;
    case OP_TEX_RECT_SCALED:
        G->draw_textured_rect_scaled(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7],
                                     (uint16_t)a[8], (uint16_t)a[9], (uint16_t)a[10]); break;
    case OP_LINE:  G->draw_line(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_SLINE: G->draw_shaded_line(a[0], a[1], (uint16_t)a[2], a[3], a[4], (uint16_t)a[5]); break;
    case OP_PIXEL: G->vram_write(a[0], a[1], (uint16_t)a[2]); break;
    case OP_XFER_IN:
        s_gl_xfers++;
        if (a[2] * a[3] >= 64 * 64) {
            s_gl_big_xfers++;
            s_gl_last_xfer = (uint32_t)(a[0] & 1023) | ((uint32_t)(a[1] & 511) << 10)
                           | ((uint32_t)(a[2] & 2047) << 19);
        }
        G->vram_transfer_in(a[0], a[1], a[2], a[3], (const uint16_t *)(a + 4)); break;
    case OP_AREA:   G->set_draw_area(a[0], a[1], a[2], a[3]); break;
    case OP_OFFSET: G->set_draw_offset(a[0], a[1]); break;
    case OP_WIDE_CONF:   G->wide_configure(a[0], a[1]); break;
    case OP_WIDE_TARGET: G->wide_set_target(a[0]); break;
    case OP_WIDE_OFF:    G->wide_disable_target(); break;
    case OP_WIDE_CLEAR:  G->wide_clear(a[0], a[1], a[2], (uint16_t)a[3]); break;
    case OP_WIDE_MARGINS: G->wide_clear_margins(a[0], a[1], a[2], (uint16_t)a[3], a[4]); break;
    case OP_BD: gl_web_set_prim_gate(a[0], 0); break;
    case OP_READ_HIRES:   /* pitch, dx, dy, dw, dh, scale */
        g_kind = 0; g_args[0] = a[1]; g_args[1] = a[2]; g_args[2] = a[3]; g_args[3] = a[4];
        break;
    case OP_READ_WIDE:    /* pitch, base, dy, dh, scale */
        g_kind = 1; g_args[0] = a[1]; g_args[1] = a[2]; g_args[2] = 0; g_args[3] = a[3];
        break;
    case OP_PUBLISH:
        memcpy(g_last_pub, a, sizeof g_last_pub);
        g_last_was_pixels = 0;
        if (gl_present_last()) { (*presented)++; g_have_frame = 1; }
        break;
    case OP_PUBLISH_PIXELS: {
        int vx, vy, vw, vh;
        memcpy(g_last_pub, a, sizeof g_last_pub);
        g_last_was_pixels = 1;
        layout(a, g_cw, g_ch, &vx, &vy, &vw, &vh);
        if (gl_web_present_pixels((const uint32_t *)(a + 7), a[0], a[1],
                                  g_cw, g_ch, vx, vy, vw, vh, !a[6])) {
            (*presented)++; g_have_frame = 1;
        }
        break;
    }
    default: break;
    }
}

/* Page main thread, once per display refresh: replays everything the
 * emulation thread recorded and draws the newest picture onto the canvas
 * (canvas_w x canvas_h, its current drawing-buffer size). Returns the number
 * of pictures drawn, or -1 if WebGL 2 could not be set up (the page then goes
 * back to the software picture: reload with PSX_WEB_GL unset). */
EMSCRIPTEN_KEEPALIVE int swt_gl_pump(int canvas_w, int canvas_h, int scale) {
    if (!s_gl_mode || !s_started) return 0;
    if (!g_inited) {
        if (g_init_failed) return -1;
        G = glweb_backend_get();
        if (!gl_web_init("#canvas", s_hr_vram, scale)) { g_init_failed = 1; return -1; }
        g_inited = 1;
    }
    const int resized = canvas_w != g_cw || canvas_h != g_ch;
    g_cw = canvas_w; g_ch = canvas_h;
    int presented = 0;
    /* Far behind (a graphics card slower than the game): skip everything
     * queued and have the emulation thread send the whole VRAM and drawing
     * state again, rather than draw stale frames. */
    {
        const uint32_t queued = atomic_load(&s_frames_queued);
        if (queued - s_frames_done > 8u) {
            atomic_store(&s_tail, atomic_load(&s_head));
            s_frames_done = queued;
            atomic_store(&s_resync_ready, 1);
            atomic_store(&s_dropping, 1);
            return 0;
        }
    }
    /* Keep the page responsive: once a picture is out and this refresh has
     * used its budget, the rest waits for the next one. A graphics card that
     * cannot keep up lets the ring fill, and the game goes on regardless
     * (records dropped, then everything resent). */
    const double t0 = emscripten_get_now();
    for (;;) {
        uint32_t tail = atomic_load(&s_tail);
        uint32_t head = atomic_load(&s_head);
        if (tail == head) {
            if (atomic_load(&s_dropping)) atomic_store(&s_resync_ready, 1);
            break;
        }
        const RecHdr *h = (const RecHdr *)(s_ring + tail % RING_BYTES);
        const uint32_t op = h->op;
        if (op != OP_WRAP) run_record_gl(h, &presented);
        atomic_store(&s_tail, tail + h->bytes);
        if (op == OP_READ_HIRES || op == OP_READ_WIDE) s_frames_done++;
        if ((op == OP_PUBLISH || op == OP_PUBLISH_PIXELS) && presented) {
            /* 10 ms per refresh; up to 30 ms while several frames are behind. */
            const double dt = emscripten_get_now() - t0;
            const uint32_t behind = atomic_load(&s_frames_queued) - s_frames_done;
            if (dt > 30.0 || (dt > 10.0 && behind < 3u)) break;
        }
    }
    if (!presented && resized && g_have_frame && gl_present_last()) presented = 1;
    return presented;
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

/* ---- native rasterizer: on the emulation thread or on its own ------------ */
/* One native call, from its recorded form (the same opcodes and arguments as
 * the presentation ring). Every native call goes through here, whichever
 * thread makes it. */
static void native_exec(uint32_t op, const int32_t *a) {
    switch (op) {
    case OP_FILTER:  sw_set_texture_filter(a[0]); break;
    case OP_SEMI:    sw_set_semi_transparency(a[0], a[1]); break;
    case OP_MASK:    sw_set_mask_bits(a[0], a[1]); break;
    case OP_TW:      sw_set_texture_window((uint32_t)a[0]); break;
    case OP_MOD:     sw_set_color_modulation(a[0], a[1], a[2], a[3]); break;
    case OP_PRECISE: sw_set_precise_triangle(a[0], a[1], a[2], a[3], a[4], a[5], a[6]); break;
    case OP_PERSP: {
        float q[3]; memcpy(q, a + 1, sizeof q);
        sw_set_perspective_triangle(a[0], q[0], q[1], q[2]);
        break;
    }
    case OP_FILL:    sw_fill_rect(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_COPY:    sw_copy_rect(a[0], a[1], a[2], a[3], a[4], a[5]); break;
    case OP_FLAT_TRI:
        sw_draw_flat_triangle(a[0], a[1], a[2], a[3], a[4], a[5], (uint16_t)a[6]); break;
    case OP_GOUR_TRI:
        sw_draw_gouraud_triangle(a[0], a[1], (uint16_t)a[2], a[3], a[4], (uint16_t)a[5],
                                 a[6], a[7], (uint16_t)a[8]); break;
    case OP_TEX_TRI:
        sw_draw_textured_triangle(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7],
                                  a[8], a[9], a[10], a[11],
                                  (uint16_t)a[12], (uint16_t)a[13], (uint16_t)a[14]); break;
    case OP_STEX_TRI:
        sw_draw_shaded_textured_triangle(a[0], a[1], a[2], a[3], (uint32_t)a[4],
                                         a[5], a[6], a[7], a[8], (uint32_t)a[9],
                                         a[10], a[11], a[12], a[13], (uint32_t)a[14],
                                         (uint16_t)a[15], (uint16_t)a[16], (uint16_t)a[17],
                                         a[18]); break;
    case OP_FLAT_RECT: sw_draw_flat_rect(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_TEX_RECT:
        sw_draw_textured_rect(a[0], a[1], a[2], a[3], a[4], a[5],
                              (uint16_t)a[6], (uint16_t)a[7], (uint16_t)a[8]); break;
    case OP_TEX_RECT_SCALED:
        sw_draw_textured_rect_scaled(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7],
                                     (uint16_t)a[8], (uint16_t)a[9], (uint16_t)a[10]); break;
    case OP_LINE:  sw_draw_line(a[0], a[1], a[2], a[3], (uint16_t)a[4]); break;
    case OP_SLINE: sw_draw_shaded_line(a[0], a[1], (uint16_t)a[2], a[3], a[4], (uint16_t)a[5]); break;
    case OP_PIXEL: sw_vram_write(a[0], a[1], (uint16_t)a[2]); break;
    case OP_AREA:   sw_set_draw_area(a[0], a[1], a[2], a[3]); break;
    case OP_OFFSET: sw_set_draw_offset(a[0], a[1]); break;
    default: break;
    }
}

/* The second ring: single producer (emulation thread), single consumer (the
 * native thread), nothing ever dropped. s_ntail moves past a record only
 * once the rasterizer has returned from it, so "s_ntail == s_nhead" means
 * every queued call is done. */
#define NRING_BYTES (4u << 20)
#define NKICK_BYTES (16u << 10)     /* wake the thread once this much is waiting */
static uint8_t         *s_nring;
static _Atomic uint32_t s_nhead, s_ntail;
static _Atomic int      s_ncons_sleep;   /* the thread sleeps on s_ncv_data */
static _Atomic int      s_nprod_wait;    /* the emulation thread waits on s_ncv_done */
static pthread_mutex_t  s_nmu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t   s_ncv_data = PTHREAD_COND_INITIALIZER;
static pthread_cond_t   s_ncv_done = PTHREAD_COND_INITIALIZER;
static pthread_t        s_nthread;
static int              s_nthread_on;    /* native calls go through the ring */
static uint32_t         s_nsyncs, s_nsync_waits;   /* probes */

static void *native_thread(void *arg) {
    (void)arg;
    for (;;) {
        uint32_t tail = atomic_load(&s_ntail);
        if (tail == atomic_load(&s_nhead)) {
            /* A frame's display list reaches the ring in small groups, a
             * few microseconds apart, for a millisecond or two. Sleeping
             * between two groups made the emulation thread wake this one
             * some fifteen times per frame (5 % of its time in the wake-up
             * call, measured on a virtual machine where waking a thread is
             * dear): keep looking for a few hundred microseconds first, so
             * that one wake-up serves the whole list. */
            int again = 0;
            for (int spin = 0; spin < 300000 && !again; spin++)
                again = atomic_load(&s_nhead) != tail;
            if (again) continue;
            pthread_mutex_lock(&s_nmu);
            atomic_store(&s_ncons_sleep, 1);
            if (atomic_load(&s_nhead) == tail) pthread_cond_wait(&s_ncv_data, &s_nmu);
            atomic_store(&s_ncons_sleep, 0);
            pthread_mutex_unlock(&s_nmu);
            continue;
        }
        const RecHdr *h = (const RecHdr *)(s_nring + tail % NRING_BYTES);
        if (h->op != OP_WRAP) native_exec(h->op, (const int32_t *)(h + 1));
        atomic_store(&s_ntail, tail + h->bytes);
        if (atomic_load(&s_nprod_wait)) {
            pthread_mutex_lock(&s_nmu); pthread_cond_signal(&s_ncv_done); pthread_mutex_unlock(&s_nmu);
        }
    }
    return NULL;
}

/* Emulation thread: the native thread gets to work on what is queued. The
 * sleep flag is taken, not just read: the thread needs some microseconds to
 * wake up, and the calls queued meanwhile would each signal it again (a
 * twentieth of the emulation thread went into those wake-ups). */
static void native_kick(void) {
    if (atomic_load(&s_ncons_sleep) && atomic_exchange(&s_ncons_sleep, 0)) {
        pthread_mutex_lock(&s_nmu); pthread_cond_signal(&s_ncv_data); pthread_mutex_unlock(&s_nmu);
    }
}
/* Once per frame: a short tail left below NKICK_BYTES gets drawn too. */
static void native_kick_pending(void) {
    if (s_nthread_on && atomic_load(&s_ntail) != atomic_load(&s_nhead)) native_kick();
}

/* Emulation thread: waits while `more` holds (re-read under the lock, after
 * announcing the wait, so a record finished meanwhile is never missed). */
static void native_wait_while_full(uint32_t need) {
    for (;;) {
        if (NRING_BYTES - (atomic_load(&s_nhead) - atomic_load(&s_ntail)) >= need) return;
        native_kick();
        pthread_mutex_lock(&s_nmu);
        atomic_store(&s_nprod_wait, 1);
        if (NRING_BYTES - (atomic_load(&s_nhead) - atomic_load(&s_ntail)) < need)
            pthread_cond_wait(&s_ncv_done, &s_nmu);
        atomic_store(&s_nprod_wait, 0);
        pthread_mutex_unlock(&s_nmu);
    }
}

/* Emulation thread: every native call queued so far has been run. To be
 * called before the authoritative VRAM is read or written directly. */
static void native_sync(void) {
    if (!s_nthread_on) return;
    const uint32_t head = atomic_load(&s_nhead);
    if (atomic_load(&s_ntail) == head) return;
    s_nsyncs++;
    native_kick();
    /* The thread is seldom more than a few hundred microseconds behind. */
    for (int spin = 0; spin < 20000; spin++)
        if (atomic_load(&s_ntail) == head) return;
    s_nsync_waits++;
    for (;;) {
        native_kick();
        pthread_mutex_lock(&s_nmu);
        atomic_store(&s_nprod_wait, 1);
        if (atomic_load(&s_ntail) != head) pthread_cond_wait(&s_ncv_done, &s_nmu);
        atomic_store(&s_nprod_wait, 0);
        pthread_mutex_unlock(&s_nmu);
        if (atomic_load(&s_ntail) == head) return;
    }
}

/* Emulation thread: one native call, run here or queued for the thread. */
static void native(uint32_t op, int n, const int32_t *a) {
    if (!s_nthread_on) { native_exec(op, a); return; }
    const uint32_t size = (uint32_t)((sizeof(RecHdr) + (uint32_t)n * 4u + 7u) & ~7u);
    uint32_t head = atomic_load_explicit(&s_nhead, memory_order_relaxed);
    uint32_t pos = head % NRING_BYTES;
    const uint32_t contig = NRING_BYTES - pos;
    if (contig < size) {                     /* pad to the start of the ring */
        native_wait_while_full(contig);
        RecHdr *w = (RecHdr *)(s_nring + pos);
        w->op = OP_WRAP; w->bytes = contig;
        head += contig;
        atomic_store(&s_nhead, head);
        pos = 0;
    }
    native_wait_while_full(size);
    RecHdr *h = (RecHdr *)(s_nring + pos);
    h->op = op; h->bytes = size;
    memcpy(h + 1, a, (size_t)n * 4u);
    atomic_store(&s_nhead, head + size);
    if (head + size - atomic_load(&s_ntail) >= NKICK_BYTES) native_kick();
}
#define NAT(op, ...) do { const int32_t n_[] = { __VA_ARGS__ }; \
    native(op, (int)(sizeof n_ / sizeof n_[0]), n_); } while (0)

/* gr_vram_sync (gpu.c reads or writes its VRAM array directly). */
static void t_vram_sync(void) { native_sync(); }

/* ---- emulation-thread side ---------------------------------------------- */
static uint16_t *s_vram;
static int s_scale = 1, s_filter = 0;
static int s_wide_w = 0, s_wide_target = 0;
static int s_wide_bases[4], s_wide_nbases = 0;
static int s_bd_sent_on = 0, s_bd_sent_pct = 0;
static int s_pending_read = 0;
/* Current drawing state, resent with the whole VRAM after a GPU-mode drop. */
static int s_sh_semi[2], s_sh_mask[2], s_sh_tw, s_sh_mod[4] = { 128, 128, 128, 0 };
static int s_sh_off[2];
static int s_sh_wide[2], s_sh_target = -1;

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

static void t_xfer_in(int x, int y, int w, int h, const uint16_t *d);

/* Online build (PSX_WEB_SKIP_NATIVE_RASTER=1, same for every participant):
 * the picture is drawn by the presentation side from the ring, so the
 * emulation thread's native rasterization only matters to a game that reads
 * VRAM back (GP0 C0h). While the title's gameplay state holds ([widescreen]
 * gameplay_state_addr, sampled once per frame) with the native-wide view on,
 * primitives are not rasterized into the authoritative VRAM (transfers, fills
 * and copies still are) — once QUIET_FRAMES frames of gameplay have gone by
 * without a read-back. Games read the screen back around transitions (wipes,
 * the first frames of a level), so menus, loading and the start of gameplay
 * always rasterize, and any read-back re-arms the wait. The decision depends
 * only on guest state, so every participant takes it at the same instruction
 * and all copies of the game stay identical. */
#define QUIET_FRAMES 300u
/* VRAM the emulation thread left out of date: 16x16-pixel blocks a skipped
 * primitive may have drawn into (its whole drawing area). The picture side
 * holds the real contents there, so a GPU-mode resync must not send those
 * blocks back (it would paste an old frame over the live one). A transfer or
 * a fill that covers a block makes it current again; a copy carries its
 * source's state. */
#define STALE_BW 64
#define STALE_BH 32
static uint8_t s_stale[STALE_BH][STALE_BW];
static int s_stale_area[4] = { -1, -1, -1, -1 };   /* area last marked */
static void stale_set(int x0, int y0, int x1, int y1, int v, int whole_only) {
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > 1023) x1 = 1023;
    if (y1 > 511) y1 = 511;
    if (x1 < x0 || y1 < y0) return;
    int bx0 = x0 >> 4, by0 = y0 >> 4, bx1 = x1 >> 4, by1 = y1 >> 4;
    if (whole_only) {               /* only blocks the rectangle covers entirely */
        if (x0 & 15) bx0++;
        if (y0 & 15) by0++;
        if ((x1 & 15) != 15) bx1--;
        if ((y1 & 15) != 15) by1--;
    }
    for (int by = by0; by <= by1; by++)
        for (int bx = bx0; bx <= bx1; bx++) s_stale[by][bx] = (uint8_t)v;
}
static uint32_t s_skipped_prims;
static int s_sh_area[4] = { 0, 0, 1023, 511 };
static int skip_prim(void) {
    ++s_skipped_prims;
    if (memcmp(s_stale_area, s_sh_area, sizeof s_stale_area) != 0) {
        memcpy(s_stale_area, s_sh_area, sizeof s_stale_area);
        stale_set(s_sh_area[0], s_sh_area[1], s_sh_area[2], s_sh_area[3], 1, 0);
    }
    return 1;
}
/* Rectangle (with VRAM wrap) brought up to date by the emulation thread. */
static void stale_clear_rect(int x, int y, int w, int h) {
    if (w <= 0 || h <= 0) return;
    x &= 1023; y &= 511;
    if (w > 1024) w = 1024;
    if (h > 512) h = 512;
    const int w1 = x + w > 1024 ? 1024 - x : w, h1 = y + h > 512 ? 512 - y : h;
    stale_set(x, y, x + w1 - 1, y + h1 - 1, 0, 1);
    if (w1 < w) stale_set(0, y, w - w1 - 1, y + h1 - 1, 0, 1);
    if (h1 < h) stale_set(x, 0, x + w1 - 1, h - h1 - 1, 0, 1);
    if (w1 < w && h1 < h) stale_set(0, 0, w - w1 - 1, h - h1 - 1, 0, 1);
    s_stale_area[0] = -1;            /* the next skipped primitive re-marks */
}
static int stale_any(int x, int y, int w, int h) {
    for (int r = 0; r < h; r += 16)
        for (int c = 0; c < w; c += 16)
            if (s_stale[((y + r) & 511) >> 4][((x + c) & 1023) >> 4]) return 1;
    if (s_stale[((y + h - 1) & 511) >> 4][((x + w - 1) & 1023) >> 4]) return 1;
    return 0;
}
static int s_skip_raster_cfg;
static uint32_t s_quiet;             /* gameplay frames since the last read-back */
static int s_gameplay;               /* configured gameplay state, sampled per frame */
int gpu_ws_gameplay_state_active(void);
#define s_skip_raster (s_skip_raster_cfg && s_gameplay && s_wide_w > 0 && s_quiet >= QUIET_FRAMES && skip_prim())
static uint32_t s_readbacks;
void swt_vram_readback_begin(void) { s_quiet = 0; s_readbacks++; }
/* Page-side probe (tests): [0] skip configured, [1] wide width, [2] read-back
 * -free gameplay frames, [3] read-backs so far, [4] primitives not
 * rasterized; [1] has bit 31 set during gameplay. GPU mode: [7] resyncs,
 * [8] transfers replayed, [9] of which 64x64 or more, [10] the last of
 * those (x | y << 10 | w << 19). Native thread: [11] on, [12] reads that
 * found calls still queued, [13] of which had to sleep. */
EMSCRIPTEN_KEEPALIVE uint32_t swt_probe(int i) {
    switch (i) {
    case 0: return (uint32_t)s_skip_raster_cfg;
    case 1: return (uint32_t)(s_wide_w | (s_gameplay << 31));
    case 2: return s_quiet;
    case 3: return s_readbacks;
    case 4: return s_skipped_prims;
    case 5: { extern uint64_t g_dirty_ram_insns_run; return (uint32_t)g_dirty_ram_insns_run; }
    case 6: {   /* static overlay dispatches served */
        extern void psx_overlay_static_get_stats(uint64_t *, uint64_t *, uint64_t *, uint64_t *)
            __attribute__((weak));
        uint64_t hits = 0;
        if (psx_overlay_static_get_stats) psx_overlay_static_get_stats(NULL, &hits, NULL, NULL);
        return (uint32_t)hits;
    }
    case 7: return s_resyncs;
    case 8: return s_gl_xfers;
    case 9: return s_gl_big_xfers;
    case 10: return s_gl_last_xfer;
    case 11: return (uint32_t)s_nthread_on;
    case 12: return s_nsyncs;
    case 13: return s_nsync_waits;
    default: return 0;
    }
}
int swt_active(void) { return s_started; }

/* Records VRAM rectangle (x, y, w, h) as it stands (no wrap). */
static void rec_vram_rect(int x, int y, int w, int h) {
    int32_t *p = (int32_t *)rec_begin(OP_XFER_IN, 16u + (uint32_t)w * (uint32_t)h * 2u);
    if (!p) return;
    p[0] = x; p[1] = y; p[2] = w; p[3] = h;
    uint16_t *d = (uint16_t *)(p + 4);
    for (int r = 0; r < h; r++)
        memcpy(d + (size_t)r * (size_t)w, s_vram + (size_t)(y + r) * 1024u + (size_t)x, (size_t)w * 2u);
    rec_commit();
}
static void resync(void) {
    s_resyncs++;
    native_sync();                       /* rec_vram_rect reads s_vram */
    REC(OP_SCALE, s_scale);
    REC(OP_FILTER, s_filter);
    REC(OP_SEMI, s_sh_semi[0], s_sh_semi[1]);
    REC(OP_TW, s_sh_tw);
    REC(OP_MOD, s_sh_mod[0], s_sh_mod[1], s_sh_mod[2], s_sh_mod[3]);
    REC(OP_AREA, s_sh_area[0], s_sh_area[1], s_sh_area[2], s_sh_area[3]);
    REC(OP_OFFSET, s_sh_off[0], s_sh_off[1]);
    REC(OP_MASK, 0, 0);
    REC(OP_WIDE_OFF, 0);
    /* The authoritative VRAM, except what the emulation thread did not draw
     * (s_stale): the picture side's own contents stand there. */
    for (int by = 0; by < STALE_BH; by++) {
        for (int bx = 0; bx < STALE_BW;) {
            if (s_stale[by][bx]) { bx++; continue; }
            int ex = bx;
            while (ex < STALE_BW && !s_stale[by][ex]) ex++;
            rec_vram_rect(bx * 16, by * 16, (ex - bx) * 16, 16);
            bx = ex;
        }
    }
    REC(OP_MASK, s_sh_mask[0], s_sh_mask[1]);
    REC(OP_WIDE_CONF, s_sh_wide[0], s_sh_wide[1]);
    if (s_sh_target >= 0) REC(OP_WIDE_TARGET, s_sh_target);
    s_bd_sent_on = 0; s_bd_sent_pct = 0;
    REC(OP_BD, 0, 0);
}

static void t_init(uint16_t *vram) {
    native_sync();                       /* a second init: nothing still drawing */
    s_vram = vram;
    sw_renderer_init(vram);
    if (!s_started) {
        const char *skip = getenv("PSX_WEB_SKIP_NATIVE_RASTER");
        s_skip_raster_cfg = skip && skip[0] == '1';
        const char *gl = getenv("PSX_WEB_GL");
        s_gl_mode = gl && gl[0] == '1';
        const char *nt = getenv("PSX_WEB_RASTER_THREAD");
        if (nt && nt[0] == '1') {
            /* The rasterizer needs little stack (the build's default is 16 MB). */
            pthread_attr_t at;
            pthread_attr_init(&at);
            pthread_attr_setstacksize(&at, 1u << 20);
            s_nring = (uint8_t *)malloc(NRING_BYTES);
            s_nthread_on = s_nring && pthread_create(&s_nthread, &at, native_thread, NULL) == 0;
            pthread_attr_destroy(&at);
        }
        s_ring = (uint8_t *)malloc(RING_BYTES);
        s_hr_vram = (uint16_t *)calloc(1024u * 512u, sizeof(uint16_t));
        if (s_hr_vram) memcpy(s_hr_vram, vram, 1024u * 512u * 2u);
        if (s_gl_mode) {
            s_started = s_ring && s_hr_vram;     /* the page pumps (swt_gl_pump) */
        } else {
            swhr_renderer_init(s_hr_vram);
            s_started = s_ring && s_hr_vram && pthread_create(&s_thread, NULL, present_thread, NULL) == 0;
        }
    }
}
static void t_set_scale(int scale) {
    if (scale < 1) scale = 1;
    if (scale > SW_MAX_INTERNAL_SCALE) scale = SW_MAX_INTERNAL_SCALE;
    s_scale = scale;
    REC(OP_SCALE, scale);
}
static int  t_scale(void) { return s_scale; }
static void t_set_filter(int b) { s_filter = b; NAT(OP_FILTER, b); REC(OP_FILTER, b); }
static int  t_filter(void) { return s_filter; }
static void t_semi(int e, int m) {
    NAT(OP_SEMI, e, m); s_sh_semi[0] = e; s_sh_semi[1] = m; REC(OP_SEMI, e, m);
}
static void t_mask(int s, int c) { NAT(OP_MASK, s, c); s_sh_mask[0] = s; s_sh_mask[1] = c; REC(OP_MASK, s, c); }
static void t_tw(uint32_t raw) { NAT(OP_TW, (int32_t)raw); s_sh_tw = (int)raw; REC(OP_TW, (int32_t)raw); }
static void t_mod(int r, int g, int b, int raw) {
    NAT(OP_MOD, r, g, b, raw);
    s_sh_mod[0] = r; s_sh_mod[1] = g; s_sh_mod[2] = b; s_sh_mod[3] = raw;
    REC(OP_MOD, r, g, b, raw);
}
static void t_precise(int e, int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t x2, int32_t y2) {
    NAT(OP_PRECISE, e, x0, y0, x1, y1, x2, y2);
    REC(OP_PRECISE, e, x0, y0, x1, y1, x2, y2);
}
static void t_persp(int e, float q0, float q1, float q2) {
    int32_t a[4] = { e, 0, 0, 0 };
    float q[3] = { q0, q1, q2 };
    memcpy(a + 1, q, sizeof q);
    native(OP_PERSP, 4, a);
    rec_args(OP_PERSP, 4, a);
}
static void t_fill(int x, int y, int w, int h, uint16_t c) {
    NAT(OP_FILL, x, y, w, h, c); stale_clear_rect(x, y, w, h); REC(OP_FILL, x, y, w, h, c);
}
static void t_copy(int sx, int sy, int dx, int dy, int w, int h) {
    NAT(OP_COPY, sx, sy, dx, dy, w, h);
    if (w > 0 && h > 0) {
        if (stale_any(sx, sy, w, h)) { stale_set(dx, dy, dx + w - 1, dy + h - 1, 1, 0); s_stale_area[0] = -1; }
        else stale_clear_rect(dx, dy, w, h);
    }
    REC(OP_COPY, sx, sy, dx, dy, w, h);
}
static void t_flat_tri(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c) {
    if (!s_skip_raster) NAT(OP_FLAT_TRI, x0, y0, x1, y1, x2, y2, c);
    bd_sync(); REC(OP_FLAT_TRI, x0, y0, x1, y1, x2, y2, c);
}
static void t_gour_tri(int x0, int y0, uint16_t c0, int x1, int y1, uint16_t c1, int x2, int y2, uint16_t c2) {
    if (!s_skip_raster) NAT(OP_GOUR_TRI, x0, y0, c0, x1, y1, c1, x2, y2, c2);
    bd_sync(); REC(OP_GOUR_TRI, x0, y0, c0, x1, y1, c1, x2, y2, c2);
}
static void t_tex_tri(int x0, int y0, int u0, int v0, int x1, int y1, int u1, int v1,
                      int x2, int y2, int u2, int v2, uint16_t cx, uint16_t cy, uint16_t tp) {
    if (!s_skip_raster) NAT(OP_TEX_TRI, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2, cx, cy, tp);
    bd_sync(); REC(OP_TEX_TRI, x0, y0, u0, v0, x1, y1, u1, v1, x2, y2, u2, v2, cx, cy, tp);
}
static void t_stex_tri(int x0, int y0, int u0, int v0, uint32_t c0, int x1, int y1, int u1, int v1, uint32_t c1,
                       int x2, int y2, int u2, int v2, uint32_t c2, uint16_t cx, uint16_t cy, uint16_t tp, int raw) {
    const int32_t a[] = { x0, y0, u0, v0, (int32_t)c0, x1, y1, u1, v1, (int32_t)c1,
                          x2, y2, u2, v2, (int32_t)c2, cx, cy, tp, raw };
    if (!s_skip_raster) native(OP_STEX_TRI, 19, a);
    bd_sync();
    rec_args(OP_STEX_TRI, 19, a);
}
static void t_flat_rect(int x, int y, int w, int h, uint16_t c) {
    if (!s_skip_raster) NAT(OP_FLAT_RECT, x, y, w, h, c);
    bd_sync(); REC(OP_FLAT_RECT, x, y, w, h, c);
}
static void t_tex_rect(int x, int y, int w, int h, int u, int v, uint16_t cx, uint16_t cy, uint16_t tp) {
    if (!s_skip_raster) NAT(OP_TEX_RECT, x, y, w, h, u, v, cx, cy, tp);
    bd_sync(); REC(OP_TEX_RECT, x, y, w, h, u, v, cx, cy, tp);
}
static void t_tex_rect_scaled(int x, int y, int w, int h, int u0, int v0, int u1, int v1,
                              uint16_t cx, uint16_t cy, uint16_t tp) {
    if (!s_skip_raster) NAT(OP_TEX_RECT_SCALED, x, y, w, h, u0, v0, u1, v1, cx, cy, tp);
    bd_sync(); REC(OP_TEX_RECT_SCALED, x, y, w, h, u0, v0, u1, v1, cx, cy, tp);
}
static void t_line(int x0, int y0, int x1, int y1, uint16_t c) {
    if (!s_skip_raster) NAT(OP_LINE, x0, y0, x1, y1, c);
    bd_sync(); REC(OP_LINE, x0, y0, x1, y1, c);
}
static void t_sline(int x0, int y0, uint16_t c0, int x1, int y1, uint16_t c1) {
    if (!s_skip_raster) NAT(OP_SLINE, x0, y0, c0, x1, y1, c1);
    bd_sync(); REC(OP_SLINE, x0, y0, c0, x1, y1, c1);
}
static void t_pixel(int x, int y, uint16_t p) { NAT(OP_PIXEL, x, y, p); REC(OP_PIXEL, x, y, p); }
static uint16_t t_read(int x, int y) { native_sync(); return sw_vram_read(x, y); }
static void t_xfer_in(int x, int y, int w, int h, const uint16_t *d) {
    /* gpu.c has already written these pixels into the VRAM array itself
     * (after gr_vram_sync), and d may point into it (t_vram_restored): the
     * copy is made here, once the native thread has nothing left to draw. */
    native_sync();
    sw_vram_transfer_in(x, y, w, h, d);
    if (w <= 0 || h <= 0) return;
    stale_clear_rect(x, y, w, h);
    const uint32_t px = (uint32_t)w * (uint32_t)h;
    int32_t *p = (int32_t *)rec_begin(OP_XFER_IN, 16u + px * 2u);
    if (!p) return;
    p[0] = x; p[1] = y; p[2] = w; p[3] = h;
    memcpy(p + 4, d, px * 2u);
    rec_commit();
}
static void t_xfer_out(int x, int y, int w, int h, uint16_t *d) {
    native_sync();
    sw_vram_transfer_out(x, y, w, h, d);
}
static void t_area(int x1, int y1, int x2, int y2) {
    NAT(OP_AREA, x1, y1, x2, y2);
    s_sh_area[0] = x1; s_sh_area[1] = y1; s_sh_area[2] = x2; s_sh_area[3] = y2;
    REC(OP_AREA, x1, y1, x2, y2);
}
static void t_get_area(int *x1, int *y1, int *x2, int *y2) {
    native_sync();                       /* the rasterizer's own (clamped) values */
    sw_get_draw_area(x1, y1, x2, y2);
}
static void t_offset(int x, int y) { NAT(OP_OFFSET, x, y); s_sh_off[0] = x; s_sh_off[1] = y; REC(OP_OFFSET, x, y); }

static void t_wide_conf(int w, int off) {
    if (w <= 0 || w != s_wide_w) s_wide_nbases = 0;
    s_wide_w = w > 0 ? w : 0;
    if (!s_wide_w) s_wide_target = 0;
    s_sh_wide[0] = w; s_sh_wide[1] = off;
    if (!s_wide_w) s_sh_target = -1;
    REC(OP_WIDE_CONF, w, off);
}
static void t_wide_target(int base) {
    if (s_wide_w) { note_base(base); s_wide_target = 1; }
    /* Once per frame (the game picks its draw buffer): gameplay on or off.
     * Leaving gameplay re-arms the skip for the next time. */
    native_kick_pending();
    s_gameplay = gpu_ws_gameplay_state_active();
    if (!s_gameplay) s_quiet = 0;
    else if (s_quiet < QUIET_FRAMES) s_quiet++;
    s_sh_target = base;
    REC(OP_WIDE_TARGET, base);
}
static void t_wide_off(void) { s_wide_target = 0; s_sh_target = -1; REC(OP_WIDE_OFF, 0); }
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
    native_sync();
    return sw_render_display(o, p, dx, dy, dw, dh);       /* native VRAM */
}
static int t_render_hires(uint32_t *o, int p, int dx, int dy, int dw, int dh) {
    (void)o;
    {   /* counted only when recorded (GPU mode may drop it) */
        const int32_t a[] = { p, dx, dy, dw, dh, s_scale };
        rec_frame(OP_READ_HIRES, 6, a);
    }
    s_pending_read = 1;
    return dw * dh * s_scale * s_scale;
}
static int t_render_wide(uint32_t *o, int p, int base, int dy, int dh) {
    (void)o;
    if (!s_wide_w) return 0;
    int known = 0;
    for (int i = 0; i < s_wide_nbases; i++) if (s_wide_bases[i] == base) known = 1;
    if (!known) return 0;
    {
        const int32_t a[] = { p, base, dy, dh, s_scale };
        rec_frame(OP_READ_WIDE, 5, a);
    }
    s_pending_read = 1;
    return s_wide_w * s_scale * dh * s_scale;
}
static int t_wide_dump(uint32_t *o, int cap, int *ow, int *oh, int base) {
    if (s_gl_mode) { *ow = 0; *oh = 0; return 0; }
    drain();
    return swhr_wide_dump_full(o, cap, ow, oh, base);
}

/* psx_web_publish_frame: 1 if the frame went through the presentation thread
 * (a queued read-out, or the pixels themselves to keep frames in order). */
int swt_publish(const uint32_t *px, int w, int h, int logical_w, int dst_w,
                int dst_h, int content_h, int nearest) {
    if (!s_started) return 0;
    native_kick_pending();               /* the frame's last native calls */
    if (s_pending_read) {
        s_pending_read = 0;
        REC(OP_PUBLISH, w, h, logical_w, dst_w, dst_h, content_h, nearest);
        return 1;
    }
    const uint32_t n = (uint32_t)w * (uint32_t)h;
    int32_t *p = (int32_t *)rec_begin(OP_PUBLISH_PIXELS, 28u + n * 4u);
    if (!p) return 1;
    p[0] = w; p[1] = h; p[2] = logical_w; p[3] = dst_w; p[4] = dst_h; p[5] = content_h; p[6] = nearest;
    memcpy(p + 7, px, (size_t)n * 4u);
    rec_commit();
    return 1;
}

/* The authoritative VRAM was replaced (savestate load): copy it whole. */
static void t_vram_restored(void) {
    memset(s_stale, 0, sizeof s_stale);
    s_stale_area[0] = -1;
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
    .vram_sync = t_vram_sync,
};
