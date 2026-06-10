/*
 * CryptoClock Pro — display_engine
 * AXS15231B (QSPI) + LVGL 9 glue: full-frame PSRAM draw buffer, chunked DMA
 * bounce buffers with inline software rotation + RGB565 byte swap, TE v-sync.
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Bring up QSPI panel, touch, LVGL core, tick timer and the LVGL task.
 * Backlight is left OFF; call ccp_board_set_brightness() once the first
 * frame is rendered to avoid showing garbage.
 */
esp_err_t display_engine_start(void);

/** Recursive lock guarding every LVGL call made outside the LVGL task. */
bool display_engine_lock(uint32_t timeout_ms); /* 0 = wait forever */
void display_engine_unlock(void);

lv_display_t *display_engine_get_disp(void);

/** Logical resolution after rotation is applied. */
int display_engine_width(void);
int display_engine_height(void);

/** Flush-rate estimate over the last second (sys_monitor telemetry). */
float display_engine_get_fps(void);

#ifdef __cplusplus
}
#endif
