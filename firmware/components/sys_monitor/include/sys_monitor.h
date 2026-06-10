/*
 * CryptoClock Pro — sys_monitor
 * Heap/PSRAM watermarks, FPS, battery, SD space → telemetry JSON;
 * task watchdog registration; periodic publish via callback.
 */
#pragma once

#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*sys_telemetry_cb_t)(const char *json);

/** Start the monitor task; cb fires every period_s with a telemetry JSON. */
esp_err_t sys_monitor_start(sys_telemetry_cb_t cb, int period_s);

/** Compose the telemetry JSON on demand. */
void sys_monitor_build_telemetry(char *buf, size_t len);

#ifdef __cplusplus
}
#endif
