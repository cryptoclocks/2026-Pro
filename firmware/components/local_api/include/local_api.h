/*
 * CryptoClock Pro — local_api
 * LAN HTTP API + mDNS discovery for the mobile apps (admin/user).
 * Started once the device has a STA IP. Unauthenticated on the local
 * network in v1 (token auth lands with M5 hardening).
 *
 *   GET  /api/v1/info        -> {device_id, fw, ip, rssi, pages, brightness, locked}
 *   GET  /api/v1/config      -> contents of device.json
 *   POST /api/v1/config      -> save device.json (SD if present, else LittleFS) + live reload
 *   POST /api/v1/brightness  -> {"value": 0-100}
 *   POST /api/v1/identify    -> beep + flash brightness
 *   POST /api/v1/wifi/reset  -> erase WiFi creds + reboot to portal
 *
 * mDNS: hostname = device id, service _ccp._tcp port 80 (txt: fw, model)
 */
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t local_api_start(void);
void local_api_stop(void);

#ifdef __cplusplus
}
#endif
