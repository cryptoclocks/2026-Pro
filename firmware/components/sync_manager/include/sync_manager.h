/*
 * CryptoClock Pro — sync_manager
 * Package lifecycle: download zip -> outer sha256 -> stream-extract to
 * staging -> per-file sha256 vs manifest -> atomic activate -> last-good.
 *
 * SD layout:
 *   /sd/packages/<pkg_id>/<version>/...    immutable extracted package
 *   /sd/packages/<pkg_id>/current.txt      active version (atomic rename)
 *   /sd/staging/<pkg_id>-<version>/        in-progress extraction (wiped on boot)
 *   /sd/cache/<sha256>.zip                 resumable downloads
 *   /sd/state/last_good.json               {"pkg_id","version"}
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char package_id[64];
    char version[16];
    char bundle_url[256];
    char bundle_sha256[65];
} sync_request_t;

/** Callback fired after a package is activated (hot reload the UI). */
typedef void (*sync_activated_cb_t)(const char *package_id, const char *version,
                                    const char *package_dir);

esp_err_t sync_manager_init(sync_activated_cb_t cb);

/**
 * Queue a sync. Runs on the sync worker task (core 0, low prio).
 * Progress/result is reported through the activated callback and cmd/res
 * by the caller.
 */
esp_err_t sync_manager_request(const sync_request_t *req);

/** Resolve the active package dir into buf ("" if none). */
void sync_manager_active_dir(char *buf, size_t len);
void sync_manager_active_id(char *buf, size_t len);
void sync_manager_active_version(char *buf, size_t len);

/** Mark the currently active package healthy (called after 60s uptime). */
esp_err_t sync_manager_mark_last_good(void);

#ifdef __cplusplus
}
#endif
