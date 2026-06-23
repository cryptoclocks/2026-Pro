#include "home_ui.h"
#include "ui_renderer.h"
#include "sync_manager.h"
#include "display_engine.h"
#include "storage.h"
#include "ccp_board.h"
#include "net_manager.h"
#include "device_security.h"
#include "ota_manager.h"
#include "audio_engine.h"

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
#define CRYPTO_POLL_STACK 4096

typedef enum { PAGE_CLOCK, PAGE_CRYPTO, PAGE_SLIDESHOW, PAGE_PACKAGE } page_kind_t;

typedef struct {
    page_kind_t kind;
    char id[16];
    char dir[200];   /* installed package dir for PAGE_PACKAGE; "" for native */
    lv_obj_t *screen;
    bool external;   /* screen owned by ui_renderer (purchased page) */
} page_t;

#define MAX_SYMBOLS 4
#define MAX_ALERTS  8
#define MAX_ALARMS  8

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
    char timeframe[8];          /* chart history candles: 15m / 1h / 4h / 1d */
    /* price alerts — unlocked when the owner links the device via app login */
    struct { char symbol[16]; bool above; double price; } alerts[MAX_ALERTS];
    int alert_count;
    bool alerts_unlocked;
    /* clock alarms — unlocked when the device holds the "clock-alarm" right.
     * days = weekday bitmask bit0=Mon..bit6=Sun; 0 = ring once at next match. */
    struct { char time[6]; uint8_t days; bool enabled; char label[24];
             char sound[16]; int snooze_min; } alarms[MAX_ALARMS];
    int alarm_count;
    bool alarm_unlocked;
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
    lv_obj_t *park_screen;
    bool net_connected;
    char ip[16];

    /* clock */
    lv_obj_t *lbl_time, *lbl_sec, *lbl_date;
    lv_timer_t *clock_timer;

    /* crypto */
    lv_obj_t *lbl_price, *lbl_change, *lbl_updated, *crypto_dot;
    lv_obj_t *lbl_pair, *btn_symbol_lbl, *btn_cur_lbl, *coin_logo;
    /* candlestick chart (TradingView-style, drawn on a canvas) */
    lv_obj_t *candle_canvas;
    void *candle_buf;                       /* RGB565 canvas backing buffer (PSRAM) */
    struct { float o, h, l, c; } candles[SPARK_POINTS];
    int candle_count;
    lv_obj_t *btn_tf_lbl;
    volatile int tf_idx;
    volatile bool need_history;  /* poll task should (re)fetch klines */
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

    /* price alerts */
    lv_obj_t *alert_overlay;
    volatile int alert_cur;             /* rule index currently showing, -1 = none */
    int64_t alert_snooze_until[MAX_ALERTS];
    bool alert_off[MAX_ALERTS];         /* Stop = disabled for this session */

    /* clock alarms — overlay on lv_layer_top covers any page; a global 1Hz
     * timer (alarm_timer) compares wall-clock time to each enabled alarm. */
    lv_obj_t *alarm_overlay;
    volatile int alarm_cur;             /* alarm index currently ringing, -1 = none */
    int64_t alarm_snooze_until[MAX_ALARMS];
    int64_t alarm_armed_key[MAX_ALARMS]; /* minute-key already fired (de-dupe) */
    lv_timer_t *alarm_timer;

    /* menu */
    lv_obj_t *menu;

    /* lazy package swap: only one package is loaded in the renderer at a time;
     * swiping to a different package page asks app_main to swap it in. */
    bool (*pkg_activator)(const char *dir, const char *slug);
    char loaded_pkg_slug[16];   /* slug currently loaded in ui_renderer; "" if none */
    lv_obj_t *loading_screen;   /* shown while a swap is in flight */
    int pending_idx;            /* target page index awaiting a swap */
    bool pending_anim_left;
    bool swap_pending;          /* a swap is in flight; ignore further nav */
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
    strcpy(c->timeframe, "15m");
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
        const cJSON *alarms = cJSON_GetObjectItem(clock, "alarms");
        if (cJSON_IsArray(alarms)) {
            c->alarm_count = 0;
            const cJSON *a;
            cJSON_ArrayForEach(a, alarms) {
                if (c->alarm_count >= MAX_ALARMS) break;
                const cJSON *t = cJSON_GetObjectItem(a, "time");
                if (!cJSON_IsString(t)) continue;
                int idx = c->alarm_count;
                strlcpy(c->alarms[idx].time, t->valuestring, sizeof(c->alarms[idx].time));
                const cJSON *en = cJSON_GetObjectItem(a, "enabled");
                c->alarms[idx].enabled = en ? cJSON_IsTrue(en) : true;
                const cJSON *lbl = cJSON_GetObjectItem(a, "label");
                strlcpy(c->alarms[idx].label, cJSON_IsString(lbl) ? lbl->valuestring : "",
                        sizeof(c->alarms[idx].label));
                const cJSON *snd = cJSON_GetObjectItem(a, "sound");
                strlcpy(c->alarms[idx].sound, cJSON_IsString(snd) ? snd->valuestring : "beep",
                        sizeof(c->alarms[idx].sound));
                const cJSON *snz = cJSON_GetObjectItem(a, "snooze");
                c->alarms[idx].snooze_min =
                    (cJSON_IsNumber(snz) && snz->valueint > 0) ? snz->valueint : 5;
                uint8_t mask = 0;
                const cJSON *days = cJSON_GetObjectItem(a, "days");
                if (cJSON_IsArray(days)) {
                    const cJSON *d;
                    cJSON_ArrayForEach(d, days) {
                        if (cJSON_IsNumber(d) && d->valueint >= 1 && d->valueint <= 7)
                            mask |= (uint8_t)(1 << (d->valueint - 1));
                    }
                }
                c->alarms[idx].days = mask;
                c->alarm_count++;
            }
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
        const cJSON *tf = cJSON_GetObjectItem(crypto, "timeframe");
        if (cJSON_IsString(tf)) {
            strlcpy(c->timeframe, tf->valuestring, sizeof(c->timeframe));
        }
        const cJSON *alerts = cJSON_GetObjectItem(crypto, "alerts");
        if (cJSON_IsArray(alerts)) {
            c->alert_count = 0;
            const cJSON *a;
            cJSON_ArrayForEach(a, alerts) {
                if (c->alert_count >= MAX_ALERTS) {
                    break;
                }
                const cJSON *asym = cJSON_GetObjectItem(a, "symbol");
                const cJSON *adir = cJSON_GetObjectItem(a, "dir");
                const cJSON *apr  = cJSON_GetObjectItem(a, "price");
                if (cJSON_IsString(asym) && cJSON_IsNumber(apr) && apr->valuedouble > 0) {
                    strlcpy(c->alerts[c->alert_count].symbol, asym->valuestring, 16);
                    c->alerts[c->alert_count].above =
                        !(cJSON_IsString(adir) && !strcmp(adir->valuestring, "below"));
                    c->alerts[c->alert_count].price = apr->valuedouble;
                    c->alert_count++;
                }
            }
        }
    }
    /* The device self-gates features by its server-granted entitlements:
     * settings.entitlements = ["crypto-alerts", "weather", ...]. Price alerts
     * only run when this specific CryptoClock holds "crypto-alerts". */
    const cJSON *ents = cJSON_GetObjectItem(root, "entitlements");
    if (cJSON_IsArray(ents)) {
        c->alerts_unlocked = false;
        c->alarm_unlocked = false;
        const cJSON *e;
        cJSON_ArrayForEach(e, ents) {
            if (!cJSON_IsString(e)) continue;
            if (!strcmp(e->valuestring, "crypto-alerts")) c->alerts_unlocked = true;
            else if (!strcmp(e->valuestring, "clock-alarm")) c->alarm_unlocked = true;
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
    /* Debounce: the touch panel (flaky i2c pull-ups) occasionally emits stray
     * gestures. Ignore swipes that arrive too soon after the last accepted one
     * so a burst can't thrash the page rotation (each package swipe reloads). */
    static uint32_t last_ms;
    uint32_t now = lv_tick_get();
    if (now - last_ms < 600) {
        return;
    }
    lv_dir_t dir = lv_indev_get_gesture_dir(indev);
    if (dir == LV_DIR_LEFT) {
        last_ms = now;
        goto_page((s.current + 1) % s.page_count, true);
    } else if (dir == LV_DIR_RIGHT) {
        last_ms = now;
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
    lv_label_set_text_fmt(s.lbl_sec, "%02d", tm.tm_sec);
    lv_label_set_text_fmt(s.lbl_date, "%s  %d %s %d",
                          WD[tm.tm_wday], tm.tm_mday, MO[tm.tm_mon], tm.tm_year + 1900);
}

static void build_clock_page(page_t *page)
{
    lv_obj_t *scr = page->screen;

    const clock_theme_t th = s.cfg.clock_theme;

    /* oversized time: montserrat 48pt scaled ~3.5x; larger values can wedge LVGL layout */
#define CLOCK_TIME_SCALE 900          /* 256 = 1x */
#define CLOCK_TIME_Y     (-20)        /* time block center offset from screen center */
    s.lbl_time = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_48
    lv_obj_set_style_text_font(s.lbl_time, &lv_font_montserrat_48, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_time, lv_color_hex(THEMES[th].time), 0);
    lv_obj_set_style_transform_scale(s.lbl_time, CLOCK_TIME_SCALE, 0);
    lv_obj_set_style_transform_pivot_x(s.lbl_time, lv_pct(50), 0);
    lv_obj_set_style_transform_pivot_y(s.lbl_time, lv_pct(50), 0);
    lv_label_set_text(s.lbl_time, "00:00");   /* measure with real digits */
    lv_obj_align(s.lbl_time, LV_ALIGN_CENTER, 0, CLOCK_TIME_Y);

    /* measure the (unscaled) text box, then derive the visual extents */
    lv_obj_update_layout(scr);
    lv_coord_t tw = lv_obj_get_width(s.lbl_time);
    lv_coord_t thh = lv_obj_get_height(s.lbl_time);
    int vis_hw = (tw * CLOCK_TIME_SCALE / 256) / 2;  /* visual half-width */
    int vis_hh = (thh * CLOCK_TIME_SCALE / 256) / 2; /* visual half-height */
    lv_label_set_text(s.lbl_time, "--:--");

    /* seconds: small orange, hugging the bottom-right of the minutes digits */
    s.lbl_sec = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(s.lbl_sec, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_sec, lv_color_hex(0xFF9500), 0); /* orange */
    lv_label_set_text(s.lbl_sec, "");
    lv_obj_align(s.lbl_sec, LV_ALIGN_CENTER, vis_hw + 12, CLOCK_TIME_Y + vis_hh - 32);

    /* date: above the time block */
    s.lbl_date = lv_label_create(scr);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(s.lbl_date, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(s.lbl_date, lv_color_hex(THEMES[th].date), 0);
    lv_label_set_text(s.lbl_date, "");
    lv_obj_align(s.lbl_date, LV_ALIGN_CENTER, 0, CLOCK_TIME_Y - vis_hh - 6);

    /* brand logo bottom-center (uploaded to /pages/clock/assets/logo.png) */
    const char *logo_dirs[2] = { STORAGE_SD_BASE, STORAGE_LFS_BASE };
    for (int i = 0; i < 2; i++) {
        char p[80];
        snprintf(p, sizeof(p), "%s/pages/clock/assets/logo.png", logo_dirs[i]);
        struct stat st;
        if (stat(p, &st) == 0) {
            lv_obj_t *logo = lv_image_create(scr);
            char lvp[96];
            snprintf(lvp, sizeof(lvp), "A:%s", p);
            lv_image_set_src(logo, lvp);
            lv_obj_align(logo, LV_ALIGN_BOTTOM_MID, 0, -6);
            break;
        }
    }

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

static void candle_render(void);

static void crypto_apply_quote(double last, double chg_pct)
{
    if (!display_engine_lock(200)) {
        return;
    }
    s.last_usd_price = last;
    s.last_chg_pct = chg_pct;
    crypto_render();
    ESP_LOGI(TAG, "quote %s: %.2f (%+.2f%%)",
             s.cfg.symbols[s.cur_symbol], last, chg_pct);
    /* live tick updates the most recent (forming) candle's close/high/low */
    if (s.candle_canvas && s.candle_count > 0) {
        float p = (float)last;
        int i = s.candle_count - 1;
        s.candles[i].c = p;
        if (p > s.candles[i].h) s.candles[i].h = p;
        if (p < s.candles[i].l) s.candles[i].l = p;
    }
    s.last_quote_ms = (int64_t)(lv_tick_get());
    display_engine_unlock();
    if (s.candle_canvas && s.candle_count > 0) {
        candle_render(); /* re-locks internally */
    }
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

static int fetch_klines_text(const char *symbol, const char *interval, char *body, size_t body_len)
{
    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/market/%s/klines/%s?limit=%d",
             CCP_CFG_SERVER_BASE_URL, symbol, interval, SPARK_POINTS);
    int n = http_get_text(url, body, body_len);
    if (n > 0) {
        return n;
    }

    snprintf(url, sizeof(url),
             "https://api.binance.com/api/v3/klines?symbol=%s&interval=%s&limit=%d",
             symbol, interval, SPARK_POINTS);
    return http_get_text(url, body, body_len);
}

static int fetch_ticker24h_text(const char *symbol, char *body, size_t body_len)
{
    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/market/%s/ticker24h",
             CCP_CFG_SERVER_BASE_URL, symbol);
    int n = http_get_text(url, body, body_len);
    if (n > 0) {
        return n;
    }

    snprintf(url, sizeof(url),
             "https://api.binance.com/api/v3/ticker/24hr?symbol=%s", symbol);
    return http_get_text(url, body, body_len);
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

/* candlestick chart geometry (matches the old chart panel footprint) */
#define CANDLE_W 444
#define CANDLE_H 130

static void candle_fill_rect(int x0, int y0, int x1, int y1, lv_color_t col)
{
    if (x0 > x1) { int t = x0; x0 = x1; x1 = t; }
    if (y0 > y1) { int t = y0; y0 = y1; y1 = t; }
    if (x1 < 0 || y1 < 0 || x0 >= CANDLE_W || y0 >= CANDLE_H) {
        return;
    }
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= CANDLE_W) x1 = CANDLE_W - 1;
    if (y1 >= CANDLE_H) y1 = CANDLE_H - 1;
    for (int y = y0; y <= y1; y++) {
        for (int x = x0; x <= x1; x++) {
            lv_canvas_set_px(s.candle_canvas, x, y, col, LV_OPA_COVER);
        }
    }
}

/* draw all candles green/red onto the canvas (TradingView-style) */
static void candle_render(void)
{
    if (!s.candle_canvas || s.candle_count <= 0) {
        return;
    }
    if (!display_engine_lock(500)) {
        return;
    }
    int n = s.candle_count;
    float lo = s.candles[0].l, hi = s.candles[0].h;
    for (int i = 1; i < n; i++) {
        if (s.candles[i].l < lo) lo = s.candles[i].l;
        if (s.candles[i].h > hi) hi = s.candles[i].h;
    }
    if (hi <= lo) hi = lo + 1.0f;
    float pad = (hi - lo) * 0.06f;
    lo -= pad; hi += pad;
    float range = hi - lo;

    lv_display_t *disp = lv_obj_get_display(s.candle_canvas);
    lv_display_enable_invalidation(disp, false);
    lv_canvas_fill_bg(s.candle_canvas, lv_color_hex(COL_PANEL), LV_OPA_COVER);

    int slot = CANDLE_W / n;
    if (slot < 1) slot = 1;
    int body_w = slot * 7 / 10;
    if (body_w < 1) body_w = 1;

    for (int i = 0; i < n; i++) {
        float o = s.candles[i].o, h = s.candles[i].h,
              l = s.candles[i].l, c = s.candles[i].c;
        bool up = c >= o;
        lv_color_t col = lv_color_hex(up ? COL_GREEN : COL_RED);

        int cx = i * slot + slot / 2;
        int y_h = (int)((hi - h) / range * (CANDLE_H - 1));
        int y_l = (int)((hi - l) / range * (CANDLE_H - 1));
        int y_o = (int)((hi - o) / range * (CANDLE_H - 1));
        int y_c = (int)((hi - c) / range * (CANDLE_H - 1));
        int body_top = y_o < y_c ? y_o : y_c;
        int body_bot = y_o < y_c ? y_c : y_o;
        if (body_bot - body_top < 1) body_bot = body_top + 1; /* doji */

        /* wick: 1px line at center, high->low */
        candle_fill_rect(cx, y_h, cx, y_l, col);
        /* body: filled rect open<->close */
        candle_fill_rect(cx - body_w / 2, body_top, cx - body_w / 2 + body_w, body_bot, col);
    }
    lv_display_enable_invalidation(disp, true);
    lv_obj_invalidate(s.candle_canvas);
    display_engine_unlock();
}

/* Binance klines = OHLC history; fields [openTime,open,high,low,close,...] */
static void fetch_klines(char *body, size_t body_len)
{
    int n = fetch_klines_text(s.cfg.symbols[s.cur_symbol], s.cfg.timeframe, body, body_len);
    if (n <= 0) {
        return;
    }
    cJSON *root = cJSON_ParseWithLength(body, n);
    if (!root) {
        return;
    }
    int cnt = 0;
    if (cJSON_IsArray(root)) {
        const cJSON *k;
        cJSON_ArrayForEach(k, root) {
            if (cnt >= SPARK_POINTS) {
                break;
            }
            const cJSON *o = cJSON_GetArrayItem(k, 1);
            const cJSON *h = cJSON_GetArrayItem(k, 2);
            const cJSON *l = cJSON_GetArrayItem(k, 3);
            const cJSON *c = cJSON_GetArrayItem(k, 4);
            if (cJSON_IsString(o) && cJSON_IsString(h) &&
                cJSON_IsString(l) && cJSON_IsString(c)) {
                s.candles[cnt].o = (float)atof(o->valuestring);
                s.candles[cnt].h = (float)atof(h->valuestring);
                s.candles[cnt].l = (float)atof(l->valuestring);
                s.candles[cnt].c = (float)atof(c->valuestring);
                cnt++;
            }
        }
    }
    cJSON_Delete(root);
    s.candle_count = cnt;
    if (cnt > 0) {
        candle_render();
    }
    ESP_LOGI(TAG, "klines %s %s: %d candles",
             s.cfg.symbols[s.cur_symbol], s.cfg.timeframe, cnt);
}

/* evaluate alert rules against live prices (one fetch per distinct symbol) */
static void alert_show(int idx, double price);

static void check_alerts(char *body, size_t body_len)
{
    char cached_sym[16] = "";
    double cached_price = 0;
    int64_t now = (int64_t)esp_log_timestamp();
    for (int i = 0; i < s.cfg.alert_count; i++) {
        if (s.alert_off[i] || s.alert_snooze_until[i] > now) {
            continue; /* stopped or snoozed */
        }
        double price;
        if (!strcmp(cached_sym, s.cfg.alerts[i].symbol)) {
            price = cached_price;
        } else {
            int n = fetch_ticker24h_text(s.cfg.alerts[i].symbol, body, body_len);
            if (n <= 0) {
                continue;
            }
            cJSON *root = cJSON_ParseWithLength(body, n);
            const cJSON *p = root ? cJSON_GetObjectItem(root, "lastPrice") : NULL;
            price = cJSON_IsString(p) ? atof(p->valuestring) : 0;
            cJSON_Delete(root);
            if (price <= 0) {
                continue;
            }
            strlcpy(cached_sym, s.cfg.alerts[i].symbol, sizeof(cached_sym));
            cached_price = price;
        }
        bool hit = s.cfg.alerts[i].above ? (price > s.cfg.alerts[i].price)
                                         : (price < s.cfg.alerts[i].price);
        if (hit) {
            s.alert_cur = i;
            alert_show(i, price);
            break; /* one alert at a time */
        }
    }
}

#define POLL_BODY_LEN 24576 /* 60 klines ≈ 12KB JSON */

static void crypto_poll_task(void *arg)
{
    /* PSRAM scratch keeps this task's stack small despite TLS work */
    char *body = heap_caps_malloc(POLL_BODY_LEN, MALLOC_CAP_SPIRAM);
    if (!body) {
        ESP_LOGE(TAG, "crypto poll scratch alloc failed");
        s.poll_task = NULL;
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "crypto poll task started (net=%d, symbol=%s, tf=%s)",
             s.net_connected, s.cfg.symbols[s.cur_symbol], s.cfg.timeframe);

    while (s.poll_run) {
        if (!s.net_connected) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        s.force_fetch = false;

        /* THB rate: fetch lazily, refresh hourly */
        if (s.cfg.currency_thb &&
            (s.usd_thb_rate <= 0 || esp_log_timestamp() - s.rate_fetched_ms > 3600 * 1000)) {
            fetch_thb_rate(body, POLL_BODY_LEN);
        }

        /* chart history first so the graph is full immediately */
        if (s.need_history) {
            s.need_history = false;
            fetch_klines(body, POLL_BODY_LEN);
        }

        int n = fetch_ticker24h_text(s.cfg.symbols[s.cur_symbol], body, POLL_BODY_LEN);
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

        /* price alerts (feature unlocked by app login) */
        if (s.cfg.alerts_unlocked && s.cfg.alert_count > 0 && !s.alert_overlay) {
            check_alerts(body, POLL_BODY_LEN);
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

static void crypto_start_poll_task(void)
{
    if (s.poll_task) {
        s.poll_run = true;
        return;
    }
    s.poll_run = true;
    BaseType_t ok = xTaskCreatePinnedToCore(crypto_poll_task, "crypto_poll",
                                            CRYPTO_POLL_STACK, NULL, 3,
                                            &s.poll_task, 0);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "crypto poll task start failed (largest internal=%u, psram=%u)",
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
        s.poll_run = false;
        s.poll_task = NULL;
    }
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
            /* Bundled coin icons are 32x32 PNGs, centered inside the 36px slot. */
            lv_image_set_inner_align(s.coin_logo, LV_IMAGE_ALIGN_CENTER);
            lv_image_set_scale(s.coin_logo, 256);
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
    s.candle_count = 0; /* drop old symbol's candles until history reloads */
    crypto_render();
    s.need_history = true;
    s.force_fetch = true;
}

static const char *TIMEFRAMES[] = { "15m", "1h", "4h", "1d" };
#define TIMEFRAME_COUNT 4

static void crypto_tf_btn_cb(lv_event_t *e)
{
    s.tf_idx = (s.tf_idx + 1) % TIMEFRAME_COUNT;
    strlcpy(s.cfg.timeframe, TIMEFRAMES[s.tf_idx], sizeof(s.cfg.timeframe));
    lv_label_set_text(s.btn_tf_lbl, s.cfg.timeframe);
    s.need_history = true;
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
    lv_obj_set_size(s.coin_logo, 36, 36);
    lv_obj_align(s.coin_logo, LV_ALIGN_TOP_LEFT, 10, 8);

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
        /* style "chart": price top, candlestick chart bottom */
        lv_obj_align(s.lbl_price, LV_ALIGN_TOP_LEFT, 18, 58);
        lv_obj_align(s.lbl_change, LV_ALIGN_TOP_LEFT, 20, 116);

        /* candlestick canvas (RGB565 in PSRAM) */
        if (!s.candle_buf) {
            s.candle_buf = heap_caps_malloc(
                LV_CANVAS_BUF_SIZE(CANDLE_W, CANDLE_H, 16, LV_DRAW_BUF_STRIDE_ALIGN),
                MALLOC_CAP_SPIRAM);
        }
        s.candle_canvas = lv_canvas_create(scr);
        if (s.candle_buf) {
            lv_canvas_set_buffer(s.candle_canvas, s.candle_buf, CANDLE_W, CANDLE_H,
                                 LV_COLOR_FORMAT_RGB565);
            lv_canvas_fill_bg(s.candle_canvas, lv_color_hex(COL_PANEL), LV_OPA_COVER);
        }
        lv_obj_set_size(s.candle_canvas, CANDLE_W, CANDLE_H);
        lv_obj_align(s.candle_canvas, LV_ALIGN_BOTTOM_MID, 0, -38);
        lv_obj_set_style_radius(s.candle_canvas, 12, 0);
        lv_obj_set_style_clip_corner(s.candle_canvas, true, 0);
        lv_obj_set_style_border_color(s.candle_canvas, lv_color_hex(COL_BORDER), 0);
        lv_obj_set_style_border_width(s.candle_canvas, 1, 0);

        /* timeframe cycle button under the chart, bottom-left */
        lv_obj_t *tf_btn = lv_button_create(scr);
        lv_obj_set_size(tf_btn, 64, 30);
        lv_obj_align(tf_btn, LV_ALIGN_BOTTOM_LEFT, 16, -4);
        lv_obj_set_style_bg_color(tf_btn, lv_color_hex(COL_PANEL), 0);
        lv_obj_set_style_border_width(tf_btn, 1, 0);
        lv_obj_set_style_border_color(tf_btn, lv_color_hex(COL_BORDER), 0);
        lv_obj_set_style_radius(tf_btn, 8, 0);
        lv_obj_set_style_shadow_width(tf_btn, 0, 0);
        s.btn_tf_lbl = lv_label_create(tf_btn);
        lv_obj_set_style_text_color(s.btn_tf_lbl, lv_color_hex(COL_FG), 0);
        lv_label_set_text(s.btn_tf_lbl, s.cfg.timeframe);
        lv_obj_center(s.btn_tf_lbl);
        lv_obj_add_event_cb(tf_btn, crypto_tf_btn_cb, LV_EVENT_CLICKED, NULL);
    }

    s.lbl_updated = lv_label_create(scr);
    lv_obj_set_style_text_color(s.lbl_updated, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(s.lbl_updated, s.net_connected ? "connecting..." : "offline");
    lv_obj_align(s.lbl_updated, LV_ALIGN_BOTTOM_RIGHT, -16, -18);

    crypto_update_header();

    /* timeframe index from config, fresh history for the (re)built chart */
    s.tf_idx = 0;
    for (int i = 0; i < TIMEFRAME_COUNT; i++) {
        if (!strcmp(s.cfg.timeframe, TIMEFRAMES[i])) {
            s.tf_idx = i;
            break;
        }
    }
    s.need_history = true;

    crypto_start_poll_task();
}

/* ============================================================== alerts */

static void alert_snooze_cb(lv_event_t *e)
{
    /* runs in the LVGL task, lock already held */
    if (s.alert_overlay) {
        lv_obj_delete(s.alert_overlay);
        s.alert_overlay = NULL;
    }
    if (s.alert_cur >= 0 && s.alert_cur < MAX_ALERTS) {
        s.alert_snooze_until[s.alert_cur] =
            (int64_t)esp_log_timestamp() + 5 * 60 * 1000;
    }
    s.alert_cur = -1;
    audio_engine_stop();
}

static void alert_stop_cb(lv_event_t *e)
{
    /* Stop = disable this rule until reboot / next config reload */
    if (s.alert_overlay) {
        lv_obj_delete(s.alert_overlay);
        s.alert_overlay = NULL;
    }
    if (s.alert_cur >= 0 && s.alert_cur < MAX_ALERTS) {
        s.alert_off[s.alert_cur] = true;
    }
    s.alert_cur = -1;
    audio_engine_stop();
}

/* full-screen alert on the top layer (covers any page, no screen swap) */
static void alert_show(int idx, double price)
{
    if (!display_engine_lock(500)) {
        return;
    }
    if (s.alert_overlay) {
        display_engine_unlock();
        return;
    }
    const bool above = s.cfg.alerts[idx].above;
    char base[12];
    symbol_base(s.cfg.alerts[idx].symbol, base, sizeof(base));

    lv_obj_t *ov = lv_obj_create(lv_layer_top());
    s.alert_overlay = ov;
    lv_obj_set_size(ov, lv_pct(100), lv_pct(100));
    lv_obj_set_style_bg_color(ov, lv_color_hex(0x200808), 0);
    lv_obj_set_style_bg_opa(ov, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(ov, 4, 0);
    lv_obj_set_style_border_color(ov, lv_color_hex(COL_RED), 0);
    lv_obj_set_style_radius(ov, 0, 0);
    lv_obj_remove_flag(ov, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *title = lv_label_create(ov);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(title, &lv_font_montserrat_28, 0);
#endif
    lv_obj_set_style_text_color(title, lv_color_hex(COL_RED), 0);
    lv_label_set_text(title, LV_SYMBOL_BELL "  PRICE ALERT");
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 16);

    lv_obj_t *what = lv_label_create(ov);
#if LV_FONT_MONTSERRAT_48
    lv_obj_set_style_text_font(what, &lv_font_montserrat_48, 0);
#endif
    lv_obj_set_style_text_color(what, lv_color_hex(COL_FG), 0);
    lv_label_set_text_fmt(what, "%s %s %.6g", base, above ? ">" : "<",
                          s.cfg.alerts[idx].price);
    lv_obj_align(what, LV_ALIGN_CENTER, 0, -46);

    lv_obj_t *nowlbl = lv_label_create(ov);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(nowlbl, &lv_font_montserrat_28, 0);
#endif
    lv_obj_set_style_text_color(nowlbl,
                                lv_color_hex(above ? COL_GREEN : COL_RED), 0);
    lv_label_set_text_fmt(nowlbl, "now  %.6g USDT", price);
    lv_obj_align(nowlbl, LV_ALIGN_CENTER, 0, 8);

    /* Snooze (5 min) on the left, Stop (disable rule) on the right */
    lv_obj_t *snz = lv_button_create(ov);
    lv_obj_set_size(snz, 200, 56);
    lv_obj_align(snz, LV_ALIGN_BOTTOM_LEFT, 20, -16);
    lv_obj_set_style_bg_color(snz, lv_color_hex(COL_ACCENT), 0);
    lv_obj_set_style_radius(snz, 12, 0);
    lv_obj_t *snzl = lv_label_create(snz);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(snzl, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(snzl, lv_color_hex(0x000000), 0);
    lv_label_set_text(snzl, LV_SYMBOL_MUTE "  SNOOZE 5m");
    lv_obj_center(snzl);
    lv_obj_add_event_cb(snz, alert_snooze_cb, LV_EVENT_CLICKED, NULL);

    lv_obj_t *stp = lv_button_create(ov);
    lv_obj_set_size(stp, 200, 56);
    lv_obj_align(stp, LV_ALIGN_BOTTOM_RIGHT, -20, -16);
    lv_obj_set_style_bg_color(stp, lv_color_hex(COL_RED), 0);
    lv_obj_set_style_radius(stp, 12, 0);
    lv_obj_t *stpl = lv_label_create(stp);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(stpl, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(stpl, lv_color_hex(0xFFFFFF), 0);
    lv_label_set_text(stpl, LV_SYMBOL_STOP "  STOP");
    lv_obj_center(stpl);
    lv_obj_add_event_cb(stp, alert_stop_cb, LV_EVENT_CLICKED, NULL);

    display_engine_unlock();

    char wav[80];
    snprintf(wav, sizeof(wav), "%s/pages/crypto/assets/alert.wav",
             storage_sd_mounted() ? STORAGE_SD_BASE : STORAGE_LFS_BASE);
    audio_engine_play_file(wav, true); /* loops until snooze */
    ESP_LOGI(TAG, "ALERT %s %s %.6g (now %.6g)", base, above ? ">" : "<",
             s.cfg.alerts[idx].price, price);
}

/* ============================================================== alarms */

/* a custom uploaded sound (a path / .wav) loops natively; presets are silent
 * here and beep via alarm_beep_preset() each second instead. */
static void alarm_play_sound(int idx)
{
    const char *snd = s.cfg.alarms[idx].sound;
    if (!strchr(snd, '/') && !strstr(snd, ".wav")) {
        return;
    }
    char path[96];
    if (snd[0] == '/') {
        snprintf(path, sizeof(path), "%s%s",
                 storage_sd_mounted() ? STORAGE_SD_BASE : STORAGE_LFS_BASE, snd);
    } else if (!strncmp(snd, "pages/", 6)) {
        snprintf(path, sizeof(path), "%s/%s",
                 storage_sd_mounted() ? STORAGE_SD_BASE : STORAGE_LFS_BASE, snd);
    } else {
        strlcpy(path, snd, sizeof(path));
    }
    audio_engine_play_file(path, true);
}

/* re-emit a preset beep so a preset alarm keeps ringing until dismissed
 * (called once a second by alarm_check while the overlay is up). */
static void alarm_beep_preset(int idx)
{
    const char *snd = s.cfg.alarms[idx].sound;
    if (strchr(snd, '/') || strstr(snd, ".wav")) {
        return; /* file sound loops on its own */
    }
    static bool toggle;
    toggle = !toggle;
    if (!strcmp(snd, "siren")) {
        audio_engine_tone(toggle ? 1100 : 700, 480, 80);
    } else if (!strcmp(snd, "chime")) {
        audio_engine_tone(toggle ? 1318 : 1047, 260, 70);
    } else { /* beep */
        audio_engine_tone(880, 250, 75);
    }
}

static void alarm_snooze_cb(lv_event_t *e)
{
    (void)e;
    if (s.alarm_overlay) {
        lv_obj_delete(s.alarm_overlay);
        s.alarm_overlay = NULL;
    }
    if (s.alarm_cur >= 0 && s.alarm_cur < MAX_ALARMS) {
        int mins = s.cfg.alarms[s.alarm_cur].snooze_min;
        if (mins <= 0) mins = 5;
        s.alarm_snooze_until[s.alarm_cur] =
            (int64_t)esp_log_timestamp() + (int64_t)mins * 60 * 1000;
    }
    s.alarm_cur = -1;
    audio_engine_stop();
}

static void alarm_stop_cb(lv_event_t *e)
{
    (void)e;
    if (s.alarm_overlay) {
        lv_obj_delete(s.alarm_overlay);
        s.alarm_overlay = NULL;
    }
    if (s.alarm_cur >= 0 && s.alarm_cur < MAX_ALARMS) {
        s.alarm_snooze_until[s.alarm_cur] = 0; /* drop any pending snooze */
    }
    s.alarm_cur = -1;
    audio_engine_stop();
}

/* full-screen alarm on the top layer (covers any page — native or package) */
static void alarm_show(int idx)
{
    if (!display_engine_lock(500)) {
        return;
    }
    if (s.alarm_overlay) {
        display_engine_unlock();
        return;
    }
    s.alarm_cur = idx;

    lv_obj_t *ov = lv_obj_create(lv_layer_top());
    s.alarm_overlay = ov;
    lv_obj_set_size(ov, lv_pct(100), lv_pct(100));
    lv_obj_set_style_bg_color(ov, lv_color_hex(0x081420), 0);
    lv_obj_set_style_bg_opa(ov, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(ov, 4, 0);
    lv_obj_set_style_border_color(ov, lv_color_hex(COL_ACCENT), 0);
    lv_obj_set_style_radius(ov, 0, 0);
    lv_obj_remove_flag(ov, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *title = lv_label_create(ov);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(title, &lv_font_montserrat_28, 0);
#endif
    lv_obj_set_style_text_color(title, lv_color_hex(COL_ACCENT), 0);
    lv_label_set_text(title, LV_SYMBOL_BELL "  ALARM");
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 16);

    lv_obj_t *tlbl = lv_label_create(ov);
#if LV_FONT_MONTSERRAT_48
    lv_obj_set_style_text_font(tlbl, &lv_font_montserrat_48, 0);
#endif
    lv_obj_set_style_text_color(tlbl, lv_color_hex(COL_FG), 0);
    lv_label_set_text(tlbl, s.cfg.alarms[idx].time);
    lv_obj_align(tlbl, LV_ALIGN_CENTER, 0, -40);

    if (s.cfg.alarms[idx].label[0]) {
        lv_obj_t *ll = lv_label_create(ov);
#if LV_FONT_MONTSERRAT_28
        lv_obj_set_style_text_font(ll, &lv_font_montserrat_28, 0);
#endif
        lv_obj_set_style_text_color(ll, lv_color_hex(0x848E9C), 0);
        lv_label_set_text(ll, s.cfg.alarms[idx].label);
        lv_obj_align(ll, LV_ALIGN_CENTER, 0, 14);
    }

    lv_obj_t *snz = lv_button_create(ov);
    lv_obj_set_size(snz, 200, 56);
    lv_obj_align(snz, LV_ALIGN_BOTTOM_LEFT, 20, -16);
    lv_obj_set_style_bg_color(snz, lv_color_hex(COL_ACCENT), 0);
    lv_obj_set_style_radius(snz, 12, 0);
    lv_obj_t *snzl = lv_label_create(snz);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(snzl, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(snzl, lv_color_hex(0x000000), 0);
    lv_label_set_text(snzl, LV_SYMBOL_MUTE "  SNOOZE");
    lv_obj_center(snzl);
    lv_obj_add_event_cb(snz, alarm_snooze_cb, LV_EVENT_CLICKED, NULL);

    lv_obj_t *stp = lv_button_create(ov);
    lv_obj_set_size(stp, 200, 56);
    lv_obj_align(stp, LV_ALIGN_BOTTOM_RIGHT, -20, -16);
    lv_obj_set_style_bg_color(stp, lv_color_hex(COL_RED), 0);
    lv_obj_set_style_radius(stp, 12, 0);
    lv_obj_t *stpl = lv_label_create(stp);
#if LV_FONT_MONTSERRAT_20
    lv_obj_set_style_text_font(stpl, &lv_font_montserrat_20, 0);
#endif
    lv_obj_set_style_text_color(stpl, lv_color_hex(0xFFFFFF), 0);
    lv_label_set_text(stpl, LV_SYMBOL_STOP "  STOP");
    lv_obj_center(stpl);
    lv_obj_add_event_cb(stp, alarm_stop_cb, LV_EVENT_CLICKED, NULL);

    display_engine_unlock();

    alarm_play_sound(idx);  /* file sounds loop */
    alarm_beep_preset(idx); /* preset: first beep immediately */
    ESP_LOGI(TAG, "ALARM %s %s", s.cfg.alarms[idx].time, s.cfg.alarms[idx].label);
}

/* global 1 Hz check: fires alarms whose time/day match, and snooze re-fires */
static void alarm_check(lv_timer_t *t)
{
    (void)t;
    if (s.alarm_overlay) {
        if (s.alarm_cur >= 0) alarm_beep_preset(s.alarm_cur); /* keep ringing */
        return;
    }
    if (!s.cfg.alarm_unlocked || s.cfg.alarm_count == 0) {
        return;
    }
    time_t now = time(NULL);
    if (now < 1600000000) { /* time not synced yet */
        return;
    }
    int64_t now_ms = (int64_t)esp_log_timestamp();
    time_t local = now + (time_t)s.cfg.tz_offset_min * 60;
    struct tm tm;
    gmtime_r(&local, &tm);
    int dnum = (tm.tm_wday == 0) ? 7 : tm.tm_wday; /* Mon=1..Sun=7 */
    uint8_t wbit = (uint8_t)(1 << (dnum - 1));
    int64_t minute_key =
        (int64_t)(local / 86400) * 1440 + tm.tm_hour * 60 + tm.tm_min;

    for (int i = 0; i < s.cfg.alarm_count; i++) {
        if (!s.cfg.alarms[i].enabled) continue;
        if (s.alarm_snooze_until[i] > 0) { /* snoozed: re-fire on expiry */
            if (now_ms >= s.alarm_snooze_until[i]) {
                s.alarm_snooze_until[i] = 0;
                alarm_show(i);
                return;
            }
            continue;
        }
        int hh = -1, mm = -1;
        if (sscanf(s.cfg.alarms[i].time, "%d:%d", &hh, &mm) != 2) continue;
        if (hh != tm.tm_hour || mm != tm.tm_min) continue;
        if (s.cfg.alarms[i].days != 0 && !(s.cfg.alarms[i].days & wbit)) continue;
        if (s.alarm_armed_key[i] == minute_key) continue; /* already fired this minute */
        s.alarm_armed_key[i] = minute_key;
        alarm_show(i);
        return;
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
                  "PNG (480x320) in /pages/slideshow/assets/\n"
                  "(SD card) or upload from the mobile app");
        lv_obj_center(s.slide_hint);
        return;
    }

    s.slide_img = lv_image_create(scr);
    lv_obj_set_size(s.slide_img, LV_HOR_RES, LV_VER_RES);
    lv_obj_center(s.slide_img);
    /* scale any non-fullscreen image to cover the 480x320 panel */
    lv_image_set_inner_align(s.slide_img, LV_IMAGE_ALIGN_CONTAIN);
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

    /* System info — mirrors the web "System" page */
    char macs[18] = "";
    device_security_mac_str(macs, sizeof(macs));
    char pkg[64] = "", pver[16] = "";
    sync_manager_active_id(pkg, sizeof(pkg));
    sync_manager_active_version(pver, sizeof(pver));

    lv_obj_t *idcap = lv_label_create(panel);
    lv_obj_set_style_text_color(idcap, lv_color_hex(COL_MUTED), 0);
    lv_label_set_text(idcap, "DEVICE ID");
    lv_obj_t *idval = lv_label_create(panel);
    lv_obj_set_style_text_color(idval, lv_color_hex(COL_FG), 0);
    lv_label_set_text(idval, device_security_id());

    char info[224];
    snprintf(info, sizeof(info), "fw %s\nIP: %s\nMAC: %s\nWiFi: %d dBm\nPage: %s%s%s",
             ota_manager_running_version(), s.ip[0] ? s.ip : "-", macs, net_manager_rssi(),
             pkg[0] ? pkg : "native", pver[0] ? " v" : "", pver);
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
    if (p->kind == PAGE_PACKAGE) {
        /* adopt the renderer-owned screen only when THIS page's package is the
         * one currently loaded; an unloaded package page stays unbuilt and is
         * brought in lazily via the swap in goto_page() */
        if (!strcmp(p->id, s.loaded_pkg_slug)) {
            lv_obj_t *pkg_scr = ui_renderer_main_screen();
            if (pkg_scr) {
                p->screen = pkg_scr;       /* swipe nav only, no home chrome */
                p->external = true;
                lv_obj_add_event_cb(p->screen, gesture_cb, LV_EVENT_GESTURE, NULL);
            }
        }
        return;
    }
    p->screen = screen_base();
    switch (p->kind) {
    case PAGE_CLOCK:     build_clock_page(p); break;
    case PAGE_CRYPTO:    build_crypto_page(p); break;
    case PAGE_SLIDESHOW: build_slideshow_page(p); break;
    case PAGE_PACKAGE:   break;
    }
    add_menu_button(p->screen);
    add_page_dots(p->screen, idx);
    lv_obj_add_event_cb(p->screen, gesture_cb, LV_EVENT_GESTURE, NULL);
}

/* per-page lifecycle: only the page on screen does background work, so swiping
 * to Crypto starts its Binance poll and swiping away stops it (and likewise the
 * slideshow timer). Package logic is gated by the lazy load/unload swap. */
static void page_leave(int idx)
{
    if (idx < 0 || idx >= s.page_count) {
        return;
    }
    switch (s.pages[idx].kind) {
    case PAGE_CRYPTO:    s.poll_run = false; break;
    case PAGE_SLIDESHOW: if (s.slide_timer) lv_timer_pause(s.slide_timer); break;
    default: break;
    }
}

static void page_enter(int idx)
{
    switch (s.pages[idx].kind) {
    case PAGE_CRYPTO:
        /* Keep the last quote visible while the poll task refreshes; clearing it
         * on every swipe made the page look like it was constantly resetting. */
        crypto_render();
        s.need_history = true;
        s.force_fetch = true;
        crypto_start_poll_task(); /* idempotent: re-arms an existing task */
        break;
    case PAGE_SLIDESHOW:
        if (s.slide_timer) lv_timer_resume(s.slide_timer);
        break;
    default: break;
    }
}

/* park on a spinner screen so the renderer can free the outgoing package's
 * screens during a swap without LVGL rendering a deleted screen */
static void show_loading_screen(void)
{
    if (!s.loading_screen) {
        s.loading_screen = screen_base();
        lv_obj_t *sp = lv_spinner_create(s.loading_screen);
        lv_obj_set_size(sp, 48, 48);
        lv_obj_center(sp);
        lv_obj_set_style_arc_color(sp, lv_color_hex(COL_ACCENT), LV_PART_INDICATOR);
        lv_obj_set_style_arc_color(sp, lv_color_hex(COL_BORDER), LV_PART_MAIN);
        lv_obj_set_style_arc_width(sp, 4, LV_PART_INDICATOR);
        lv_obj_set_style_arc_width(sp, 4, LV_PART_MAIN);
    }
    lv_screen_load(s.loading_screen);
    s.owns_screen = true;
}

/* dynamic mode: auto-advance pages; the slideshow page drives its own exit */
static void advance_tick(lv_timer_t *t)
{
    if (s.menu || s.page_count < 2 || s.swap_pending) {
        return;
    }
    if (s.pages[s.current].kind == PAGE_SLIDESHOW) {
        return;
    }
    goto_page((s.current + 1) % s.page_count, true);
}

static void goto_page(int idx, bool anim_left)
{
    if (idx < 0 || idx >= s.page_count || s.swap_pending) {
        return; /* ignore navigation while a package swap is in flight */
    }
    page_t *p = &s.pages[idx];

    page_leave(s.current);

    /* a package page that isn't the one currently in the renderer must be
     * swapped in first (off the LVGL task) — only one package is ever loaded */
    if (p->kind == PAGE_PACKAGE && strcmp(p->id, s.loaded_pkg_slug) && s.pkg_activator) {
        /* the swap frees the loaded package's screens — drop our adopted refs */
        for (int i = 0; i < s.page_count; i++) {
            if (s.pages[i].external) {
                lv_obj_remove_event_cb(s.pages[i].screen, gesture_cb);
                s.pages[i].screen = NULL;
                s.pages[i].external = false;
            }
        }
        show_loading_screen();
        s.pending_idx = idx;
        s.pending_anim_left = anim_left;
        s.swap_pending = true;
        if (s.pkg_activator(p->dir, p->id)) {
            return; /* finishes in home_ui_package_loaded() */
        }
        s.swap_pending = false; /* queue full — best effort, fall through */
    }

    build_page(idx);
    if (!s.pages[idx].screen) {
        return; /* package not loaded yet and no swap available */
    }
    s.current = idx;
    s.owns_screen = true;
    page_enter(idx);
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
    s.btn_tf_lbl = NULL;
    if (s.alert_overlay) {
        lv_obj_delete(s.alert_overlay);
        s.alert_overlay = NULL;
        audio_engine_stop();
    }
    s.alert_cur = -1;
    memset(s.alert_off, 0, sizeof(s.alert_off));
    memset(s.alert_snooze_until, 0, sizeof(s.alert_snooze_until));
    if (s.menu) { lv_obj_delete(s.menu); s.menu = NULL; }
    for (int i = 0; i < s.page_count; i++) {
        if (s.pages[i].screen) {
            if (s.pages[i].external) {
                lv_obj_remove_event_cb(s.pages[i].screen, gesture_cb);
            } else {
                lv_obj_delete(s.pages[i].screen);
            }
            s.pages[i].screen = NULL;
            s.pages[i].external = false;
        }
    }
    /* canvas object is destroyed with its screen; free the backing buffer */
    s.candle_canvas = NULL;
    if (s.candle_buf) {
        heap_caps_free(s.candle_buf);
        s.candle_buf = NULL;
    }
    s.candle_count = 0;
    s.slide_img = NULL;
    if (s.loading_screen) { lv_obj_delete(s.loading_screen); s.loading_screen = NULL; }
    s.swap_pending = false;
}

/* p001-p006 are the six canonical customer pages. Keep the firmware cap in
 * sync with that catalog so the last entitled page is not silently dropped. */
#define ROTATION_MAX 6

static void setup_pages_from_cfg(void)
{
    /* every installed package page joins the rotation (not just the active one);
     * the matching package is loaded lazily when the user swipes to it */
    s.page_count = 0;
    for (int i = 0; i < s.cfg.page_count && s.page_count < ROTATION_MAX; i++) {
        page_t *p = &s.pages[s.page_count];
        memset(p, 0, sizeof(*p));
        strlcpy(p->id, s.cfg.pages[i], sizeof(p->id));
        /* Prefer an installed custom package over the built-in renderer for the same
         * slug so a published com.ccp.<slug> (the Builder clock as com.ccp.clock)
         * replaces the native page — admin/device/app share one canonical slug. */
        if (sync_manager_installed_dir_for_slug(p->id, p->dir, sizeof(p->dir))) {
            p->kind = PAGE_PACKAGE;
        } else if (!strcmp(p->id, "clock")) {
            p->kind = PAGE_CLOCK;
        } else if (!strcmp(p->id, "crypto")) {
            p->kind = PAGE_CRYPTO;
        } else if (!strcmp(p->id, "slideshow")) {
            p->kind = PAGE_SLIDESHOW;
        } else {
            continue; /* page id without an installed package -> skip */
        }
        s.page_count++;
    }
    if (s.page_count == 0) {
        strcpy(s.pages[0].id, "clock");
        s.pages[0].kind = PAGE_CLOCK;
        s.page_count = 1;
    }
    /* whatever package app_main loaded at boot (the sync "active" one) is the one
     * currently in the renderer; record its slug so we only swap when needed */
    char pkg[64] = "";
    sync_manager_active_id(pkg, sizeof(pkg));
    const char *dot = strrchr(pkg, '.');
    strlcpy(s.loaded_pkg_slug, (dot && ui_renderer_main_screen()) ? dot + 1 : "",
            sizeof(s.loaded_pkg_slug));

    char list[96] = "";
    for (int i = 0; i < s.page_count; i++) {
        strlcat(list, s.pages[i].id, sizeof(list));
        if (i < s.page_count - 1) strlcat(list, ",", sizeof(list));
    }
    ESP_LOGI(TAG, "pages in rotation: %s (loaded pkg=%s)",
             list, s.loaded_pkg_slug[0] ? s.loaded_pkg_slug : "-");
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
    /* one global 1 Hz timer drives clock alarms regardless of the visible page */
    if (!s.alarm_timer) {
        s.alarm_cur = -1;
        s.alarm_timer = lv_timer_create(alarm_check, 1000, NULL);
    }
    display_engine_unlock();
}

bool home_ui_owns_screen(void) { return s.owns_screen; }

void home_ui_set_package_activator(bool (*fn)(const char *dir, const char *slug))
{
    s.pkg_activator = fn;
}

void home_ui_package_loaded(const char *slug, bool ok)
{
    /* runs on the sync worker (off the LVGL task). Wait for the lock like
     * home_ui_reload() does — a short timeout could lose to the loading-screen
     * spinner + the freshly-started package wasm and strand the swap. */
    if (!display_engine_lock(0)) {
        return;
    }
    const int idx = s.pending_idx;
    s.swap_pending = false;
    strlcpy(s.loaded_pkg_slug, (ok && slug) ? slug : "", sizeof(s.loaded_pkg_slug));

    if (idx >= 0 && idx < s.page_count) {
        build_page(idx); /* adopts the freshly loaded package screen */
    }
    if (idx >= 0 && idx < s.page_count && s.pages[idx].screen) {
        s.current = idx;
        s.owns_screen = true;
        page_enter(idx);
        lv_screen_load(s.pages[idx].screen); /* immediate (loading screen deleted next) */
    } else {
        /* swap failed: drop back to the first page (clock) */
        s.loaded_pkg_slug[0] = '\0';
        build_page(0);
        if (s.pages[0].screen) {
            s.current = 0;
            s.owns_screen = true;
            lv_screen_load(s.pages[0].screen);
        }
    }
    if (s.loading_screen) {
        lv_obj_delete(s.loading_screen);
        s.loading_screen = NULL;
    }
    if (s.advance_timer) {
        lv_timer_reset(s.advance_timer);
    }
    display_engine_unlock();
}

/* ---- serial debug helpers ---- */
int home_ui_debug_pages(char *buf, size_t len)
{
    int n = snprintf(buf, len, "pages(%d) current=%d loaded_pkg=%s%s:\n",
                     s.page_count, s.current,
                     s.loaded_pkg_slug[0] ? s.loaded_pkg_slug : "-",
                     s.swap_pending ? " [swapping]" : "");
    for (int i = 0; i < s.page_count && n < (int)len; i++) {
        n += snprintf(buf + n, len - n, "  [%d]%s %s%s%s%s\n", i, s.pages[i].id,
                      i == s.current ? "*" : "",
                      s.pages[i].kind == PAGE_PACKAGE ? "(pkg)" : "",
                      s.pages[i].kind == PAGE_PACKAGE ? " dir=" : "",
                      s.pages[i].kind == PAGE_PACKAGE ? s.pages[i].dir : "");
    }
    return s.page_count;
}

bool home_ui_goto_id(const char *id)
{
    for (int i = 0; i < s.page_count; i++) {
        if (!strcmp(s.pages[i].id, id)) {
            if (display_engine_lock(200)) {
                goto_page(i, i >= s.current);
                display_engine_unlock();
            }
            return true;
        }
    }
    return false;
}

void home_ui_network_changed(bool connected, const char *ip)
{
    s.net_connected = connected;
    if (ip) {
        strlcpy(s.ip, ip, sizeof(s.ip));
    }
}

void home_ui_park(void)
{
    if (!display_engine_lock(0)) {
        return;
    }
    if (s.owns_screen && !s.park_screen) {
        s.park_screen = lv_obj_create(NULL);
        lv_obj_set_style_bg_color(s.park_screen, lv_color_hex(COL_BG), 0);
        lv_screen_load(s.park_screen);
    }
    display_engine_unlock();
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
    /* reloaded alarms: drop any ringing/snooze so the new set re-arms cleanly */
    if (s.alarm_overlay) {
        lv_obj_delete(s.alarm_overlay);
        s.alarm_overlay = NULL;
    }
    s.alarm_cur = -1;
    audio_engine_stop();
    for (int i = 0; i < MAX_ALARMS; i++) {
        s.alarm_snooze_until[i] = 0;
        s.alarm_armed_key[i] = 0;
    }
    setup_pages_from_cfg();
    ccp_board_set_brightness(s.cfg.brightness);
    if (s.owns_screen) {
        s.current = 0;
        build_page(0);
        if (s.pages[0].screen) {
            /* immediate load (no anim) so parking can be deleted right away */
            lv_screen_load(s.pages[0].screen);
        } else {
            /* page 0 is a package not currently loaded — pull it in via the
             * normal lazy swap (parks on a loading screen, finishes async) */
            goto_page(0, true);
        }
        if (s.cfg.dynamic_mode && !s.advance_timer) {
            s.advance_timer = lv_timer_create(advance_tick,
                                              (uint32_t)s.cfg.page_delay_s * 1000, NULL);
        }
    }
    /* never delete the parking screen while it is still the active one */
    if (parking && lv_screen_active() != parking) {
        lv_obj_delete(parking);
    }
    if (s.park_screen) {
        lv_obj_delete(s.park_screen);
        s.park_screen = NULL;
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
