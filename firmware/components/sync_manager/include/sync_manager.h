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

/** Handler for a lazy page-package swap, run on the sync worker (off the LVGL
 *  task). dir="" means "unload, show no package". */
typedef void (*sync_nav_cb_t)(const char *dir, const char *slug);

esp_err_t sync_manager_init(sync_activated_cb_t cb);

/** Register the page-swap handler invoked for sync_manager_request_nav(). */
void sync_manager_set_nav_handler(sync_nav_cb_t cb);

/** Queue a lazy page-package swap onto the sync worker (reuses its stack so no
 *  extra internal DRAM is spent). The handler runs off the LVGL task. */
esp_err_t sync_manager_request_nav(const char *dir, const char *slug);

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

/**
 * Resolve a page slug to the dir of its installed package, regardless of which
 * package is the "active" one. Scans /sd/packages for an id ending in
 * ".<slug>" (e.g. slug "weather" -> "com.ccp.weather"), reads its current.txt
 * and returns "/sd/packages/<id>/<version>" if layout.json exists there.
 * Returns true and fills buf on success; false (buf="") otherwise.
 * Used by home_ui to keep every installed page in the swipe rotation.
 */
bool sync_manager_installed_dir_for_slug(const char *slug, char *buf, size_t len);

/** Mark the currently active package healthy (called after 60s uptime). */
esp_err_t sync_manager_mark_last_good(void);

#ifdef __cplusplus
}
#endif
