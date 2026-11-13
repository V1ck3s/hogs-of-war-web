/* Browser presentation: the emulation pthread copies each finished frame into
 * one of two buffers in shared wasm memory and returns at once; the page draws
 * the latest one with WebGL at the display's refresh rate, scaled to any
 * screen. No synchronous hop to the browser thread per frame (SDL's canvas
 * present proxies and waits). Pixels are the software renderer's ARGB8888
 * words (bytes B,G,R,A in memory). */
#include <emscripten/emscripten.h>
#include <stdint.h>
#include <string.h>

#define WEB_MAX_W 1280
#define WEB_MAX_H 1024

static uint32_t s_frames[2][WEB_MAX_W * WEB_MAX_H];
/* [0] seq (odd while writing), [1] buffer index, [2] width, [3] height,
 * [4] logical width of the present (aspect: logical_w : 480*scale),
 * [5] destination width (pinned 4:3 or the logical width), [6] dest height,
 * [7] content height out of 240 (short FMV bands), [8] nearest filtering. */
static volatile uint32_t s_hdr[16];

EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_frame_header(void) { return (uintptr_t)s_hdr; }
EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_frame_buffer(int i) { return (uintptr_t)s_frames[i & 1]; }

void psx_web_publish_frame(const uint32_t *px, int w, int h, int logical_w,
                           int dst_w, int dst_h, int content_h, int nearest) {
    if (!px || w <= 0 || h <= 0) return;
    if (w > WEB_MAX_W) w = WEB_MAX_W;
    if (h > WEB_MAX_H) h = WEB_MAX_H;
    const uint32_t back = s_hdr[1] ^ 1u;
    memcpy(s_frames[back], px, (size_t)w * (size_t)h * 4u);
    __atomic_add_fetch(&s_hdr[0], 1u, __ATOMIC_SEQ_CST);   /* odd: updating */
    s_hdr[1] = back;
    s_hdr[2] = (uint32_t)w;
    s_hdr[3] = (uint32_t)h;
    s_hdr[4] = (uint32_t)logical_w;
    s_hdr[5] = (uint32_t)dst_w;
    s_hdr[6] = (uint32_t)dst_h;
    s_hdr[7] = (uint32_t)content_h;
    s_hdr[8] = (uint32_t)nearest;
    __atomic_add_fetch(&s_hdr[0], 1u, __ATOMIC_SEQ_CST);   /* even: published */
}
