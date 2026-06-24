#include "local_api.h"
#include "storage.h"
#include "ccp_board.h"
#include "device_security.h"
#include "net_manager.h"
#include "ota_manager.h"
#include "home_ui.h"
#include "audio_engine.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>
#include <strings.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_http_server.h"
#include "mdns.h"
#include "cJSON.h"
#include "esp_check.h"
#include "esp_system.h"
#include "esp_log.h"

static const char *TAG = "local_api";

static httpd_handle_t s_httpd;

/* CORS — the browser-based web-user app (served over http on the LAN) calls this
 * LAN API directly, so every response needs Access-Control-Allow-Origin and POST
 * requests get an OPTIONS preflight. Native apps (Flutter) don't need this. */
static void cors(httpd_req_t *req)
{
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
}

/* Wildcard OPTIONS preflight responder for any api route. */
static esp_err_t h_options(httpd_req_t *req)
{
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type, Authorization");
    httpd_resp_set_hdr(req, "Access-Control-Max-Age", "86400");
    return httpd_resp_send(req, NULL, 0);
}

static esp_err_t send_json(httpd_req_t *req, cJSON *root)
{
    char *out = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!out) {
        return httpd_resp_send_500(req);
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, out, HTTPD_RESP_USE_STRLEN);
    free(out);
    return err;
}

static const char *config_path(void)
{
    return storage_sd_mounted() ? STORAGE_SD_BASE "/config/device.json"
                                : STORAGE_LFS_BASE "/config/device.json";
}

/* ------------------------------------------------------------ handlers */

static esp_err_t h_info(httpd_req_t *req)
{
    cors(req);
    char ip[16];
    net_manager_ip(ip, sizeof(ip));
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device_id", device_security_id());
    cJSON_AddStringToObject(root, "model", "JC3248W535C");
    cJSON_AddStringToObject(root, "fw", ota_manager_running_version());
    cJSON_AddStringToObject(root, "ip", ip);
    cJSON_AddNumberToObject(root, "rssi", net_manager_rssi());
    cJSON_AddNumberToObject(root, "brightness", ccp_board_get_brightness());
    cJSON_AddBoolToObject(root, "locked", device_security_locked());
    cJSON_AddBoolToObject(root, "sd_mounted", storage_sd_mounted());
    cJSON_AddBoolToObject(root, "claimed", device_security_claimed());
    return send_json(req, root);
}

static esp_err_t h_config_get(httpd_req_t *req)
{
    cors(req);
    size_t len = 0;
    char *json = storage_read_file(config_path(), &len);
    if (!json) {
        /* also try the other location before giving an empty default */
        json = storage_read_file(STORAGE_LFS_BASE "/config/device.json", &len);
    }
    httpd_resp_set_type(req, "application/json");
    if (json) {
        httpd_resp_send(req, json, len);
        free(json);
    } else {
        httpd_resp_send(req, "{}", 2);
    }
    return ESP_OK;
}

static esp_err_t h_config_post(httpd_req_t *req)
{
    cors(req);
    if (req->content_len <= 0 || req->content_len > 8192) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    char *body = malloc(req->content_len + 1);
    if (!body) {
        return httpd_resp_send_500(req);
    }
    int rd = httpd_req_recv(req, body, req->content_len);
    if (rd <= 0) {
        free(body);
        return httpd_resp_send_500(req);
    }
    body[rd] = '\0';

    cJSON *root = cJSON_Parse(body);
    if (!root) {
        free(body);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid JSON");
    }
    cJSON_Delete(root);

    /* config dir may not exist on first write */
    char dir[96];
    snprintf(dir, sizeof(dir), "%s/config",
             storage_sd_mounted() ? STORAGE_SD_BASE : STORAGE_LFS_BASE);
    storage_mkdirs(dir);

    esp_err_t err = storage_write_file_atomic(config_path(), body, rd);
    free(body);
    if (err != ESP_OK) {
        return httpd_resp_send_500(req);
    }
    home_ui_reload();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t h_brightness(httpd_req_t *req)
{
    cors(req);
    char body[64] = {0};
    int rd = httpd_req_recv(req, body, sizeof(body) - 1);
    if (rd <= 0) {
        return httpd_resp_send_500(req);
    }
    cJSON *root = cJSON_Parse(body);
    const cJSON *v = root ? cJSON_GetObjectItem(root, "value") : NULL;
    if (!cJSON_IsNumber(v)) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "need {\"value\":0-100}");
    }
    if (v->valueint < 0 || v->valueint > 100) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "value must be 0-100");
    }
    ccp_board_set_brightness(v->valueint);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t h_identify(httpd_req_t *req)
{
    cors(req);
    audio_engine_tone(1200, 250, 70);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

/* ------------------------------------------------ file management (SD) */

static bool rel_path_safe(const char *p)
{
    return p && strncmp(p, "pages/", 6) == 0 && !strstr(p, "..") && !strchr(p, '\\');
}

static const char *mime_for_path(const char *rel)
{
    const char *ext = strrchr(rel, '.');
    if (!ext) {
        return "application/octet-stream";
    }
    if (!strcasecmp(ext, ".png")) return "image/png";
    if (!strcasecmp(ext, ".jpg") || !strcasecmp(ext, ".jpeg")) return "image/jpeg";
    if (!strcasecmp(ext, ".gif")) return "image/gif";
    if (!strcasecmp(ext, ".bmp")) return "image/bmp";
    return "application/octet-stream";
}

static esp_err_t send_file(httpd_req_t *req, const char *full_path, const char *mime)
{
    FILE *f = fopen(full_path, "rb");
    if (!f) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
    }

    httpd_resp_set_type(req, mime);
    char buf[1024];
    esp_err_t err = ESP_OK;
    while (true) {
        size_t rd = fread(buf, 1, sizeof(buf), f);
        if (rd > 0) {
            err = httpd_resp_send_chunk(req, buf, rd);
            if (err != ESP_OK) {
                break;
            }
        }
        if (rd < sizeof(buf)) {
            break;
        }
    }
    fclose(f);
    if (err == ESP_OK) {
        err = httpd_resp_send_chunk(req, NULL, 0);
    }
    return err;
}

/** GET /api/v1/file?path=pages/slideshow/assets/x.png */
static esp_err_t h_file(httpd_req_t *req)
{
    cors(req);
    char query[160] = {0}, rel[120] = {0};
    httpd_req_get_url_query_str(req, query, sizeof(query));
    httpd_query_key_value(query, "path", rel, sizeof(rel));
    if (!rel_path_safe(rel)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "path must be under pages/");
    }
    char full[180];
    snprintf(full, sizeof(full), "%s/%s", STORAGE_SD_BASE, rel);

    if (!storage_sd_lock(5000)) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "SD busy");
    }
    esp_err_t err = send_file(req, full, mime_for_path(rel));
    storage_sd_unlock();
    return err;
}

/** GET /api/v1/files?dir=pages/slideshow/assets */
static esp_err_t h_files(httpd_req_t *req)
{
    cors(req);
    char query[128] = {0}, rel[96] = {0};
    httpd_req_get_url_query_str(req, query, sizeof(query));
    httpd_query_key_value(query, "dir", rel, sizeof(rel));
    if (!rel_path_safe(rel)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "dir must be under pages/");
    }
    char full[160];
    snprintf(full, sizeof(full), "%s/%s", STORAGE_SD_BASE, rel);

    cJSON *arr = cJSON_CreateArray();
    DIR *dir = opendir(full);
    if (dir) {
        struct dirent *de;
        while ((de = readdir(dir)) != NULL) {
            if (de->d_name[0] == '.') {
                continue;
            }
            char fpath[300];
            snprintf(fpath, sizeof(fpath), "%s/%s", full, de->d_name);
            struct stat st;
            if (stat(fpath, &st) == 0 && S_ISREG(st.st_mode)) {
                cJSON *f = cJSON_CreateObject();
                cJSON_AddStringToObject(f, "name", de->d_name);
                cJSON_AddNumberToObject(f, "size", (double)st.st_size);
                cJSON_AddItemToArray(arr, f);
            }
        }
        closedir(dir);
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "sd_mounted", storage_sd_mounted());
    cJSON_AddItemToObject(root, "files", arr);
    return send_json(req, root);
}

/** POST /api/v1/upload?path=pages/slideshow/assets/<name> — raw image body */
static esp_err_t h_upload(httpd_req_t *req)
{
    cors(req);
    if (!storage_sd_mounted()) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "no SD card");
    }
    char query[160] = {0}, rel[120] = {0};
    httpd_req_get_url_query_str(req, query, sizeof(query));
    httpd_query_key_value(query, "path", rel, sizeof(rel));
    if (!rel_path_safe(rel)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "path must be under pages/");
    }
    if (req->content_len <= 0 || req->content_len > 512 * 1024) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "size limit 512KB");
    }

    char full[180];
    snprintf(full, sizeof(full), "%s/%s", STORAGE_SD_BASE, rel);
    char *slash = strrchr(full, '/');
    if (slash) {
        *slash = '\0';
        storage_mkdirs(full);
        *slash = '/';
    }

    if (!storage_sd_lock(5000)) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "SD busy");
    }
    FILE *f = fopen(full, "wb");
    if (!f) {
        storage_sd_unlock();
        return httpd_resp_send_500(req);
    }
    char *buf = malloc(4096);
    int remaining = req->content_len;
    esp_err_t err = ESP_OK;
    while (remaining > 0 && buf) {
        int rd = httpd_req_recv(req, buf, remaining > 4096 ? 4096 : remaining);
        if (rd <= 0 || fwrite(buf, 1, rd, f) != (size_t)rd) {
            err = ESP_FAIL;
            break;
        }
        remaining -= rd;
    }
    free(buf);
    fclose(f);
    storage_sd_unlock();
    if (err != ESP_OK) {
        unlink(full);
        return httpd_resp_send_500(req);
    }
    ESP_LOGI(TAG, "uploaded %s (%d bytes)", rel, req->content_len);
    home_ui_reload(); /* new slideshow content shows immediately */
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

/** POST /api/v1/delete  {"path":"pages/slideshow/assets/x.jpg"} */
static esp_err_t h_delete(httpd_req_t *req)
{
    cors(req);
    char body[200] = {0};
    int rd = httpd_req_recv(req, body, sizeof(body) - 1);
    if (rd <= 0) {
        return httpd_resp_send_500(req);
    }
    cJSON *root = cJSON_Parse(body);
    const cJSON *jp = root ? cJSON_GetObjectItem(root, "path") : NULL;
    if (!cJSON_IsString(jp) || !rel_path_safe(jp->valuestring)) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "path must be under pages/");
    }
    char full[180];
    snprintf(full, sizeof(full), "%s/%s", STORAGE_SD_BASE, jp->valuestring);
    cJSON_Delete(root);
    int ok = unlink(full) == 0;
    if (ok) {
        home_ui_reload();
    }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, ok ? "{\"ok\":true}" : "{\"ok\":false}",
                           HTTPD_RESP_USE_STRLEN);
}

static esp_err_t h_wifi_reset(httpd_req_t *req)
{
    cors(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, "{\"ok\":true,\"note\":\"rebooting into setup portal\"}",
                    HTTPD_RESP_USE_STRLEN);
    vTaskDelay(pdMS_TO_TICKS(500));
    net_manager_forget(); /* reboots */
    return ESP_OK;
}

/* Admin provisioning over the cable/LAN: write the assigned serial + token to
 * NVS, then reboot so the new identity (and encId topics) take effect. */
static esp_err_t h_provision(httpd_req_t *req)
{
    cors(req);
    char body[512] = {0};
    if (req->content_len <= 0 || req->content_len >= (int)sizeof(body)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    int rd = httpd_req_recv(req, body, sizeof(body) - 1);
    if (rd <= 0) {
        return httpd_resp_send_500(req);
    }
    body[rd] = '\0';
    cJSON *root = cJSON_Parse(body);
    if (!root) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid JSON");
    }
    const char *device_id = cJSON_GetStringValue(cJSON_GetObjectItem(root, "deviceId"));
    const char *token = cJSON_GetStringValue(cJSON_GetObjectItem(root, "token"));
    if (!device_id || !device_id[0]) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "deviceId required");
    }
    device_security_set_provision(device_id, token);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, "{\"ok\":true,\"rebooting\":true}", HTTPD_RESP_USE_STRLEN);
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

/* -------------------------------------------------------------- public */

esp_err_t local_api_start(void)
{
    if (s_httpd) {
        return ESP_OK;
    }
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = 80;
    cfg.max_uri_handlers = 13;
    cfg.lru_purge_enable = true;
    cfg.uri_match_fn = httpd_uri_match_wildcard; /* enables the OPTIONS catch-all route */
    ESP_RETURN_ON_ERROR(httpd_start(&s_httpd, &cfg), TAG, "httpd");

    const httpd_uri_t routes[] = {
        { .uri = "/api/v1/info",       .method = HTTP_GET,  .handler = h_info },
        { .uri = "/api/v1/config",     .method = HTTP_GET,  .handler = h_config_get },
        { .uri = "/api/v1/config",     .method = HTTP_POST, .handler = h_config_post },
        { .uri = "/api/v1/brightness", .method = HTTP_POST, .handler = h_brightness },
        { .uri = "/api/v1/identify",   .method = HTTP_POST, .handler = h_identify },
        { .uri = "/api/v1/wifi/reset", .method = HTTP_POST, .handler = h_wifi_reset },
        { .uri = "/api/v1/files",      .method = HTTP_GET,  .handler = h_files },
        { .uri = "/api/v1/file",       .method = HTTP_GET,  .handler = h_file },
        { .uri = "/api/v1/upload",     .method = HTTP_POST, .handler = h_upload },
        { .uri = "/api/v1/delete",     .method = HTTP_POST, .handler = h_delete },
        { .uri = "/api/v1/provision",  .method = HTTP_POST, .handler = h_provision },
        { .uri = "/*",                 .method = HTTP_OPTIONS, .handler = h_options },
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(s_httpd, &routes[i]);
    }

    /* mDNS: find the device as <device-id>.local + browse _ccp._tcp */
    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(device_security_id());
        mdns_instance_name_set("CryptoClock Pro");
        mdns_txt_item_t txt[] = {
            { "fw", (char *)ota_manager_running_version() },
            { "model", "JC3248W535C" },
        };
        mdns_service_add(NULL, "_ccp", "_tcp", 80, txt, 2);
    }

    ESP_LOGI(TAG, "LAN API up: http://%s.local/api/v1/info", device_security_id());
    return ESP_OK;
}

void local_api_stop(void)
{
    if (s_httpd) {
        httpd_stop(s_httpd);
        s_httpd = NULL;
    }
    mdns_free();
}
