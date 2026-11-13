/*
 * Online multiplayer (WebAssembly lockstep build): who controls the game.
 *
 * Hogs of War plays every team's turn on controller 1 (hot-seat). Online,
 * every participant owns a team, and controller 1 takes only the input of the
 * participant entitled to act at this moment:
 *   - battle turn of team N: the participant who owns team N;
 *   - team setup ("PORC FORCE" ... "JOUEUR SUIVANT"): the owner of the team
 *     being set up;
 *   - anything else (menus, debriefs, single-player missions): the host.
 * A participant who left is replaced by the host.
 *
 * Session modes (PSX_WEB_MODE, chosen in the room):
 *   multi: the menus lead straight to "SELECTION NIVEAU MULTIJOUEUR" with one
 *          JOUEUR team per participant (plus PSX_WEB_CPUS computer teams), and
 *          that screen cannot be left backwards: the session stays multiplayer.
 *   solo:  the menus lead straight to "UN JOUEUR" (new game / load game).
 * The intro and title are skipped in both.
 *
 * Every decision is a pure function of guest RAM at the frame boundary, the
 * frame number and the frame's inputs (no state kept here), so every peer —
 * including one that joined from a snapshot — makes the same choice.
 *
 * Addresses (French SLES-02766, found by diffing deterministic RAM dumps):
 *   0x8002AA50  game-state handler: 2 = menus, 0x80042768 = battle
 *   0x800858A4  pointer to the current menu: 0x800E4408 main, 0x800E47B0
 *               UN JOUEUR, 0x800E4840 team types, 0x800E4BA0 multiplayer
 *               level select, 0x800E4D50 team setup; +0xC = its cursor
 *               (main: 0 UN JOUEUR, 1 MULTIJOUEUR; types: 0..3 slots, 4 OK)
 *   0x8002C9F8  team types, 4 words: 0 JOUEUR, 1 CPU, 2 OFF
 *   0x80085960  team being set up (0-based, in slot order)
 *   0x800F7008  pointer to the battle state; +0x348 = 1 multiplayer battle,
 *               +0x360 = number (1-based) of the team whose turn it is
 */
#include "mod_plugins.h"
#include "psx_lockstep.h"

#include <stdlib.h>
#include <string.h>

#define STATE_HANDLER      0x8002AA50u
#define STATE_MENUS        2u
#define STATE_BATTLE       0x80042768u
#define MENU_PTR           0x800858A4u
#define MENU_MAIN          0x800E4408u
#define MENU_SOLO          0x800E47B0u
#define MENU_TYPES         0x800E4840u
#define MENU_LEVEL         0x800E4BA0u
#define MENU_SETUP         0x800E4D50u
#define MENU_CURSOR        0x0Cu
#define TEAM_TYPES         0x8002C9F8u
#define SETUP_TEAM         0x80085960u
#define BATTLE_STATE_PTR   0x800F7008u
#define BATTLE_MULTI       0x348u
#define BATTLE_TURN_TEAM   0x360u

/* Pad bits (active-low words). */
#define PAD_SELECT   (1u << 0)
#define PAD_START    (1u << 3)
#define PAD_UP       (1u << 4)
#define PAD_DOWN     (1u << 6)
#define PAD_TRIANGLE (1u << 12)
#define PAD_CIRCLE   (1u << 13)
#define PAD_CROSS    (1u << 14)

enum { MODE_FREE, MODE_MULTI, MODE_SOLO };
static int s_mode = -1;
static uint32_t s_cpus;

static void read_mode(void) {
    const char *m = getenv("PSX_WEB_MODE");
    s_mode = !m ? MODE_FREE : !strcmp(m, "multi") ? MODE_MULTI : !strcmp(m, "solo") ? MODE_SOLO : MODE_FREE;
    const char *c = getenv("PSX_WEB_CPUS");
    s_cpus = c ? (uint32_t)atoi(c) : 0u;
}

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

/* A short press every 40 frames: menus see one clean edge per step and have
 * time to switch screens before the next one. */
static uint16_t pulse(uint32_t frame, uint32_t bits) {
    return (uint16_t)((frame % 40u) < 3u ? (0xFFFFu & ~bits) : 0xFFFFu);
}

static uint32_t host_of(uint32_t n) {
    const uint32_t h = psx_lockstep_host();
    return h < n ? h : 0u;
}

/* Participant entitled to act for `slot` (team slot, 0-based). */
static uint32_t slot_owner(uint32_t slot, uint32_t n) {
    if (slot < n && !(psx_lockstep_gone_mask() & (1u << slot))) return slot;
    return host_of(n);
}

/* Automatic menu steps of the session's mode. Returns 1 when it set pads. */
static int menu_driver(uint32_t frame, uint32_t n, const uint16_t *words, uint16_t pads[2]) {
    if (s_mode == MODE_FREE) return 0;
    const uint32_t state = psx_mod_read_word(STATE_HANDLER);
    const uint32_t menu = psx_mod_read_word(MENU_PTR);
    const uint32_t host = host_of(n);
    pads[1] = 0xFFFFu;
    if (state != STATE_MENUS && state != STATE_BATTLE && menu == 0) {   /* never set before the first menu */
        pads[0] = pulse(frame, PAD_START);              /* intro, title */
        psx_lockstep_set_owner(-1, 0);
        return 1;
    }
    if (state != STATE_MENUS) return 0;
    if (menu == MENU_MAIN) {                              /* main menu */
        const uint32_t cur = psx_mod_read_word(MENU_MAIN + MENU_CURSOR);
        const uint32_t want = s_mode == MODE_MULTI ? 1u : 0u;
        pads[0] = pulse(frame, cur == want ? PAD_CROSS : cur < want ? PAD_DOWN : PAD_UP);
        psx_lockstep_set_owner(-1, 0);
        return 1;
    }
    if (s_mode == MODE_MULTI && menu == MENU_TYPES) {     /* team types */
        uint32_t players = n < 4u ? n : 4u;
        /* A battle needs two teams: one participant plays the computer. */
        const uint32_t cpus = players + s_cpus < 2u ? 2u - players : s_cpus;
        for (uint32_t s = 0; s < 4u; s++) {
            const uint32_t t = s < players ? 0u : s < players + cpus ? 1u : 2u;
            if (psx_mod_read_word(TEAM_TYPES + 4u * s) != t) psx_mod_write_word(TEAM_TYPES + 4u * s, t);
        }
        const uint32_t cur = psx_mod_read_word(MENU_TYPES + MENU_CURSOR);
        pads[0] = pulse(frame, cur == 4u ? PAD_CROSS : PAD_DOWN);
        psx_lockstep_set_owner(-1, 0);
        return 1;
    }
    /* The mode's home screen cannot be left backwards. */
    if ((s_mode == MODE_MULTI && menu == MENU_LEVEL) ||
        (s_mode == MODE_SOLO && menu == MENU_SOLO)) {
        pads[0] = (uint16_t)(words[host] | PAD_TRIANGLE | PAD_CIRCLE | PAD_SELECT);
        psx_lockstep_set_owner((int)host, 0);
        return 1;
    }
    return 0;
}

static void turn_owner_select(uint32_t frame, const uint16_t *words,
                              uint32_t nplayers, uint16_t pads[2]) {
    if (s_mode < 0) read_mode();
    if (!nplayers) { psx_lockstep_default_select(frame, words, nplayers, pads); return; }
    if (menu_driver(frame, nplayers, words, pads)) return;
    const uint32_t team = battle_turn_team();
    if (team) {
        /* Teams are numbered in slot order: JOUEUR teams first, one per
         * participant, then the computer's (which ignore the pad). */
        const uint32_t owner = slot_owner(team - 1u, nplayers);
        pads[0] = words[owner];
        pads[1] = 0xFFFFu;
        psx_lockstep_set_owner((int)owner, team);
        return;
    }
    if (psx_mod_read_word(STATE_HANDLER) == STATE_MENUS &&
        psx_mod_read_word(MENU_PTR) == MENU_SETUP) {
        const uint32_t slot = psx_mod_read_byte(SETUP_TEAM);   /* team setup */
        const uint32_t owner = slot_owner(slot, nplayers);
        pads[0] = words[owner];
        pads[1] = 0xFFFFu;
        psx_lockstep_set_owner((int)owner, 0x100u | (slot + 1u));   /* setup */
        return;
    }
    psx_lockstep_default_select(frame, words, nplayers, pads);
}

PSX_MOD_CONSTRUCTOR(cochons_register_turn_owner) {
    psx_lockstep_set_select(turn_owner_select);
}
