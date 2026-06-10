#include "storage.h"
#include "ccp_board.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/unistd.h>
#include <dirent.h>
#include <errno.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_littlefs.h"
#include "esp_vfs_fat.h"
#include "driver/sdmmc_host.h"
#include "sdmmc_cmd.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "storage";

static bool s_sd_mounted;
static sdmmc_card_t *s_card;
static SemaphoreHandle_t s_sd_mutex;

static esp_err_t mount_littlefs(void)
{
    const esp_vfs_littlefs_conf_t conf = {
        .base_path = STORAGE_LFS_BASE,
        .partition_label = "storage",
        .format_if_mount_failed = true,
        .dont_mount = false,
    };
    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err == ESP_OK) {
        size_t total = 0, used = 0;
        esp_littlefs_info(conf.partition_label, &total, &used);
        ESP_LOGI(TAG, "littlefs mounted: %u/%u KB used", (unsigned)(used / 1024), (unsigned)(total / 1024));
    }
    return err;
}

static esp_err_t mount_sd(void)
{
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.max_freq_khz = SDMMC_FREQ_HIGHSPEED;

    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    slot.width = 1;
    slot.clk = CCP_PIN_SD_CLK;
    slot.cmd = CCP_PIN_SD_CMD;
    slot.d0 = CCP_PIN_SD_D0;
    slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;

    const esp_vfs_fat_sdmmc_mount_config_t mount_cfg = {
        .format_if_mount_failed = false,
        .max_files = 8,
        .allocation_unit_size = 16 * 1024,
    };

    esp_err_t err = esp_vfs_fat_sdmmc_mount(STORAGE_SD_BASE, &host, &slot, &mount_cfg, &s_card);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SD mount failed (%s) — running from internal flash only", esp_err_to_name(err));
        return err;
    }
    s_sd_mounted = true;
    ESP_LOGI(TAG, "SD mounted: %s %lluMB", s_card->cid.name,
             ((uint64_t)s_card->csd.capacity * s_card->csd.sector_size) / (1024 * 1024));

    storage_mkdirs(STORAGE_PACKAGES_DIR);
    storage_mkdirs(STORAGE_CACHE_DIR);
    storage_mkdirs(STORAGE_STATE_DIR);
    /* staging is transient: clear leftovers from interrupted syncs */
    storage_rm_rf(STORAGE_STAGING_DIR);
    storage_mkdirs(STORAGE_STAGING_DIR);
    return ESP_OK;
}

esp_err_t storage_init(void)
{
    s_sd_mutex = xSemaphoreCreateRecursiveMutex();
    ESP_RETURN_ON_FALSE(s_sd_mutex, ESP_ERR_NO_MEM, TAG, "sd mutex");

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_RETURN_ON_ERROR(err, TAG, "nvs");

    ESP_RETURN_ON_ERROR(mount_littlefs(), TAG, "littlefs");
    storage_mkdirs(STORAGE_RECOVERY_DIR);

    mount_sd(); /* optional — failure tolerated */
    return ESP_OK;
}

bool storage_sd_mounted(void) { return s_sd_mounted; }

int64_t storage_sd_free_kb(void)
{
    if (!s_sd_mounted) {
        return -1;
    }
    uint64_t total = 0, free_b = 0;
    if (esp_vfs_fat_info(STORAGE_SD_BASE, &total, &free_b) != ESP_OK) {
        return -1;
    }
    return (int64_t)(free_b / 1024);
}

bool storage_sd_lock(uint32_t timeout_ms)
{
    const TickType_t t = (timeout_ms == 0) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    return xSemaphoreTakeRecursive(s_sd_mutex, t) == pdTRUE;
}

void storage_sd_unlock(void)
{
    xSemaphoreGiveRecursive(s_sd_mutex);
}

/* ------------------------------------------------------------------- KV */

esp_err_t storage_kv_set_str(const char *ns, const char *key, const char *val)
{
    nvs_handle_t h;
    ESP_RETURN_ON_ERROR(nvs_open(ns, NVS_READWRITE, &h), TAG, "open %s", ns);
    esp_err_t err = nvs_set_str(h, key, val);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

esp_err_t storage_kv_get_str(const char *ns, const char *key, char *buf, size_t buf_len)
{
    nvs_handle_t h;
    ESP_RETURN_ON_ERROR(nvs_open(ns, NVS_READONLY, &h), TAG, "open %s", ns);
    size_t len = buf_len;
    esp_err_t err = nvs_get_str(h, key, buf, &len);
    nvs_close(h);
    return err;
}

esp_err_t storage_kv_set_blob(const char *ns, const char *key, const void *val, size_t len)
{
    nvs_handle_t h;
    ESP_RETURN_ON_ERROR(nvs_open(ns, NVS_READWRITE, &h), TAG, "open %s", ns);
    esp_err_t err = nvs_set_blob(h, key, val, len);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

int storage_kv_get_blob(const char *ns, const char *key, void *buf, size_t buf_len)
{
    nvs_handle_t h;
    if (nvs_open(ns, NVS_READONLY, &h) != ESP_OK) {
        return -1;
    }
    size_t len = buf_len;
    esp_err_t err = nvs_get_blob(h, key, buf, &len);
    nvs_close(h);
    return (err == ESP_OK) ? (int)len : -1;
}

esp_err_t storage_kv_erase_ns(const char *ns)
{
    nvs_handle_t h;
    ESP_RETURN_ON_ERROR(nvs_open(ns, NVS_READWRITE, &h), TAG, "open %s", ns);
    esp_err_t err = nvs_erase_all(h);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

/* --------------------------------------------------------------- helpers */

esp_err_t storage_mkdirs(const char *path)
{
    char tmp[160];
    if (strlen(path) >= sizeof(tmp)) {
        return ESP_ERR_INVALID_ARG;
    }
    strcpy(tmp, path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(tmp, 0775);
            *p = '/';
        }
    }
    if (mkdir(tmp, 0775) != 0 && errno != EEXIST) {
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t storage_rm_rf(const char *path)
{
    struct stat st;
    if (stat(path, &st) != 0) {
        return ESP_OK; /* nothing to do */
    }
    if (!S_ISDIR(st.st_mode)) {
        return (unlink(path) == 0) ? ESP_OK : ESP_FAIL;
    }
    DIR *dir = opendir(path);
    if (!dir) {
        return ESP_FAIL;
    }
    struct dirent *de;
    char child[300];
    while ((de = readdir(dir)) != NULL) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) {
            continue;
        }
        snprintf(child, sizeof(child), "%s/%s", path, de->d_name);
        storage_rm_rf(child);
    }
    closedir(dir);
    return (rmdir(path) == 0) ? ESP_OK : ESP_FAIL;
}

esp_err_t storage_write_file_atomic(const char *path, const void *data, size_t len)
{
    char tmp[300];
    snprintf(tmp, sizeof(tmp), "%s.new", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) {
        return ESP_FAIL;
    }
    size_t wr = fwrite(data, 1, len, f);
    fclose(f);
    if (wr != len) {
        unlink(tmp);
        return ESP_FAIL;
    }
    /* FAT has no atomic replace; remove-then-rename is the closest we get. */
    unlink(path);
    return (rename(tmp, path) == 0) ? ESP_OK : ESP_FAIL;
}

char *storage_read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0 || sz > 4 * 1024 * 1024) { /* sanity cap: layouts/manifests only */
        fclose(f);
        return NULL;
    }
    char *buf = malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t rd = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    if (rd != (size_t)sz) {
        free(buf);
        return NULL;
    }
    buf[sz] = '\0';
    if (out_len) {
        *out_len = (size_t)sz;
    }
    return buf;
}
