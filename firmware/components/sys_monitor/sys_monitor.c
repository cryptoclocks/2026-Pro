#include "sys_monitor.h"
#include "display_engine.h"
#include "storage.h"
#include "ccp_board.h"
#include "wasm_engine.h"

#include <stdio.h>
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "sysmon";

static sys_telemetry_cb_t s_cb;
static int s_period_s = 30;

void sys_monitor_build_telemetry(char *buf, size_t len)
{
    const uint32_t heap = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    const uint32_t heap_min = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL);
    const uint32_t psram = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    const int64_t uptime_s = esp_timer_get_time() / 1000000;
    const int batt = ccp_board_read_battery_mv();
    const int64_t sd_free = storage_sd_free_kb();

    snprintf(buf, len,
             "{\"heap\":%" PRIu32 ",\"heap_min\":%" PRIu32 ",\"psram\":%" PRIu32
             ",\"batt_mv\":%d,\"fps\":%.1f,\"uptime_s\":%lld,\"sd_free_kb\":%lld"
             ",\"wasm_crashes\":%" PRIu32 "}",
             heap, heap_min, psram, batt, display_engine_get_fps(),
             (long long)uptime_s, (long long)sd_free, wasm_engine_crash_count());
}

static void monitor_task(void *arg)
{
    char json[320];
    while (true) {
        vTaskDelay(pdMS_TO_TICKS((uint32_t)s_period_s * 1000));
        sys_monitor_build_telemetry(json, sizeof(json));
        ESP_LOGD(TAG, "%s", json);
        if (s_cb) {
            s_cb(json);
        }
        /* fragmentation guard: warn when the largest free block degrades */
        size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
        if (largest < 16 * 1024) {
            ESP_LOGW(TAG, "internal heap fragmented: largest free block %u B", (unsigned)largest);
        }
    }
}

esp_err_t sys_monitor_start(sys_telemetry_cb_t cb, int period_s)
{
    s_cb = cb;
    if (period_s > 0) {
        s_period_s = period_s;
    }
    BaseType_t ok = xTaskCreatePinnedToCore(monitor_task, "sysmon", 4096, NULL, 2, NULL, 0);
    ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_FAIL, TAG, "task");
    return ESP_OK;
}
