/*
 * Second, independent instance of the software rasterizer (gpu_sw_renderer.c
 * compiled again under other names), owned by the presentation thread of the
 * threaded software backend (gpu_sw_threaded.c). Every file-scope state of the
 * rasterizer is static, so this translation unit has its own VRAM copy, hi-res
 * mirror and native-wide surfaces; only the public entry points need renaming.
 *
 * The per-primitive backdrop decision (psx_ws_prim_in_backdrop and the
 * stretch settings) is taken on the emulation thread when the primitive is
 * recorded and replayed here through swhr_prim_in_backdrop / g_swhr_bd_*.
 */
#define sw_renderer_init                 swhr_renderer_init
#define sw_renderer_set_scale            swhr_renderer_set_scale
#define sw_renderer_scale                swhr_renderer_scale
#define sw_set_precise_triangle          swhr_set_precise_triangle
#define sw_set_perspective_triangle      swhr_set_perspective_triangle
#define sw_perspective_triangle_count    swhr_perspective_triangle_count
#define sw_set_texture_filter            swhr_set_texture_filter
#define sw_texture_filter                swhr_texture_filter
#define sw_set_semi_transparency         swhr_set_semi_transparency
#define sw_set_mask_bits                 swhr_set_mask_bits
#define sw_set_texture_window            swhr_set_texture_window
#define sw_set_color_modulation          swhr_set_color_modulation
#define sw_fill_rect                     swhr_fill_rect
#define sw_copy_rect                     swhr_copy_rect
#define sw_draw_flat_triangle            swhr_draw_flat_triangle
#define sw_draw_gouraud_triangle         swhr_draw_gouraud_triangle
#define sw_draw_textured_triangle        swhr_draw_textured_triangle
#define sw_draw_shaded_textured_triangle swhr_draw_shaded_textured_triangle
#define sw_draw_flat_rect                swhr_draw_flat_rect
#define sw_draw_textured_rect            swhr_draw_textured_rect
#define sw_draw_textured_rect_scaled     swhr_draw_textured_rect_scaled
#define sw_draw_line                     swhr_draw_line
#define sw_draw_shaded_line              swhr_draw_shaded_line
#define sw_render_display                swhr_render_display
#define sw_render_display_hires          swhr_render_display_hires
#define sw_vram_write                    swhr_vram_write
#define sw_vram_read                     swhr_vram_read
#define sw_vram_transfer_in              swhr_vram_transfer_in
#define sw_vram_transfer_out             swhr_vram_transfer_out
#define sw_set_draw_area                 swhr_set_draw_area
#define sw_get_draw_area                 swhr_get_draw_area
#define sw_set_draw_offset               swhr_set_draw_offset
#define sw_wide_configure                swhr_wide_configure
#define sw_wide_set_target               swhr_wide_set_target
#define sw_wide_disable_target           swhr_wide_disable_target
#define sw_wide_clear                    swhr_wide_clear
#define sw_wide_clear_margins            swhr_wide_clear_margins
#define sw_wide_emit_tile                swhr_wide_emit_tile
#define sw_render_wide_display           swhr_render_wide_display
#define sw_wide_dump_full                swhr_wide_dump_full
#define sw_wide_width                    swhr_wide_width
#define sw_set_present_skip              swhr_set_present_skip

#define psx_ws_prim_in_backdrop          swhr_prim_in_backdrop
#define g_ws_bd_stretch_on               g_swhr_bd_on
#define g_ws_bd_stretch_pct              g_swhr_bd_pct

#include "gpu_sw_renderer.c"
