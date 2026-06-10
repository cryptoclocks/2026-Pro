/*
 * CryptoClock Pro — storage
 * Internal LittleFS (/lfs): config, recovery UI, last-good state. Survives without SD.
 * SD card (/sd, SDMMC 1-bit): packages, assets, audio, cache.
 * NVS-backed KV for small settings (and per-package WASM KV namespaces).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define STORAGE_LFS_BASE  "/lfs"
#define STORAGE_SD_BASE   "/sd"

#define STORAGE_PACKAGES_DIR  STORAGE_SD_BASE "/packages"
#define STORAGE_STAGING_DIR   STORAGE_SD_BASE "/staging"
#define STORAGE_CACHE_DIR     STORAGE_SD_BASE "/cache"
#define STORAGE_STATE_DIR     STORAGE_SD_BASE "/state"
#define STORAGE_RECOVERY_DIR  STORAGE_LFS_BASE "/recovery"

/** Mount LittleFS (format on first boot) and try to mount SD. */
esp_err_t storage_init(void);

bool storage_sd_mounted(void);
/** Free space on SD in KB, -1 if unmounted. */
int64_t storage_sd_free_kb(void);

/**
 * Serialize all SD access between audio streaming, sync downloads and asset
 * loads (single SDMMC bus). Recursive.
 */
bool storage_sd_lock(uint32_t timeout_ms);
void storage_sd_unlock(void);

/* ---- small KV on NVS ---- */
esp_err_t storage_kv_set_str(const char *ns, const char *key, const char *val);
esp_err_t storage_kv_get_str(const char *ns, const char *key, char *buf, size_t buf_len);
esp_err_t storage_kv_set_blob(const char *ns, const char *key, const void *val, size_t len);
int       storage_kv_get_blob(const char *ns, const char *key, void *buf, size_t buf_len);
esp_err_t storage_kv_erase_ns(const char *ns);

/* ---- helpers ---- */
esp_err_t storage_mkdirs(const char *path);          /* mkdir -p */
esp_err_t storage_rm_rf(const char *path);           /* recursive delete */
esp_err_t storage_write_file_atomic(const char *path, const void *data, size_t len);
/** Read whole file; caller frees. Returns NULL on error, sets *out_len. */
char *storage_read_file(const char *path, size_t *out_len);

#ifdef __cplusplus
}
#endif
