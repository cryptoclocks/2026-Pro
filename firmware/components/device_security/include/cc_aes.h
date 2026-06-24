/*
 * CryptoClock Pro — cc_aes
 * AES-128-CBC (key = iv = "ClocktoCrypt1234"), AESLib-compatible padding,
 * lowercase-hex output. Used to derive the encrypted MQTT clientId / topic id
 * the same way the legacy firmware does: encId = aesEncrypt(device_id).
 */
#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Encrypt `plain` (null-terminated) and write lowercase hex into `out`.
 * `out` must hold at least ((strlen(plain)/16 + 1) * 16 * 2 + 1) bytes.
 * Returns the hex length (excluding NUL), or -1 on error.
 */
int cc_aes_encrypt_hex(const char *plain, char *out, size_t out_len);

#ifdef __cplusplus
}
#endif
