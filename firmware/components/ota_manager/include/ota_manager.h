/*
 * CryptoClock Pro — ota_manager
 * esp_https_ota wrapper with rollback safety: the bootloader keeps the old
 * image until ota_manager_mark_healthy() confirms the new one.
 */
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Download + flash + reboot. sha256_hex optional (server-published). */
esp_err_t ota_manager_update(const char *fw_url, const char *fw_sha256_hex);

/** Call once after display+storage+network health checks pass post-boot. */
esp_err_t ota_manager_mark_healthy(void);

const char *ota_manager_running_version(void);

#ifdef __cplusplus
}
#endif
