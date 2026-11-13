#include "psx_sdl_audio.h"

#include <algorithm>
#include <cstring>

#if defined(PSX_SDL3)

static SDL_AudioStream *s_audio_stream;
static PsxSdlAudioCallback s_audio_callback;
static void *s_audio_userdata;

static void SDLCALL psx_sdl3_audio_feed(
    void *, SDL_AudioStream *stream, int additional_amount, int)
{
    Uint8 buffer[16384];
    while (s_audio_callback && additional_amount > 0) {
        const int chunk = std::min(additional_amount, (int)sizeof(buffer));
        s_audio_callback(s_audio_userdata, buffer, chunk);
        if (!SDL_PutAudioStreamData(stream, buffer, chunk)) break;
        additional_amount -= chunk;
    }
}

extern "C" SDL_AudioDeviceID psx_sdl_audio_open(
    const PsxSdlAudioSpec *want, PsxSdlAudioSpec *have)
{
    if (!want || s_audio_stream) return 0;

    SDL_AudioSpec requested;
    SDL_zero(requested);
    requested.freq = want->freq;
    requested.format = want->format;
    requested.channels = want->channels;

    s_audio_callback = want->callback;
    s_audio_userdata = want->userdata;
    s_audio_stream = SDL_OpenAudioDeviceStream(
        SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,
        &requested,
        s_audio_callback ? psx_sdl3_audio_feed : nullptr,
        nullptr);
    if (!s_audio_stream) {
        s_audio_callback = nullptr;
        s_audio_userdata = nullptr;
        return 0;
    }

    const SDL_AudioDeviceID device = SDL_GetAudioStreamDevice(s_audio_stream);
    if (have) {
        /* Report the stream input spec. SDL3 converts from this format to the
         * device format internally; reporting the device format here makes the
         * runtime generate at the wrong rate before SDL resamples it again. */
        std::memset(have, 0, sizeof(*have));
        have->freq = requested.freq;
        have->format = requested.format;
        have->channels = requested.channels;
        have->samples = want->samples;
    }

    return device;
}

extern "C" int psx_sdl_audio_resume(SDL_AudioDeviceID)
{
    return s_audio_stream && SDL_ResumeAudioStreamDevice(s_audio_stream)
               ? 0
               : -1;
}

extern "C" void psx_sdl_audio_close(SDL_AudioDeviceID)
{
    if (s_audio_stream) SDL_DestroyAudioStream(s_audio_stream);
    s_audio_stream = nullptr;
    s_audio_callback = nullptr;
    s_audio_userdata = nullptr;
}

extern "C" void psx_sdl_audio_clear(SDL_AudioDeviceID)
{
    if (s_audio_stream) (void)SDL_ClearAudioStream(s_audio_stream);
}

extern "C" Uint32 psx_sdl_audio_queued_size(SDL_AudioDeviceID)
{
    if (!s_audio_stream) return 0;
    const int queued = SDL_GetAudioStreamQueued(s_audio_stream);
    return queued > 0 ? (Uint32)queued : 0;
}

extern "C" int psx_sdl_audio_queue(
    SDL_AudioDeviceID, const void *data, Uint32 bytes)
{
    return s_audio_stream &&
           SDL_PutAudioStreamData(s_audio_stream, data, (int)bytes)
               ? 0
               : -1;
}

extern "C" void psx_sdl_audio_lock(SDL_AudioDeviceID)
{
    if (s_audio_stream) (void)SDL_LockAudioStream(s_audio_stream);
}

extern "C" void psx_sdl_audio_unlock(SDL_AudioDeviceID)
{
    if (s_audio_stream) (void)SDL_UnlockAudioStream(s_audio_stream);
}

#elif defined(PSX_WEB)

/* Browser audio: the emulation pthread writes S16 stereo frames into a ring in
 * shared wasm memory; an AudioWorklet on the page (psx-audio-worklet.js) reads
 * it directly. No per-chunk thread hop, and nothing touches Web Audio from the
 * emulation thread. JS discovers the ring with psx_web_audio_ring(). */
#include <emscripten/emscripten.h>
#include <atomic>

#define PSX_WEB_AUDIO_FRAMES (1u << 16)          /* ~1.5 s at 44.1 kHz */
static int16_t s_web_ring[PSX_WEB_AUDIO_FRAMES * 2];
/* [0] write index (frames, free-running), [1] read index (worklet),
 * [2] sample rate, [3] ring size in frames. */
static std::atomic<uint32_t> s_web_ctl[4];

extern "C" EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_audio_ring(void) { return (uintptr_t)s_web_ring; }
extern "C" EMSCRIPTEN_KEEPALIVE uintptr_t psx_web_audio_ctl(void) { return (uintptr_t)s_web_ctl; }

extern "C" SDL_AudioDeviceID psx_sdl_audio_open(
    const PsxSdlAudioSpec *want, PsxSdlAudioSpec *have)
{
    if (want->channels != 2) return 0;
    s_web_ctl[2].store((uint32_t)want->freq);
    s_web_ctl[3].store(PSX_WEB_AUDIO_FRAMES);
    if (have) {
        std::memset(have, 0, sizeof(*have));
        have->freq = want->freq;
        have->format = want->format;
        have->channels = 2;
        have->samples = want->samples;
    }
    return 1;
}
extern "C" int psx_sdl_audio_resume(SDL_AudioDeviceID) { return 0; }
extern "C" void psx_sdl_audio_close(SDL_AudioDeviceID) {}
extern "C" void psx_sdl_audio_clear(SDL_AudioDeviceID)
{
    s_web_ctl[0].store(s_web_ctl[1].load());
}
extern "C" Uint32 psx_sdl_audio_queued_size(SDL_AudioDeviceID)
{
    const uint32_t w = s_web_ctl[0].load(), r = s_web_ctl[1].load();
    const uint32_t q = w - r;
    return (q > PSX_WEB_AUDIO_FRAMES ? 0u : q) * 4u;
}
extern "C" int psx_sdl_audio_queue(
    SDL_AudioDeviceID, const void *data, Uint32 bytes)
{
    const int16_t *src = (const int16_t *)data;
    uint32_t frames = bytes / 4u;
    uint32_t w = s_web_ctl[0].load(std::memory_order_relaxed);
    const uint32_t r = s_web_ctl[1].load();
    const uint32_t room = PSX_WEB_AUDIO_FRAMES - (w - r > PSX_WEB_AUDIO_FRAMES ? 0u : w - r);
    if (frames > room) frames = room;             /* overflow: drop the tail */
    for (uint32_t i = 0; i < frames; i++, w++) {
        const uint32_t k = (w & (PSX_WEB_AUDIO_FRAMES - 1u)) * 2u;
        s_web_ring[k] = src[i * 2u];
        s_web_ring[k + 1u] = src[i * 2u + 1u];
    }
    s_web_ctl[0].store(w, std::memory_order_release);
    return 0;
}
extern "C" void psx_sdl_audio_lock(SDL_AudioDeviceID) {}
extern "C" void psx_sdl_audio_unlock(SDL_AudioDeviceID) {}

#else

extern "C" SDL_AudioDeviceID psx_sdl_audio_open(
    const PsxSdlAudioSpec *want, PsxSdlAudioSpec *have)
{
    SDL_AudioSpec requested;
    SDL_AudioSpec obtained;
    SDL_zero(requested);
    SDL_zero(obtained);
    requested.freq = want->freq;
    requested.format = want->format;
    requested.channels = want->channels;
    requested.samples = want->samples;
    requested.callback = want->callback;
    requested.userdata = want->userdata;
    const SDL_AudioDeviceID device = SDL_OpenAudioDevice(
        nullptr, 0, &requested, &obtained,
        want->allow_frequency_change ? SDL_AUDIO_ALLOW_FREQUENCY_CHANGE : 0);
    if (device && have) {
        std::memset(have, 0, sizeof(*have));
        have->freq = obtained.freq;
        have->format = obtained.format;
        have->channels = obtained.channels;
        have->samples = obtained.samples;
    }
    return device;
}

extern "C" int psx_sdl_audio_resume(SDL_AudioDeviceID device)
{
    SDL_PauseAudioDevice(device, 0);
    return 0;
}

extern "C" void psx_sdl_audio_close(SDL_AudioDeviceID device)
{
    SDL_CloseAudioDevice(device);
}

extern "C" void psx_sdl_audio_clear(SDL_AudioDeviceID device)
{
    SDL_ClearQueuedAudio(device);
}

extern "C" Uint32 psx_sdl_audio_queued_size(SDL_AudioDeviceID device)
{
    return SDL_GetQueuedAudioSize(device);
}

extern "C" int psx_sdl_audio_queue(
    SDL_AudioDeviceID device, const void *data, Uint32 bytes)
{
    return SDL_QueueAudio(device, data, bytes);
}

extern "C" void psx_sdl_audio_lock(SDL_AudioDeviceID device)
{
    SDL_LockAudioDevice(device);
}

extern "C" void psx_sdl_audio_unlock(SDL_AudioDeviceID device)
{
    SDL_UnlockAudioDevice(device);
}

#endif
