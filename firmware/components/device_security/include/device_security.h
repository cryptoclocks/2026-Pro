/*
 * CryptoClock Pro — device_security
 * Device identity (factory MAC), claim/device-token storage, remote
 * lock / wipe handling.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t device_security_init(void);

/** Stable device id, e.g. "ccp-a1b2c3d4e5f6". */
const char *device_security_id(void);

/** Device token (MQTT password / API bearer). Empty until claimed. */
esp_err_t device_security_get_token(char *buf, size_t len);
esp_err_t device_security_set_token(const char *token);
bool device_security_claimed(void);

/** Six-char claim code derived from the MAC, shown as QR during claim. */
void device_security_claim_code(char *buf, size_t len);

/** Remote lock: persists across reboot. UI must show the lock screen. */
esp_err_t device_security_set_locked(bool locked);
bool device_security_locked(void);

/** Factory wipe: erase NVS + LittleFS, then reboot. Destructive. */
esp_err_t device_security_wipe(void);

#ifdef __cplusplus
}
#endif
