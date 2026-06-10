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

/** True while a built-in screen owns the display (vs. a ui_renderer package). */
bool home_ui_owns_screen(void);

/** Note connectivity changes (enables crypto polling, shows IP in menu). */
void home_ui_network_changed(bool connected, const char *ip);

/** Re-read config files and rebuild pages (called by LAN API / server). */
esp_err_t home_ui_reload(void);

/** True when the slideshow page is enabled but has zero images. */
bool home_ui_slideshow_needs_content(void);

/** Directory slideshow images are read from (SD when mounted, else LFS). */
const char *home_ui_slideshow_dir(void);

#ifdef __cplusplus
}
#endif
