/*
 * gpu_gl_web_shim.h — browser build of the OpenGL renderer (WebGL 2).
 *
 * In the browser the OpenGL renderer is not the authoritative backend: the
 * emulation thread rasterizes native VRAM with the software renderer (what the
 * game reads back, identical whatever the picture quality), and records every
 * GPU command into gpu_sw_threaded.c's ring. The page's main thread replays
 * that ring into this renderer (dual-raster mode: no FBO read-back ever) at the
 * requested scale and native-wide width, and presents straight to a canvas.
 *
 * The renderer's software-mirror calls (sw_*) must not reach the emulation
 * thread's rasterizer, so they are renamed to replay-side stubs
 * (gpu_gl_web.c) that only keep the replay VRAM copy the upload path reads.
 * The per-primitive backdrop gate is the value recorded by the emulation
 * thread for that primitive.
 */
#ifndef GPU_GL_WEB_SHIM_H
#define GPU_GL_WEB_SHIM_H

#define sw_renderer_init                 swg_renderer_init
#define sw_renderer_set_scale            swg_renderer_set_scale
#define sw_set_precise_triangle          swg_set_precise_triangle
#define sw_set_perspective_triangle      swg_set_perspective_triangle
#define sw_set_texture_filter            swg_set_texture_filter
#define sw_set_semi_transparency         swg_set_semi_transparency
#define sw_set_mask_bits                 swg_set_mask_bits
#define sw_set_texture_window            swg_set_texture_window
#define sw_set_color_modulation          swg_set_color_modulation
#define sw_fill_rect                     swg_fill_rect
#define sw_copy_rect                     swg_copy_rect
#define sw_draw_flat_triangle            swg_draw_flat_triangle
#define sw_draw_gouraud_triangle         swg_draw_gouraud_triangle
#define sw_draw_textured_triangle        swg_draw_textured_triangle
#define sw_draw_shaded_textured_triangle swg_draw_shaded_textured_triangle
#define sw_draw_flat_rect                swg_draw_flat_rect
#define sw_draw_textured_rect            swg_draw_textured_rect
#define sw_draw_textured_rect_scaled     swg_draw_textured_rect_scaled
#define sw_draw_line                     swg_draw_line
#define sw_draw_shaded_line              swg_draw_shaded_line
#define sw_render_display                swg_render_display
#define sw_render_display_hires          swg_render_display_hires
#define sw_vram_write                    swg_vram_write
#define sw_vram_read                     swg_vram_read
#define sw_vram_transfer_in              swg_vram_transfer_in
#define sw_vram_transfer_out             swg_vram_transfer_out
#define sw_set_draw_area                 swg_set_draw_area
#define sw_get_draw_area                 swg_get_draw_area
#define sw_set_draw_offset               swg_set_draw_offset
#define sw_wide_configure                swg_wide_configure
#define sw_wide_set_target               swg_wide_set_target
#define sw_wide_disable_target           swg_wide_disable_target
#define sw_wide_clear                    swg_wide_clear
#define sw_wide_clear_margins            swg_wide_clear_margins
#define sw_render_wide_display           swg_render_wide_display
#define sw_wide_dump_full                swg_wide_dump_full

#define psx_ws_prim_in_backdrop          swg_prim_in_backdrop
#define psx_ws_prim_is_tagged            swg_prim_is_tagged

/* The runtime-facing OpenGL API stays the inert one (gpu_gl_renderer_unavailable.c):
 * the emulation thread must never touch WebGL. This build of the renderer is
 * reached only through the page-side replay (gpu_sw_threaded.c). */
#define gl_backend_get glweb_backend_get
#define gl_renderer_batch_diag glweb_renderer_batch_diag
#define gl_renderer_coh_get glweb_renderer_coh_get
#define gl_renderer_coh_total glweb_renderer_coh_total
#define gl_renderer_cpu_auth_dual glweb_renderer_cpu_auth_dual
#define gl_renderer_diag glweb_renderer_diag
#define gl_renderer_fbo_peek glweb_renderer_fbo_peek
#define gl_renderer_flush_cpu_uploads glweb_renderer_flush_cpu_uploads
#define gl_renderer_get_post_gamma glweb_renderer_get_post_gamma
#define gl_renderer_get_scanlines glweb_renderer_get_scanlines
#define gl_renderer_get_wide_fast glweb_renderer_get_wide_fast
#define gl_renderer_get_ws_ablate glweb_renderer_get_ws_ablate
#define gl_renderer_has_bezel glweb_renderer_has_bezel
#define gl_renderer_init_context glweb_renderer_init_context
#define gl_renderer_interpolation_diag glweb_renderer_interpolation_diag
#define gl_renderer_interpolation_owns_cadence glweb_renderer_interpolation_owns_cadence
#define gl_renderer_invalidate_present glweb_renderer_invalidate_present
#define gl_renderer_perf_aggregate glweb_renderer_perf_aggregate
#define gl_renderer_perf_prim_split glweb_renderer_perf_prim_split
#define gl_renderer_pres_get glweb_renderer_pres_get
#define gl_renderer_pres_total glweb_renderer_pres_total
#define gl_renderer_present glweb_renderer_present
#define gl_renderer_present_blank glweb_renderer_present_blank
#define gl_renderer_present_hold_last glweb_renderer_present_hold_last
#define gl_renderer_present_probe_reset glweb_renderer_present_probe_reset
#define gl_renderer_present_probe_take glweb_renderer_present_probe_take
#define gl_renderer_present_rect_dirty glweb_renderer_present_rect_dirty
#define gl_renderer_present_vram glweb_renderer_present_vram
#define gl_renderer_present_wide_fbo glweb_renderer_present_wide_fbo
#define gl_renderer_restage_vram_after_savestate glweb_renderer_restage_vram_after_savestate
#define gl_renderer_runtime_diag glweb_renderer_runtime_diag
#define gl_renderer_select_texture_bank glweb_renderer_select_texture_bank
#define gl_renderer_set_bezel glweb_renderer_set_bezel
#define gl_renderer_set_cpu_auth_dual glweb_renderer_set_cpu_auth_dual
#define gl_renderer_set_display_aspect glweb_renderer_set_display_aspect
#define gl_renderer_set_fmv_filter glweb_renderer_set_fmv_filter
#define gl_renderer_set_interpolation glweb_renderer_set_interpolation
#define gl_renderer_set_interpolation_suspended glweb_renderer_set_interpolation_suspended
#define gl_renderer_set_post_gamma glweb_renderer_set_post_gamma
#define gl_renderer_set_scanlines glweb_renderer_set_scanlines
#define gl_renderer_set_swap_interval glweb_renderer_set_swap_interval
#define gl_renderer_set_wide_fast glweb_renderer_set_wide_fast
#define gl_renderer_set_ws_ablate glweb_renderer_set_ws_ablate
#define gl_renderer_shutdown glweb_renderer_shutdown
#define gl_renderer_sync_cpu glweb_renderer_sync_cpu
#define gl_renderer_texture_banks_supported glweb_renderer_texture_banks_supported
#define gl_renderer_vram_diff glweb_renderer_vram_diff

#endif
