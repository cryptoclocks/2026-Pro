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
#include <unistd.h>
#include <sys/stat.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h" /* xTaskCreatePinnedToCoreWithCaps (PSRAM stacks) */
#include "esp_heap_caps.h"
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
#include "dbg_console.h"
#include "local_api.h"
#include "user_config.h"

#include "esp_http_client.h"
#include "esp_crt_bundle.h"

static const char *TAG = "main";

#define DEFAULT_BROKER_URI CCP_CFG_MQTT_BROKER_URI

/* ------------------------------------------------------------ helpers */

static void deliver_page_settings(const cJSON *config);
static void deliver_saved_page_settings(void);
static void schedule_saved_page_settings_replay(void);
static const char *device_json_path(void);

/* The package UI is loaded once, AFTER MQTT connects, so the MQTT task can claim
 * its stack while internal DRAM is still free (loading the package + wasm + GIF
 * first starved it → "Error create mqtt task"). Guarded so the boot fallback and
 * the net_worker path don't double-load. */
static volatile bool s_ui_loaded = false;

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
    if (s_ui_loaded) {
        return;
    }
    s_ui_loaded = true;
    if (device_security_locked()) {
        ui_renderer_show_lock_screen();
        return;
    }
    /* purchased package (layout+wasm) loads alongside the built-in suite;
     * home_ui adopts its screen as an extra swipe page (settings.pages) */
    char dir[220];
    sync_manager_active_dir(dir, sizeof(dir));
    bool pkg_loaded = false;
    if (dir[0] && ui_renderer_load_dir(dir) == ESP_OK) {
        subscribe_layout_streams();
        wasm_engine_load_modules();
        pkg_loaded = true;
    }
    home_ui_show_home();
    if (pkg_loaded) {
        /* page list was enumerated before the package existed — rebuild so
         * the purchased page joins the rotation */
        home_ui_reload();
        /* feed the page its saved settings now (settings.<slug>) so bindings
         * show stored values immediately, not just after the next change */
        schedule_saved_page_settings_replay();
    }
}

/* ------------------------------------------------------- settings sync */

static const char *device_json_path(void)
{
    return storage_sd_mounted() ? STORAGE_SD_BASE "/config/device.json"
                                : STORAGE_LFS_BASE "/config/device.json";
}

static void deliver_page_settings(const cJSON *config);

/** Persist a server-provided config (JSON object) and hot-reload the UI. */
static esp_err_t apply_server_settings(int version, const cJSON *config)
{
    char *text = cJSON_PrintUnformatted(config);
    if (!text) {
        return ESP_ERR_NO_MEM;
    }
    char dir[96];
    snprintf(dir, sizeof(dir), "%s/config",
             storage_sd_mounted() ? STORAGE_SD_BASE : STORAGE_LFS_BASE);
    storage_mkdirs(dir);
    esp_err_t err = storage_write_file_atomic(device_json_path(), text, strlen(text));
    free(text);
    if (err == ESP_OK) {
        char ver[12];
        snprintf(ver, sizeof(ver), "%d", version);
        storage_kv_set_str("settings", "ver", ver);
        home_ui_reload();
        deliver_page_settings(config);
        schedule_saved_page_settings_replay();
        ESP_LOGI(TAG, "server settings v%d applied", version);
    }
    return err;
}

/* Deliver the active package's settings (config[<slug>], slug = package id after
 * the last dot) to its page as the reserved stream "settings.<slug>", so a
 * binding like {source:"settings", path:"nickname"} or wasm on_data picks up
 * admin/app changes live. No-op when no package or no matching settings object. */
static void deliver_page_settings_for_slug(const cJSON *config, const char *slug)
{
    if (!slug || !slug[0]) {
        return;
    }
    const cJSON *obj = cJSON_GetObjectItem(config, slug);
    if (!cJSON_IsObject(obj)) {
        return;
    }
    char *json = cJSON_PrintUnformatted(obj);
    if (!json) {
        return;
    }
    char stream[80];
    snprintf(stream, sizeof(stream), "settings.%s", slug);
    ui_renderer_handle_data(stream, json, strlen(json));
    free(json);

    /* The clock page's time text is drawn by wasm (CLOCK_LOGIC_SOURCE), which
     * can't see the binding stream — mirror the format/tz settings into the wasm
     * KV ("wasmkv") so ccp_kv_get() picks them up (24/12h, date format, tz). */
    if (!strcmp(slug, "clock")) {
        const cJSON *it = cJSON_GetObjectItem(obj, "tz_offset_min");
        char b[16];
        int len = snprintf(b, sizeof(b), "%d", cJSON_IsNumber(it) ? it->valueint : 420);
        storage_kv_set_blob("wasmkv", "clk_tz", b, len);

        it = cJSON_GetObjectItem(obj, "format_24h");
        bool f24 = it ? cJSON_IsTrue(it) : true; /* default 24h when unset */
        storage_kv_set_blob("wasmkv", "clk_fmt24", f24 ? "1" : "0", 1);

        it = cJSON_GetObjectItem(obj, "date_format");
        const char *df = cJSON_IsString(it) ? it->valuestring : "long";
        storage_kv_set_blob("wasmkv", "clk_datefmt", df, strlen(df));
    }
}

static void deliver_page_settings(const cJSON *config)
{
    char pkg[64] = "";
    sync_manager_active_id(pkg, sizeof(pkg));
    const char *dot = strrchr(pkg, '.');
    deliver_page_settings_for_slug(config, dot ? dot + 1 : pkg);
}

/* Deliver settings for one specific page slug (used after a lazy swap, where the
 * loaded package is not necessarily sync_manager's "active" one). */
static void deliver_saved_settings_for_slug(const char *slug)
{
    char *cfg = storage_read_file(device_json_path(), NULL);
    if (!cfg) {
        return;
    }
    cJSON *root = cJSON_Parse(cfg);
    if (root) {
        deliver_page_settings_for_slug(root, slug);
        cJSON_Delete(root);
    }
    free(cfg);
}

static void deliver_saved_page_settings(void)
{
    char *cfg = storage_read_file(device_json_path(), NULL);
    if (!cfg) {
        return;
    }
    cJSON *root = cJSON_Parse(cfg);
    if (root) {
        deliver_page_settings(root);
        cJSON_Delete(root);
    }
    free(cfg);
}

static void settings_replay_task(void *arg)
{
    (void)arg;
    /* Wait for home_ui to finish adopting the renderer-owned screen before
     * pushing settings into the freshly rebuilt widget tree. */
    vTaskDelay(pdMS_TO_TICKS(750));
    deliver_saved_page_settings();
    vTaskDelete(NULL);
}

static void schedule_saved_page_settings_replay(void)
{
    xTaskCreate(settings_replay_task, "settings_replay", 4096, NULL, 2, NULL);
}

/*
 * Boot-time check: ask the Hub whether this device/user has newer settings
 * than what is stored locally (SD/LittleFS). Applied only when the version
 * differs; offline or 404 keeps the local config untouched.
 */
static void settings_sync_from_server(void)
{
    char url[192];
    snprintf(url, sizeof(url), "%s/api/v1/devices/%s/settings",
             CCP_CFG_SERVER_BASE_URL, device_security_id());

    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = 6000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) {
        return;
    }
    char *body = malloc(8192);
    int total = -1;
    if (body && esp_http_client_open(client, 0) == ESP_OK) {
        esp_http_client_fetch_headers(client);
        if (esp_http_client_get_status_code(client) == 200) {
            total = 0;
            int rd;
            while ((rd = esp_http_client_read(client, body + total, 8191 - total)) > 0) {
                total += rd;
            }
            body[total] = '\0';
        }
    }
    esp_http_client_cleanup(client);
    if (total <= 0) {
        ESP_LOGI(TAG, "settings sync: server unreachable or no settings — keeping local");
        free(body);
        return;
    }

    cJSON *root = cJSON_Parse(body);
    free(body);
    if (!root) {
        return;
    }
    const cJSON *jver = cJSON_GetObjectItem(root, "version");
    const cJSON *jcfg = cJSON_GetObjectItem(root, "config");
    if (cJSON_IsNumber(jver) && cJSON_IsObject(jcfg)) {
        char local_ver[12] = "0";
        storage_kv_get_str("settings", "ver", local_ver, sizeof(local_ver));
        if (atoi(local_ver) != jver->valueint) {
            apply_server_settings(jver->valueint, jcfg);
        } else {
            ESP_LOGI(TAG, "settings in sync (v%s)", local_ver);
        }
    }
    cJSON_Delete(root);
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
    home_ui_park(); /* renderer reload deletes screens home may be showing */
    wasm_engine_unload_all();
    if (ui_renderer_load_dir(dir) == ESP_OK) {
        subscribe_layout_streams();
        wasm_engine_load_modules();
    }
    home_ui_reload(); /* re-adopt the fresh package screen into the rotation */
    schedule_saved_page_settings_replay();
    publish_status();
}

/* ------------------------------------------------ lazy page-package swap
 * home_ui keeps every installed page in the swipe rotation but only one package
 * is loaded at a time. When the user swipes to a package that isn't loaded,
 * home_ui parks the display and asks us (via the registered activator) to swap.
 * The heavy work (SD read + widget build + wasm (re)load) must run off the LVGL
 * task — it would otherwise block rendering and risk the task WDT — so it runs
 * on the existing sync worker (no extra task stack). dir="" = unload only. */
static void do_page_swap(const char *dir, const char *slug)
{
    ESP_LOGI(TAG, "page swap: slug='%s' dir='%s'", slug ? slug : "", dir ? dir : "");
    bool ok;
    wasm_engine_unload_all(); /* stop the outgoing package's logic */
    if (dir && dir[0]) {
        ok = (ui_renderer_load_dir(dir) == ESP_OK);
        if (ok) {
            subscribe_layout_streams();
            wasm_engine_load_modules();
            /* widgets exist now — push saved settings before home_ui adopts */
            deliver_saved_settings_for_slug(slug);
        }
    } else {
        ok = true; /* pure unload (swiped to a native page) */
    }
    home_ui_package_loaded(slug, ok);
}

/* activator registered with home_ui: queue a swap onto the sync worker */
static bool request_package_page(const char *dir, const char *slug)
{
    return sync_manager_request_nav(dir, slug) == ESP_OK;
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
    } else if (!strcmp(type, "settings")) {
        /* server pushes {version, config} — persist + hot reload */
        const cJSON *jver = cJSON_GetObjectItem(params, "version");
        const cJSON *jcfg = cJSON_GetObjectItem(params, "config");
        if (cJSON_IsNumber(jver) && cJSON_IsObject(jcfg)) {
            esp_err_t err = apply_server_settings(jver->valueint, jcfg);
            cmd_respond(id, err == ESP_OK, err == ESP_OK ? NULL : "write failed");
        } else {
            cmd_respond(id, false, "missing version/config");
        }
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

/* First boot with an empty slideshow: pull 3 sample photos so page 3 isn't
 * blank. User photos from the app/SD replace them naturally. */
static void seed_slideshow_if_empty(void)
{
    if (!home_ui_slideshow_needs_content()) {
        return;
    }
    const char *dir = home_ui_slideshow_dir();
    storage_mkdirs(dir);
    /* PNG, not JPEG: LVGL's lodepng decodes the whole image reliably, while
     * its tiled tjpgd path renders blank on this panel. placehold.co serves
     * baseline 480x320 PNGs (the panel's exact resolution). */
    static const char *seed_colors[3] = { "0E7C7B", "1F3A93", "8E44AD" };
    int ok = 0;
    for (int i = 0; i < 3; i++) {
        char url[160], dest[128], tmp[136];
        snprintf(url, sizeof(url),
                 "https://placehold.co/480x320/%s/FFFFFF/png?text=CryptoClock+%d",
                 seed_colors[i], i + 1);
        snprintf(dest, sizeof(dest), "%s/sample%d.png", dir, i + 1);
        struct stat st;
        if (stat(dest, &st) == 0 && st.st_size > 0) {
            ok++; /* already there from an earlier boot */
            continue;
        }
        snprintf(tmp, sizeof(tmp), "%s.part", dest);
        unlink(tmp);
        if (conn_http_download(url, tmp, NULL, 20000) == ESP_OK &&
            rename(tmp, dest) == 0) {
            ok++;
        } else {
            unlink(tmp);
        }
    }
    ESP_LOGI(TAG, "slideshow seed: %d/3 sample images -> %s", ok, dir);
    if (ok > 0) {
        home_ui_reload();
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
            settings_sync_from_server(); /* initial check: local vs server config */
            seed_slideshow_if_empty();
            start_online_services();
            /* load the package UI now that MQTT owns its task — internal DRAM was
             * still free when connectivity_start ran above */
            load_active_or_recovery();
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

    /* lazy page-package swap: home_ui drives swaps on swipe; the work runs on
     * the sync worker (reuses its stack — no extra internal DRAM) */
    sync_manager_set_nav_handler(do_page_swap);
    home_ui_set_package_activator(request_package_page);

    /* Reserve the USB serial debug REPL before packages/images fragment
     * internal RAM; the console is non-fatal if USB setup is unavailable. */
    dbg_console_start();

    s_net_events = xEventGroupCreate();
    /* net_worker stack stays in internal DRAM — it runs TLS/WiFi which fault on a
     * PSRAM stack (cache gets disabled during some ops → stack unreachable) */
    xTaskCreatePinnedToCore(net_worker_task, "net_worker", 8192, NULL, 4, NULL, 0);
    ESP_ERROR_CHECK(net_manager_start(on_net_event));

    /* net_worker loads the package UI right after MQTT connects (keeps internal
     * DRAM free for the MQTT task). Offline fallback: if we haven't connected
     * within ~8s (and aren't in the captive portal), load it anyway so the
     * device still shows its page without live data. */
    for (int i = 0; i < 16 && !s_ui_loaded; i++) {
        if (net_manager_state() == NET_STATE_PROVISIONING) {
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    if (net_manager_state() != NET_STATE_PROVISIONING) {
        load_active_or_recovery(); /* idempotent — no-op if net_worker already did it */
    }
    /* telemetry is non-critical — a startup failure (e.g. transient OOM) must not
     * abort the whole device and trigger a boot loop; log and carry on.
     * NB: kept AFTER the package load on purpose — starting these 4KB-stack
     * tasks before it starves the boot and hangs the device on "Starting…". */
    if (sys_monitor_start(on_telemetry, 30) != ESP_OK) {
        ESP_LOGW(TAG, "sys_monitor failed to start (continuing without telemetry)");
    }
    xTaskCreatePinnedToCore(health_gate_task, "health", 4096, NULL, 6, NULL, 0);
}
