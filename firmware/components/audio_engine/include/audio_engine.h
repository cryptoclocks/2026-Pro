/*
 * CryptoClock Pro — audio_engine
 * NS4168 over I2S (BCLK=42, LRCK=2, DOUT=41). v1: tone generator + WAV
 * (16-bit PCM) streaming from SD/LittleFS. MP3 (helix) arrives in M4.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t audio_engine_init(void);

/** Play a .wav file (absolute VFS path). Replaces anything playing. */
int audio_engine_play_file(const char *abs_path, bool loop);
/** Simple square-wave beep, vol 0..100. */
int audio_engine_tone(uint32_t freq_hz, uint32_t dur_ms, uint32_t vol);
int audio_engine_stop(void);

/** Master volume 0..100 (applied to WAV samples). */
void audio_engine_set_volume(int vol);
bool audio_engine_playing(void);

#ifdef __cplusplus
}
#endif
