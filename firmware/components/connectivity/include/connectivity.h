/*
 * CryptoClock Pro — connectivity
 * MQTT client (commands, status, telemetry, data streams) + HTTP downloader
 * with Range-resume and SHA-256 verification.
 *
 * Topic scheme (see schema/mqtt-messages.schema.json). {id} is the encrypted
 * client_id (aesEncrypt(device_id)) so the plaintext device_id never appears on
 * the wire; Node-RED computes the same value from device_id to address a device.
 *   ccp/v1/{id}/cmd                S->D
 *   ccp/v1/{id}/cmd/res            D->S
 *   ccp/v1/{id}/status             D->S retained + LWT
 *   ccp/v1/{id}/telemetry          D->S
 *   ccp/v1/{id}/data/{stream}      S->D
 *   ccp/v1/{id}/evt/{name}         D->S
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*conn_cmd_cb_t)(const char *json, size_t len);
typedef void (*conn_data_cb_t)(const char *stream, const char *payload, size_t len);

typedef struct {
    const char *broker_uri;   /* e.g. mqtts://hub.cryptoclock.pro:8883 or mqtt://192.168.1.10:1883 */
    const char *device_id;    /* plaintext id: MQTT username + status payload */
    const char *client_id;    /* encrypted id (aesEncrypt(device_id)): MQTT clientId + topic node.
                                 If NULL, falls back to device_id. */
    const char *password;     /* device token minted at claim */
    conn_cmd_cb_t on_cmd;
    conn_data_cb_t on_data;
} conn_config_t;

esp_err_t connectivity_start(const conn_config_t *cfg);
bool connectivity_mqtt_connected(void);

esp_err_t conn_publish_status(const char *json);     /* retained */
esp_err_t conn_publish_telemetry(const char *json);
esp_err_t conn_publish_cmd_res(const char *json);
esp_err_t conn_publish_evt(const char *name, const char *json);

esp_err_t conn_subscribe_stream(const char *stream);
esp_err_t conn_unsubscribe_stream(const char *stream);

/**
 * Download url to dest_path (Range-resume if a partial file exists).
 * If sha256_hex != NULL the file is verified after download and deleted on
 * mismatch. Blocking; call from a worker task.
 */
esp_err_t conn_http_download(const char *url, const char *dest_path,
                             const char *sha256_hex, int timeout_ms);

/** SHA-256 of a file, hex into out (65 bytes). */
esp_err_t conn_sha256_file(const char *path, char *out_hex65);

#ifdef __cplusplus
}
#endif
