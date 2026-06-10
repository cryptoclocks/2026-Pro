#include "net_manager.h"
#include "storage.h"

#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_netif_sntp.h"
#include "esp_http_server.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "net";

#define KV_NS          "net"
#define MAX_RETRY_BEFORE_PORTAL 6
#define AP_IP          "192.168.4.1"

static net_event_cb_t s_cb;
static net_state_t s_state = NET_STATE_IDLE;
static int s_retry;
static char s_ap_ssid[20];
static httpd_handle_t s_httpd;
static TaskHandle_t s_dns_task;
static esp_netif_t *s_sta_netif, *s_ap_netif;

static void set_state(net_state_t st)
{
    if (s_state != st) {
        s_state = st;
        if (s_cb) {
            s_cb(st);
        }
    }
}

/* ----------------------------------------------------- catch-all DNS */

/* Minimal DNS responder: answer every A query with the AP address so phones
 * open the captive portal sheet. */
static void dns_task(void *arg)
{
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(53),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    bind(sock, (struct sockaddr *)&addr, sizeof(addr));

    uint8_t buf[256];
    while (true) {
        struct sockaddr_in src;
        socklen_t slen = sizeof(src);
        int len = recvfrom(sock, buf, sizeof(buf) - 16, 0, (struct sockaddr *)&src, &slen);
        if (len < 12) {
            continue;
        }
        buf[2] = 0x81; buf[3] = 0x80;       /* response, recursion available */
        buf[6] = buf[4]; buf[7] = buf[5];   /* ANCOUNT = QDCOUNT */
        buf[8] = buf[9] = buf[10] = buf[11] = 0;
        int p = len;
        buf[p++] = 0xC0; buf[p++] = 0x0C;   /* name: pointer to query */
        buf[p++] = 0x00; buf[p++] = 0x01;   /* type A */
        buf[p++] = 0x00; buf[p++] = 0x01;   /* class IN */
        buf[p++] = 0; buf[p++] = 0; buf[p++] = 0; buf[p++] = 30; /* TTL 30s */
        buf[p++] = 0x00; buf[p++] = 0x04;   /* RDLENGTH */
        buf[p++] = 192; buf[p++] = 168; buf[p++] = 4; buf[p++] = 1;
        sendto(sock, buf, p, 0, (struct sockaddr *)&src, slen);
    }
}

/* ----------------------------------------------------- portal HTTP */

static const char PORTAL_HTML[] =
    "<!DOCTYPE html><html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>CryptoClock Pro Setup</title><style>"
    "body{font-family:-apple-system,sans-serif;background:#0B0E11;color:#EAECEF;margin:0;padding:24px}"
    "h1{color:#F0B90B;font-size:22px}input,button{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;"
    "border-radius:8px;border:1px solid #2B3139;background:#181C22;color:#EAECEF;font-size:16px}"
    "button{background:#F0B90B;color:#0B0E11;font-weight:700;border:none}</style></head><body>"
    "<h1>CryptoClock Pro</h1><p>Connect this display to your WiFi.</p>"
    "<form method='POST' action='/save'>"
    "<input name='ssid' placeholder='WiFi name (SSID)' required>"
    "<input name='pass' type='password' placeholder='Password'>"
    "<button type='submit'>Save &amp; Connect</button></form></body></html>";

static esp_err_t portal_get(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, PORTAL_HTML, HTTPD_RESP_USE_STRLEN);
}

/* iOS/Android connectivity probes: reply with the portal (not 204/Success)
 * so the OS pops the sign-in sheet. */
static esp_err_t portal_redirect(httpd_req_t *req)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://" AP_IP "/");
    return httpd_resp_send(req, NULL, 0);
}

static int url_decode(char *dst, size_t dlen, const char *src)
{
    size_t di = 0;
    for (size_t i = 0; src[i] && di + 1 < dlen; i++) {
        if (src[i] == '+') {
            dst[di++] = ' ';
        } else if (src[i] == '%' && src[i + 1] && src[i + 2]) {
            char hex[3] = { src[i + 1], src[i + 2], 0 };
            dst[di++] = (char)strtol(hex, NULL, 16);
            i += 2;
        } else {
            dst[di++] = src[i];
        }
    }
    dst[di] = '\0';
    return (int)di;
}

static esp_err_t portal_save(httpd_req_t *req)
{
    char body[256] = {0};
    int len = httpd_req_recv(req, body, sizeof(body) - 1);
    if (len <= 0) {
        return httpd_resp_send_500(req);
    }
    char raw_ssid[96] = {0}, raw_pass[96] = {0}, ssid[64] = {0}, pass[64] = {0};
    httpd_query_key_value(body, "ssid", raw_ssid, sizeof(raw_ssid));
    httpd_query_key_value(body, "pass", raw_pass, sizeof(raw_pass));
    url_decode(ssid, sizeof(ssid), raw_ssid);
    url_decode(pass, sizeof(pass), raw_pass);
    if (ssid[0] == '\0') {
        return httpd_resp_send_500(req);
    }

    storage_kv_set_str(KV_NS, "ssid", ssid);
    storage_kv_set_str(KV_NS, "pass", pass);
    ESP_LOGI(TAG, "credentials saved for \"%s\" — rebooting", ssid);

    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req,
        "<html><body style='font-family:sans-serif;background:#0B0E11;color:#EAECEF;padding:24px'>"
        "<h2>Saved.</h2><p>The display now reboots and joins your WiFi.</p></body></html>",
        HTTPD_RESP_USE_STRLEN);
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
    return ESP_OK;
}

static void start_portal_httpd(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.max_uri_handlers = 8;
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    if (httpd_start(&s_httpd, &cfg) != ESP_OK) {
        return;
    }
    const httpd_uri_t root = { .uri = "/", .method = HTTP_GET, .handler = portal_get };
    const httpd_uri_t save = { .uri = "/save", .method = HTTP_POST, .handler = portal_save };
    const httpd_uri_t any = { .uri = "/*", .method = HTTP_GET, .handler = portal_redirect };
    httpd_register_uri_handler(s_httpd, &root);
    httpd_register_uri_handler(s_httpd, &save);
    httpd_register_uri_handler(s_httpd, &any);
}

static void start_provisioning(void)
{
    ESP_LOGI(TAG, "starting captive portal");
    esp_wifi_stop();

    wifi_config_t ap_cfg = { 0 };
    strlcpy((char *)ap_cfg.ap.ssid, s_ap_ssid, sizeof(ap_cfg.ap.ssid));
    ap_cfg.ap.ssid_len = strlen(s_ap_ssid);
    ap_cfg.ap.authmode = WIFI_AUTH_OPEN;
    ap_cfg.ap.max_connection = 4;

    esp_wifi_set_mode(WIFI_MODE_AP);
    esp_wifi_set_config(WIFI_IF_AP, &ap_cfg);
    esp_wifi_start();

    if (!s_dns_task) {
        xTaskCreatePinnedToCore(dns_task, "dns_hijack", 3072, NULL, 4, &s_dns_task, 0);
    }
    start_portal_httpd();
    set_state(NET_STATE_PROVISIONING);
}

/* ----------------------------------------------------- STA flow */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
        set_state(NET_STATE_CONNECTING);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        if (s_state == NET_STATE_PROVISIONING) {
            return;
        }
        s_retry++;
        if (s_retry >= MAX_RETRY_BEFORE_PORTAL && s_state != NET_STATE_CONNECTED) {
            /* never connected with these creds — assume bad config */
            start_provisioning();
            return;
        }
        set_state(NET_STATE_DISCONNECTED);
        vTaskDelay(pdMS_TO_TICKS(1000 * (s_retry > 10 ? 10 : s_retry)));
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        s_retry = 0;
        esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
        sntp_cfg.start = true;
        esp_netif_sntp_init(&sntp_cfg);
        set_state(NET_STATE_CONNECTED);
    }
}

esp_err_t net_manager_start(net_event_cb_t cb)
{
    s_cb = cb;

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_ap_ssid, sizeof(s_ap_ssid), "CCP-Setup-%02X%02X", mac[4], mac[5]);

    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "event loop");
    s_sta_netif = esp_netif_create_default_wifi_sta();
    s_ap_netif = esp_netif_create_default_wifi_ap();

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init_cfg), TAG, "wifi init");
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL);

    char ssid[64] = {0}, pass[64] = {0};
    if (storage_kv_get_str(KV_NS, "ssid", ssid, sizeof(ssid)) != ESP_OK || ssid[0] == '\0') {
        start_provisioning();
        return ESP_OK;
    }
    storage_kv_get_str(KV_NS, "pass", pass, sizeof(pass));

    wifi_config_t sta_cfg = { 0 };
    strlcpy((char *)sta_cfg.sta.ssid, ssid, sizeof(sta_cfg.sta.ssid));
    strlcpy((char *)sta_cfg.sta.password, pass, sizeof(sta_cfg.sta.password));
    sta_cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &sta_cfg), TAG, "config");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "start");
    ESP_LOGI(TAG, "connecting to \"%s\"", ssid);
    return ESP_OK;
}

net_state_t net_manager_state(void) { return s_state; }

int net_manager_rssi(void)
{
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        return ap.rssi;
    }
    return 0;
}

void net_manager_ip(char *buf, size_t len)
{
    buf[0] = '\0';
    if (s_state != NET_STATE_CONNECTED || !s_sta_netif) {
        return;
    }
    esp_netif_ip_info_t info;
    if (esp_netif_get_ip_info(s_sta_netif, &info) == ESP_OK) {
        snprintf(buf, len, IPSTR, IP2STR(&info.ip));
    }
}

const char *net_manager_ap_ssid(void) { return s_ap_ssid; }

esp_err_t net_manager_forget(void)
{
    storage_kv_erase_ns(KV_NS);
    esp_restart();
    return ESP_OK;
}
