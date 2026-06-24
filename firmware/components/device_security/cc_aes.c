#include "cc_aes.h"

#include <stdint.h>
#include <string.h>

#include "mbedtls/aes.h"

#define CC_AES_KEY "ClocktoCrypt1234"
#define CC_AES_IV  "ClocktoCrypt1234"
#define CC_AES_BLOCK 16

/*
 * AESLib `set_paddingmode((paddingMode)1)` compatibility.
 * Confirm which scheme it really is with firmware/tools/cc_aes_ref.mjs against a
 * real legacy `encodedClientId`, then leave CC_AES_PAD on the matching value.
 * Until verified this defaults to PKCS#7 — DO NOT flash to a fleet before the
 * verifier confirms the match, or Node-RED will decode a different clientId.
 */
#define CC_AES_PAD_PKCS7 1   /* each pad byte = pad length          */
#define CC_AES_PAD_BIT   2   /* ISO/IEC 7816-4: 0x80 then 0x00...   */
#define CC_AES_PAD_ZERO  3   /* 0x00...                             */
#ifndef CC_AES_PAD
#define CC_AES_PAD CC_AES_PAD_PKCS7
#endif

/* Pad `len` bytes (already copied into `buf`) up to a block multiple in place.
 * Returns the padded total. When `len` is already aligned a full block is added
 * (AESLib behaviour). `buf` must have room for len + 16. */
static size_t cc_aes_pad(uint8_t *buf, size_t len)
{
    size_t pad_len = CC_AES_BLOCK - (len % CC_AES_BLOCK); /* 1..16 */
#if CC_AES_PAD == CC_AES_PAD_PKCS7
    memset(buf + len, (int)pad_len, pad_len);
#elif CC_AES_PAD == CC_AES_PAD_BIT
    buf[len] = 0x80;
    memset(buf + len + 1, 0x00, pad_len - 1);
#else /* CC_AES_PAD_ZERO */
    memset(buf + len, 0x00, pad_len);
#endif
    return len + pad_len;
}

int cc_aes_encrypt_hex(const char *plain, char *out, size_t out_len)
{
    if (!plain || !out) {
        return -1;
    }
    size_t len = strlen(plain);
    if (len == 0 || len > 224) {
        return -1; /* keep stack buffers bounded */
    }

    uint8_t padded[256];
    memcpy(padded, plain, len);
    size_t total = cc_aes_pad(padded, len);
    if (out_len < total * 2 + 1) {
        return -1;
    }

    uint8_t key[16], iv[16], cipher[256];
    memcpy(key, CC_AES_KEY, 16);
    memcpy(iv, CC_AES_IV, 16); /* mbedtls mutates the IV — use a copy */

    mbedtls_aes_context ctx;
    mbedtls_aes_init(&ctx);
    int rc = mbedtls_aes_setkey_enc(&ctx, key, 128);
    if (rc == 0) {
        rc = mbedtls_aes_crypt_cbc(&ctx, MBEDTLS_AES_ENCRYPT, total, iv, padded, cipher);
    }
    mbedtls_aes_free(&ctx);
    if (rc != 0) {
        return -1;
    }

    static const char hexd[] = "0123456789abcdef";
    for (size_t i = 0; i < total; i++) {
        out[i * 2] = hexd[cipher[i] >> 4];
        out[i * 2 + 1] = hexd[cipher[i] & 0x0f];
    }
    out[total * 2] = '\0';
    return (int)(total * 2);
}
