/*
 * CryptoClock Pro — wasm_engine
 * WAMR (fast interpreter) wrapper. Modules run on a dedicated task below the
 * LVGL task priority; every entry point is deadline-supervised and a stuck
 * module is terminated with wasm_runtime_terminate(), then reinstantiated
 * (3 strikes -> dead until next layout reload).
 *
 * All I/O is mediated by the ccp_* host ABI (schema/abi/ccp_abi_v1.md):
 * no WASI, no sockets, no direct filesystem access.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CCP_ABI_VERSION 1

typedef struct {
    /* wired to connectivity in main; may be NULL for offline operation */
    int (*stream_subscribe)(const char *stream);
    int (*stream_unsubscribe)(const char *stream);
    /* wired to audio_engine */
    int (*audio_play)(const char *abs_path, bool loop);
    int (*audio_tone)(uint32_t freq_hz, uint32_t dur_ms, uint32_t vol);
    int (*audio_stop)(void);
} wasm_engine_hooks_t;

/** One-time runtime init with a dedicated PSRAM pool (2 MB). */
esp_err_t wasm_engine_init(const wasm_engine_hooks_t *hooks);

/** Load all modules declared by the active layout (ui_renderer). */
esp_err_t wasm_engine_load_modules(void);
void wasm_engine_unload_all(void);

/** Forward a UI event into a module (queued; never blocks the caller). */
void wasm_engine_send_event(const char *module_id, int widget_idx,
                            uint32_t event, int32_t p0, int32_t p1);

/** Route a data-stream payload into subscribed modules (queued, copies). */
void wasm_engine_on_data(const char *stream, const char *payload, size_t len);

uint32_t wasm_engine_crash_count(void);
int wasm_engine_loaded_count(void);

#ifdef __cplusplus
}
#endif
