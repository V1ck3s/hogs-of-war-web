/* Minimal CPUState for the terrain-line equivalence harness. */
#pragma once
#include <stdint.h>
typedef struct CPUState { uint32_t gpr[32]; uint32_t pc; } CPUState;
