/*
 * gpu_gl_web.c — replay side of the browser's WebGL 2 presentation renderer.
 *
 * gpu_gl_renderer.c runs in dual-raster mode in the browser (see
 * gpu_gl_web_shim.h): every primitive is drawn on the GPU only, and its calls
 * to the software mirror land here instead of in the emulation thread's
 * rasterizer. Only the VRAM writes from the CPU matter on this side: the
 * upload path reads the uploaded rectangle back from the replay VRAM copy, so
 * transfers and single-pixel writes are applied to it; every drawing call is
 * the GPU's alone (no CPU mirror is kept, nothing reads it back).
 *
 * The backdrop gate of the current primitive is the value the emulation
 * thread recorded for it (gpu_sw_threaded.c, OP_BD).
 */
#if defined(PSX_WEB)
#include "gpu_gl_web_shim.h"
#include "gpu_sw_renderer.h"

#include <stdint.h>
#include <string.h>

static uint16_t *s_vram;

/* Backdrop gate of the primitive being replayed (set from the ring). */
int g_swg_in_backdrop = 0;
int g_swg_tagged = 0;
int swg_prim_in_backdrop(void) { return g_swg_in_backdrop; }
int swg_prim_is_tagged(void) { return g_swg_tagged; }

void swg_renderer_init(uint16_t *vram) { s_vram = vram; }

void swg_vram_write(int x, int y, uint16_t pixel) {
    s_vram[(size_t)(y & 511) * 1024u + (size_t)(x & 1023)] = pixel;
}
uint16_t swg_vram_read(int x, int y) {
    return s_vram[(size_t)(y & 511) * 1024u + (size_t)(x & 1023)];
}
/* The emulation thread already applied the transfer to the authoritative
 * VRAM (mask bits included); the words recorded are what it wrote. */
void swg_vram_transfer_in(int x, int y, int w, int h, const uint16_t *data) {
    for (int r = 0; r < h; r++) {
        uint16_t *row = s_vram + (size_t)((y + r) & 511) * 1024u;
        const uint16_t *src = data + (size_t)r * (size_t)w;
        if ((x & 1023) + w <= 1024) {
            memcpy(row + (x & 1023), src, (size_t)w * 2u);
        } else {
            for (int c = 0; c < w; c++) row[(x + c) & 1023] = src[c];
        }
    }
}
void swg_vram_transfer_out(int x, int y, int w, int h, uint16_t *data) {
    for (int r = 0; r < h; r++)
        for (int c = 0; c < w; c++)
            data[(size_t)r * (size_t)w + (size_t)c] = swg_vram_read(x + c, y + r);
}

/* Drawing and state: the GPU replay owns them (dual-raster, no CPU mirror). */
void swg_renderer_set_scale(int scale) { (void)scale; }
void swg_set_precise_triangle(int enabled, int32_t x0, int32_t y0, int32_t x1, int32_t y1,
                              int32_t x2, int32_t y2) {
    (void)enabled; (void)x0; (void)y0; (void)x1; (void)y1; (void)x2; (void)y2;
}
void swg_set_perspective_triangle(int enabled, float q0, float q1, float q2) {
    (void)enabled; (void)q0; (void)q1; (void)q2;
}
void swg_set_texture_filter(int bilinear) { (void)bilinear; }
void swg_set_semi_transparency(int enabled, int mode) { (void)enabled; (void)mode; }
void swg_set_mask_bits(int set_bit, int check_bit) { (void)set_bit; (void)check_bit; }
void swg_set_texture_window(uint32_t raw) { (void)raw; }
void swg_set_color_modulation(int r, int g, int b, int raw) { (void)r; (void)g; (void)b; (void)raw; }
void swg_fill_rect(int x, int y, int w, int h, uint16_t c) { (void)x; (void)y; (void)w; (void)h; (void)c; }
void swg_copy_rect(int sx, int sy, int dx, int dy, int w, int h) {
    (void)sx; (void)sy; (void)dx; (void)dy; (void)w; (void)h;
}
void swg_draw_flat_triangle(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c) {
    (void)x0; (void)y0; (void)x1; (void)y1; (void)x2; (void)y2; (void)c;
}
void swg_draw_gouraud_triangle(int x0, int y0, uint16_t c0, int x1, int y1, uint16_t c1,
                               int x2, int y2, uint16_t c2) {
    (void)x0; (void)y0; (void)c0; (void)x1; (void)y1; (void)c1; (void)x2; (void)y2; (void)c2;
}
void swg_draw_textured_triangle(int x0, int y0, int u0, int v0, int x1, int y1, int u1, int v1,
                                int x2, int y2, int u2, int v2,
                                uint16_t cx, uint16_t cy, uint16_t tp) {
    (void)x0; (void)y0; (void)u0; (void)v0; (void)x1; (void)y1; (void)u1; (void)v1;
    (void)x2; (void)y2; (void)u2; (void)v2; (void)cx; (void)cy; (void)tp;
}
void swg_draw_shaded_textured_triangle(int x0, int y0, int u0, int v0, uint32_t c0,
                                       int x1, int y1, int u1, int v1, uint32_t c1,
                                       int x2, int y2, int u2, int v2, uint32_t c2,
                                       uint16_t cx, uint16_t cy, uint16_t tp, int raw) {
    (void)x0; (void)y0; (void)u0; (void)v0; (void)c0; (void)x1; (void)y1; (void)u1; (void)v1;
    (void)c1; (void)x2; (void)y2; (void)u2; (void)v2; (void)c2; (void)cx; (void)cy; (void)tp;
    (void)raw;
}
void swg_draw_flat_rect(int x, int y, int w, int h, uint16_t c) { (void)x; (void)y; (void)w; (void)h; (void)c; }
void swg_draw_textured_rect(int x, int y, int w, int h, int u, int v,
                            uint16_t cx, uint16_t cy, uint16_t tp) {
    (void)x; (void)y; (void)w; (void)h; (void)u; (void)v; (void)cx; (void)cy; (void)tp;
}
void swg_draw_textured_rect_scaled(int x, int y, int w, int h, int u0, int v0, int u1, int v1,
                                   uint16_t cx, uint16_t cy, uint16_t tp) {
    (void)x; (void)y; (void)w; (void)h; (void)u0; (void)v0; (void)u1; (void)v1;
    (void)cx; (void)cy; (void)tp;
}
void swg_draw_line(int x0, int y0, int x1, int y1, uint16_t c) { (void)x0; (void)y0; (void)x1; (void)y1; (void)c; }
void swg_draw_shaded_line(int x0, int y0, uint16_t c0, int x1, int y1, uint16_t c1) {
    (void)x0; (void)y0; (void)c0; (void)x1; (void)y1; (void)c1;
}
void swg_set_draw_area(int x1, int y1, int x2, int y2) { (void)x1; (void)y1; (void)x2; (void)y2; }
void swg_get_draw_area(int *x1, int *y1, int *x2, int *y2) { *x1 = 0; *y1 = 0; *x2 = 1023; *y2 = 511; }
void swg_set_draw_offset(int x, int y) { (void)x; (void)y; }
void swg_wide_configure(int wide_w, int offset) { (void)wide_w; (void)offset; }
void swg_wide_set_target(int base_x) { (void)base_x; }
void swg_wide_disable_target(void) { }
void swg_wide_clear(int base_x, int y, int h, uint16_t c) { (void)base_x; (void)y; (void)h; (void)c; }
void swg_wide_clear_margins(int base_x, int y, int h, uint16_t c, int sides) {
    (void)base_x; (void)y; (void)h; (void)c; (void)sides;
}
/* Read-outs are never asked of the replay: the picture goes to the canvas. */
int swg_render_display(uint32_t *o, int p, int dx, int dy, int dw, int dh) {
    (void)o; (void)p; (void)dx; (void)dy; (void)dw; (void)dh; return 0;
}
int swg_render_display_hires(uint32_t *o, int p, int dx, int dy, int dw, int dh) {
    (void)o; (void)p; (void)dx; (void)dy; (void)dw; (void)dh; return 0;
}
int swg_render_wide_display(uint32_t *o, int p, int base_x, int dy, int dh) {
    (void)o; (void)p; (void)base_x; (void)dy; (void)dh; return 0;
}
int swg_wide_dump_full(uint32_t *o, int cap, int *ow, int *oh, int base_x) {
    (void)o; (void)cap; (void)base_x; *ow = 0; *oh = 0; return 0;
}
#endif
