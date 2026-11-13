/* Frame-locked input for lockstep multiplayer and determinism checks.
 *
 * When a provider is installed, every guest vblank boundary takes its pad
 * words from the provider instead of sampling local devices: all peers that
 * feed the same words on the same frames run the same simulation. Native
 * builds can drive it from a script (PSX_LOCKSTEP_SCRIPT) and log a RAM digest
 * (PSX_LOCKSTEP_DIGEST) to prove determinism; the WebAssembly build installs a
 * provider fed by the browser's network layer. */
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Fill pads[0..1] (active-low) for `frame`; may block until they are known.
 * Return 0 to stop the provider (local sampling resumes). */
typedef int (*psx_lockstep_provider_fn)(uint32_t frame, uint16_t pads[2]);

void     psx_lockstep_set_provider(psx_lockstep_provider_fn fn);
int      psx_lockstep_active(void);
uint32_t psx_lockstep_frame(void);
/* Called once per guest vblank boundary; applies the frame's pads to SIO. */
void     psx_lockstep_boundary(void);
/* Reads PSX_LOCKSTEP_* (native test harness). */
void     psx_lockstep_init_from_env(void);
uint32_t psx_lockstep_ram_digest(void);

/* Picks the pads the game sees from every participant's word for a frame
 * (WebAssembly lockstep). Must depend only on guest state and its inputs. */
typedef void (*psx_lockstep_select_fn)(uint32_t frame, const uint16_t *words,
                                       uint32_t nplayers, uint16_t pads[2]);
void psx_lockstep_set_select(psx_lockstep_select_fn fn);

#ifdef __cplusplus
}
#endif
