/*
 * Widescreen mod for Cochons de Guerre (SLES-02766), from Frontschweine's.
 *
 * "adaptive" (default, used by the streaming server): the window shape drives
 * the field of view live, from 4:3 up to 32:9 (super-ultrawide, e.g. 5120x1440) — the server resizes the game
 * window to each host's screen. "16:9" / "21:9" keep Frontschweine's fixed
 * modes.
 */
#include "mod_plugins.h"

#include <string.h>

#define PACKAGE_ID "frontschweine.presentation.widescreen"
#define FEATURE_ID "widescreen"

static void widescreen_activate(void) {
    char aspect[16] = "adaptive";
    (void)psx_mod_option_value(PACKAGE_ID, FEATURE_ID, "aspect", aspect, sizeof aspect);
    if (strcmp(aspect, "21:9") == 0) {
        (void)psx_mod_set_fixed_display_aspect(21u, 9u);
    } else if (strcmp(aspect, "16:9") == 0) {
        (void)psx_mod_set_fixed_display_aspect(16u, 9u);
    } else {
        (void)psx_mod_set_fixed_display_aspect(16u, 9u); /* initial window shape */
        (void)psx_mod_set_adaptive_display_aspect(32u, 9u);
    }
}

PSX_MOD_CONSTRUCTOR(cochons_register_widescreen_plugin) {
    (void)psx_mod_register_activation_plugin("frontschweine.widescreen",
                                             widescreen_activate);
}
