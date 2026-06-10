#include "home_ui.h"
#include "display_engine.h"
#include "storage.h"
#include "ccp_board.h"
#include "net_manager.h"
#include "device_security.h"
#include "ota_manager.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"
#include "esp_check.h"
#include "esp_log.h"
#include "lvgl.h"

#include "user_config.h"

static const char *TAG = "home_ui";

/* ---------------------------------------------------------------- theme */
#define COL_BG       0x0B0E11
#define COL_PANEL    0x161B22
#define COL_BORDER   0x2B3139
#define COL_FG       0xEAECEF
#define COL_MUTED    0x848E9C
#define COL_ACCENT   0xF0B90B
#define COL_GREEN    0x0ECB81
#define COL_RED      0xF6465D

#define MAX_PAGES        6
#define MAX_SLIDES       8
#define SPARK_POINTS     60

typedef enum { PAGE_CLOCK, PAGE_CRYPTO, PAGE_SLIDESHOW } page_kind_t;

typedef struct {
    page_kind_t kind;
    char id[16];
    lv_obj_t *screen;
} page_t;

#define MAX_SYMBOLS 4

typedef enum { THEME_GOLD, THEME_MINT, THEME_NEON } clock_theme_t;
typedef enum { CRYPTO_STYLE_CHART, CRYPTO_STYLE_BIG } crypto_style_t;
typedef enum { SLIDE_FX_FADE, SLIDE_FX_SLIDE, SLIDE_FX_NONE } slide_fx_t;

typedef struct {
    char pages[MAX_PAGES][16];
    int page_count;
    bool dynamic_mode;          /* false = swipe only, true = auto-advance */
    int page_delay_s;
    int tz_offset_min;
    int brightness;
    char profile_name[32];
    char profile_title[32];
    clock_theme_t clock_theme;
    char symbols[MAX_SYMBOLS][16];
    int symbol_count;
    crypto_style_t crypto_style;
    bool currency_thb;
    int fetch_interval_s;
    int slide_interval_s;
    slide_fx_t slide_fx;
    char slide_order[MAX_SLIDES][32];
    int slide_order_count;
    bool slide_return_first;
} home_cfg_t;

/* clock theme palettes: time / seconds / date */
static const struct { uint32_t time, accent, date; } THEMES[] = {
    [THEME_GOLD] = { 0xEAECEF, 0xF0B90B, 0x848E9C },
    [THEME_MINT] = { 0xE8FFF6, 0x0ECB81, 0x6BA292 },
    [THEME_NEON] = { 0xE0F7FF, 0x00D1FF, 0x7A6FF0 },
};

static struct {
    home_cfg_t cfg;
    page_t pages[MAX_PAGES];
    int page_count;
    int current;
    bool owns_screen;
    bool net_connected;
    char ip[16];

    /* clock */
    lv_obj_t *lbl_time, *lbl_sec, *lbl_date;
    lv_timer_t *clock_timer;

    /* crypto */
    lv_obj_t *lbl_price, *lbl_change, *lbl_updated, *crypto_dot;
    lv_obj_t *lbl_pair, *btn_symbol_lbl, *btn_cur_lbl, *coin_logo;
    lv_obj_t *spark;
    lv_chart_series_t *spark_ser;
    int32_t spark_min, spark_max; /* running range of pushed points */
    int spark_points;
    TaskHandle_t poll_task;
    volatile bool poll_run;
    volatile int cur_symbol;
    volatile bool force_fetch;
    double last_usd_price;
    double last_chg_pct;
    double usd_thb_rate;        /* 0 = not fetched yet */
    int64_t rate_fetched_ms;
    int64_t last_quote_ms;

    /* dynamic page mode */
    lv_timer_t *advance_timer;

    /* slideshow */
    char slides[MAX_SLIDES][96];
    int slide_count;
    int slide_idx;
    lv_obj_t *slide_img, *slide_hint;
    lv_timer_t *slide_timer;

    /* menu */
    lv_obj_t *menu;
} s;

/* ================================================================ config */

static void cfg_defaults(home_cfg_t *c)
{
    memset(c, 0, sizeof(*c));
    strcpy(c->pages[0], "clock");
    strcpy(c->pages[1], "crypto");
    strcpy(c->pages[2], "slideshow");
    c->page_count = 3;
    c->dynamic_mode = false;
    c->page_delay_s = 10;
    c->tz_offset_min = CCP_CFG_TZ_OFFSET_MIN;
    c->brightness = CCP_CFG_DEFAULT_BRIGHTNESS;
    strlcpy(c->profile_name, CCP_CFG_PROFILE_NAME, sizeof(c->profile_name));
    strlcpy(c->profile_title, CCP_CFG_PROFILE_TITLE, sizeof(c->profile_title));
    c->clock_theme = THEME_GOLD;
    strlcpy(c->symbols[0], CCP_CFG_CRYPTO_SYMBOL, 16);
    strlcpy(c->symbols[1], "ETHUSDT", 16);
    strlcpy(c->symbols[2], "BNBUSDT", 16);
    strlcpy(c->symbols[3], "DOGEUSDT", 16);
    c->symbol_count = 4;
    c->crypto_style = CRYPTO_STYLE_CHART;
    c->currency_thb = false;
    c->fetch_interval_s = CCP_CFG_CRYPTO_POLL_S;
    c->slide_interval_s = CCP_CFG_SLIDE_INTERVAL_S;
    c->slide_fx = SLIDE_FX_FADE;
    c->slide_return_first = CCP_CFG_SLIDE_RETURN_FIRST;
}

static void cfg_apply_json(home_cfg_t *c, const cJSON *root)
{
    const cJSON *pages = cJSON_GetObjectItem(root, "pages");
    if (cJSON_IsArray(pages) && cJSON_GetArraySize(pages) > 0) {
        c->page_count = 0;
        const cJSON *p;
        cJSON_ArrayForEach(p, pages) {
            if (cJSON_IsString(p) && c->page_count < MAX_PAGES) {
                strlcpy(c->pages[c->page_count++], p->valuestring, 16);
            }
        }
    }
    const cJSON *it;
    if ((it = cJSON_GetObjectItem(root, "tz_offset_min")) && cJSON_IsNumber(it)) {
        c->tz_offset_min = it->valueint;
    }
    if ((it = cJSON_GetObjectItem(root, "brightness")) && cJSON_IsNumber(it)) {
        c->brightness = it->valueint;
    }
    const cJSON *profile = cJSON_GetObjectItem(root, "profile");
    if (profile) {
        const cJSON *n = cJSON_GetObjectItem(profile, "name");
        const cJSON *t = cJSON_GetObjectItem(profile, "title");
        if (cJSON_IsString(n)) strlcpy(c->profile_name, n->valuestring, sizeof(c->profile_name));
        if (cJSON_IsString(t)) strlcpy(c->profile_title, t->valuestring, sizeof(c->profile_title));
    }
    const cJSON *mode = cJSON_GetObjectItem(root, "display_mode");
    if (cJSON_IsString(mode)) {
        c->dynamic_mode = (strcmp(mode->valuestring, "dynamic") == 0);
    }
    if ((it = cJSON_GetObjectItem(root, "page_delay_s")) && cJSON_IsNumber(it) && it->valueint >= 3) {
        c->page_delay_s = it->valueint;
    }
    const cJSON *clock = cJSON_GetObjectItem(root, "clock");
    if (clock) {
        const cJSON *th = cJSON_GetObjectItem(clock, "theme");
        if (cJSON_IsString(th)) {
            if (!strcmp(th->valuestring, "mint")) c->clock_theme = THEME_MINT;
            else if (!strcmp(th->valuestring, "neon")) c->clock_theme = THEME_NEON;
            else c->clock_theme = THEME_GOLD;
        }
    }
    const cJSON *crypto = cJSON_GetObjectItem(root, "crypto");
    if (crypto) {
        const cJSON *syms = cJSON_GetObjectItem(crypto, "symbols");
        if (cJSON_IsArray(syms) && cJSON_GetArraySize(syms) > 0) {
            c->symbol_count = 0;
            const cJSON *sj;
            cJSON_ArrayForEach(sj, syms) {
                if (cJSON_IsString(sj) && c->symbol_count < MAX_SYMBOLS) {
                    strlcpy(c->symbols[c->symbol_count++], sj->valuestring, 16);
                }
            }
        }
        const cJSON *sym = cJSON_GetObjectItem(crypto, "symbol"); /* legacy single */
        if (cJSON_IsString(sym)) {
            strlcpy(c->symbols[0], sym->valuestring, 16);
            if (c->symbol_count == 0) c->symbol_count = 1;
        }
        const cJSON *style = cJSON_GetObjectItem(crypto, "style");
        if (cJSON_IsString(style)) {
            c->crypto_style = !strcmp(style->valuestring, "big") ? CRYPTO_STYLE_BIG
                                                                 : CRYPTO_STYLE_CHART;
        }
        const cJSON *cur = cJSON_GetObjectItem(crypto, "currency");
        if (cJSON_IsString(cur)) {
            c->currency_thb = (strcmp(cur->valuestring, "THB") == 0);
        }
        if ((it = cJSON_GetObjectItem(crypto, "fetch_interval_s")) && cJSON_IsNumber(it) &&
            it->valueint >= 5) {
            c->fetch_interval_s = it->valueint;
        }
    }
    const cJSON *slide = cJSON_GetObjectItem(root, "slideshow");
    if (slide) {
        if ((it = cJSON_GetObjectItem(slide, "interval_s")) && cJSON_IsNumber(it)) {
            c->slide_interval_s = it->valueint > 0 ? it->valueint : 5;
        }
        if ((it = cJSON_GetObjectItem(slide, "return_to_first")) && cJSON_IsBool(it)) {
            c->slide_return_first = cJSON_IsTrue(it);
        }
        const cJSON *fx = cJSON_GetObjectItem(slide, "effect");
        if (cJSON_IsString(fx)) {
            if (!strcmp(fx->valuestring, "slide")) c->slide_fx = SLIDE_FX_SLIDE;
            else if (!strcmp(fx->valuestring, "none")) c->slide_fx = SLIDE_FX_NONE;
            else c->slide_fx = SLIDE_FX_FADE;
        }
        const cJSON *order = cJSON_GetObjectItem(slide, "order");
        if (cJSON_IsArray(order)) {
            c->slide_order_count = 0;
            const cJSON *oj;
            cJSON_ArrayForEach(oj, order) {
                if (cJSON_IsString(oj) && c->slide_order_count < MAX_SLIDES) {
                    strlcpy(c->slide_order[c->slide_order_count++], oj->valuestring, 32);
                }
            }
        }
    }
}

static void cfg_apply_file(home_cfg_t *c, const char *path)
{
    size_t len = 0;
    char *json = storage_read_file(path, &len);
    if (!json) {
        return;
    }
    cJSON *root = cJSON_ParseWithLength(json, len);
    free(json);
    if (root) {
        cfg_apply_json(c, root);
        cJSON_Delete(root);
        ESP_LOGI(TAG, "config applied: %s", path);
    }
}

static void cfg_load(home_cfg_t *c)
{
    cfg_defaults(c);
    cfg_apply_file(c, STORAGE_LFS_BASE "/config/device.json");
    cfg_apply_file(c, STORAGE_SD_BASE "/config/device.json");
    /* per-page overrides live inside each page's own folder */
    for (int i = 0; i < c->page_count; i++) {
        char path[96];
        snprintf(path, sizeof(path), STORAGE_SD_BASE "/pages/%s/config.json", c->pages[i]);
        cfg_apply_file(c, path);
    }
}

/* =========================================================== chrome bits */

static void menu_open(void);

static void menu_btn_cb(lv_event_t *e)
{
    menu_open();
}

static lv_obj_t *screen_base(void)
{
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, lv_color_hex(COL_BG), 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    return scr;
}

static void add_menu_button(lv_obj_t *scr)
{
    lv_obj_t *btn = lv_button_create(scr);
    lv_obj_set_size(btn, 40, 32);
    lv_obj_align(btn, LV_ALIGN_TOP_RIGHT, -8, 8);
    lv_obj_set_style_bg_color(btn, lv_color_hex(COL_PANEL), 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_70, 0);
    lv_obj_set_style_border_width(btn, 1, 0);
    lv_obj_set_style_border_color(btn, lv_color_hex(COL_BORDER), 0);
    lv_obj_set_style_radius(btn, 8, 0);
    lv_obj_set_style_shadow_width(btn, 0, 0);
    lv_obj_t *lbl = lv_label_create(btn);
    lv_label_set_text(lbl, LV_SYMBOL_LIST);
    lv_obj_set_style_text_color(lbl, lv_color_hex(COL_MUTED), 0);
    lv_obj_center(lbl);
    lv_obj_add_event_cb(btn, menu_btn_cb, LV_EVENT_CLICKED, NULL);
}

static void add_page_dots(lv_obj_t *scr, int active)
{
    lv_obj_t *row = lv_obj_create(scr);
    lv_obj_remove_style_all(row);
    lv_obj_set_size(row, LV_SIZE_CONTENT, 8);
    lv_obj_align(row, LV_ALIGN_BOTTOM_MID, 0, -6);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_style_pad_column(row, 8, 0);
    for (int i = 0; i < s.page_count; i++) {
        lv_obj_t *dot = lv_obj_create(row);
        lv_obj_remove_style_all(dot);
        lv_obj_set_size(dot, 8, 8);
        lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(dot, lv_color_hex(i == active ? COL_ACCENT : COL_BORDER), 0);
    }
}

static void goto_page(int idx, bool anim_left);

static void gesture_cb(lv_event_t *e)
{
    lv_indev_t *indev = lv_indev_active();
    if (!indev) {
        return;
    }
    lv_dir_t dir = lv_indev_get_gesture_dir(indev);
    if (dir == LV_DIR_LEFT) {
        goto_page((s.current + 1) % s.page_count, true);
    } else if (dir == LV_DIR_RIGHT) {
        goto_page((s.current - 1 + s.page_count) % s.page_count, false);
    }
}

/* =============================================================== clock */

static void clock_tick(lv_timer_t *t)
{
    time_t now = time(NULL);
    if (now < 1600000000) { /* SNTP not synced yet */
        lv_label_set_text(s.lbl_time, "--:--");
        lv_label_set_text(s.lbl_sec, "");
        lv_label_set_text(s.lbl_date, s.net_connected ? "Syncing time..." : "Waiting for WiFi...");
        return;
    }
    now += (time_t)s.cfg.tz_offset_min * 60;
    struct tm tm;
    gmtime_r(&now, &tm);

    static const char *WD[] = { "Sunday", "Monday", "Tuesday", "Wednesday",
                                "Thursday", "Friday", "Saturday" };
    static const char *MO[] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
    lv_label_set_text_fmt(s.lbl_time, "%02d:%02d", tm.tm_hour, tm.tm_min);
    lv_label_set_text_fmt(s.lbl_sec, ":%02d", tm.tm_sec);
    lv_label_set_text_fmt(s.lbl_date, "%s  %d %s %d",
                          WD[tm.tm_wday], tm.tm_mday, MO[tm.tm_mon], tm.tm_year + 1900);
}

static void build_clock_page(page_t *page)
{
    lv_obj_t *scr = page->screen;

    const clock_theme_t th = s.cfg.clock_theme;

    /* near-fullscreen time: 48pt scaled 2.2x (~105px tall) */
    s.lbl_time = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_48
    lv_obj_set_style_text_font(s.lbl_time, &lv_font_montserrat_48, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_time, lv_color_hex(THEMES[th].time), 0);
    lv_obj_set_style_transform_scale(s.lbl_time, 563, 0); /* 256 = 1x */
    lv_obj_set_style_transform_pivot_x(s.lbl_time, lv_pct(50), 0);
    lv_obj_set_style_transform_pivot_y(s.lbl_time, lv_pct(50), 0);
    lv_label_set_text(s.lbl_time, "--:--");
    lv_obj_align(s.lbl_time, LV_ALIGN_CENTER, 0, -36);

    s.lbl_sec = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(s.lbl_sec, &lv_font_montserrat_28, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_sec, lv_color_hex(THEMES[th].accent), 0);
    lv_label_set_text(s.lbl_sec, "");
    lv_obj_align(s.lbl_sec, LV_ALIGN_CENTER, 0, 54);

    s.lbl_date = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(s.lbl_date, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_date, lv_color_hex(THEMES[th].date), 0);
    lv_label_set_text(s.lbl_date, "");
    lv_obj_align(s.lbl_date, LV_ALIGN_BOTTOM_MID, 0, -26);

    if (!s.clock_timer) {
        s.clock_timer = lv_timer_create(clock_tick, 1000, NULL);
    }
    clock_tick(NULL);
}

/* ============================================================== crypto */

static const char *symbol_base(const char *sym, char *buf, size_t len)
{
    strlcpy(buf, sym, len);
    char *q = strstr(buf, "USDT");
    if (q && q != buf) {
        *q = '\0';
    }
    return buf;
}

static void format_price(char *out, size_t out_len, double price, bool thb)
{
    const char *prefix = thb ? "THB " : "$";
    if (price >= 1000) {
        long whole = (long)price;
        int frac = (int)((price - whole) * 100);
        char raw[24], sep[32];
        snprintf(raw, sizeof(raw), "%ld", whole);
        int len = strlen(raw), si = 0;
        for (int i = 0; i < len; i++) {
            sep[si++] = raw[i];
            int rem = len - 1 - i;
            if (rem > 0 && rem % 3 == 0) {
                sep[si++] = ',';
            }
        }
        sep[si] = 0;
        snprintf(out, out_len, "%s%s.%02d", prefix, sep, frac);
    } else if (price >= 1) {
        snprintf(out, out_len, "%s%.2f", prefix, price);
    } else {
        snprintf(out, out_len, "%s%.4f", prefix, price);
    }
}

/* re-render price/change from cached state (call under display lock) */
static void crypto_render(void)
{
    if (!s.lbl_price) {
        return;
    }
    if (s.last_usd_price <= 0) {
        lv_label_set_text(s.lbl_price, "--");
        lv_label_set_text(s.lbl_change, s.net_connected ? "loading..." : "offline");
        return;
    }
    double price = s.last_usd_price;
    bool thb = s.cfg.currency_thb && s.usd_thb_rate > 0;
    if (thb) {
        price *= s.usd_thb_rate;
    }
    char buf[48];
    format_price(buf, sizeof(buf), price, thb);
    lv_label_set_text(s.lbl_price, buf);

    snprintf(buf, sizeof(buf), "%+.2f%% (24h)", s.last_chg_pct);
    lv_label_set_text(s.lbl_change, buf);
    lv_color_t col = lv_color_hex(s.last_chg_pct < 0 ? COL_RED : COL_GREEN);
    lv_obj_set_style_text_color(s.lbl_change, col, 0);
    lv_obj_set_style_bg_color(s.crypto_dot, col, 0);
    lv_label_set_text(s.lbl_updated,
                      s.cfg.currency_thb && s.usd_thb_rate <= 0
                          ? "Binance · fetching THB rate..." : "Binance · live");
}

static void crypto_apply_quote(double last, double chg_pct)
{
    if (!display_engine_lock(200)) {
        return;
    }
    s.last_usd_price = last;
    s.last_chg_pct = chg_pct;
    crypto_render();
    if (s.spark && s.spark_ser) {
        int32_t v = (int32_t)last;
        if (s.spark_points == 0) {
            s.spark_min = s.spark_max = v;
        } else {
            if (v < s.spark_min) s.spark_min = v;
            if (v > s.spark_max) s.spark_max = v;
        }
        s.spark_points++;
        /* default chart range is 0..100 which clips BTC-sized values —
         * follow the data with ~1% padding (min 4 units so a flat line centers) */
        int32_t pad = (s.spark_max - s.spark_min) / 2 + s.spark_max / 100;
        if (pad < 4) pad = 4;
        lv_chart_set_range(s.spark, LV_CHART_AXIS_PRIMARY_Y,
                           s.spark_min - pad, s.spark_max + pad);
        lv_chart_set_next_value(s.spark, s.spark_ser, v);
        lv_chart_refresh(s.spark);
    }
    s.last_quote_ms = (int64_t)(lv_tick_get());
    display_engine_unlock();
}

/** GET url into buf; returns body length or <0. Logs failures. */
static int http_get_text(const char *url, char *buf, size_t buf_len)
{
    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = 8000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) {
        return -1;
    }
    int total = -1;
    esp_err_t err = esp_http_client_open(client, 0);
    if (err == ESP_OK) {
        esp_http_client_fetch_headers(client);
        int status = esp_http_client_get_status_code(client);
        if (status == 200) {
            total = 0;
            int rd;
            while ((rd = esp_http_client_read(client, buf + total,
                                              (int)buf_len - 1 - total)) > 0) {
                total += rd;
                if (total >= (int)buf_len - 1) {
                    break;
                }
            }
            buf[total] = '\0';
        } else {
            ESP_LOGW(TAG, "GET %s -> HTTP %d", url, status);
        }
    } else {
        ESP_LOGW(TAG, "GET %s failed: %s", url, esp_err_to_name(err));
    }
    esp_http_client_cleanup(client);
    return total;
}

static void fetch_thb_rate(char *body, size_t body_len)
{
    /* free, no API key: https://open.er-api.com/v6/latest/USD */
    int n = http_get_text("https://open.er-api.com/v6/latest/USD", body, body_len);
    if (n <= 0) {
        return;
    }
    cJSON *root = cJSON_Parse(body);
    if (!root) {
        return;
    }
    const cJSON *rates = cJSON_GetObjectItem(root, "rates");
    const cJSON *thb = rates ? cJSON_GetObjectItem(rates, "THB") : NULL;
    if (cJSON_IsNumber(thb) && thb->valuedouble > 1) {
        s.usd_thb_rate = thb->valuedouble;
        s.rate_fetched_ms = esp_log_timestamp();
        ESP_LOGI(TAG, "USD->THB rate: %.2f", s.usd_thb_rate);
    }
    cJSON_Delete(root);
}

static void crypto_poll_task(void *arg)
{
    /* PSRAM scratch keeps this task's stack small despite TLS work */
    char *body = heap_caps_malloc(8192, MALLOC_CAP_SPIRAM);
    if (!body) {
        s.poll_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    while (s.poll_run) {
        if (!s.net_connected) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        s.force_fetch = false;

        /* THB rate: fetch lazily, refresh hourly */
        if (s.cfg.currency_thb &&
            (s.usd_thb_rate <= 0 || esp_log_timestamp() - s.rate_fetched_ms > 3600 * 1000)) {
            fetch_thb_rate(body, 8192);
        }

        char url[128];
        snprintf(url, sizeof(url),
                 "https://api.binance.com/api/v3/ticker/24hr?symbol=%s",
                 s.cfg.symbols[s.cur_symbol]);
        int n = http_get_text(url, body, 8192);
        if (n > 0) {
            cJSON *root = cJSON_Parse(body);
            if (root) {
                const cJSON *lp = cJSON_GetObjectItem(root, "lastPrice");
                const cJSON *cp = cJSON_GetObjectItem(root, "priceChangePercent");
                if (cJSON_IsString(lp) && cJSON_IsString(cp)) {
                    crypto_apply_quote(atof(lp->valuestring), atof(cp->valuestring));
                } else {
                    const cJSON *msg = cJSON_GetObjectItem(root, "msg");
                    ESP_LOGW(TAG, "binance: %s",
                             cJSON_IsString(msg) ? msg->valuestring : "unexpected payload");
                }
                cJSON_Delete(root);
            }
        }

        int interval = s.cfg.fetch_interval_s > 0 ? s.cfg.fetch_interval_s : 10;
        for (int i = 0; i < interval * 10 && s.poll_run && !s.force_fetch; i++) {
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
    free(body);
    s.poll_task = NULL;
    vTaskDelete(NULL);
}

static void crypto_update_header(void)
{
    char base[12], disp[24];
    symbol_base(s.cfg.symbols[s.cur_symbol], base, sizeof(base));
    snprintf(disp, sizeof(disp), "%s/USDT " LV_SYMBOL_DOWN, base);
    lv_label_set_text(s.btn_symbol_lbl, disp);

    /* coin logo from SD: /pages/crypto/assets/<base lowercase>.png */
    if (s.coin_logo) {
        char lower[12];
        for (int i = 0; base[i] && i < 11; i++) {
            lower[i] = (char)tolower((unsigned char)base[i]);
            lower[i + 1] = '\0';
        }
        char path[96];
        snprintf(path, sizeof(path), STORAGE_SD_BASE "/pages/crypto/assets/%s.png", lower);
        struct stat st;
        if (storage_sd_mounted() && stat(path, &st) == 0) {
            char lv_path[104];
            snprintf(lv_path, sizeof(lv_path), "A:%s", path);
            lv_image_set_src(s.coin_logo, lv_path);
            lv_obj_remove_flag(s.coin_logo, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s.coin_logo, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

static void crypto_symbol_btn_cb(lv_event_t *e)
{
    if (s.cfg.symbol_count <= 1) {
        return;
    }
    s.cur_symbol = (s.cur_symbol + 1) % s.cfg.symbol_count;
    s.last_usd_price = 0;
    crypto_update_header();
    if (s.spark && s.spark_ser) {
        lv_chart_set_all_value(s.spark, s.spark_ser, LV_CHART_POINT_NONE);
    }
    s.spark_points = 0; /* restart range tracking for the new symbol */
    crypto_render();
    s.force_fetch = true;
}

static void crypto_currency_btn_cb(lv_event_t *e)
{
    s.cfg.currency_thb = !s.cfg.currency_thb;
    lv_label_set_text(s.btn_cur_lbl, s.cfg.currency_thb ? "THB" : "USD");
    crypto_render();
    if (s.cfg.currency_thb && s.usd_thb_rate <= 0) {
        s.force_fetch = true; /* poll loop fetches the rate */
    }
}

static void build_crypto_page(page_t *page)
{
    lv_obj_t *scr = page->screen;
    const bool big = (s.cfg.crypto_style == CRYPTO_STYLE_BIG);

    /* top-left: coin logo + symbol cycle button */
    s.coin_logo = lv_image_create(scr);
    lv_obj_set_size(s.coin_logo, 32, 32);
    lv_obj_align(s.coin_logo, LV_ALIGN_TOP_LEFT, 12, 10);

    lv_obj_t *sym_btn = lv_button_create(scr);
    lv_obj_set_size(sym_btn, 150, 36);
    lv_obj_align(sym_btn, LV_ALIGN_TOP_LEFT, 50, 8);
    lv_obj_set_style_bg_color(sym_btn, lv_color_hex(COL_PANEL), 0);
    lv_obj_set_style_border_width(sym_btn, 1, 0);
    lv_obj_set_style_border_color(sym_btn, lv_color_hex(COL_BORDER), 0);
    lv_obj_set_style_radius(sym_btn, 8, 0);
    lv_obj_set_style_shadow_width(sym_btn, 0, 0);
    s.btn_symbol_lbl = lv_label_create(sym_btn);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(s.btn_symbol_lbl, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(s.btn_symbol_lbl, lv_color_hex(COL_FG), 0);
    lv_obj_center(s.btn_symbol_lbl);
    lv_obj_add_event_cb(sym_btn, crypto_symbol_btn_cb, LV_EVENT_CLICKED, NULL);

    /* top-right (left of the menu button): currency toggle USD/THB */
    lv_obj_t *cur_btn = lv_button_create(scr);
    lv_obj_set_size(cur_btn, 58, 32);
    lv_obj_align(cur_btn, LV_ALIGN_TOP_RIGHT, -56, 8);
    lv_obj_set_style_bg_color(cur_btn, lv_color_hex(COL_PANEL), 0);
    lv_obj_set_style_border_width(cur_btn, 1, 0);
    lv_obj_set_style_border_color(cur_btn, lv_color_hex(COL_ACCENT), 0);
    lv_obj_set_style_radius(cur_btn, 8, 0);
    lv_obj_set_style_shadow_width(cur_btn, 0, 0);
    s.btn_cur_lbl = lv_label_create(cur_btn);
    lv_obj_set_style_text_color(s.btn_cur_lbl, lv_color_hex(COL_ACCENT), 0);
    lv_label_set_text(s.btn_cur_lbl, s.cfg.currency_thb ? "THB" : "USD");
    lv_obj_center(s.btn_cur_lbl);
    lv_obj_add_event_cb(cur_btn, crypto_currency_btn_cb, LV_EVENT_CLICKED, NULL);

    s.crypto_dot = lv_obj_create(scr);
    lv_obj_remove_style_all(s.crypto_dot);
    lv_obj_set_size(s.crypto_dot, 10, 10);
    lv_obj_set_style_radius(s.crypto_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(s.crypto_dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s.crypto_dot, lv_color_hex(COL_MUTED), 0);
    lv_obj_align(s.crypto_dot, LV_ALIGN_TOP_LEFT, 208, 22);

    /* price + change */
    s.lbl_price = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_48
    lv_obj_set_style_text_font(s.lbl_price, &lv_font_montserrat_48, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_price, lv_color_hex(COL_FG), 0);
    lv_label_set_text(s.lbl_price, "--");

    s.lbl_change = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(s.lbl_change, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_change, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(s.lbl_change, "loading...");

    if (big) {
        /* style "big": one huge centered price, change below */
        lv_obj_align(s.lbl_price, LV_ALIGN_CENTER, 0, -10);
        lv_obj_align(s.lbl_change, LV_ALIGN_CENTER, 0, 44);
    } else {
        /* style "chart": price top, sparkline bottom */
        lv_obj_align(s.lbl_price, LV_ALIGN_TOP_LEFT, 18, 58);
        lv_obj_align(s.lbl_change, LV_ALIGN_TOP_LEFT, 20, 116);

        s.spark = lv_chart_create(scr);
        lv_obj_set_size(s.spark, 444, 130);
        lv_obj_align(s.spark, LV_ALIGN_BOTTOM_MID, 0, -38);
        lv_obj_set_style_bg_color(s.spark, lv_color_hex(COL_PANEL), 0);
        lv_obj_set_style_border_color(s.spark, lv_color_hex(COL_BORDER), 0);
        lv_obj_set_style_border_width(s.spark, 1, 0);
        lv_obj_set_style_radius(s.spark, 12, 0);
        lv_obj_set_style_size(s.spark, 0, 0, LV_PART_INDICATOR);
        lv_chart_set_type(s.spark, LV_CHART_TYPE_LINE);
        lv_chart_set_point_count(s.spark, SPARK_POINTS);
        lv_chart_set_update_mode(s.spark, LV_CHART_UPDATE_MODE_SHIFT);
        lv_chart_set_div_line_count(s.spark, 3, 0);
        s.spark_ser = lv_chart_add_series(s.spark, lv_color_hex(COL_ACCENT),
                                          LV_CHART_AXIS_PRIMARY_Y);
    }

    s.lbl_updated = lv_label_create(scr);
    lv_obj_set_style_text_color(s.lbl_updated, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(s.lbl_updated, s.net_connected ? "connecting..." : "offline");
    lv_obj_align(s.lbl_updated, LV_ALIGN_BOTTOM_RIGHT, -16, -18);

    crypto_update_header();

    if (!s.poll_task) {
        s.poll_run = true;
        xTaskCreatePinnedToCore(crypto_poll_task, "crypto_poll", 10240, NULL, 3,
                                &s.poll_task, 0);
    }
}

/* ============================================================ slideshow */

/** Where slideshow images live: SD when mounted, else LittleFS. */
static const char *slideshow_assets_dir(void)
{
    return storage_sd_mounted() ? STORAGE_SD_BASE "/pages/slideshow/assets"
                                : STORAGE_LFS_BASE "/pages/slideshow/assets";
}

static void slideshow_scan(void)
{
    s.slide_count = 0;
    const char *dir_path = slideshow_assets_dir();

    /* explicit order from config wins (app reorders by rewriting it) */
    if (s.cfg.slide_order_count > 0) {
        struct stat st;
        for (int i = 0; i < s.cfg.slide_order_count && s.slide_count < MAX_SLIDES; i++) {
            char full[120];
            snprintf(full, sizeof(full), "%s/%s", dir_path, s.cfg.slide_order[i]);
            if (stat(full, &st) == 0) {
                snprintf(s.slides[s.slide_count++], sizeof(s.slides[0]), "A:%s", full);
            }
        }
        if (s.slide_count > 0) {
            ESP_LOGI(TAG, "slideshow: %d images (configured order)", s.slide_count);
            return;
        }
    }

    DIR *dir = opendir(dir_path);
    if (!dir) {
        return;
    }
    struct dirent *de;
    while ((de = readdir(dir)) != NULL && s.slide_count < MAX_SLIDES) {
        const char *ext = strrchr(de->d_name, '.');
        if (!ext) {
            continue;
        }
        if (!strcasecmp(ext, ".png") || !strcasecmp(ext, ".jpg") || !strcasecmp(ext, ".jpeg")) {
            snprintf(s.slides[s.slide_count], sizeof(s.slides[0]),
                     "A:%s/%s", dir_path, de->d_name);
            s.slide_count++;
        }
    }
    closedir(dir);
    ESP_LOGI(TAG, "slideshow: %d images", s.slide_count);
}

static void slide_fade_in(void *var, int32_t v)
{
    lv_obj_set_style_opa((lv_obj_t *)var, (lv_opa_t)v, 0);
}

static void slide_translate_x(void *var, int32_t v)
{
    lv_obj_set_style_translate_x((lv_obj_t *)var, v, 0);
}

static void slide_show_current(void)
{
    if (s.slide_count == 0 || !s.slide_img) {
        return;
    }
    lv_image_set_src(s.slide_img, s.slides[s.slide_idx]);

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, s.slide_img);
    switch (s.cfg.slide_fx) {
    case SLIDE_FX_FADE:
        lv_anim_set_exec_cb(&a, slide_fade_in);
        lv_anim_set_values(&a, LV_OPA_TRANSP, LV_OPA_COVER);
        lv_anim_set_duration(&a, 450);
        lv_anim_start(&a);
        break;
    case SLIDE_FX_SLIDE:
        lv_anim_set_exec_cb(&a, slide_translate_x);
        lv_anim_set_values(&a, lv_obj_get_width(lv_screen_active()), 0);
        lv_anim_set_duration(&a, 350);
        lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
        lv_anim_start(&a);
        break;
    case SLIDE_FX_NONE:
    default:
        break;
    }
}

static void slide_advance(lv_timer_t *t)
{
    if (s.slide_count == 0) {
        return;
    }
    int next = s.slide_idx + 1;
    if (next >= s.slide_count) {
        s.slide_idx = 0;
        if (s.cfg.slide_return_first && s.page_count > 1) {
            goto_page(0, true); /* full cycle done -> back to page 1 */
            return;
        }
    } else {
        s.slide_idx = next;
    }
    slide_show_current();
}

static void build_slideshow_page(page_t *page)
{
    lv_obj_t *scr = page->screen;
    slideshow_scan();

    if (s.slide_count == 0) {
        s.slide_hint = lv_label_create(scr);
        lv_obj_set_style_text_color(s.slide_hint, lv_color_hex(COL_MUTED), 0);
        lv_obj_set_style_text_align(s.slide_hint, LV_TEXT_ALIGN_CENTER, 0);
        lv_label_set_text(s.slide_hint,
            s.net_connected
                ? LV_SYMBOL_IMAGE "  No images yet\n\n"
                  "Downloading sample photos..."
                : LV_SYMBOL_IMAGE "  No images found\n\n"
                  "Connect WiFi for sample photos, or put\n"
                  "PNG/JPG (320x240) in /pages/slideshow/assets/\n"
                  "(SD card) or upload from the mobile app");
        lv_obj_center(s.slide_hint);
        return;
    }

    s.slide_img = lv_image_create(scr);
    lv_obj_center(s.slide_img);
    s.slide_idx = 0;
    slide_show_current();

    s.slide_timer = lv_timer_create(slide_advance, (uint32_t)s.cfg.slide_interval_s * 1000, NULL);
}

/* ================================================================ menu */

static void menu_close_cb(lv_event_t *e)
{
    if (s.menu) {
        lv_obj_delete(s.menu);
        s.menu = NULL;
    }
}

static void menu_page_cb(lv_event_t *e)
{
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    menu_close_cb(NULL);
    goto_page(idx, idx > s.current);
}

static void menu_brightness_cb(lv_event_t *e)
{
    lv_obj_t *slider = lv_event_get_target(e);
    ccp_board_set_brightness((int)lv_slider_get_value(slider));
}

static void menu_wifi_reset_cb(lv_event_t *e)
{
    net_manager_forget(); /* erases creds + reboots into setup portal */
}

static void menu_open(void)
{
    if (s.menu) {
        return;
    }
    /* dim overlay on the top layer so it survives page switches */
    s.menu = lv_obj_create(lv_layer_top());
    lv_obj_set_size(s.menu, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(s.menu, lv_color_hex(0x000000), 0);
    lv_obj_set_style_bg_opa(s.menu, LV_OPA_60, 0);
    lv_obj_set_style_border_width(s.menu, 0, 0);
    lv_obj_set_style_radius(s.menu, 0, 0);
    lv_obj_add_event_cb(s.menu, menu_close_cb, LV_EVENT_CLICKED, NULL);

    lv_obj_t *panel = lv_obj_create(s.menu);
    lv_obj_set_size(panel, 240, LV_PCT(100));
    lv_obj_align(panel, LV_ALIGN_RIGHT_MID, 0, 0);
    lv_obj_set_style_bg_color(panel, lv_color_hex(COL_PANEL), 0);
    lv_obj_set_style_border_width(panel, 0, 0);
    lv_obj_set_style_radius(panel, 0, 0);
    lv_obj_set_style_pad_all(panel, 14, 0);
    lv_obj_set_flex_flow(panel, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(panel, 8, 0);
    /* clicks inside the panel must not close the overlay */
    lv_obj_remove_flag(panel, LV_OBJ_FLAG_EVENT_BUBBLE);

    lv_obj_t *title = lv_label_create(panel);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(title, lv_color_hex(COL_ACCENT), 0);
    lv_label_set_text(title, LV_SYMBOL_SETTINGS "  Menu");

    static const char *NAMES[] = { "clock", "crypto", "slideshow" };
    static const char *LABELS[] = { LV_SYMBOL_BELL "  Clock", LV_SYMBOL_CHARGE "  Crypto",
                                    LV_SYMBOL_IMAGE "  Slideshow" };
    for (int i = 0; i < s.page_count; i++) {
        const char *label = s.pages[i].id;
        for (size_t k = 0; k < sizeof(NAMES) / sizeof(NAMES[0]); k++) {
            if (!strcmp(s.pages[i].id, NAMES[k])) {
                label = LABELS[k];
                break;
            }
        }
        lv_obj_t *btn = lv_button_create(panel);
        lv_obj_set_width(btn, LV_PCT(100));
        lv_obj_set_style_bg_color(btn, lv_color_hex(i == s.current ? COL_BORDER : COL_BG), 0);
        lv_obj_set_style_radius(btn, 8, 0);
        lv_obj_set_style_shadow_width(btn, 0, 0);
        lv_obj_t *bl = lv_label_create(btn);
        lv_label_set_text(bl, label);
        lv_obj_set_style_text_color(bl, lv_color_hex(COL_FG), 0);
        lv_obj_add_event_cb(btn, menu_page_cb, LV_EVENT_CLICKED, (void *)(intptr_t)i);
    }

    lv_obj_t *blabel = lv_label_create(panel);
    lv_obj_set_style_text_color(blabel, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(blabel, "Brightness");

    lv_obj_t *slider = lv_slider_create(panel);
    lv_obj_set_width(slider, LV_PCT(96));
    lv_slider_set_range(slider, 5, 100);
    lv_slider_set_value(slider, ccp_board_get_brightness(), LV_ANIM_OFF);
    lv_obj_set_style_bg_color(slider, lv_color_hex(COL_ACCENT), LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(slider, lv_color_hex(COL_ACCENT), LV_PART_KNOB);
    lv_obj_add_event_cb(slider, menu_brightness_cb, LV_EVENT_VALUE_CHANGED, NULL);

    char info[128];
    snprintf(info, sizeof(info), "%s\nIP: %s\nfw %s",
             device_security_id(), s.ip[0] ? s.ip : "-", ota_manager_running_version());
    lv_obj_t *infol = lv_label_create(panel);
    lv_obj_set_style_text_color(infol, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(infol, info);

    lv_obj_t *wifi_btn = lv_button_create(panel);
    lv_obj_set_width(wifi_btn, LV_PCT(100));
    lv_obj_set_style_bg_color(wifi_btn, lv_color_hex(0x3B1219), 0);
    lv_obj_set_style_radius(wifi_btn, 8, 0);
    lv_obj_set_style_shadow_width(wifi_btn, 0, 0);
    lv_obj_t *wl = lv_label_create(wifi_btn);
    lv_label_set_text(wl, LV_SYMBOL_WIFI "  Reset WiFi");
    lv_obj_set_style_text_color(wl, lv_color_hex(COL_RED), 0);
    lv_obj_add_event_cb(wifi_btn, menu_wifi_reset_cb, LV_EVENT_LONG_PRESSED, NULL);
    lv_obj_t *wh = lv_label_create(panel);
    lv_obj_set_style_text_color(wh, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(wh, "(hold to confirm)");
}

/* ============================================================ navigation */

static void build_page(int idx)
{
    page_t *p = &s.pages[idx];
    if (p->screen) {
        return;
    }
    p->screen = screen_base();
    switch (p->kind) {
    case PAGE_CLOCK:     build_clock_page(p); break;
    case PAGE_CRYPTO:    build_crypto_page(p); break;
    case PAGE_SLIDESHOW: build_slideshow_page(p); break;
    }
    add_menu_button(p->screen);
    add_page_dots(p->screen, idx);
    lv_obj_add_event_cb(p->screen, gesture_cb, LV_EVENT_GESTURE, NULL);
}

/* dynamic mode: auto-advance pages; the slideshow page drives its own exit */
static void advance_tick(lv_timer_t *t)
{
    if (s.menu || s.page_count < 2) {
        return;
    }
    if (s.pages[s.current].kind == PAGE_SLIDESHOW) {
        return;
    }
    goto_page((s.current + 1) % s.page_count, true);
}

static void goto_page(int idx, bool anim_left)
{
    if (idx < 0 || idx >= s.page_count) {
        return;
    }
    build_page(idx);
    s.current = idx;
    s.owns_screen = true;
    lv_screen_load_anim(s.pages[idx].screen,
                        anim_left ? LV_SCR_LOAD_ANIM_MOVE_LEFT : LV_SCR_LOAD_ANIM_MOVE_RIGHT,
                        240, 0, false);

    if (s.cfg.dynamic_mode && !s.advance_timer) {
        s.advance_timer = lv_timer_create(advance_tick,
                                          (uint32_t)s.cfg.page_delay_s * 1000, NULL);
    }
    if (s.advance_timer) {
        lv_timer_reset(s.advance_timer);
    }
}

/* ============================================================== screens */

void home_ui_show_welcome(const char *status_line)
{
    if (!display_engine_lock(0)) {
        return;
    }
    lv_obj_t *scr = screen_base();

    lv_obj_t *glow = lv_obj_create(scr);
    lv_obj_remove_style_all(glow);
    lv_obj_set_size(glow, 260, 260);
    lv_obj_align(glow, LV_ALIGN_CENTER, 0, -10);
    lv_obj_set_style_radius(glow, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(glow, LV_OPA_10, 0);
    lv_obj_set_style_bg_color(glow, lv_color_hex(COL_ACCENT), 0);

    lv_obj_t *title = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_48
    lv_obj_set_style_text_font(title, &lv_font_montserrat_48, 0);
#endif
    lv_obj_set_style_text_color(title, lv_color_hex(COL_ACCENT), 0);
    lv_label_set_text(title, "CryptoClock");
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -40);

    lv_obj_t *sub = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(sub, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(sub, lv_color_hex(COL_FG), 0);
    lv_label_set_text(sub, "P R O");
    lv_obj_align(sub, LV_ALIGN_CENTER, 0, 0);

    lv_obj_t *spinner = lv_spinner_create(scr);
    lv_obj_set_size(spinner, 36, 36);
    lv_obj_align(spinner, LV_ALIGN_CENTER, 0, 52);
    lv_obj_set_style_arc_color(spinner, lv_color_hex(COL_ACCENT), LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(spinner, lv_color_hex(COL_BORDER), LV_PART_MAIN);
    lv_obj_set_style_arc_width(spinner, 4, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(spinner, 4, LV_PART_MAIN);

    lv_obj_t *status = lv_label_create(scr);
    lv_obj_set_style_text_color(status, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(status, status_line ? status_line : "");
    lv_obj_align(status, LV_ALIGN_CENTER, 0, 92);

    char footer[64];
    snprintf(footer, sizeof(footer), "%s  ·  fw %s",
             device_security_id(), ota_manager_running_version());
    lv_obj_t *foot = lv_label_create(scr);
    lv_obj_set_style_text_color(foot, lv_color_hex(0x3A4149), 0);
    lv_label_set_text(foot, footer);
    lv_obj_align(foot, LV_ALIGN_BOTTOM_MID, 0, -8);

    s.owns_screen = true;
    lv_screen_load(scr);
    display_engine_unlock();
}

void home_ui_show_wifi_setup(const char *ap_ssid)
{
    if (!display_engine_lock(0)) {
        return;
    }
    lv_obj_t *scr = screen_base();

    lv_obj_t *title = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(title, &lv_font_montserrat_28, 0);
#endif
    lv_obj_set_style_text_color(title, lv_color_hex(COL_ACCENT), 0);
    lv_label_set_text(title, LV_SYMBOL_WIFI "  WiFi Setup");
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 18, 14);

    lv_obj_t *steps = lv_label_create(scr);
    lv_obj_set_style_text_color(steps, lv_color_hex(COL_FG), 0);
    lv_obj_set_style_text_line_space(steps, 10, 0);
    char buf[200];
    snprintf(buf, sizeof(buf),
             "1.  Scan QR or join WiFi:\n     %s\n\n"
             "2.  Open  http://192.168.4.1\n\n"
             "3.  Enter your home WiFi", ap_ssid);
    lv_label_set_text(steps, buf);
    lv_obj_align(steps, LV_ALIGN_LEFT_MID, 20, 14);

    /* QR card */
    lv_obj_t *card = lv_obj_create(scr);
    lv_obj_set_size(card, 160, 186);
    lv_obj_align(card, LV_ALIGN_RIGHT_MID, -18, 8);
    lv_obj_set_style_bg_color(card, lv_color_white(), 0);
    lv_obj_set_style_radius(card, 14, 0);
    lv_obj_set_style_border_width(card, 0, 0);
    lv_obj_set_style_pad_all(card, 10, 0);
    lv_obj_remove_flag(card, LV_OBJ_FLAG_SCROLLABLE);

#if LV_USE_QRCODE
    char qr[96];
    snprintf(qr, sizeof(qr), "WIFI:T:nopass;S:%s;;", ap_ssid);
    lv_obj_t *code = lv_qrcode_create(card);
    lv_qrcode_set_size(code, 132);
    lv_qrcode_update(code, qr, strlen(qr));
    lv_obj_align(code, LV_ALIGN_TOP_MID, 0, 0);
#endif
    lv_obj_t *cap = lv_label_create(card);
    lv_obj_set_style_text_color(cap, lv_color_hex(0x333333), 0);
    lv_label_set_text(cap, "Scan to join");
    lv_obj_align(cap, LV_ALIGN_BOTTOM_MID, 0, 0);

    s.owns_screen = true;
    lv_screen_load(scr);
    display_engine_unlock();
}

/* ============================================================== public */

static void destroy_pages(void)
{
    if (s.clock_timer) { lv_timer_delete(s.clock_timer); s.clock_timer = NULL; }
    if (s.slide_timer) { lv_timer_delete(s.slide_timer); s.slide_timer = NULL; }
    if (s.advance_timer) { lv_timer_delete(s.advance_timer); s.advance_timer = NULL; }
    s.poll_run = false;
    s.cur_symbol = 0;
    s.last_usd_price = 0;
    s.lbl_price = NULL;
    s.coin_logo = NULL;
    if (s.menu) { lv_obj_delete(s.menu); s.menu = NULL; }
    for (int i = 0; i < s.page_count; i++) {
        if (s.pages[i].screen) {
            lv_obj_delete(s.pages[i].screen);
            s.pages[i].screen = NULL;
        }
    }
    s.spark = NULL;
    s.spark_ser = NULL;
    s.spark_points = 0;
    s.slide_img = NULL;
}

static void setup_pages_from_cfg(void)
{
    s.page_count = 0;
    for (int i = 0; i < s.cfg.page_count && s.page_count < MAX_PAGES; i++) {
        page_t *p = &s.pages[s.page_count];
        memset(p, 0, sizeof(*p));
        strlcpy(p->id, s.cfg.pages[i], sizeof(p->id));
        if (!strcmp(p->id, "clock")) p->kind = PAGE_CLOCK;
        else if (!strcmp(p->id, "crypto")) p->kind = PAGE_CRYPTO;
        else if (!strcmp(p->id, "slideshow")) p->kind = PAGE_SLIDESHOW;
        else continue; /* unknown page id (future: purchased layout pages) */
        s.page_count++;
    }
    if (s.page_count == 0) {
        strcpy(s.pages[0].id, "clock");
        s.pages[0].kind = PAGE_CLOCK;
        s.page_count = 1;
    }
}

esp_err_t home_ui_init(void)
{
    cfg_load(&s.cfg);
    setup_pages_from_cfg();
    ccp_board_set_brightness(s.cfg.brightness);
    ESP_LOGI(TAG, "home_ui: %d pages, %d symbols (%s), tz=%+d min, mode=%s",
             s.page_count, s.cfg.symbol_count, s.cfg.symbols[0], s.cfg.tz_offset_min,
             s.cfg.dynamic_mode ? "dynamic" : "static");
    return ESP_OK;
}

void home_ui_show_home(void)
{
    if (!display_engine_lock(0)) {
        return;
    }
    goto_page(0, true);
    display_engine_unlock();
}

bool home_ui_owns_screen(void) { return s.owns_screen; }

void home_ui_network_changed(bool connected, const char *ip)
{
    s.net_connected = connected;
    if (ip) {
        strlcpy(s.ip, ip, sizeof(s.ip));
    }
}

esp_err_t home_ui_reload(void)
{
    if (!display_engine_lock(0)) {
        return ESP_ERR_TIMEOUT;
    }
    /* destroy_pages() deletes the active screen, which LVGL must never have
     * pulled out from under it (render task spins on the dangling screen) —
     * park the display on a blank screen during the rebuild */
    lv_obj_t *parking = NULL;
    if (s.owns_screen) {
        parking = lv_obj_create(NULL);
        lv_obj_set_style_bg_color(parking, lv_color_hex(COL_BG), 0);
        lv_screen_load(parking);
    }
    destroy_pages();
    cfg_load(&s.cfg);
    setup_pages_from_cfg();
    ccp_board_set_brightness(s.cfg.brightness);
    if (s.owns_screen) {
        build_page(0);
        s.current = 0;
        /* immediate load (no anim) so parking can be deleted right away */
        lv_screen_load(s.pages[0].screen);
        if (s.cfg.dynamic_mode && !s.advance_timer) {
            s.advance_timer = lv_timer_create(advance_tick,
                                              (uint32_t)s.cfg.page_delay_s * 1000, NULL);
        }
    }
    if (parking) {
        lv_obj_delete(parking);
    }
    display_engine_unlock();
    return ESP_OK;
}

bool home_ui_slideshow_needs_content(void)
{
    bool enabled = false;
    for (int i = 0; i < s.cfg.page_count; i++) {
        if (!strcmp(s.cfg.pages[i], "slideshow")) {
            enabled = true;
            break;
        }
    }
    if (!enabled) {
        return false;
    }
    /* scan the dir directly: s.slide_count is only set once the page built */
    DIR *dir = opendir(slideshow_assets_dir());
    if (!dir) {
        return true;
    }
    bool found = false;
    struct dirent *de;
    while ((de = readdir(dir)) != NULL) {
        const char *ext = strrchr(de->d_name, '.');
        if (ext && (!strcasecmp(ext, ".png") || !strcasecmp(ext, ".jpg") ||
                    !strcasecmp(ext, ".jpeg"))) {
            found = true;
            break;
        }
    }
    closedir(dir);
    return !found;
}

const char *home_ui_slideshow_dir(void)
{
    return slideshow_assets_dir();
}
