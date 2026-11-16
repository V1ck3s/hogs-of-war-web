/*
 * Wider battle view cone, so that a wide screen sees everything it shows.
 *
 * The battle module does not cull pigs, props or ground by their screen
 * position: four loops walk a precomputed list of map cells (16 x 16 grid,
 * 2048 units per cell) around the camera and draw only what lies in those
 * cells. The list is a cone in front of the camera sized for the 4:3 view
 * (apex 8 cells behind the camera, half-width 4 + depth/2 cells, 14.5 cells
 * long), stored at 0x80076700 as 9 sub-tables (camera yaw within a quadrant,
 * 11.25 degree steps; the code mirrors them for the other quadrants) of 220
 * (dx, dy) byte pairs, 213 of them read; entry 212 is not a cell but the list
 * of objects outside the grid. In 32:9 the view is 8/3 as wide, so pigs and
 * ground in the extended sides fell outside the cone and vanished.
 *
 * game.toml patches the four loops (battle module, overlay_only) to read
 * these tables instead: same layout, 440 entries per sub-table (stride 880
 * bytes), the out-of-grid list at entry 439. The cone is 8/3 as wide (the
 * 32:9 view), and contains every cell of the original. It is the same for
 * every screen shape, so online peers with different shapes keep the same
 * simulation (drawing more cells changes nothing the game reads back).
 *
 * The tables live in mod guest memory (Expansion 1, KSEG0 0x9F000000): the
 * first and only allocation of this region, made when the program starts.
 *
 * Packet buffers. A battle builds each frame's GPU primitives in one of two
 * buffers of 0x28000 bytes (160 KB), carved from a single malloc block of
 * twice that size: db0 = block, db1 = block + 0x28000. The game never checks
 * for overflow; the 4:3 cone stays well inside, but the wide cone can draw
 * more than 160 KB of ground and pigs in some camera angles (seen: high view
 * across the map). db1 then runs past the end of the block over the heap's
 * last headers (0x801DFFF8), and the next malloc loops forever on the broken
 * free list (the game freezes) or hands out overlapping blocks (crashes).
 * With the 8 MB main RAM (requested by widescreen.c's activation), db1 is moved to
 * 0x80200000, above the retail 2 MB, so that each buffer has 320 KB: db0
 * keeps the whole malloc block, db1 has 2 MB of otherwise unused RAM. The
 * heap is not touched (the block is still allocated and freed by the game),
 * so every heap address stays where the rest of the mods expect it. The move
 * happens at a guest VBlank, from guest RAM only: identical on every peer.
 */
#include "mod_plugins.h"

#include <stdint.h>

int psx_ram_8mb_active(void);   /* runtime: expanded main RAM in effect */

#define STATE_HANDLER  0x8002AA50u   /* 0x80042768 in a battle */
#define STATE_BATTLE   0x80042768u
#define DB0_BASE       0x80033AC4u   /* packet buffer bases (draw env pair) */
#define DB1_BASE       0x80037B38u
#define PKT_SIZE       0x80029194u   /* size of one buffer, 0x28000 in battle */
#define BATTLE_PKT     0x28000u
#define DB1_WIDE       0x80200000u   /* db1 above the retail 2 MB */

static void packet_buffers_vblank(void) {
    if (!psx_ram_8mb_active()) return;
    if (psx_mod_read_word(STATE_HANDLER) != STATE_BATTLE) return;
    if (psx_mod_read_word(PKT_SIZE) != BATTLE_PKT) return;
    const uint32_t db0 = psx_mod_read_word(DB0_BASE);
    if (psx_mod_read_word(DB1_BASE) != db0 + BATTLE_PKT) return;   /* moved, or not the pair */
    psx_mod_write_word(DB1_BASE, DB1_WIDE);
}

#define TABLE_ADDR   0x9F000000u   /* game.toml: lui 0x9F00 in the four loops */
#define SUBTABLES    9
#define ENTRIES      440           /* game.toml: slti 440 / 439 */
#define SPECIAL      (ENTRIES - 1) /* objects outside the grid */
#define PAD          (-99)         /* outside any map: skipped by the loops */

/* sin / cos of k * 11.25 degrees, k = 0..8 (the sub-table's view axis, from
 * +dy towards +dx). Constants rather than libm so every build agrees. */
static const double SIN_K[SUBTABLES] = {
    0.0, 0.19509032201612825, 0.38268343236508978, 0.55557023301960218,
    0.70710678118654752, 0.83146961230254524, 0.92387953251128674,
    0.98078528040323043, 1.0,
};

typedef struct { double u, v; int8_t x, y; } Cell;

static int cell_before(const Cell *a, const Cell *b) {
    if (a->u != b->u) return a->u < b->u;
    return a->v < b->v;
}

/* Cells of sub-table k, nearest first; returns the count. */
static int cone_cells(int k, Cell *out, int cap) {
    const double s = SIN_K[k], c = SIN_K[SUBTABLES - 1 - k];
    const double widen = 8.0 / 3.0;          /* 32:9 view / 4:3 view */
    int n = 0;
    for (int x = -16; x <= 16; x++) {
        for (int y = -16; y <= 16; y++) {
            const double u = x * s + y * c;    /* along the view */
            const double v = -x * c + y * s;   /* across */
            const double half = (4.0 + u * 0.5) * widen;
            if (u < -2.0 || x * x + y * y > 14.5 * 14.5) continue;
            if (v > half || -v > half) continue;
            if (n >= cap) return n;
            Cell cell = { u, v, (int8_t)x, (int8_t)y };
            int i = n++;
            while (i > 0 && cell_before(&cell, &out[i - 1])) { out[i] = out[i - 1]; i--; }
            out[i] = cell;
        }
    }
    return n;
}

PSX_MOD_CONSTRUCTOR(cochons_register_view_cone) {
    (void)psx_mod_register_vblank_plugin("frontschweine.widescreen", packet_buffers_vblank);
    const uint32_t size = SUBTABLES * ENTRIES * 2u;
    const uint32_t base = psx_mod_alloc_guest_memory(size, 4u);
    if (base != TABLE_ADDR) return;   /* the patched loops would read open bus */
    static Cell cells[33 * 33];
    for (int k = 0; k < SUBTABLES; k++) {
        const int n = cone_cells(k, cells, SPECIAL);
        const uint32_t t = base + (uint32_t)k * ENTRIES * 2u;
        for (int i = 0; i < ENTRIES; i++) {
            int8_t x = PAD, y = PAD;
            if (i < n) { x = cells[i].x; y = cells[i].y; }
            else if (i == SPECIAL) { x = 0; y = 0; }  /* in the grid: passes the bounds test */
            psx_mod_write_byte(t + 2u * (uint32_t)i, (uint8_t)x);
            psx_mod_write_byte(t + 2u * (uint32_t)i + 1u, (uint8_t)y);
        }
    }
}
