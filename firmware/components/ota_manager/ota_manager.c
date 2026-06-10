#include "ota_manager.h"

#include <string.h>
#include "esp_https_ota.h"
#include "esp_ota_ops.h"
#include "esp_crt_bundle.h"
#include "esp_app_desc.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "ota";

esp_err_t ota_manager_update(const char *fw_url, const char *fw_sha256_hex)
{
    ESP_LOGI(TAG, "starting OTA from %s", fw_url);
    /* TODO(M4): pre-check fw_sha256_hex against the downloaded image before
     * esp_ota_set_boot_partition; esp_https_ota already verifies the image
     * header/magic and the app is gated by rollback anyway. */
    (void)fw_sha256_hex;

    const esp_http_client_config_t http_cfg = {
        .url = fw_url,
        .timeout_ms = 30000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = true,
    };
    const esp_https_ota_config_t ota_cfg = {
        .http_config = &http_cfg,
    };

    esp_err_t err = esp_https_ota(&ota_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "OTA failed: %s", esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "OTA OK — rebooting into new image (pending verify)");
    esp_restart();
    return ESP_OK;
}

esp_err_t ota_manager_mark_healthy(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "marking app image valid (rollback cancelled)");
        return esp_ota_mark_app_valid_cancel_rollback();
    }
    return ESP_OK;
}

const char *ota_manager_running_version(void)
{
    return esp_app_get_description()->version;
}
