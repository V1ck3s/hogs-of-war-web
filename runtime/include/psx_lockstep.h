/* Frame-locked input for lockstep multiplayer and determinism checks.
 *
 * When a provider is installed, every guest vblank boundary takes its pad
 * words from the provider instead of sampling local devices: all peers that
 * feed the same words on the same frames run the same simulation. Native
 * builds can drive it from a script (PSX_LOCKSTEP_SCRIPT) and log a RAM digest
 * (PSX_LOCKSTEP_DIGEST) to prove determinism; the WebAssembly build installs a
 * provider fed by the browser's network layer. */
#pragma once
#include <stddef.h>
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

/* WebAssembly lockstep, owner-only: at each frame the game reads ONE
 * participant's pad (turn-based titles: whoever's turn it is; menus: the
 * host), so a frame waits only for that participant's word, never for the
 * others. The title plugin names the participant from guest state alone
 * (every peer makes the same choice); -1 = the host. A participant who left
 * (or is beyond nplayers) falls back to the host, then to the first one still
 * there. *team is only shown to the page (0 none, N = battle team N,
 * 0x100 | N = setting up team N). */
typedef int (*psx_lockstep_who_fn)(uint32_t frame, uint32_t nplayers, uint32_t *team);
void psx_lockstep_set_who(psx_lockstep_who_fn fn);
/* Participant driving the menus (set by the page for the session). */
uint32_t psx_lockstep_host(void);

/* Whole-machine snapshot for a player joining a running game. A peer asks
 * for one at a boundary frame; once written, EVERY peer (the one that saved
 * it included) loads that same snapshot, and the boundary after the load is
 * numbered as in the saving run. Reloading everywhere keeps the copies equal
 * even where loading itself perturbs the machine (CD timing catch-up). */
void psx_lockstep_request_snapshot(uint32_t frame);
/* 0 idle, 1 saving, 2 saved (file ready, *frame = its frame), -1 failed. */
int  psx_lockstep_snapshot_status(uint32_t *frame);
/* Path of the snapshot file (the savestate slot it uses). */
int  psx_lockstep_snapshot_path(char *out, size_t cap);
/* Loads `data` (a snapshot written by any peer) at the next safe point; the
 * boundary following the load is `frame`. Returns 1 if staged. */
int  psx_lockstep_load_snapshot(const void *data, size_t size, uint32_t frame);
/* 1 while a staged load has not run yet. */
int  psx_lockstep_loading(void);

#ifdef __cplusplus
}
#endif
