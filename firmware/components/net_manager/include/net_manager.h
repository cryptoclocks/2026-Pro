/*
 * CryptoClock Pro — net_manager
 * WiFi STA with NVS-stored credentials. If none stored (or repeated connect
 * failure), starts a captive portal: softAP "CCP-Setup-XXXX" + catch-all DNS
 * + provisioning page at http://192.168.4.1.
 */
#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    NET_STATE_IDLE = 0,
    NET_STATE_PROVISIONING,   /* captive portal active */
    NET_STATE_CONNECTING,
    NET_STATE_CONNECTED,      /* got IP; SNTP started */
    NET_STATE_DISCONNECTED,
} net_state_t;

typedef void (*net_event_cb_t)(net_state_t state);

esp_err_t net_manager_start(net_event_cb_t cb);

net_state_t net_manager_state(void);
int net_manager_rssi(void);
/** Dotted-quad IP into buf (len >= 16); empty string when not connected. */
void net_manager_ip(char *buf, size_t len);
/** The softAP SSID shown to the user during provisioning. */
const char *net_manager_ap_ssid(void);

/** Erase stored credentials and reboot into provisioning. */
esp_err_t net_manager_forget(void);

#ifdef __cplusplus
}
#endif
