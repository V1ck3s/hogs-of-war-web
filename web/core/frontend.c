/*
 * Cochons de Guerre Web — minimal libretro frontend compiled to WebAssembly.
 *
 * Links statically against the pcsx_rearmed libretro core and exposes a
 * small C API to JavaScript (worker.js / tests). Everything the browser
 * needs goes through plain memory buffers:
 *   - video: RGBA8888 framebuffer (fe_fb_ptr / fe_fb_w / fe_fb_h)
 *   - audio: interleaved int16 stereo, 44.1 kHz (fe_audio_ptr / fe_audio_frames)
 *   - input: one 16-bit RetroPad mask per port (fe_set_input)
 *
 * The core runs only when fe_run_frame() is called, so the caller owns timing
 * (needed for deterministic lockstep multiplayer).
 */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include "libretro.h"

#define EXPORT EMSCRIPTEN_KEEPALIVE

#define MAX_PORTS 8
#define FB_MAX_W 1024
#define FB_MAX_H 512
#define AUDIO_MAX_FRAMES 8192

static uint32_t fb[FB_MAX_W * FB_MAX_H];
static int fb_w = 320, fb_h = 240;
static int16_t audio_buf[AUDIO_MAX_FRAMES * 2];
static int audio_frames;
static uint16_t pad_state[MAX_PORTS];
static int16_t analog_state[MAX_PORTS][4]; /* lx, ly, rx, ry */
static enum retro_pixel_format pix_fmt = RETRO_PIXEL_FORMAT_0RGB1555;
static struct retro_system_av_info av_info;
static int verbose = 0;

/* ---- core variables -------------------------------------------------- */
#define MAX_VARS 192
static struct { char key[64]; char val[64]; } vars[MAX_VARS];
static int nvars;
static int vars_dirty;

static int var_find(const char *key)
{
    for (int i = 0; i < nvars; i++)
        if (!strcmp(vars[i].key, key))
            return i;
    return -1;
}

static void var_set(const char *key, const char *val, int only_if_missing)
{
    int i = var_find(key);
    if (i >= 0) {
        if (only_if_missing)
            return;
    } else {
        if (nvars >= MAX_VARS)
            return;
        i = nvars++;
        snprintf(vars[i].key, sizeof(vars[i].key), "%s", key);
    }
    snprintf(vars[i].val, sizeof(vars[i].val), "%s", val);
    vars_dirty = 1;
}

/* Settings forced by the web port (applied before the core reads them). */
static void apply_port_defaults(void)
{
    var_set("pcsx_rearmed_memcard1", "libretro", 0); /* SAVE_RAM = card 1 */
    var_set("pcsx_rearmed_memcard2", "none", 0);
    var_set("pcsx_rearmed_region", "auto", 0);
    var_set("pcsx_rearmed_drc", "disabled", 0);
    var_set("pcsx_rearmed_frameskip_type", "disabled", 0);
    var_set("pcsx_rearmed_show_bios_bootlogo", "disabled", 0);
    var_set("pcsx_rearmed_rgb32_output", "enabled", 0);
}

/* ---- libretro callbacks --------------------------------------------- */
static void log_cb(enum retro_log_level level, const char *fmt, ...)
{
    if (level < RETRO_LOG_WARN && !verbose)
        return;
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
}

static bool environ_cb(unsigned cmd, void *data)
{
    switch (cmd) {
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        ((struct retro_log_callback *)data)->log = log_cb;
        return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
        *(unsigned *)data = 0; /* -> core uses SET_VARIABLES */
        return true;
    case RETRO_ENVIRONMENT_SET_VARIABLES: {
        const struct retro_variable *v = data;
        for (; v && v->key; v++) {
            /* "Description; default|opt2|opt3" */
            const char *semi = strchr(v->value, ';');
            if (!semi)
                continue;
            semi++;
            while (*semi == ' ')
                semi++;
            char def[64];
            size_t n = strcspn(semi, "|");
            if (n >= sizeof(def))
                n = sizeof(def) - 1;
            memcpy(def, semi, n);
            def[n] = 0;
            var_set(v->key, def, 1);
        }
        apply_port_defaults();
        return true;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
        struct retro_variable *v = data;
        int i = var_find(v->key);
        v->value = i >= 0 ? vars[i].val : NULL;
        return i >= 0;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *(bool *)data = vars_dirty;
        vars_dirty = 0;
        return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        pix_fmt = *(enum retro_pixel_format *)data;
        return pix_fmt == RETRO_PIXEL_FORMAT_XRGB8888 || pix_fmt == RETRO_PIXEL_FORMAT_RGB565 ||
               pix_fmt == RETRO_PIXEL_FORMAT_0RGB1555;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        *(const char **)data = "/system";
        return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        *(const char **)data = "/save";
        return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
        return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
        av_info.geometry = *(const struct retro_game_geometry *)data;
        return true;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
        av_info = *(const struct retro_system_av_info *)data;
        return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
        *(bool *)data = true;
        return true;
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
    case RETRO_ENVIRONMENT_SET_MESSAGE:
        return true;
    default:
        return false;
    }
}

/* The core's output buffer stays valid until the next retro_run(), so the
 * pixel conversion is done lazily, only for frames the caller displays. */
static const void *raw_data;
static unsigned raw_w, raw_h;
static size_t raw_pitch;
static int fb_dirty;

static void video_cb(const void *data, unsigned w, unsigned h, size_t pitch)
{
    if (!data) /* dupe: keep previous frame */
        return;
    raw_data = data;
    raw_w = w > FB_MAX_W ? FB_MAX_W : w;
    raw_h = h > FB_MAX_H ? FB_MAX_H : h;
    raw_pitch = pitch;
    fb_dirty = 1;
}

static void convert_frame(void)
{
    if (!fb_dirty || !raw_data)
        return;
    fb_dirty = 0;
    unsigned w = raw_w, h = raw_h;
    fb_w = w;
    fb_h = h;
    const uint8_t *src = raw_data;
    for (unsigned y = 0; y < h; y++, src += raw_pitch) {
        uint32_t *dst = fb + y * w;
        if (pix_fmt == RETRO_PIXEL_FORMAT_XRGB8888) {
            const uint32_t *s = (const uint32_t *)src;
            for (unsigned x = 0; x < w; x++) {
                uint32_t p = s[x];
                /* XRGB -> RGBA bytes in little endian = 0xAABBGGRR */
                dst[x] = 0xFF000000u | ((p & 0xFF) << 16) | (p & 0xFF00) | ((p >> 16) & 0xFF);
            }
        } else if (pix_fmt == RETRO_PIXEL_FORMAT_RGB565) {
            const uint16_t *s = (const uint16_t *)src;
            for (unsigned x = 0; x < w; x++) {
                uint16_t p = s[x];
                uint32_t r = (p >> 11) & 31, g = (p >> 5) & 63, b = p & 31;
                r = (r << 3) | (r >> 2); g = (g << 2) | (g >> 4); b = (b << 3) | (b >> 2);
                dst[x] = 0xFF000000u | (b << 16) | (g << 8) | r;
            }
        } else {
            const uint16_t *s = (const uint16_t *)src;
            for (unsigned x = 0; x < w; x++) {
                uint16_t p = s[x];
                uint32_t r = (p >> 10) & 31, g = (p >> 5) & 31, b = p & 31;
                r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2);
                dst[x] = 0xFF000000u | (b << 16) | (g << 8) | r;
            }
        }
    }
}

static size_t audio_batch_cb(const int16_t *data, size_t frames)
{
    size_t room = AUDIO_MAX_FRAMES - audio_frames;
    size_t n = frames < room ? frames : room;
    memcpy(audio_buf + audio_frames * 2, data, n * 4);
    audio_frames += n;
    return frames;
}

static void audio_cb(int16_t l, int16_t r)
{
    int16_t s[2] = { l, r };
    audio_batch_cb(s, 1);
}

static void input_poll_cb(void) {}

static int16_t input_state_cb(unsigned port, unsigned device, unsigned index, unsigned id)
{
    if (port >= MAX_PORTS)
        return 0;
    if (device == RETRO_DEVICE_JOYPAD) {
        if (id == RETRO_DEVICE_ID_JOYPAD_MASK)
            return (int16_t)pad_state[port];
        return (pad_state[port] >> id) & 1;
    }
    if (device == RETRO_DEVICE_ANALOG && index < 2 && id < 2)
        return analog_state[port][index * 2 + id];
    return 0;
}

/* ---- exported API ---------------------------------------------------- */
static int initialized, loaded;

EXPORT void fe_set_verbose(int v) { verbose = v; }

EXPORT void fe_set_option(const char *key, const char *val)
{
    var_set(key, val, 0);
}

EXPORT int fe_init(void)
{
    if (initialized)
        return 1;
    retro_set_environment(environ_cb);
    retro_set_video_refresh(video_cb);
    retro_set_audio_sample(audio_cb);
    retro_set_audio_sample_batch(audio_batch_cb);
    retro_set_input_poll(input_poll_cb);
    retro_set_input_state(input_state_cb);
    retro_init();
    initialized = 1;
    return 1;
}

EXPORT int fe_load(const char *path)
{
    struct retro_game_info info = { path, NULL, 0, NULL };
    if (!fe_init())
        return 0;
    if (!retro_load_game(&info))
        return 0;
    retro_get_system_av_info(&av_info);
    for (int p = 0; p < 2; p++)
        retro_set_controller_port_device(p, RETRO_DEVICE_JOYPAD);
    loaded = 1;
    return 1;
}

EXPORT void fe_set_port_device(int port, int device)
{
    retro_set_controller_port_device(port, device);
}

EXPORT void fe_set_input(int port, int mask)
{
    if (port >= 0 && port < MAX_PORTS)
        pad_state[port] = (uint16_t)mask;
}

EXPORT void fe_set_analog(int port, int lx, int ly, int rx, int ry)
{
    if (port < 0 || port >= MAX_PORTS)
        return;
    analog_state[port][0] = lx;
    analog_state[port][1] = ly;
    analog_state[port][2] = rx;
    analog_state[port][3] = ry;
}

EXPORT void fe_run_frame(void)
{
    audio_frames = 0;
    if (loaded)
        retro_run();
}

EXPORT void fe_reset(void) { if (loaded) retro_reset(); }

EXPORT uint32_t *fe_fb_ptr(void) { convert_frame(); return fb; }
EXPORT int fe_fb_w(void) { convert_frame(); return fb_w; }
EXPORT int fe_fb_h(void) { convert_frame(); return fb_h; }
EXPORT int16_t *fe_audio_ptr(void) { return audio_buf; }
EXPORT int fe_audio_frames(void) { return audio_frames; }
EXPORT double fe_fps(void) { return av_info.timing.fps; }
EXPORT double fe_sample_rate(void) { return av_info.timing.sample_rate; }
EXPORT double fe_aspect(void)
{
    float a = av_info.geometry.aspect_ratio;
    return a > 0 ? a : 4.0 / 3.0;
}

EXPORT int fe_state_size(void) { return (int)retro_serialize_size(); }
EXPORT int fe_state_save(void *buf, int size) { return retro_serialize(buf, size) ? 1 : 0; }
EXPORT int fe_state_load(const void *buf, int size) { return retro_unserialize(buf, size) ? 1 : 0; }

EXPORT void *fe_mem_ptr(int id) { return retro_get_memory_data(id); }
EXPORT int fe_mem_size(int id) { return (int)retro_get_memory_size(id); }

extern char CdromId[10];
extern char CdromLabel[33];
EXPORT const char *fe_cdrom_id(void) { return CdromId; }

/* FNV-1a over main RAM: cheap desync detector for lockstep netplay. */
EXPORT uint32_t fe_ram_hash(void)
{
    const uint8_t *p = retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
    size_t n = retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
    uint32_t h = 2166136261u;
    if (!p)
        return 0;
    for (size_t i = 0; i < n; i++)
        h = (h ^ p[i]) * 16777619u;
    return h;
}
