#include "sync_manager.h"
#include "storage.h"
#include "connectivity.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/unistd.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "cJSON.h"
#include "esp_check.h"
#include "esp_log.h"

#include "miniz.h"

static const char *TAG = "sync";

#define SYNC_TASK_STACK   (10 * 1024)
#define SYNC_TASK_PRIO    3
#define SYNC_TASK_CORE    0
#define MAX_BUNDLE_BYTES  (16 * 1024 * 1024)

static QueueHandle_t s_queue;
static sync_activated_cb_t s_cb;

/* --------------------------------------------------------------- helpers */

static bool path_is_safe(const char *p)
{
    /* manifest/zip entries must be plain relative paths */
    return p[0] != '/' && p[0] != '\\' && strstr(p, "..") == NULL && strchr(p, ':') == NULL;
}

static esp_err_t extract_zip(const char *zip_path, const char *dest_dir)
{
    mz_zip_archive zip;
    memset(&zip, 0, sizeof(zip));
    if (!mz_zip_reader_init_file(&zip, zip_path, 0)) {
        ESP_LOGE(TAG, "zip open failed: %s", zip_path);
        return ESP_FAIL;
    }

    esp_err_t err = ESP_OK;
    const mz_uint n = mz_zip_reader_get_num_files(&zip);
    for (mz_uint i = 0; i < n && err == ESP_OK; i++) {
        mz_zip_archive_file_stat st;
        if (!mz_zip_reader_file_stat(&zip, i, &st)) {
            err = ESP_FAIL;
            break;
        }
        if (!path_is_safe(st.m_filename)) {
            ESP_LOGE(TAG, "unsafe zip entry: %s", st.m_filename);
            err = ESP_ERR_INVALID_ARG;
            break;
        }
        char out[300];
        snprintf(out, sizeof(out), "%s/%s", dest_dir, st.m_filename);

        if (mz_zip_reader_is_file_a_directory(&zip, i)) {
            storage_mkdirs(out);
            continue;
        }
        /* ensure parent dirs exist */
        char *slash = strrchr(out, '/');
        if (slash) {
            *slash = '\0';
            storage_mkdirs(out);
            *slash = '/';
        }
        if (!mz_zip_reader_extract_to_file(&zip, i, out, 0)) {
            ESP_LOGE(TAG, "extract failed: %s", st.m_filename);
            err = ESP_FAIL;
        }
    }
    mz_zip_reader_end(&zip);
    return err;
}

static esp_err_t verify_manifest(const char *dir)
{
    char mpath[300];
    snprintf(mpath, sizeof(mpath), "%s/manifest.json", dir);
    size_t mlen = 0;
    char *mjson = storage_read_file(mpath, &mlen);
    ESP_RETURN_ON_FALSE(mjson, ESP_ERR_NOT_FOUND, TAG, "manifest missing");

    cJSON *root = cJSON_ParseWithLength(mjson, mlen);
    free(mjson);
    ESP_RETURN_ON_FALSE(root, ESP_ERR_INVALID_ARG, TAG, "manifest parse");

    esp_err_t err = ESP_OK;
    const cJSON *files = cJSON_GetObjectItem(root, "files");
    if (!cJSON_IsArray(files)) {
        err = ESP_ERR_INVALID_ARG;
        goto out;
    }
    const cJSON *fit = NULL;
    cJSON_ArrayForEach(fit, files) {
        const cJSON *jpath = cJSON_GetObjectItem(fit, "path");
        const cJSON *jsha = cJSON_GetObjectItem(fit, "sha256");
        if (!cJSON_IsString(jpath) || !cJSON_IsString(jsha) || !path_is_safe(jpath->valuestring)) {
            err = ESP_ERR_INVALID_ARG;
            break;
        }
        char fpath[300];
        snprintf(fpath, sizeof(fpath), "%s/%s", dir, jpath->valuestring);
        char actual[65];
        if (conn_sha256_file(fpath, actual) != ESP_OK ||
            strcasecmp(actual, jsha->valuestring) != 0) {
            ESP_LOGE(TAG, "hash mismatch: %s", jpath->valuestring);
            err = ESP_ERR_INVALID_CRC;
            break;
        }
    }
out:
    cJSON_Delete(root);
    return err;
}

static esp_err_t activate(const char *package_id, const char *version)
{
    char dir[200];
    snprintf(dir, sizeof(dir), "%s/%s", STORAGE_PACKAGES_DIR, package_id);
    storage_mkdirs(dir);

    char cur[220];
    snprintf(cur, sizeof(cur), "%s/current.txt", dir);
    return storage_write_file_atomic(cur, version, strlen(version));
}

static void persist_active(const char *package_id, const char *version)
{
    storage_kv_set_str("sync", "active_pkg", package_id);
    storage_kv_set_str("sync", "active_ver", version);
}

/* ------------------------------------------------------------ worker */

static esp_err_t do_sync(const sync_request_t *req)
{
    ESP_RETURN_ON_FALSE(storage_sd_mounted(), ESP_ERR_INVALID_STATE, TAG, "no SD card");
    ESP_RETURN_ON_FALSE(path_is_safe(req->package_id) && path_is_safe(req->version),
                        ESP_ERR_INVALID_ARG, TAG, "bad ids");

    char final_dir[220];
    snprintf(final_dir, sizeof(final_dir), "%s/%s/%s",
             STORAGE_PACKAGES_DIR, req->package_id, req->version);

    struct stat st;
    if (stat(final_dir, &st) == 0) {
        ESP_LOGI(TAG, "version already on SD, activating only");
        ESP_RETURN_ON_ERROR(activate(req->package_id, req->version), TAG, "activate");
        persist_active(req->package_id, req->version);
        if (s_cb) {
            s_cb(req->package_id, req->version, final_dir);
        }
        return ESP_OK;
    }

    char zip_path[200];
    snprintf(zip_path, sizeof(zip_path), "%s/%.32s.zip", STORAGE_CACHE_DIR, req->bundle_sha256);

    /* 1) download (resumable) + outer hash check */
    ESP_RETURN_ON_ERROR(conn_http_download(req->bundle_url, zip_path,
                                           req->bundle_sha256, 30000), TAG, "download");

    /* 2) extract into staging */
    char staging[220];
    snprintf(staging, sizeof(staging), "%s/%s-%s", STORAGE_STAGING_DIR,
             req->package_id, req->version);
    storage_rm_rf(staging);
    ESP_RETURN_ON_ERROR(storage_mkdirs(staging), TAG, "mkstaging");

    esp_err_t err = ESP_OK;
    if (!storage_sd_lock(0)) {
        return ESP_ERR_TIMEOUT;
    }
    err = extract_zip(zip_path, staging);
    storage_sd_unlock();
    if (err != ESP_OK) {
        storage_rm_rf(staging);
        return err;
    }

    /* 3) verify every file against the manifest */
    err = verify_manifest(staging);
    if (err != ESP_OK) {
        storage_rm_rf(staging);
        return err;
    }

    /* 4) move into place; the only mutable step afterwards is current.txt */
    char parent[200];
    snprintf(parent, sizeof(parent), "%s/%s", STORAGE_PACKAGES_DIR, req->package_id);
    storage_mkdirs(parent);
    ESP_RETURN_ON_FALSE(rename(staging, final_dir) == 0, ESP_FAIL, TAG, "rename to final");

    ESP_RETURN_ON_ERROR(activate(req->package_id, req->version), TAG, "activate");
    persist_active(req->package_id, req->version);
    unlink(zip_path); /* cache no longer needed */

    ESP_LOGI(TAG, "package %s@%s activated", req->package_id, req->version);
    if (s_cb) {
        s_cb(req->package_id, req->version, final_dir);
    }
    return ESP_OK;
}

static void sync_task(void *arg)
{
    sync_request_t req;
    while (true) {
        if (xQueueReceive(s_queue, &req, portMAX_DELAY) == pdTRUE) {
            esp_err_t err = do_sync(&req);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "sync %s@%s failed: %s",
                         req.package_id, req.version, esp_err_to_name(err));
            }
        }
    }
}

/* ------------------------------------------------------------- public */

esp_err_t sync_manager_init(sync_activated_cb_t cb)
{
    s_cb = cb;
    s_queue = xQueueCreate(4, sizeof(sync_request_t));
    ESP_RETURN_ON_FALSE(s_queue, ESP_ERR_NO_MEM, TAG, "queue");
    BaseType_t ok = xTaskCreatePinnedToCore(sync_task, "sync_worker", SYNC_TASK_STACK,
                                            NULL, SYNC_TASK_PRIO, NULL, SYNC_TASK_CORE);
    return ok == pdPASS ? ESP_OK : ESP_FAIL;
}

esp_err_t sync_manager_request(const sync_request_t *req)
{
    return xQueueSend(s_queue, req, 0) == pdTRUE ? ESP_OK : ESP_ERR_NO_MEM;
}

void sync_manager_active_id(char *buf, size_t len)
{
    if (storage_kv_get_str("sync", "active_pkg", buf, len) != ESP_OK) {
        buf[0] = '\0';
    }
}

void sync_manager_active_version(char *buf, size_t len)
{
    if (storage_kv_get_str("sync", "active_ver", buf, len) != ESP_OK) {
        buf[0] = '\0';
    }
}

void sync_manager_active_dir(char *buf, size_t len)
{
    char pkg[64], ver[16];
    sync_manager_active_id(pkg, sizeof(pkg));
    sync_manager_active_version(ver, sizeof(ver));
    if (pkg[0] && ver[0] && storage_sd_mounted()) {
        snprintf(buf, len, "%s/%s/%s", STORAGE_PACKAGES_DIR, pkg, ver);
        struct stat st;
        if (stat(buf, &st) == 0) {
            return;
        }
    }
    buf[0] = '\0';
}

esp_err_t sync_manager_mark_last_good(void)
{
    char pkg[64], ver[16], json[128];
    sync_manager_active_id(pkg, sizeof(pkg));
    sync_manager_active_version(ver, sizeof(ver));
    if (!pkg[0]) {
        return ESP_ERR_INVALID_STATE;
    }
    snprintf(json, sizeof(json), "{\"pkg_id\":\"%s\",\"version\":\"%s\"}", pkg, ver);
    if (storage_sd_mounted()) {
        char path[200];
        snprintf(path, sizeof(path), "%s/last_good.json", STORAGE_STATE_DIR);
        return storage_write_file_atomic(path, json, strlen(json));
    }
    return ESP_OK;
}
