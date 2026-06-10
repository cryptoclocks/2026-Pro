#include "connectivity.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/unistd.h>

#include "freertos/FreeRTOS.h"
#include "mqtt_client.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "mbedtls/sha256.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "conn";

static esp_mqtt_client_handle_t s_mqtt;
static conn_config_t s_cfg;
static bool s_connected;
static char s_topic_prefix[64];   /* ccp/v1/{device_id} */
static char s_lwt_topic[80];

static void publish(const char *suffix, const char *payload, int qos, int retain)
{
    if (!s_mqtt) {
        return;
    }
    char topic[128];
    snprintf(topic, sizeof(topic), "%s/%s", s_topic_prefix, suffix);
    esp_mqtt_client_publish(s_mqtt, topic, payload, 0, qos, retain);
}

static void mqtt_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = event_data;

    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED: {
        s_connected = true;
        char topic[128];
        snprintf(topic, sizeof(topic), "%s/cmd", s_topic_prefix);
        esp_mqtt_client_subscribe(s_mqtt, topic, 1);
        ESP_LOGI(TAG, "MQTT connected, subscribed %s", topic);
        break;
    }
    case MQTT_EVENT_DISCONNECTED:
        s_connected = false;
        break;
    case MQTT_EVENT_DATA: {
        /* exact-topic dispatch: cmd or data/{stream} */
        char topic[160];
        size_t tlen = event->topic_len < sizeof(topic) - 1 ? event->topic_len : sizeof(topic) - 1;
        memcpy(topic, event->topic, tlen);
        topic[tlen] = '\0';

        const size_t plen = strlen(s_topic_prefix);
        if (strncmp(topic, s_topic_prefix, plen) != 0) {
            break;
        }
        const char *suffix = topic + plen + 1;
        if (strcmp(suffix, "cmd") == 0 && s_cfg.on_cmd) {
            s_cfg.on_cmd(event->data, event->data_len);
        } else if (strncmp(suffix, "data/", 5) == 0 && s_cfg.on_data) {
            s_cfg.on_data(suffix + 5, event->data, event->data_len);
        }
        break;
    }
    default:
        break;
    }
}

esp_err_t connectivity_start(const conn_config_t *cfg)
{
    s_cfg = *cfg;
    snprintf(s_topic_prefix, sizeof(s_topic_prefix), "ccp/v1/%s", cfg->device_id);
    snprintf(s_lwt_topic, sizeof(s_lwt_topic), "%s/status", s_topic_prefix);

    const esp_mqtt_client_config_t mqtt_cfg = {
        .broker.address.uri = cfg->broker_uri,
        .credentials = {
            .username = cfg->device_id,
            .client_id = cfg->device_id,
            .authentication.password = cfg->password,
        },
        .session = {
            .keepalive = 30,
            .last_will = {
                .topic = s_lwt_topic,
                .msg = "{\"online\":false}",
                .qos = 1,
                .retain = 1,
            },
        },
        .network.reconnect_timeout_ms = 5000,
        .broker.verification.crt_bundle_attach = esp_crt_bundle_attach,
    };

    s_mqtt = esp_mqtt_client_init(&mqtt_cfg);
    ESP_RETURN_ON_FALSE(s_mqtt, ESP_FAIL, TAG, "mqtt init");
    esp_mqtt_client_register_event(s_mqtt, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    return esp_mqtt_client_start(s_mqtt);
}

bool connectivity_mqtt_connected(void) { return s_connected; }

esp_err_t conn_publish_status(const char *json)    { publish("status", json, 1, 1); return ESP_OK; }
esp_err_t conn_publish_telemetry(const char *json) { publish("telemetry", json, 0, 0); return ESP_OK; }
esp_err_t conn_publish_cmd_res(const char *json)   { publish("cmd/res", json, 1, 0); return ESP_OK; }

esp_err_t conn_publish_evt(const char *name, const char *json)
{
    char suffix[96];
    snprintf(suffix, sizeof(suffix), "evt/%s", name);
    publish(suffix, json, 0, 0);
    return ESP_OK;
}

esp_err_t conn_subscribe_stream(const char *stream)
{
    if (!s_mqtt) {
        return ESP_ERR_INVALID_STATE;
    }
    char topic[160];
    snprintf(topic, sizeof(topic), "%s/data/%s", s_topic_prefix, stream);
    return esp_mqtt_client_subscribe(s_mqtt, topic, 0) >= 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t conn_unsubscribe_stream(const char *stream)
{
    if (!s_mqtt) {
        return ESP_ERR_INVALID_STATE;
    }
    char topic[160];
    snprintf(topic, sizeof(topic), "%s/data/%s", s_topic_prefix, stream);
    return esp_mqtt_client_unsubscribe(s_mqtt, topic) >= 0 ? ESP_OK : ESP_FAIL;
}

/* ----------------------------------------------------------- downloads */

esp_err_t conn_sha256_file(const char *path, char *out_hex65)
{
    FILE *f = fopen(path, "rb");
    ESP_RETURN_ON_FALSE(f, ESP_ERR_NOT_FOUND, TAG, "open %s", path);

    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts(&sha, 0);

    uint8_t *buf = malloc(8192);
    if (!buf) {
        fclose(f);
        return ESP_ERR_NO_MEM;
    }
    size_t rd;
    while ((rd = fread(buf, 1, 8192, f)) > 0) {
        mbedtls_sha256_update(&sha, buf, rd);
    }
    free(buf);
    fclose(f);

    uint8_t digest[32];
    mbedtls_sha256_finish(&sha, digest);
    mbedtls_sha256_free(&sha);
    for (int i = 0; i < 32; i++) {
        sprintf(out_hex65 + i * 2, "%02x", digest[i]);
    }
    out_hex65[64] = '\0';
    return ESP_OK;
}

esp_err_t conn_http_download(const char *url, const char *dest_path,
                             const char *sha256_hex, int timeout_ms)
{
    long existing = 0;
    struct stat st;
    if (stat(dest_path, &st) == 0) {
        existing = st.st_size;
    }

    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = timeout_ms > 0 ? timeout_ms : 15000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,
        .buffer_size_tx = 1024,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    ESP_RETURN_ON_FALSE(client, ESP_FAIL, TAG, "http init");

    char range[48];
    if (existing > 0) {
        snprintf(range, sizeof(range), "bytes=%ld-", existing);
        esp_http_client_set_header(client, "Range", range);
    }

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        return err;
    }
    esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);

    /* manual open() does not auto-follow redirects (picsum, S3 presign...) */
    for (int hop = 0; hop < 3 && (status == 301 || status == 302 ||
                                  status == 303 || status == 307 || status == 308); hop++) {
        esp_http_client_set_redirection(client);
        esp_http_client_close(client);
        err = esp_http_client_open(client, 0);
        if (err != ESP_OK) {
            esp_http_client_cleanup(client);
            return err;
        }
        esp_http_client_fetch_headers(client);
        status = esp_http_client_get_status_code(client);
    }

    const char *mode = "wb";
    if (status == 206) {
        mode = "ab";                       /* server honored resume */
    } else if (status == 200) {
        existing = 0;                      /* full restart */
    } else {
        ESP_LOGE(TAG, "download %s -> HTTP %d", url, status);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }

    FILE *f = fopen(dest_path, mode);
    if (!f) {
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }

    char *buf = malloc(8192);
    if (!buf) {
        fclose(f);
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }

    int total = (int)existing;
    while (true) {
        int rd = esp_http_client_read(client, buf, 8192);
        if (rd < 0) {
            err = ESP_FAIL;
            break;
        }
        if (rd == 0) {
            err = ESP_OK;
            break;
        }
        if (fwrite(buf, 1, rd, f) != (size_t)rd) {
            err = ESP_FAIL; /* SD full / IO error */
            break;
        }
        total += rd;
    }
    free(buf);
    fclose(f);
    esp_http_client_cleanup(client);
    ESP_RETURN_ON_ERROR(err, TAG, "download body");
    ESP_LOGI(TAG, "downloaded %d bytes -> %s", total, dest_path);

    if (sha256_hex && sha256_hex[0]) {
        char actual[65];
        ESP_RETURN_ON_ERROR(conn_sha256_file(dest_path, actual), TAG, "hash");
        if (strcasecmp(actual, sha256_hex) != 0) {
            ESP_LOGE(TAG, "sha256 mismatch for %s", dest_path);
            unlink(dest_path);
            return ESP_ERR_INVALID_CRC;
        }
    }
    return ESP_OK;
}
