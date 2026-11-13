/*
 * Widescreen mod for Cochons de Guerre (SLES-02766), from Frontschweine's.
 *
 * "adaptive" (default, used by the streaming server): the window shape drives
 * the field of view live, from 4:3 up to 32:9 (super-ultrawide, e.g. 5120x1440) — the server resizes the game
 * window to each host's screen. A fixed "N:M" (4:3 .. 32:9) keeps that
 * view whatever the window (Frontschweine's 16:9 / 21:9 modes, and the
 * online build, where every peer must project the same world).
 */
#include "mod_plugins.h"

#include <stdio.h>
#include <string.h>

#define PACKAGE_ID "frontschweine.presentation.widescreen"
#define FEATURE_ID "widescreen"

static void widescreen_activate(void) {
    char aspect[16] = "adaptive";
    (void)psx_mod_option_value(PACKAGE_ID, FEATURE_ID, "aspect", aspect, sizeof aspect);
    unsigned num = 0, den = 0;
    /* Fixed "N:M" (4:3 .. 32:9): the view no longer follows the window. The
     * online lockstep build uses it so every peer projects the same world. */
    if (strcmp(aspect, "adaptive") != 0 && sscanf(aspect, "%u:%u", &num, &den) == 2 &&
        psx_mod_set_fixed_display_aspect(num, den)) {
        return;
    }
    (void)psx_mod_set_fixed_display_aspect(16u, 9u); /* initial window shape */
    (void)psx_mod_set_adaptive_display_aspect(32u, 9u);
}

PSX_MOD_CONSTRUCTOR(cochons_register_widescreen_plugin) {
    (void)psx_mod_register_activation_plugin("frontschweine.widescreen",
                                             widescreen_activate);
}
