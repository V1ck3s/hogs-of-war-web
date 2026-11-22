/*
 * Proves the French Fast-Enemy-AI hook (mods/plugins/terrain_line.c) computes
 * exactly what the game's own routine computes: the real routine bytes from
 * the battle RAM run in a small MIPS interpreter (with delay slots), the hook
 * runs natively, both from identical registers and memory. Return value,
 * every GPR and every memory byte must match.
 *   cc -O2 -Istubs terrain_line_equiv.c -o equiv && ./equiv battle_ram.bin [N]
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cpu_state.h"
#include "mod_plugins.h"

#define RAM_SIZE 0x200000u
static uint8_t* mem;
static int returned;
static PSXModFunctionEntryCallback hook;

uint32_t psx_mod_read_word(uint32_t a) { uint32_t v; memcpy(&v, mem + (a & 0x1FFFFC), 4); return v; }
uint16_t psx_mod_read_half(uint32_t a) { uint16_t v; memcpy(&v, mem + (a & 0x1FFFFE), 2); return v; }
void psx_mod_write_word(uint32_t a, uint32_t v) { memcpy(mem + (a & 0x1FFFFC), &v, 4); }
int psx_mod_function_can_return(void) { return 1; }
void psx_mod_function_return(struct CPUState* cpu) { cpu->pc = cpu->gpr[31]; returned = 1; }
int psx_mod_register_function_entry_plugin(const char* id, uint32_t address, PSXModFunctionEntryCallback cb) {
    (void)id; (void)address; hook = cb; return 1;
}

#include "../mods/plugins/terrain_line.c"

/* --- reference: interpret the real MIPS routine ----------------------- */
static uint64_t steps;
static int interp(CPUState* c) {
    uint32_t pc = c->pc, next = pc + 4;
    uint32_t* r = c->gpr;
    for (steps = 0; steps < 50000000ull; steps++) {
        uint32_t w = psx_mod_read_word(pc);
        uint32_t op = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31, rd = (w >> 11) & 31, sh = (w >> 6) & 31;
        int32_t imm = (int16_t)(w & 0xFFFF);
        uint32_t uimm = w & 0xFFFF;
        uint32_t target = next; int branch = 0;
        switch (op) {
        case 0:
            switch (w & 63) {
            case 0: if (rd) r[rd] = r[rt] << sh; break;
            case 2: if (rd) r[rd] = r[rt] >> sh; break;
            case 3: if (rd) r[rd] = (uint32_t)((int32_t)r[rt] >> sh); break;
            case 8: target = r[rs]; branch = 1; break;                 /* jr */
            case 33: if (rd) r[rd] = r[rs] + r[rt]; break;              /* addu */
            case 35: if (rd) r[rd] = r[rs] - r[rt]; break;              /* subu */
            case 36: if (rd) r[rd] = r[rs] & r[rt]; break;
            case 37: if (rd) r[rd] = r[rs] | r[rt]; break;
            case 42: if (rd) r[rd] = (int32_t)r[rs] < (int32_t)r[rt]; break;
            case 43: if (rd) r[rd] = r[rs] < r[rt]; break;
            default: fprintf(stderr, "SPECIAL %u not handled at %08x\n", w & 63, pc); return 0;
            }
            break;
        case 1:
            if (rt == 0 && (int32_t)r[rs] < 0) { target = pc + 4 + (imm << 2); branch = 1; }
            else if (rt == 1 && (int32_t)r[rs] >= 0) { target = pc + 4 + (imm << 2); branch = 1; }
            else if (rt > 1) { fprintf(stderr, "REGIMM %u\n", rt); return 0; }
            else branch = 1;
            break;
        case 2: target = (pc & 0xF0000000u) | ((w & 0x3FFFFFF) << 2); branch = 1; break;
        case 4: branch = 1; if (r[rs] == r[rt]) target = pc + 4 + (imm << 2); break;
        case 5: branch = 1; if (r[rs] != r[rt]) target = pc + 4 + (imm << 2); break;
        case 6: branch = 1; if ((int32_t)r[rs] <= 0) target = pc + 4 + (imm << 2); break;
        case 7: branch = 1; if ((int32_t)r[rs] > 0) target = pc + 4 + (imm << 2); break;
        case 9: if (rt) r[rt] = r[rs] + imm; break;
        case 10: if (rt) r[rt] = (int32_t)r[rs] < imm; break;
        case 11: if (rt) r[rt] = r[rs] < (uint32_t)imm; break;
        case 12: if (rt) r[rt] = r[rs] & uimm; break;
        case 13: if (rt) r[rt] = r[rs] | uimm; break;
        case 15: if (rt) r[rt] = uimm << 16; break;
        case 33: if (rt) r[rt] = (uint32_t)(int16_t)psx_mod_read_half(r[rs] + imm); break;  /* lh */
        case 35: if (rt) r[rt] = psx_mod_read_word(r[rs] + imm); break;
        case 37: if (rt) r[rt] = psx_mod_read_half(r[rs] + imm); break;                     /* lhu */
        case 43: psx_mod_write_word(r[rs] + imm, r[rt]); break;
        default: fprintf(stderr, "opcode %u not handled at %08x\n", op, pc); return 0;
        }
        if (branch) {
            /* execute the delay slot */
            uint32_t ra = r[31];
            CPUState tmp = *c; (void)tmp;
            pc = next; next = target;
            if (w == 0x03E00008u && 0) (void)ra;
            continue;
        }
        if (pc == c->gpr[31] - 0) { /* unreachable: returns are handled via jr below */ }
        pc = next; next = pc + 4;
        if (pc == 0xDEAD0000u) { c->pc = pc; return 1; }
    }
    return 0;
}

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s battle_ram.bin [N]\n", argv[0]); return 2; }
    long n = argc > 2 ? atol(argv[2]) : 20000;
    uint8_t* ram = malloc(RAM_SIZE); mem = malloc(RAM_SIZE);
    FILE* f = fopen(argv[1], "rb");
    if (!f || fread(ram, 1, RAM_SIZE, f) != RAM_SIZE) { fprintf(stderr, "RAM illisible\n"); return 2; }
    fclose(f);
    memcpy(mem, ram, RAM_SIZE);
    if (!terrain_line_loaded()) { fprintf(stderr, "routine FR absente de cette RAM (empreinte)\n"); return 1; }
    uint8_t* ref_mem = malloc(RAM_SIZE);
    srand(1234);
    long blocked = 0, bad = 0; uint64_t total_steps = 0;
    for (long i = 0; i < n; i++) {
        CPUState a = {0}, b;
        for (int k = 1; k < 32; k++) a.gpr[k] = (uint32_t)rand() * 2654435761u;
        a.gpr[29] = 0x801FFF00u - (rand() & 0xF0);
        a.gpr[31] = 0xDEAD0000u;
        a.pc = FN_TERRAIN_LINE;
        /* map coordinates: 50 tiles x 512 units, plus some out-of-range */
        int span = (i % 10 == 0) ? 40000 : 25600;
        a.gpr[5] = rand() % span; a.gpr[6] = rand() % span; a.gpr[7] = rand() % span;
        if (i % 7 == 0) a.gpr[7] = a.gpr[5] + (rand() % 200) - 100;   /* near axis-aligned */
        int shortline = (i % 2 == 1);                                 /* half: short moves */
        b = a;
        memcpy(mem, ram, RAM_SIZE);
        uint32_t arg5 = rand() % span;
        if (shortline) { b.gpr[7] = a.gpr[7] = a.gpr[5] + (rand() % 3000) - 1500; arg5 = a.gpr[6] + (rand() % 3000) - 1500; }
        psx_mod_write_word(a.gpr[29] + 16, arg5);                     /* 5th argument */
        memcpy(ref_mem, mem, RAM_SIZE);
        /* native hook */
        returned = 0; hook(&a, FN_TERRAIN_LINE);
        uint8_t* hook_mem = mem; mem = ref_mem;
        int ok = interp(&b);
        mem = hook_mem;
        total_steps += steps;
        if (!ok || !returned) { fprintf(stderr, "case %ld: incomplete execution\n", i); bad++; continue; }
        b.pc = b.gpr[31];
        int diff = memcmp(a.gpr, b.gpr, sizeof a.gpr) != 0 || memcmp(hook_mem, ref_mem, RAM_SIZE) != 0;
        if ((int32_t)b.gpr[2] < 0) blocked++;
        if (diff) {
            if (bad < 5) {
                fprintf(stderr, "ÉCART cas %ld: v0 hook=%08x jeu=%08x\n", i, a.gpr[2], b.gpr[2]);
                for (int k = 0; k < 32; k++) if (a.gpr[k] != b.gpr[k]) fprintf(stderr, "  r%d hook=%08x jeu=%08x\n", k, a.gpr[k], b.gpr[k]);
            }
            bad++;
        }
    }
    printf("%ld cases, %ld blocked lines, %ld differences, %.0f MIPS instructions per call on average\n",
           n, blocked, bad, (double)total_steps / n);
    return bad ? 1 : 0;
}
