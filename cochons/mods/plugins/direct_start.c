/*
 * Direct start for online sessions (SLES-02766, French).
 *
 * The online page starts every player's copy of the game in a mode chosen in
 * the room (environment PSX_WEB_MODE, PSX_WEB_PLAYERS, PSX_WEB_CPUS). With
 * this feature the game itself goes there at boot, without showing anything
 * else:
 *   - the logo videos (INFOGRAM.SXA, SHEFF.SXA), the title picture and the
 *     boot's INTRO.SXA + CUTIN.SXA are skipped (their calls return at once;
 *     a campaign started later still gets its cutscenes);
 *   - the boot path of the menu session no longer shows "Appuyer sur la
 *     touche START", and opens, instead of the main menu (menu 1):
 *       solo:  UN JOUEUR (menu 14);
 *       multi: SELECTION NIVEAU MULTIJOUEUR (menu 28) — which is how the game
 *              itself comes back from a multiplayer battle — after doing what
 *              validating the MULTIJOUEUR team-type screen does: one JOUEUR
 *              team per player, then the computer teams.
 * A screen opened this way has no parent menu (the engine sets the parent
 * only when navigating), so there is no way back out of the chosen mode.
 *
 * The menu module is loaded at run time over other code and runs through the
 * interpreter, so its boot path is changed in guest RAM (each instruction
 * checked against the expected one) when the main loop enters the menus,
 * before that path runs. The module is reloaded from the disc for every later
 * menu session, so nothing outlives the boot. The team-type validation calls
 * game functions; a small MIPS routine written into unused kernel RAM
 * (0x80006548..0x80008477 is zero in every RAM image of boots, menus, solo
 * missions and battles) does it with the game's own code, exactly as the
 * validation handler (0x80077D78..0x80077FC4) does.
 *
 * Everything depends only on guest state and the session's settings, so all
 * peers of a lockstep game do the same.
 */
#include "cpu_state.h"
#include "mod_plugins.h"

#include <stdlib.h>
#include <string.h>

#define PLUGIN_ID "frontschweine.direct-start"

/* Main EXE (compiled). */
#define FN_PLAY_STREAM  0x80011DE4u /* play a .SXA video: (name, flags) */
#define FN_TITLE        0x80017A70u /* title picture, waits for Start */
#define NAME_INFOGRAM   0x800103ACu
#define NAME_SHEFF      0x800103BCu
#define NAME_INTRO      0x800103C8u /* INTRO.SXA */
#define NAME_CUTIN      0x800103D4u /* CUTIN.SXA, "La guerre : tout ce que vous devez savoir" */
/* The main loop starts with video selector -6: INTRO then CUTIN (the same
 * pair opens a new campaign later). Return addresses of those two calls: */
#define RA_INTRO        0x80011A3Cu
#define RA_CUTIN        0x80011B50u

/* Menu module (loaded at run time, interpreted). */
#define FN_MENUS        0x8005F7F8u /* entered from the main loop */
#define FN_OPEN_MENU    0x80083594u /* open menu screen a0 */
#define SITE_PRESS_START 0x8005F134u /* jal 0x8005FD88: "Appuyer sur la touche START" */
#define SITE_FIRST_MENU  0x8005F17Cu /* addiu s4,zero,1: boot opens the main menu */
#define SITE_OPEN_FIRST  0x8005F3C4u /* jal open_menu (delay slot: a0 = s4) */
#define INSN_PRESS_START 0x0C017F62u
#define INSN_FIRST_MENU  0x24140001u
#define INSN_OPEN_FIRST  0x0C020D65u
#define MENU_SOLO        14u
#define MENU_LEVEL       28u

/* Session data (0x8002C964 block) and menu globals. */
#define S_TEAM_COUNT    0x8002C964u /* teams of the last game: 0 boot, 1 solo, >=2 multi */
#define S_TEAM_TYPES    0x8002C9F8u /* +148: 4 words, 0 JOUEUR, 1 CPU, 2 OFF */
#define S_TEAM_CLEAR    0x8002CA08u /* +164: 4 words cleared by the validation */
#define G_TEAMS_ACTIVE  0x80052C4Cu /* byte: number of teams in play */
#define G_TEAM_BASE     0x80052C40u /* team records, 620 bytes each */
#define G_TEXTS         0x80085700u
#define G_NAMED_FLAG    0x80085994u
#define G_TEAM_RENAMED  0x80085964u /* 4 words */
#define FN_TEAM_SETUP   0x80060754u /* (team, texts) */
#define FN_TEXT         0x8005DBE4u /* (texts, id) -> string */
#define FN_STRCPY       0x8001F3A8u
#define FN_STRLEN       0x8001FBE8u

#define ROUTINE         0x80006800u /* unused kernel RAM, see above */

enum { MODE_NONE, MODE_SOLO, MODE_MULTI };
static int s_mode = -1;
static uint32_t s_players, s_cpus;

static void read_settings(void) {
    const char *m = getenv("PSX_WEB_MODE");
    s_mode = !m ? MODE_NONE : !strcmp(m, "solo") ? MODE_SOLO : !strcmp(m, "multi") ? MODE_MULTI : MODE_NONE;
    const char *p = getenv("PSX_WEB_PLAYERS");
    const char *c = getenv("PSX_WEB_CPUS");
    s_players = p ? (uint32_t)atoi(p) : 1u;
    s_cpus = c ? (uint32_t)atoi(c) : 0u;
    if (s_players < 1u) s_players = 1u;
    if (s_players > 4u) s_players = 4u;
    if (s_players + s_cpus > 4u) s_cpus = 4u - s_players;
    if (s_players + s_cpus < 2u) s_cpus = 2u - s_players;   /* a battle needs two teams */
}

static int active(void) {
    if (s_mode < 0) read_settings();
    return s_mode != MODE_NONE;
}

/* No game played yet (team count 0): the boot, not a later session. */
static int at_boot(void) { return psx_mod_read_word(S_TEAM_COUNT) == 0u; }

/* ---- tiny MIPS assembler for the routine ---------------------------------- */
enum { ZERO = 0, V0 = 2, A0 = 4, A1 = 5, T0 = 8, T1, T2, T3, T4, T5, T6,
       S0 = 16, S1, S2, S3, S4, SP = 29, RA = 31 };
static uint32_t I(uint32_t op, uint32_t rs, uint32_t rt, int32_t imm) {
    return (op << 26) | (rs << 21) | (rt << 16) | ((uint32_t)imm & 0xFFFFu);
}
static uint32_t R(uint32_t rs, uint32_t rt, uint32_t rd, uint32_t fn) {
    return (rs << 21) | (rt << 16) | (rd << 11) | fn;
}
#define LUI(rt, imm)        I(0x0F, 0, rt, imm)
#define ADDIU(rt, rs, imm)  I(0x09, rs, rt, imm)
#define LW(rt, off, b)      I(0x23, b, rt, off)
#define SW(rt, off, b)      I(0x2B, b, rt, off)
#define LBU(rt, off, b)     I(0x24, b, rt, off)
#define SB(rt, off, b)      I(0x28, b, rt, off)
#define ADDU(rd, rs, rt)    R(rs, rt, rd, 0x21)
#define SLT(rd, rs, rt)     R(rs, rt, rd, 0x2A)
#define SLTU(rd, rs, rt)    R(rs, rt, rd, 0x2B)
#define JAL(t)              ((3u << 26) | (((t) >> 2) & 0x03FFFFFFu))
#define J(t)                ((2u << 26) | (((t) >> 2) & 0x03FFFFFFu))
#define NOP                 0u
#define HI(a)               ((int32_t)((((a) + 0x8000u) >> 16) & 0xFFFFu))
#define LO(a)               ((int32_t)(int16_t)((a) & 0xFFFFu))

/* Called in place of the boot's open_menu(28): applies the team-type
 * validation (0x80077D78..0x80077FC4) for this session's teams, then
 * tail-calls open_menu with the caller's a0 and return address. */
static void write_routine(void) {
    uint32_t code[128];
    unsigned n = 0, loop, done_br, next_br, next, done;
    uint32_t types[4], count = 0;
    for (uint32_t s = 0; s < 4u; s++) {
        types[s] = s < s_players ? 0u : s < s_players + s_cpus ? 1u : 2u;
        if (types[s] != 2u) count++;
    }
#define E(x) (code[n++] = (x))
    E(ADDIU(SP, SP, -40));
    E(SW(RA, 32, SP)); E(SW(A0, 36, SP));
    E(SW(S0, 16, SP)); E(SW(S1, 20, SP)); E(SW(S2, 24, SP)); E(SW(S3, 28, SP));
    /* Data part: types (already packed: no OFF before a team), team count,
     * the four cleared words, number of teams in play. Every team is a
     * JOUEUR or CPU team here, so the "no human" flag stays clear. */
    for (uint32_t s = 0; s < 4u; s++) {
        E(LUI(T0, HI(S_TEAM_TYPES + 4u * s)));
        E(ADDIU(T1, ZERO, (int32_t)types[s]));
        E(SW(T1, LO(S_TEAM_TYPES + 4u * s), T0));
        E(LUI(T0, HI(S_TEAM_CLEAR + 4u * s)));
        E(SW(ZERO, LO(S_TEAM_CLEAR + 4u * s), T0));
    }
    E(LUI(T0, HI(S_TEAM_COUNT))); E(ADDIU(T1, ZERO, (int32_t)count)); E(SW(T1, LO(S_TEAM_COUNT), T0));
    E(LUI(T0, HI(G_TEAMS_ACTIVE))); E(SB(T1, LO(G_TEAMS_ACTIVE), T0));
    /* Per-team part, as the validation does it. */
    E(ADDU(S1, ZERO, ZERO));                       /* team index */
    E(ADDU(S2, ZERO, ZERO));                       /* index * 620 */
    E(LUI(S3, HI(G_TEAM_RENAMED))); E(ADDIU(S3, S3, LO(G_TEAM_RENAMED)));
    loop = n;
    E(LUI(T0, HI(G_TEAMS_ACTIVE)));
    E(LBU(T1, LO(G_TEAMS_ACTIVE), T0));
    E(SLT(T2, S1, T1));
    done_br = n; E(0);                              /* beq t2,zero,done */
    E(NOP);
    E(LW(T3, LO(G_TEAM_BASE), T0));
    E(ADDU(S0, T3, S2));
    E(LUI(T4, HI(G_TEXTS))); E(LW(A1, LO(G_TEXTS), T4));
    E(JAL(FN_TEAM_SETUP)); E(ADDU(A0, S0, ZERO));
    E(LUI(T4, HI(G_NAMED_FLAG))); E(LW(V0, LO(G_NAMED_FLAG), T4)); E(NOP);
    E(SLTU(V0, ZERO, V0));
    E(SW(V0, 16, S0));
    E(LW(T5, 0, S3)); E(NOP);
    next_br = n; E(0);                              /* bne t5,zero,next */
    E(NOP);
    E(LUI(T4, HI(G_TEXTS))); E(LW(A0, LO(G_TEXTS), T4));
    E(JAL(FN_TEXT)); E(ADDIU(A1, ZERO, 333));
    E(ADDIU(A0, S0, 564));
    E(JAL(FN_STRCPY)); E(ADDU(A1, V0, ZERO));
    E(ADDIU(A0, S0, 564));
    E(JAL(FN_STRLEN)); E(NOP);
    E(ADDU(V0, V0, S0));
    E(ADDIU(T6, S1, 18));
    E(SB(T6, 563, V0));                             /* name[len-1] = index + 18 */
    next = n;
    E(ADDIU(S1, S1, 1));
    E(ADDIU(S2, S2, 620));
    E(J(ROUTINE + 4u * loop)); E(ADDIU(S3, S3, 4));
    done = n;
    E(LW(S0, 16, SP)); E(LW(S1, 20, SP)); E(LW(S2, 24, SP)); E(LW(S3, 28, SP));
    E(LW(RA, 32, SP)); E(LW(A0, 36, SP));
    E(J(FN_OPEN_MENU)); E(ADDIU(SP, SP, 40));
#undef E
    code[done_br] = I(0x04, T2, ZERO, (int32_t)done - (int32_t)done_br - 1);
    code[next_br] = I(0x05, T5, ZERO, (int32_t)next - (int32_t)next_br - 1);
    for (unsigned i = 0; i < n; i++) psx_mod_write_code_word(ROUTINE + 4u * i, code[i]);
}

/* Replace one instruction of the loaded menu module if it is the expected
 * one (otherwise this is not the module version these addresses describe:
 * leave it alone). */
static int patch(uint32_t address, uint32_t expected, uint32_t replacement) {
    if (psx_mod_read_word(address) != expected) return 0;
    psx_mod_write_code_word(address, replacement);
    return 1;
}

static void skip_call(CPUState *cpu) {
    cpu->gpr[2] = 0;
    psx_mod_function_return(cpu);
}

static void hook_play_stream(CPUState *cpu, uint32_t address) {
    (void)address;
    if (!active() || !psx_mod_function_can_return()) return;
    const uint32_t name = cpu->gpr[4];
    const uint32_t ra = cpu->gpr[31];
    if (name == NAME_INFOGRAM || name == NAME_SHEFF ||
        (at_boot() && name == NAME_INTRO && ra == RA_INTRO) ||
        (at_boot() && name == NAME_CUTIN && ra == RA_CUTIN))
        skip_call(cpu);
}

static void hook_title(CPUState *cpu, uint32_t address) {
    (void)address;
    if (active() && psx_mod_function_can_return()) skip_call(cpu);
}

static void hook_menus(CPUState *cpu, uint32_t address) {
    (void)cpu;
    (void)address;
    if (!active() || !at_boot()) return;
    if (!patch(SITE_FIRST_MENU, INSN_FIRST_MENU,
               ADDIU(S4, ZERO, s_mode == MODE_SOLO ? MENU_SOLO : MENU_LEVEL)))
        return;
    (void)patch(SITE_PRESS_START, INSN_PRESS_START, NOP);
    if (s_mode == MODE_MULTI) {
        write_routine();
        (void)patch(SITE_OPEN_FIRST, INSN_OPEN_FIRST, JAL(ROUTINE));
    }
}

PSX_MOD_CONSTRUCTOR(frontschweine_register_direct_start_plugin) {
    (void)psx_mod_register_function_entry_plugin(PLUGIN_ID, FN_PLAY_STREAM, hook_play_stream);
    (void)psx_mod_register_function_entry_plugin(PLUGIN_ID, FN_TITLE, hook_title);
    (void)psx_mod_register_function_entry_plugin(PLUGIN_ID, FN_MENUS, hook_menus);
}
