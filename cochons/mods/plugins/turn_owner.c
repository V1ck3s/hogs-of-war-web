/*
 * Online multiplayer (WebAssembly lockstep build): real turn ownership.
 *
 * Hogs of War plays every team's turn on controller 1 (hot-seat). Online,
 * each participant owns a team: while a battle turn is running, controller 1
 * takes only the input of the participant who owns the team whose turn it is,
 * so nobody else can act for them. Outside multiplayer battles (menus, team
 * setup, debriefs, single-player missions) the host drives the controller.
 *
 * Team N (1-based, in the game's team order) belongs to participant
 * (N - 1) mod <participants>: Joueur 1 plays team 1, Joueur 2 team 2...
 * CPU teams ignore the pad anyway.
 *
 * Everything read here is guest RAM at the frame boundary and the frame's
 * inputs, so every peer makes the same choice.
 *
 * Addresses (French SLES-02766, found by diffing deterministic RAM dumps):
 *   0x8002AA50  current game-state handler; 0x80042768 = battle gameplay
 *               (the same state the widescreen hack keys on)
 *   0x800F7008  pointer to the battle state structure
 *     +0x348    1 in a MULTIJOUEUR battle, 0 in a single-player one
 *     +0x360    number (1-based) of the team whose turn it is
 *
 * Single player (UN JOUEUR) online: the host plays, the others watch.
 */
#include "mod_plugins.h"
#include "psx_lockstep.h"

#define STATE_HANDLER      0x8002AA50u
#define STATE_BATTLE       0x80042768u
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

static void turn_owner_select(uint32_t frame, const uint16_t *words,
                              uint32_t nplayers, uint16_t pads[2]) {
    const uint32_t team = battle_turn_team();
    if (!team || !nplayers) {
        psx_lockstep_default_select(frame, words, nplayers, pads);
        return;
    }
    const uint32_t owner = (team - 1u) % nplayers;
    pads[0] = words[owner];
    pads[1] = 0xFFFFu;
    psx_lockstep_set_owner((int)owner, team);
}

PSX_MOD_CONSTRUCTOR(cochons_register_turn_owner) {
    psx_lockstep_set_select(turn_owner_select);
}
