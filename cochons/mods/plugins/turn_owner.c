/*
 * Online multiplayer (WebAssembly lockstep build): who controls the game.
 *
 * Hogs of War plays every team's turn on controller 1 (hot-seat). Online,
 * every participant owns a team, and controller 1 takes only the input of the
 * participant entitled to act at this moment (the runtime then waits for that
 * participant's input only, see psx_lockstep.h):
 *   - battle turn of team N: the participant who owns team N;
 *   - team setup ("PORC FORCE" ... "JOUEUR SUIVANT"): the owner of the team
 *     being set up;
 *   - anything else (menus, debriefs, single-player missions): the host.
 * A participant who left is replaced by the host. Teams are numbered in slot
 * order: one JOUEUR team per participant first (see direct_start.c), then
 * the computer's, which ignore the pad.
 *
 * Every decision is a pure function of guest RAM at the frame boundary and
 * the frame's inputs (no state kept here), so every peer — including one that
 * joined from a snapshot — makes the same choice.
 *
 * Addresses (French SLES-02766, found by diffing deterministic RAM dumps):
 *   0x8002AA50  2 in the menus, 0x80042768 in a battle
 *   0x800858A4  pointer to the current menu; 0x800E4D50 = team setup
 *   0x80085960  team being set up (0-based, in slot order)
 *   0x800F7008  pointer to the battle state; +0x348 = 1 multiplayer battle,
 *               +0x360 = number (1-based) of the team whose turn it is
 */
#include "mod_plugins.h"
#include "psx_lockstep.h"

#define STATE_HANDLER      0x8002AA50u
#define STATE_MENUS        2u
#define STATE_BATTLE       0x80042768u
#define MENU_PTR           0x800858A4u
#define MENU_SETUP         0x800E4D50u
#define SETUP_TEAM         0x80085960u
#define BATTLE_STATE_PTR   0x800F7008u
#define BATTLE_MULTI       0x348u
#define BATTLE_TURN_TEAM   0x360u

static int ram_addr_ok(uint32_t a) {
    return (a & 3u) == 0 && ((a & 0x1FFFFFFFu) < 0x00200000u) && (a >> 24) == 0x80u;
}

static uint32_t battle_turn_team(void) {
    if (psx_mod_read_word(STATE_HANDLER) != STATE_BATTLE) return 0;
    const uint32_t st = psx_mod_read_word(BATTLE_STATE_PTR);
    if (!ram_addr_ok(st)) return 0;
    if (psx_mod_read_word(st + BATTLE_MULTI) != 1u) return 0;   /* single player */
    const uint32_t team = psx_mod_read_word(st + BATTLE_TURN_TEAM);
    return (team >= 1u && team <= 8u) ? team : 0u;
}

/* Participant whose pad the game reads at this frame (the runtime waits for
 * that participant's word only, falling back to the host for a team nobody
 * owns or a participant who left). */
static int turn_owner_who(uint32_t frame, uint32_t nplayers, uint32_t *team) {
    (void)frame; (void)nplayers;
    const uint32_t t = battle_turn_team();
    if (t) {
        *team = t;
        return (int)(t - 1u);
    }
    if (psx_mod_read_word(STATE_HANDLER) == STATE_MENUS &&
        psx_mod_read_word(MENU_PTR) == MENU_SETUP) {
        const uint32_t slot = psx_mod_read_byte(SETUP_TEAM);   /* team setup */
        *team = 0x100u | (slot + 1u);
        return (int)slot;
    }
    *team = 0;
    return -1;   /* the host */
}

PSX_MOD_CONSTRUCTOR(cochons_register_turn_owner) {
    psx_lockstep_set_who(turn_owner_who);
}
