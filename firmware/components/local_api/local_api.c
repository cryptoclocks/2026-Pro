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

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_http_server.h"
#include "mdns.h"
#include "cJSON.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "local_api";

static httpd_handle_t s_httpd;

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
    ccp_board_set_brightness(v->valueint);
    cJSON_Delete(root);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t h_identify(httpd_req_t *req)
{
    audio_engine_tone(1200, 250, 70);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t h_wifi_reset(httpd_req_t *req)
{
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, "{\"ok\":true,\"note\":\"rebooting into setup portal\"}",
                    HTTPD_RESP_USE_STRLEN);
    vTaskDelay(pdMS_TO_TICKS(500));
    net_manager_forget(); /* reboots */
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
    cfg.max_uri_handlers = 10;
    cfg.lru_purge_enable = true;
    ESP_RETURN_ON_ERROR(httpd_start(&s_httpd, &cfg), TAG, "httpd");

    const httpd_uri_t routes[] = {
        { .uri = "/api/v1/info",       .method = HTTP_GET,  .handler = h_info },
        { .uri = "/api/v1/config",     .method = HTTP_GET,  .handler = h_config_get },
        { .uri = "/api/v1/config",     .method = HTTP_POST, .handler = h_config_post },
        { .uri = "/api/v1/brightness", .method = HTTP_POST, .handler = h_brightness },
        { .uri = "/api/v1/identify",   .method = HTTP_POST, .handler = h_identify },
        { .uri = "/api/v1/wifi/reset", .method = HTTP_POST, .handler = h_wifi_reset },
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
