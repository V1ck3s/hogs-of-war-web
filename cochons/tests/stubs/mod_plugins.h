/* Stub plugin API for the terrain-line equivalence harness. */
#pragma once
#include <stdint.h>
struct CPUState;
typedef void (*PSXModFunctionEntryCallback)(struct CPUState*, uint32_t);
uint32_t psx_mod_read_word(uint32_t a);
uint16_t psx_mod_read_half(uint32_t a);
void psx_mod_write_word(uint32_t a, uint32_t v);
int psx_mod_function_can_return(void);
void psx_mod_function_return(struct CPUState* cpu);
int psx_mod_register_function_entry_plugin(const char* id, uint32_t address, PSXModFunctionEntryCallback cb);
#define PSX_MOD_CONSTRUCTOR(name) static void name(void) __attribute__((constructor)); static void name(void)
