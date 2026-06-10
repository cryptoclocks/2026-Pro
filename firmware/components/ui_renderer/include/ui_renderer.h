/*
 * CryptoClock Pro — ui_renderer
 * Builds LVGL 9 widget trees from server-delivered layout.json
 * (schema/layout.schema.json), wires live data bindings and touch actions.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

#define UI_MAX_WIDGETS   128
#define UI_MAX_PAGES     16
#define UI_MAX_BINDINGS  96
#define UI_MAX_SOURCES   12
#define UI_MAX_WASM      4
#define UI_MAX_ASSETS    32

/* Event codes shared with the WASM ABI (schema/abi/ccp_abi_v1.md) */
enum {
    CCP_EVT_PRESSED = 1,
    CCP_EVT_PRESSING = 2,
    CCP_EVT_RELEASED = 3,
    CCP_EVT_CLICKED = 4,
    CCP_EVT_LONG_PRESSED = 5,
    CCP_EVT_VALUE_CHANGED = 6,
    CCP_EVT_GESTURE = 7,
    CCP_EVT_DRAG = 8,
    CCP_EVT_APP_BASE = 100,
};

typedef struct {
    char id[32];
    char path[160];     /* absolute path of the .wasm file */
    uint32_t tick_ms;
    uint32_t memory_kb;
    char canvas_id[32]; /* first bound canvas widget id, "" if none */
} ui_wasm_desc_t;

typedef struct {
    /* cross-component action hooks; any may be NULL */
    void (*audio_play)(const char *abs_path, bool loop);
    void (*audio_stop)(void);
    void (*wasm_event)(const char *module_id, int widget_idx, uint32_t event,
                       int32_t p0, int32_t p1);
    void (*mqtt_publish_evt)(const char *name, const char *json);
    void (*brightness_set)(int value);
} ui_hooks_t;

esp_err_t ui_renderer_init(const ui_hooks_t *hooks);

/** Load <dir>/layout.json and build all pages (replaces the current layout). */
esp_err_t ui_renderer_load_dir(const char *package_dir);
esp_err_t ui_renderer_load_json(const char *json, size_t len, const char *base_dir);

esp_err_t ui_renderer_show_page(const char *page_id);

/** Widget registry (stable indices for the WASM ABI). -1 / NULL when absent. */
int       ui_renderer_widget_index(const char *id);
lv_obj_t *ui_renderer_widget_by_index(int idx);
const char *ui_renderer_widget_id(int idx);

/** Feed an incoming data-stream payload; applies every matching binding. */
void ui_renderer_handle_data(const char *stream, const char *payload, size_t len);

/** Streams the active layout wants (for MQTT subscription). */
int ui_renderer_get_streams(char out[][96], int max);

/** WASM modules declared by the active layout. Returns count. */
int ui_renderer_get_wasm_modules(const ui_wasm_desc_t **out);

/** Built-in screens used before/without a package. */
void ui_renderer_show_boot_screen(const char *line1, const char *line2);
void ui_renderer_show_provisioning_screen(const char *ap_ssid);
void ui_renderer_show_lock_screen(void);

#ifdef __cplusplus
}
#endif
