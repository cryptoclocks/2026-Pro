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

typedef struct {
    char pages[MAX_PAGES][16];
    int page_count;
    int tz_offset_min;
    int brightness;
    char profile_name[32];
    char profile_title[32];
    char crypto_symbol[16];
    char crypto_display[20];
    int slide_interval_s;
    bool slide_return_first;
} home_cfg_t;

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
    lv_obj_t *spark;
    lv_chart_series_t *spark_ser;
    TaskHandle_t poll_task;
    volatile bool poll_run;
    int64_t last_quote_ms;

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
    c->tz_offset_min = CCP_CFG_TZ_OFFSET_MIN;
    c->brightness = CCP_CFG_DEFAULT_BRIGHTNESS;
    strlcpy(c->profile_name, CCP_CFG_PROFILE_NAME, sizeof(c->profile_name));
    strlcpy(c->profile_title, CCP_CFG_PROFILE_TITLE, sizeof(c->profile_title));
    strlcpy(c->crypto_symbol, CCP_CFG_CRYPTO_SYMBOL, sizeof(c->crypto_symbol));
    strlcpy(c->crypto_display, CCP_CFG_CRYPTO_DISPLAY, sizeof(c->crypto_display));
    c->slide_interval_s = CCP_CFG_SLIDE_INTERVAL_S;
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
    const cJSON *crypto = cJSON_GetObjectItem(root, "crypto");
    if (crypto) {
        const cJSON *sym = cJSON_GetObjectItem(crypto, "symbol");
        const cJSON *disp = cJSON_GetObjectItem(crypto, "display");
        if (cJSON_IsString(sym)) strlcpy(c->crypto_symbol, sym->valuestring, sizeof(c->crypto_symbol));
        if (cJSON_IsString(disp)) strlcpy(c->crypto_display, disp->valuestring, sizeof(c->crypto_display));
    }
    const cJSON *slide = cJSON_GetObjectItem(root, "slideshow");
    if (slide) {
        if ((it = cJSON_GetObjectItem(slide, "interval_s")) && cJSON_IsNumber(it)) {
            c->slide_interval_s = it->valueint > 0 ? it->valueint : 5;
        }
        if ((it = cJSON_GetObjectItem(slide, "return_to_first")) && cJSON_IsBool(it)) {
            c->slide_return_first = cJSON_IsTrue(it);
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

    /* big time, center-left */
    s.lbl_time = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_48
    lv_obj_set_style_text_font(s.lbl_time, &lv_font_montserrat_48, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_time, lv_color_hex(COL_FG), 0);
    lv_label_set_text(s.lbl_time, "--:--");
    lv_obj_align(s.lbl_time, LV_ALIGN_CENTER, -30, -50);

    s.lbl_sec = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(s.lbl_sec, &lv_font_montserrat_28, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_sec, lv_color_hex(COL_ACCENT), 0);
    lv_label_set_text(s.lbl_sec, "");
    lv_obj_align_to(s.lbl_sec, s.lbl_time, LV_ALIGN_OUT_RIGHT_BOTTOM, 4, -6);

    s.lbl_date = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(s.lbl_date, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_date, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(s.lbl_date, "");
    lv_obj_align(s.lbl_date, LV_ALIGN_CENTER, 0, 4);

    /* profile card */
    lv_obj_t *card = lv_obj_create(scr);
    lv_obj_set_size(card, 300, 64);
    lv_obj_align(card, LV_ALIGN_BOTTOM_MID, 0, -22);
    lv_obj_set_style_bg_color(card, lv_color_hex(COL_PANEL), 0);
    lv_obj_set_style_border_color(card, lv_color_hex(COL_BORDER), 0);
    lv_obj_set_style_border_width(card, 1, 0);
    lv_obj_set_style_radius(card, 14, 0);
    lv_obj_set_style_pad_all(card, 8, 0);
    lv_obj_remove_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    /* avatar: image from SD if present, else initial in a gold circle */
    const char *avatar_path = STORAGE_SD_BASE "/pages/clock/assets/avatar.png";
    struct stat st;
    if (storage_sd_mounted() && stat(avatar_path, &st) == 0) {
        lv_obj_t *img = lv_image_create(card);
        char lv_path[128];
        snprintf(lv_path, sizeof(lv_path), "A:%s", avatar_path);
        lv_image_set_src(img, lv_path);
        lv_obj_set_size(img, 48, 48);
        lv_obj_align(img, LV_ALIGN_LEFT_MID, 0, 0);
        lv_obj_set_style_radius(img, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_clip_corner(img, true, 0);
    } else {
        lv_obj_t *circle = lv_obj_create(card);
        lv_obj_remove_style_all(circle);
        lv_obj_set_size(circle, 48, 48);
        lv_obj_align(circle, LV_ALIGN_LEFT_MID, 0, 0);
        lv_obj_set_style_radius(circle, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_opa(circle, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(circle, lv_color_hex(COL_ACCENT), 0);
        lv_obj_t *initial = lv_label_create(circle);
#if LV_FONT_MONTSERRAT_28
        lv_obj_set_style_text_font(initial, &lv_font_montserrat_28, 0);
#endif
        lv_obj_set_style_text_color(initial, lv_color_hex(COL_BG), 0);
        char ini[2] = { s.cfg.profile_name[0] ? s.cfg.profile_name[0] : 'C', 0 };
        lv_label_set_text(initial, ini);
        lv_obj_center(initial);
    }

    lv_obj_t *name = lv_label_create(card);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(name, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(name, lv_color_hex(COL_FG), 0);
    lv_label_set_text(name, s.cfg.profile_name);
    lv_obj_align(name, LV_ALIGN_LEFT_MID, 60, -10);

    lv_obj_t *title = lv_label_create(card);
    lv_obj_set_style_text_color(title, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(title, s.cfg.profile_title);
    lv_obj_align(title, LV_ALIGN_LEFT_MID, 60, 12);

    if (!s.clock_timer) {
        s.clock_timer = lv_timer_create(clock_tick, 1000, NULL);
    }
    clock_tick(NULL);
}

/* ============================================================== crypto */

static void crypto_apply_quote(double last, double chg_pct)
{
    if (!display_engine_lock(200)) {
        return;
    }
    char buf[48];
    if (last >= 1000) {
        /* thousands separator for readability */
        long whole = (long)last;
        int frac = (int)((last - whole) * 100);
        char raw[24];
        snprintf(raw, sizeof(raw), "%ld", whole);
        char sep[32];
        int len = strlen(raw), si = 0;
        for (int i = 0; i < len; i++) {
            sep[si++] = raw[i];
            int rem = len - 1 - i;
            if (rem > 0 && rem % 3 == 0) {
                sep[si++] = ',';
            }
        }
        sep[si] = 0;
        snprintf(buf, sizeof(buf), "$%s.%02d", sep, frac);
    } else {
        snprintf(buf, sizeof(buf), "$%.4f", last);
    }
    lv_label_set_text(s.lbl_price, buf);

    snprintf(buf, sizeof(buf), "%+.2f%% (24h)", chg_pct);
    lv_label_set_text(s.lbl_change, buf);
    lv_color_t col = lv_color_hex(chg_pct < 0 ? COL_RED : COL_GREEN);
    lv_obj_set_style_text_color(s.lbl_change, col, 0);
    lv_obj_set_style_bg_color(s.crypto_dot, col, 0);

    lv_label_set_text(s.lbl_updated, "Binance · live");
    if (s.spark && s.spark_ser) {
        lv_chart_set_next_value(s.spark, s.spark_ser, (int32_t)last);
        lv_chart_refresh(s.spark);
    }
    s.last_quote_ms = (int64_t)(lv_tick_get());
    display_engine_unlock();
}

static void crypto_poll_task(void *arg)
{
    char url[128];
    snprintf(url, sizeof(url),
             "https://api.binance.com/api/v3/ticker/24hr?symbol=%s", s.cfg.crypto_symbol);

    while (s.poll_run) {
        if (!s.net_connected) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        esp_http_client_config_t cfg = {
            .url = url,
            .timeout_ms = 8000,
            .crt_bundle_attach = esp_crt_bundle_attach,
            .buffer_size = 2048,
        };
        esp_http_client_handle_t client = esp_http_client_init(&cfg);
        if (client) {
            char body[1536];
            int total = 0;
            if (esp_http_client_open(client, 0) == ESP_OK) {
                esp_http_client_fetch_headers(client);
                int rd;
                while ((rd = esp_http_client_read(client, body + total,
                                                  sizeof(body) - 1 - total)) > 0) {
                    total += rd;
                    if (total >= (int)sizeof(body) - 1) {
                        break;
                    }
                }
                body[total] = '\0';
            }
            esp_http_client_cleanup(client);

            if (total > 0) {
                cJSON *root = cJSON_Parse(body);
                if (root) {
                    const cJSON *lp = cJSON_GetObjectItem(root, "lastPrice");
                    const cJSON *cp = cJSON_GetObjectItem(root, "priceChangePercent");
                    if (cJSON_IsString(lp) && cJSON_IsString(cp)) {
                        crypto_apply_quote(atof(lp->valuestring), atof(cp->valuestring));
                    }
                    cJSON_Delete(root);
                }
            }
        }
        for (int i = 0; i < CCP_CFG_CRYPTO_POLL_S * 10 && s.poll_run; i++) {
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
    s.poll_task = NULL;
    vTaskDelete(NULL);
}

static void build_crypto_page(page_t *page)
{
    lv_obj_t *scr = page->screen;

    /* header: pair + live dot */
    lv_obj_t *pair = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(pair, &lv_font_montserrat_28, 0);
#endif
    lv_obj_set_style_text_color(pair, lv_color_hex(COL_FG), 0);
    lv_label_set_text(pair, s.cfg.crypto_display);
    lv_obj_align(pair, LV_ALIGN_TOP_LEFT, 18, 14);

    s.crypto_dot = lv_obj_create(scr);
    lv_obj_remove_style_all(s.crypto_dot);
    lv_obj_set_size(s.crypto_dot, 10, 10);
    lv_obj_set_style_radius(s.crypto_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(s.crypto_dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s.crypto_dot, lv_color_hex(COL_MUTED), 0);
    lv_obj_align_to(s.crypto_dot, pair, LV_ALIGN_OUT_RIGHT_MID, 10, 0);

    /* price */
    s.lbl_price = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_48
    lv_obj_set_style_text_font(s.lbl_price, &lv_font_montserrat_48, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_price, lv_color_hex(COL_FG), 0);
    lv_label_set_text(s.lbl_price, "$ --");
    lv_obj_align(s.lbl_price, LV_ALIGN_TOP_LEFT, 18, 58);

    s.lbl_change = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(s.lbl_change, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_change, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(s.lbl_change, "waiting for data...");
    lv_obj_align(s.lbl_change, LV_ALIGN_TOP_LEFT, 20, 116);

    /* sparkline */
    s.spark = lv_chart_create(scr);
    lv_obj_set_size(s.spark, 444, 130);
    lv_obj_align(s.spark, LV_ALIGN_BOTTOM_MID, 0, -38);
    lv_obj_set_style_bg_color(s.spark, lv_color_hex(COL_PANEL), 0);
    lv_obj_set_style_border_color(s.spark, lv_color_hex(COL_BORDER), 0);
    lv_obj_set_style_border_width(s.spark, 1, 0);
    lv_obj_set_style_radius(s.spark, 12, 0);
    lv_obj_set_style_size(s.spark, 0, 0, LV_PART_INDICATOR); /* hide point dots */
    lv_chart_set_type(s.spark, LV_CHART_TYPE_LINE);
    lv_chart_set_point_count(s.spark, SPARK_POINTS);
    lv_chart_set_update_mode(s.spark, LV_CHART_UPDATE_MODE_SHIFT);
    lv_chart_set_div_line_count(s.spark, 3, 0);
    s.spark_ser = lv_chart_add_series(s.spark, lv_color_hex(COL_ACCENT), LV_CHART_AXIS_PRIMARY_Y);

    s.lbl_updated = lv_label_create(scr);
    lv_obj_set_style_text_color(s.lbl_updated, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(s.lbl_updated, s.net_connected ? "connecting..." : "offline");
    lv_obj_align(s.lbl_updated, LV_ALIGN_BOTTOM_RIGHT, -16, -18);

    if (!s.poll_task) {
        s.poll_run = true;
        xTaskCreatePinnedToCore(crypto_poll_task, "crypto_poll", 6144, NULL, 3, &s.poll_task, 0);
    }
}

/* ============================================================ slideshow */

static void slideshow_scan(void)
{
    s.slide_count = 0;
    const char *dir_path = STORAGE_SD_BASE "/pages/slideshow/assets";
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

static void slide_show_current(void)
{
    if (s.slide_count == 0 || !s.slide_img) {
        return;
    }
    lv_image_set_src(s.slide_img, s.slides[s.slide_idx]);
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, s.slide_img);
    lv_anim_set_exec_cb(&a, slide_fade_in);
    lv_anim_set_values(&a, LV_OPA_TRANSP, LV_OPA_COVER);
    lv_anim_set_duration(&a, 450);
    lv_anim_start(&a);
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
            LV_SYMBOL_IMAGE "  No images found\n\n"
            "Put PNG/JPG (320x240) files in\nSD card: /pages/slideshow/assets/");
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
    s.poll_run = false;
    if (s.menu) { lv_obj_delete(s.menu); s.menu = NULL; }
    for (int i = 0; i < s.page_count; i++) {
        if (s.pages[i].screen) {
            lv_obj_delete(s.pages[i].screen);
            s.pages[i].screen = NULL;
        }
    }
    s.spark = NULL;
    s.spark_ser = NULL;
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
    ESP_LOGI(TAG, "home_ui: %d pages, symbol=%s, tz=%+d min",
             s.page_count, s.cfg.crypto_symbol, s.cfg.tz_offset_min);
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
    destroy_pages();
    cfg_load(&s.cfg);
    setup_pages_from_cfg();
    ccp_board_set_brightness(s.cfg.brightness);
    if (s.owns_screen) {
        goto_page(0, true);
    }
    display_engine_unlock();
    return ESP_OK;
}
