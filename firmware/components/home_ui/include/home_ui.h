/*
 * CryptoClock Pro — home_ui
 * Built-in screen suite: Welcome, WiFi Setup, and the default swipeable
 * pages (Clock+Profile, Crypto price, SD-card Slideshow) with a hamburger
 * menu. Active when no server package is installed.
 *
 * Config precedence: /sd/config/device.json -> /lfs/config/device.json
 * -> user_config.h defaults. Per-page overrides: /sd/pages/<id>/config.json
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Load config + prepare internal state (display must be up). */
esp_err_t home_ui_init(void);

void home_ui_show_welcome(const char *status_line);
void home_ui_show_wifi_setup(const char *ap_ssid);

/** Build (if needed) and show the first enabled page. */
void home_ui_show_home(void);

/** Park the display on a blank screen (call before ui_renderer reloads a
 *  package whose screens may be live); home_ui_reload() cleans it up. */
void home_ui_park(void);

/** True while a built-in screen owns the display (vs. a ui_renderer package). */
bool home_ui_owns_screen(void);

/* serial debug console helpers */
int  home_ui_debug_pages(char *buf, size_t len); /* writes a listing, returns page count */
bool home_ui_goto_id(const char *id);            /* switch to a built-in page by id */

/** Note connectivity changes (enables crypto polling, shows IP in menu). */
void home_ui_network_changed(bool connected, const char *ip);

/** Re-read config files and rebuild pages (called by LAN API / server). */
esp_err_t home_ui_reload(void);

/**
 * Register the callback home_ui uses to (de)activate a package page lazily on
 * swipe. `fn(dir, slug)` must load <dir> into the renderer off the LVGL task
 * (dir="" means "unload, no package") and, when done, call
 * home_ui_package_loaded(slug, ok). Returns false if the request can't be
 * queued. Set by app_main, which owns ui_renderer + wasm_engine.
 */
void home_ui_set_package_activator(bool (*fn)(const char *dir, const char *slug));

/** Called by the activator worker when a package (un)load finishes; adopts the
 *  fresh renderer screen for the pending page and completes the swipe. */
void home_ui_package_loaded(const char *slug, bool ok);

/** True when the slideshow page is enabled but has zero images. */
bool home_ui_slideshow_needs_content(void);

/** Directory slideshow images are read from (SD when mounted, else LFS). */
const char *home_ui_slideshow_dir(void);

#ifdef __cplusplus
}
#endif
