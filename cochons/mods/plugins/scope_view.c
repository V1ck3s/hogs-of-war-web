/*
 * Sniper scope on a wide screen.
 *
 * Zooming with the sniper rifle (hold L1 while aiming) narrows the camera:
 * the battle camera's projection distance, stored first in the camera block
 * pointed to by 0x80077678, grows from 320 (normal view) up to 1280
 * (0x80063304 / 0x80063368 clamp it). The game then masks the 4:3 frame
 * with the scope (black outside a circle). In a native-wide view the
 * extended sides are not part of that mask and showed the plain world.
 *
 * While zoomed in a battle, the frame is presented 4:3 with black side bars,
 * so the scope fills the screen as it was authored. Presentation only: guest
 * state is untouched, so online peers with different screens stay identical.
 */
#include "mod_plugins.h"

#include <stdint.h>

#define STATE_HANDLER  0x8002AA50u   /* 0x80042768 while a battle runs */
#define STATE_BATTLE   0x80042768u
#define CAMERA_PTR     0x80077678u   /* -> camera block, [0] = projection H */
#define H_NORMAL       320u

static int ram_addr_ok(uint32_t a) {
    return (a & 3u) == 0 && (a >> 24) == 0x80u && (a & 0x00FFFFFFu) < 0x00200000u;
}

static int scope_zoomed(void) {
    if (psx_mod_read_word(STATE_HANDLER) != STATE_BATTLE) return 0;
    const uint32_t cam = psx_mod_read_word(CAMERA_PTR);
    if (!ram_addr_ok(cam)) return 0;
    const uint32_t h = psx_mod_read_word(cam);
    return h > H_NORMAL && h <= 4u * H_NORMAL;
}

PSX_MOD_CONSTRUCTOR(cochons_register_scope_view) {
    psx_mod_set_native_43_predicate(scope_zoomed);
}
