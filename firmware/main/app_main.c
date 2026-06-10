/*
 * CryptoClock Pro — boot orchestration
 *
 * Boot:   NVS/storage -> board -> display (boot screen) -> security -> WiFi
 * Online: MQTT connect -> status/telemetry -> command handling
 * UI:     active package from SD (fallback: recovery layout in LittleFS)
 * Logic:  WASM modules declared by the layout
 * Safety: OTA rollback is cancelled only after the health gate passes.
 */
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "cJSON.h"

#include "ccp_board.h"
#include "display_engine.h"
#include "storage.h"
#include "net_manager.h"
#include "connectivity.h"
#include "sync_manager.h"
#include "ui_renderer.h"
#include "wasm_engine.h"
#include "audio_engine.h"
#include "ota_manager.h"
#include "device_security.h"
#include "sys_monitor.h"
#include "home_ui.h"
#include "local_api.h"
#include "user_config.h"

static const char *TAG = "main";

#define DEFAULT_BROKER_URI CCP_CFG_MQTT_BROKER_URI

/* ------------------------------------------------------------ helpers */

static void publish_status(void)
{
    char ip[16] = "";
    char pkg[64] = "", ver[16] = "";
    net_manager_ip(ip, sizeof(ip));
    sync_manager_active_id(pkg, sizeof(pkg));
    sync_manager_active_version(ver, sizeof(ver));

    char json[256];
    snprintf(json, sizeof(json),
             "{\"online\":true,\"fw\":\"%s\",\"pkg\":\"%s\",\"pkg_ver\":\"%s\","
             "\"ip\":\"%s\",\"rssi\":%d,\"locked\":%s}",
             ota_manager_running_version(), pkg, ver, ip, net_manager_rssi(),
             device_security_locked() ? "true" : "false");
    conn_publish_status(json);
}

static void subscribe_layout_streams(void)
{
    char streams[UI_MAX_SOURCES][96];
    int n = ui_renderer_get_streams(streams, UI_MAX_SOURCES);
    for (int i = 0; i < n; i++) {
        conn_subscribe_stream(streams[i]);
    }
}

static void load_active_or_recovery(void)
{
    if (device_security_locked()) {
        ui_renderer_show_lock_screen();
        return;
    }
    char dir[220];
    sync_manager_active_dir(dir, sizeof(dir));
    if (dir[0] && ui_renderer_load_dir(dir) == ESP_OK) {
        subscribe_layout_streams();
        wasm_engine_load_modules();
        return;
    }
    if (ui_renderer_load_dir(STORAGE_RECOVERY_DIR) == ESP_OK) {
        ESP_LOGW(TAG, "running recovery layout");
        return;
    }
    /* no server package installed -> built-in home suite */
    home_ui_show_home();
}

/* --------------------------------------------------------------- hooks */

static void hook_audio_play(const char *abs_path, bool loop)
{
    audio_engine_play_file(abs_path, loop);
}

static int hook_audio_play_int(const char *abs_path, bool loop)
{
    return audio_engine_play_file(abs_path, loop);
}

static void hook_audio_stop(void) { audio_engine_stop(); }

static void hook_wasm_event(const char *module_id, int widget_idx, uint32_t event,
                            int32_t p0, int32_t p1)
{
    wasm_engine_send_event(module_id, widget_idx, event, p0, p1);
}

static void hook_mqtt_publish_evt(const char *name, const char *json)
{
    conn_publish_evt(name, json);
}

static void hook_brightness(int value)
{
    ccp_board_set_brightness(value);
}

static int hook_stream_subscribe(const char *stream) { return conn_subscribe_stream(stream); }
static int hook_stream_unsubscribe(const char *stream) { return conn_unsubscribe_stream(stream); }
static int hook_audio_tone(uint32_t f, uint32_t d, uint32_t v) { return audio_engine_tone(f, d, v); }
static int hook_audio_stop_int(void) { return audio_engine_stop(); }

/* ---------------------------------------------------------- sync done */

static void on_package_activated(const char *pkg, const char *ver, const char *dir)
{
    ESP_LOGI(TAG, "activating %s@%s", pkg, ver);
    wasm_engine_unload_all();
    if (ui_renderer_load_dir(dir) == ESP_OK) {
        subscribe_layout_streams();
        wasm_engine_load_modules();
    }
    publish_status();
}

/* ------------------------------------------------------------ commands */

static void cmd_respond(const char *id, bool ok, const char *error)
{
    char json[192];
    if (error) {
        snprintf(json, sizeof(json), "{\"id\":\"%s\",\"ok\":%s,\"error\":\"%s\"}",
                 id, ok ? "true" : "false", error);
    } else {
        snprintf(json, sizeof(json), "{\"id\":\"%s\",\"ok\":%s}", id, ok ? "true" : "false");
    }
    conn_publish_cmd_res(json);
}

static void on_cmd(const char *json, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(json, len);
    if (!root) {
        return;
    }
    const cJSON *jid = cJSON_GetObjectItem(root, "id");
    const cJSON *jtype = cJSON_GetObjectItem(root, "type");
    const cJSON *params = cJSON_GetObjectItem(root, "params");
    const char *id = cJSON_IsString(jid) ? jid->valuestring : "?";
    const char *type = cJSON_IsString(jtype) ? jtype->valuestring : "";
    ESP_LOGI(TAG, "cmd %s (%s)", type, id);

    if (!strcmp(type, "ping")) {
        cmd_respond(id, true, NULL);
    } else if (!strcmp(type, "reboot")) {
        cmd_respond(id, true, NULL);
        vTaskDelay(pdMS_TO_TICKS(300));
        esp_restart();
    } else if (!strcmp(type, "brightness")) {
        int v = (int)cJSON_GetNumberValue(cJSON_GetObjectItem(params, "value"));
        ccp_board_set_brightness(v);
        cmd_respond(id, true, NULL);
    } else if (!strcmp(type, "identify")) {
        audio_engine_tone(1200, 300, 70);
        cmd_respond(id, true, NULL);
    } else if (!strcmp(type, "show_page")) {
        const cJSON *pg = cJSON_GetObjectItem(params, "page_id");
        esp_err_t err = ESP_ERR_INVALID_ARG;
        if (cJSON_IsString(pg) && display_engine_lock(500)) {
            err = ui_renderer_show_page(pg->valuestring);
            display_engine_unlock();
        }
        cmd_respond(id, err == ESP_OK, err == ESP_OK ? NULL : "page not found");
    } else if (!strcmp(type, "sync")) {
        sync_request_t req = {0};
        strlcpy(req.package_id, cJSON_GetStringValue(cJSON_GetObjectItem(params, "package_id")) ?: "",
                sizeof(req.package_id));
        strlcpy(req.version, cJSON_GetStringValue(cJSON_GetObjectItem(params, "version")) ?: "",
                sizeof(req.version));
        strlcpy(req.bundle_url, cJSON_GetStringValue(cJSON_GetObjectItem(params, "bundle_url")) ?: "",
                sizeof(req.bundle_url));
        strlcpy(req.bundle_sha256, cJSON_GetStringValue(cJSON_GetObjectItem(params, "bundle_sha256")) ?: "",
                sizeof(req.bundle_sha256));
        if (req.package_id[0] && req.version[0] && req.bundle_url[0]) {
            esp_err_t err = sync_manager_request(&req);
            cmd_respond(id, err == ESP_OK, err == ESP_OK ? NULL : "sync queue full");
        } else {
            cmd_respond(id, false, "missing params");
        }
    } else if (!strcmp(type, "reload")) {
        load_active_or_recovery();
        cmd_respond(id, true, NULL);
    } else if (!strcmp(type, "ota")) {
        const char *url = cJSON_GetStringValue(cJSON_GetObjectItem(params, "fw_url"));
        const char *sha = cJSON_GetStringValue(cJSON_GetObjectItem(params, "fw_sha256"));
        if (url) {
            cmd_respond(id, true, NULL);
            vTaskDelay(pdMS_TO_TICKS(300));
            ota_manager_update(url, sha); /* reboots on success */
            cmd_respond(id, false, "ota failed");
        } else {
            cmd_respond(id, false, "missing fw_url");
        }
    } else if (!strcmp(type, "lock")) {
        device_security_set_locked(true);
        wasm_engine_unload_all();
        ui_renderer_show_lock_screen();
        cmd_respond(id, true, NULL);
    } else if (!strcmp(type, "unlock")) {
        device_security_set_locked(false);
        cmd_respond(id, true, NULL);
        load_active_or_recovery();
    } else if (!strcmp(type, "wipe")) {
        cmd_respond(id, true, NULL);
        vTaskDelay(pdMS_TO_TICKS(300));
        device_security_wipe(); /* reboots */
    } else {
        cmd_respond(id, false, "unknown command");
    }
    cJSON_Delete(root);
}

static void on_data(const char *stream, const char *payload, size_t len)
{
    ui_renderer_handle_data(stream, payload, len);
    wasm_engine_on_data(stream, payload, len);
}

static void on_telemetry(const char *json)
{
    conn_publish_telemetry(json);
}

/* ----------------------------------------------------------- net state */

static void start_online_services(void)
{
    static bool started = false;
    if (started) {
        publish_status();
        return;
    }
    started = true;

    char token[128] = "";
    device_security_get_token(token, sizeof(token));

    char broker[128] = DEFAULT_BROKER_URI;
    storage_kv_get_str("conn", "broker", broker, sizeof(broker));

    const conn_config_t cfg = {
        .broker_uri = broker,
        .device_id = device_security_id(),
        .password = token,
        .on_cmd = on_cmd,
        .on_data = on_data,
    };
    if (connectivity_start(&cfg) == ESP_OK) {
        /* status published on first telemetry tick; push one now too */
        vTaskDelay(pdMS_TO_TICKS(1000));
        publish_status();
        subscribe_layout_streams();
    }
}

/*
 * WiFi events arrive on the system event-loop task whose stack is tiny —
 * never do UI/MQTT/httpd work there. The handler only sets bits; this
 * worker (8KB stack) does the heavy lifting.
 */
#include "freertos/event_groups.h"

#define NETEVT_CONNECTED    BIT0
#define NETEVT_PROVISIONING BIT1
#define NETEVT_DISCONNECTED BIT2

static EventGroupHandle_t s_net_events;

static void on_net_event(net_state_t state)
{
    switch (state) {
    case NET_STATE_PROVISIONING:  xEventGroupSetBits(s_net_events, NETEVT_PROVISIONING); break;
    case NET_STATE_CONNECTED:     xEventGroupSetBits(s_net_events, NETEVT_CONNECTED); break;
    case NET_STATE_DISCONNECTED:  xEventGroupSetBits(s_net_events, NETEVT_DISCONNECTED); break;
    default: break;
    }
}

static void net_worker_task(void *arg)
{
    while (true) {
        EventBits_t bits = xEventGroupWaitBits(
            s_net_events, NETEVT_CONNECTED | NETEVT_PROVISIONING | NETEVT_DISCONNECTED,
            pdTRUE, pdFALSE, portMAX_DELAY);

        if (bits & NETEVT_PROVISIONING) {
            home_ui_show_wifi_setup(net_manager_ap_ssid());
        }
        if (bits & NETEVT_DISCONNECTED) {
            home_ui_network_changed(false, NULL);
        }
        if (bits & NETEVT_CONNECTED) {
            char ip[16];
            net_manager_ip(ip, sizeof(ip));
            ESP_LOGI(TAG, "network up (%s)", ip);
            home_ui_network_changed(true, ip);
            local_api_start();
            start_online_services();
        }
    }
}

/* ------------------------------------------------------------- health */

static void health_gate_task(void *arg)
{
    /* Health gate: display task alive (fps counter moves or lvgl lock works),
     * storage mounted, and 60s of stable uptime -> commit OTA + last-good. */
    vTaskDelay(pdMS_TO_TICKS(60 * 1000));
    bool display_ok = display_engine_lock(1000);
    if (display_ok) {
        display_engine_unlock();
    }
    if (display_ok) {
        ota_manager_mark_healthy();
        sync_manager_mark_last_good();
        ESP_LOGI(TAG, "health gate passed");
    } else {
        ESP_LOGE(TAG, "health gate FAILED — leaving rollback armed");
    }
    vTaskDelete(NULL);
}

/* ---------------------------------------------------------------- main */

void app_main(void)
{
    ESP_LOGI(TAG, "CryptoClock Pro fw %s", ota_manager_running_version());

    ESP_ERROR_CHECK(storage_init());
    ESP_ERROR_CHECK(ccp_board_init());
    ESP_ERROR_CHECK(device_security_init());
    ESP_ERROR_CHECK(display_engine_start());

    /* built-in UI: config from SD/LittleFS, applies brightness */
    ESP_ERROR_CHECK(home_ui_init());
    home_ui_show_welcome("Starting...");

    if (audio_engine_init() != ESP_OK) {
        ESP_LOGW(TAG, "audio unavailable");
    }

    const ui_hooks_t ui_hooks = {
        .audio_play = hook_audio_play,
        .audio_stop = hook_audio_stop,
        .wasm_event = hook_wasm_event,
        .mqtt_publish_evt = hook_mqtt_publish_evt,
        .brightness_set = hook_brightness,
    };
    ESP_ERROR_CHECK(ui_renderer_init(&ui_hooks));

    const wasm_engine_hooks_t wasm_hooks = {
        .stream_subscribe = hook_stream_subscribe,
        .stream_unsubscribe = hook_stream_unsubscribe,
        .audio_play = hook_audio_play_int,
        .audio_tone = hook_audio_tone,
        .audio_stop = hook_audio_stop_int,
    };
    ESP_ERROR_CHECK(wasm_engine_init(&wasm_hooks));
    ESP_ERROR_CHECK(sync_manager_init(on_package_activated));

    s_net_events = xEventGroupCreate();
    xTaskCreatePinnedToCore(net_worker_task, "net_worker", 8192, NULL, 4, NULL, 0);
    ESP_ERROR_CHECK(net_manager_start(on_net_event));

    /* let the welcome splash breathe, then enter the home/package UI
     * (unless the captive portal took over the screen) */
    vTaskDelay(pdMS_TO_TICKS(1800));
    if (net_manager_state() != NET_STATE_PROVISIONING) {
        load_active_or_recovery();
    }
    ESP_ERROR_CHECK(sys_monitor_start(on_telemetry, 30));

    xTaskCreatePinnedToCore(health_gate_task, "health", 4096, NULL, 6, NULL, 0);
}
