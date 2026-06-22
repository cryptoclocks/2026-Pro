#include "device_security.h"
#include "storage.h"

#include <stdio.h>
#include <string.h>

#include "esp_mac.h"
#include "esp_littlefs.h"
#include "nvs_flash.h"
#include "esp_system.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "devsec";
#define KV_NS "devsec"

static char s_device_id[20];
static bool s_locked;

esp_err_t device_security_init(void)
{
    /* Provisioned serial (e.g. CCP000007) wins; else fall back to the MAC id. */
    char prov[20] = {0};
    if (storage_kv_get_str(KV_NS, "device_id", prov, sizeof(prov)) == ESP_OK && prov[0]) {
        strlcpy(s_device_id, prov, sizeof(s_device_id));
    } else {
        uint8_t mac[6];
        ESP_RETURN_ON_ERROR(esp_read_mac(mac, ESP_MAC_WIFI_STA), TAG, "mac");
        snprintf(s_device_id, sizeof(s_device_id), "ccp-%02x%02x%02x%02x%02x%02x",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }

    char buf[8] = {0};
    if (storage_kv_get_str(KV_NS, "locked", buf, sizeof(buf)) == ESP_OK) {
        s_locked = (buf[0] == '1');
    }
    ESP_LOGI(TAG, "device id: %s%s", s_device_id, s_locked ? " (LOCKED)" : "");
    return ESP_OK;
}

const char *device_security_id(void) { return s_device_id; }

void device_security_mac_str(char *buf, size_t len)
{
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(buf, len, "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

esp_err_t device_security_set_provision(const char *device_id, const char *token)
{
    if (device_id && device_id[0]) {
        ESP_RETURN_ON_ERROR(storage_kv_set_str(KV_NS, "device_id", device_id), TAG, "save id");
        strlcpy(s_device_id, device_id, sizeof(s_device_id));
    }
    if (token && token[0]) {
        ESP_RETURN_ON_ERROR(storage_kv_set_str(KV_NS, "token", token), TAG, "save token");
    }
    ESP_LOGI(TAG, "provisioned id=%s", s_device_id);
    return ESP_OK;
}

esp_err_t device_security_get_token(char *buf, size_t len)
{
    buf[0] = '\0';
    return storage_kv_get_str(KV_NS, "token", buf, len);
}

esp_err_t device_security_set_token(const char *token)
{
    return storage_kv_set_str(KV_NS, "token", token);
}

bool device_security_claimed(void)
{
    char tok[8];
    return storage_kv_get_str(KV_NS, "token", tok, sizeof(tok)) == ESP_OK && tok[0];
}

void device_security_claim_code(char *buf, size_t len)
{
    /* human-typable code from the MAC tail; server pairs it at claim time */
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(buf, len, "%02X%02X%02X", mac[3], mac[4], mac[5]);
}

esp_err_t device_security_set_locked(bool locked)
{
    s_locked = locked;
    return storage_kv_set_str(KV_NS, "locked", locked ? "1" : "0");
}

bool device_security_locked(void) { return s_locked; }

esp_err_t device_security_wipe(void)
{
    ESP_LOGW(TAG, "REMOTE WIPE: erasing NVS + LittleFS");
    esp_littlefs_format("storage");
    nvs_flash_erase();
    esp_restart();
    return ESP_OK;
}
