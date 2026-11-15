/*
 * Scope views on a wide screen.
 *
 * Holding L1 with a sighted weapon (sniper rifle, machine gun) puts the pig
 * in one of its two scope states (14, 17: the state setter at 0x80094E80
 * switches on the pig's state word +0x9C). Entering either calls
 * 0x80099D40(*(0x80077680), 1), which sets word +0x1C of that view block;
 * leaving them sets it back to 0. The game then masks the 4:3 frame with the
 * scope (black outside a circle). In a native-wide view the extended sides
 * are not part of that mask and showed the plain world. The sniper rifle
 * also zooms (camera projection distance, first word of the block at
 * 0x80077678, above 320); the machine gun does not.
 *
 * While a scope view is up in a battle, the frame is presented 4:3 with
 * black side bars, so the scope fills the screen as it was authored.
 * Presentation only: guest state is untouched, so online peers with
 * different screens stay identical.
 */
#include "mod_plugins.h"

#include <stdint.h>

#define STATE_HANDLER  0x8002AA50u   /* 0x80042768 while a battle runs */
#define STATE_BATTLE   0x80042768u
#define CAMERA_PTR     0x80077678u   /* -> camera block, [0] = projection H */
#define H_NORMAL       320u
#define VIEW_PTR       0x80077680u   /* -> view block, +0x1C = 1 in a scope state */

static int ram_addr_ok(uint32_t a) {
    return (a & 3u) == 0 && (a >> 24) == 0x80u && (a & 0x00FFFFFFu) < 0x00200000u;
}

static int scope_zoomed(void) {
    if (psx_mod_read_word(STATE_HANDLER) != STATE_BATTLE) return 0;
    const uint32_t view = psx_mod_read_word(VIEW_PTR);
    if (ram_addr_ok(view) && psx_mod_read_word(view + 0x1Cu) == 1u) return 1;
    const uint32_t cam = psx_mod_read_word(CAMERA_PTR);
    if (!ram_addr_ok(cam)) return 0;
    const uint32_t h = psx_mod_read_word(cam);
    return h > H_NORMAL && h <= 4u * H_NORMAL;
}

PSX_MOD_CONSTRUCTOR(cochons_register_scope_view) {
    psx_mod_set_native_43_predicate(scope_zoomed);
}
