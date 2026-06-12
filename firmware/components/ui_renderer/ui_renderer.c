#include "ui_renderer.h"
#include "display_engine.h"
#include "storage.h"
#include "widgets/gif/lv_gif.h" /* lv_gif_class / lv_gif_set_src for runtime src binding */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_log.h"

static const char *TAG = "ui";

/* ------------------------------------------------------------- registry */

typedef enum {
    BIND_TEXT, BIND_VALUE, BIND_SERIES, BIND_VISIBLE, BIND_SRC,
    BIND_STYLE_TEXT_COLOR, BIND_STYLE_BG_COLOR,
} bind_prop_t;

typedef struct {
    int widget_idx;
    bind_prop_t prop;
    int series_n;
    int source_idx;
    char path[64];        /* $.a.b[0] subset */
    char format[24];      /* printf-like, ',' flag adds thousands */
    cJSON *map;           /* owned clone, may be NULL */
    float scale;
} binding_t;

typedef struct {
    char on[16];
    char act[16];         /* page.show | wasm.event | audio.play | ... */
    char target[64];
    char asset[32];
    int event_id;
    char key[32];
    char value[64];
} ui_action_t;

typedef struct {
    char id[32];
    lv_obj_t *obj;
    char type[16];
    char wasm_module[32]; /* canvas only */
    uint8_t touch_mode;   /* 0 none, 1 click, 2 drag */
    lv_point_t last_pt;
    ui_action_t *actions;
    int action_count;
} widget_ent_t;

typedef struct {
    char id[32];
    lv_obj_t *screen;
} page_ent_t;

typedef struct {
    char id[32];
    char stream[96];
} source_ent_t;

typedef struct {
    char id[32];
    char type[12];
    char abs_path[200];
} asset_ent_t;

static struct {
    ui_hooks_t hooks;
    widget_ent_t widgets[UI_MAX_WIDGETS];
    int widget_count;
    page_ent_t pages[UI_MAX_PAGES];
    int page_count;
    binding_t bindings[UI_MAX_BINDINGS];
    int binding_count;
    source_ent_t sources[UI_MAX_SOURCES];
    int source_count;
    ui_wasm_desc_t wasm[UI_MAX_WASM];
    int wasm_count;
    asset_ent_t assets[UI_MAX_ASSETS];
    int asset_count;
    char base_dir[160];
    lv_obj_t *system_screen; /* boot/provision/lock overlay screen */
} s_ui;

/* --------------------------------------------------------------- utils */

static lv_color_t parse_color(const char *hex, lv_color_t fallback)
{
    if (!hex || hex[0] != '#' || strlen(hex) < 7) {
        return fallback;
    }
    uint32_t v = (uint32_t)strtoul(hex + 1, NULL, 16);
    if (strlen(hex) >= 9) {
        v >>= 8; /* drop alpha */
    }
    return lv_color_hex(v);
}

static const lv_font_t *parse_font(const char *name)
{
    if (!name) return LV_FONT_DEFAULT;
#if LV_FONT_MONTSERRAT_14
    if (!strcmp(name, "montserrat_14")) return &lv_font_montserrat_14;
#endif
#if LV_FONT_MONTSERRAT_20
    if (!strcmp(name, "montserrat_20")) return &lv_font_montserrat_20;
#endif
#if LV_FONT_MONTSERRAT_28
    if (!strcmp(name, "montserrat_28")) return &lv_font_montserrat_28;
#endif
#if LV_FONT_MONTSERRAT_48
    if (!strcmp(name, "montserrat_48")) return &lv_font_montserrat_48;
#endif
    return LV_FONT_DEFAULT;
}

static const char *jstr(const cJSON *obj, const char *key, const char *dflt)
{
    const cJSON *it = cJSON_GetObjectItem(obj, key);
    return cJSON_IsString(it) ? it->valuestring : dflt;
}

static double jnum(const cJSON *obj, const char *key, double dflt)
{
    const cJSON *it = cJSON_GetObjectItem(obj, key);
    return cJSON_IsNumber(it) ? it->valuedouble : dflt;
}

static bool jbool(const cJSON *obj, const char *key, bool dflt)
{
    const cJSON *it = cJSON_GetObjectItem(obj, key);
    return cJSON_IsBool(it) ? cJSON_IsTrue(it) : dflt;
}

static const asset_ent_t *find_asset(const char *id)
{
    for (int i = 0; i < s_ui.asset_count; i++) {
        if (!strcmp(s_ui.assets[i].id, id)) {
            return &s_ui.assets[i];
        }
    }
    return NULL;
}

/* LVGL POSIX fs driver letter 'A' maps to the VFS root */
static void asset_lv_path(const asset_ent_t *a, char *out, size_t len)
{
    snprintf(out, len, "A:%s", a->abs_path);
}

/* ------------------------------------------------------- mini JSONPath */

/* Supports $.a.b[2].c — good enough for ticker/sensor payloads. */
static const cJSON *jsonpath(const cJSON *root, const char *path)
{
    if (!path || path[0] != '$') {
        return NULL;
    }
    const cJSON *cur = root;
    const char *p = path + 1;
    char key[48];
    while (*p && cur) {
        if (*p == '.') {
            p++;
            size_t k = 0;
            while (*p && *p != '.' && *p != '[' && k < sizeof(key) - 1) {
                key[k++] = *p++;
            }
            key[k] = '\0';
            if (k) {
                cur = cJSON_GetObjectItem(cur, key);
            }
        } else if (*p == '[') {
            int idx = atoi(p + 1);
            while (*p && *p != ']') {
                p++;
            }
            if (*p == ']') {
                p++;
            }
            cur = cJSON_GetArrayItem((cJSON *)cur, idx);
        } else {
            return NULL;
        }
    }
    return cur;
}

/* printf-subset with ',' thousands extension, e.g. "$%,.2f" "%+d%%" */
static void format_value(char *out, size_t out_len, const char *fmt, double num, const char *str)
{
    if (!fmt || !fmt[0]) {
        if (str) {
            snprintf(out, out_len, "%s", str);
        } else if (num == (long long)num) {
            snprintf(out, out_len, "%lld", (long long)num);
        } else {
            snprintf(out, out_len, "%.2f", num);
        }
        return;
    }

    /* split into prefix % spec suffix */
    const char *pct = strchr(fmt, '%');
    if (!pct) {
        snprintf(out, out_len, "%s", fmt);
        return;
    }
    char prefix[16] = {0}, spec[16] = {0}, suffix[16] = {0};
    size_t plen = (size_t)(pct - fmt);
    if (plen >= sizeof(prefix)) plen = sizeof(prefix) - 1;
    memcpy(prefix, fmt, plen);

    bool thousands = false;
    size_t si = 0;
    spec[si++] = '%';
    const char *p = pct + 1;
    if (*p == '%') { /* literal percent — treat rest as suffix */
        snprintf(out, out_len, "%s%%%s", prefix, p + 1);
        return;
    }
    for (; *p && si < sizeof(spec) - 2; p++) {
        if (*p == ',') {
            thousands = true;
            continue;
        }
        spec[si++] = *p;
        if (strchr("dfsxXu", *p)) {
            p++;
            break;
        }
    }
    spec[si] = '\0';
    snprintf(suffix, sizeof(suffix), "%s", p);

    char body[48];
    char conv = spec[si - 1];
    if (conv == 's') {
        snprintf(body, sizeof(body), spec, str ? str : "");
    } else if (conv == 'd' || conv == 'u' || conv == 'x' || conv == 'X') {
        /* rebuild spec with long-long length to match the cast */
        char llspec[20];
        size_t baselen = si - 1;
        if (baselen > sizeof(llspec) - 4) baselen = sizeof(llspec) - 4;
        memcpy(llspec, spec, baselen);
        llspec[baselen] = 'l';
        llspec[baselen + 1] = 'l';
        llspec[baselen + 2] = conv;
        llspec[baselen + 3] = '\0';
        snprintf(body, sizeof(body), llspec, (long long)num);
    } else {
        snprintf(body, sizeof(body), spec, num);
    }

    if (thousands) {
        /* insert separators into the integer part */
        char with_sep[64];
        const char *dot = strchr(body, '.');
        int int_len = dot ? (int)(dot - body) : (int)strlen(body);
        int start = (body[0] == '-' || body[0] == '+') ? 1 : 0;
        int digits = int_len - start;
        int wi = 0;
        for (int i = 0; i < int_len && wi < (int)sizeof(with_sep) - 2; i++) {
            with_sep[wi++] = body[i];
            int remaining = int_len - 1 - i;
            if (i >= start && remaining > 0 && remaining % 3 == 0) {
                with_sep[wi++] = ',';
            }
            (void)digits;
        }
        with_sep[wi] = '\0';
        if (dot) {
            strlcat(with_sep, dot, sizeof(with_sep));
        }
        snprintf(out, out_len, "%s%s%s", prefix, with_sep, suffix);
    } else {
        snprintf(out, out_len, "%s%s%s", prefix, body, suffix);
    }
}

/* ------------------------------------------------------------- actions */

static void run_action(const ui_action_t *a, widget_ent_t *w)
{
    if (!strcmp(a->act, "page.show")) {
        ui_renderer_show_page(a->target);
    } else if (!strcmp(a->act, "widget.set")) {
        int idx = ui_renderer_widget_index(a->target);
        if (idx >= 0) {
            widget_ent_t *target = &s_ui.widgets[idx];
            lv_obj_t *obj = target->obj;
            if (!strcmp(a->key, "text")) {
                if (!strcmp(target->type, "button")) {
                    lv_obj_t *lbl = lv_obj_get_child(obj, 0);
                    if (lbl) lv_label_set_text(lbl, a->value);
                } else if (!strcmp(target->type, "textarea")) {
                    lv_textarea_set_text(obj, a->value);
                } else {
                    lv_label_set_text(obj, a->value);
                }
            } else if (!strcmp(a->key, "value")) {
                int v = atoi(a->value);
                if (!strcmp(target->type, "arc")) lv_arc_set_value(obj, v);
                else if (!strcmp(target->type, "bar")) lv_bar_set_value(obj, v, LV_ANIM_ON);
                else if (!strcmp(target->type, "slider")) lv_slider_set_value(obj, v, LV_ANIM_OFF);
                else if (!strcmp(target->type, "switch")) {
                    if (v) lv_obj_add_state(obj, LV_STATE_CHECKED);
                    else lv_obj_remove_state(obj, LV_STATE_CHECKED);
                } else if (!strcmp(target->type, "led")) {
                    if (v) lv_led_on(obj);
                    else lv_led_off(obj);
                }
            } else if (!strcmp(a->key, "visible")) {
                if (atoi(a->value)) lv_obj_remove_flag(obj, LV_OBJ_FLAG_HIDDEN);
                else lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
            } else if (!strcmp(a->key, "style.text_color")) {
                lv_obj_set_style_text_color(obj, parse_color(a->value, lv_color_white()), 0);
            } else if (!strcmp(a->key, "style.bg_color")) {
                lv_obj_set_style_bg_color(obj, parse_color(a->value, lv_color_black()), 0);
            } else if (!strcmp(a->key, "src")) {
                const asset_ent_t *asset = find_asset(a->value);
                if (asset) {
                    char path[220];
                    asset_lv_path(asset, path, sizeof(path));
                    lv_image_set_src(obj, path);
                }
            }
        }
    } else if (!strcmp(a->act, "wasm.event")) {
        if (s_ui.hooks.wasm_event) {
            s_ui.hooks.wasm_event(a->target, (int)(w - s_ui.widgets),
                                  CCP_EVT_APP_BASE + a->event_id, 0, 0);
        }
    } else if (!strcmp(a->act, "audio.play")) {
        const asset_ent_t *asset = find_asset(a->asset);
        if (asset && s_ui.hooks.audio_play) {
            s_ui.hooks.audio_play(asset->abs_path, false);
        }
    } else if (!strcmp(a->act, "audio.stop")) {
        if (s_ui.hooks.audio_stop) {
            s_ui.hooks.audio_stop();
        }
    } else if (!strcmp(a->act, "mqtt.publish")) {
        if (s_ui.hooks.mqtt_publish_evt) {
            s_ui.hooks.mqtt_publish_evt(a->target[0] ? a->target : "ui",
                                        a->value[0] ? a->value : "{}");
        }
    } else if (!strcmp(a->act, "brightness.set")) {
        if (s_ui.hooks.brightness_set) {
            s_ui.hooks.brightness_set(atoi(a->value));
        }
    }
}

static void widget_event_cb(lv_event_t *e)
{
    widget_ent_t *w = lv_event_get_user_data(e);
    const lv_event_code_t code = lv_event_get_code(e);

    /* layout-declared actions */
    const char *on = NULL;
    switch (code) {
    case LV_EVENT_CLICKED:       on = "clicked"; break;
    case LV_EVENT_PRESSED:       on = "pressed"; break;
    case LV_EVENT_RELEASED:      on = "released"; break;
    case LV_EVENT_LONG_PRESSED:  on = "long_pressed"; break;
    case LV_EVENT_VALUE_CHANGED: on = "value_changed"; break;
    default: break;
    }
    if (on) {
        for (int i = 0; i < w->action_count; i++) {
            if (!strcmp(w->actions[i].on, on)) {
                run_action(&w->actions[i], w);
            }
        }
    }

    /* canvas touch forwarding to its WASM module */
    if (w->wasm_module[0] && s_ui.hooks.wasm_event && w->touch_mode > 0) {
        lv_indev_t *indev = lv_indev_active();
        lv_point_t pt = {0, 0};
        if (indev) {
            lv_indev_get_point(indev, &pt);
        }
        lv_area_t coords;
        lv_obj_get_coords(w->obj, &coords);
        int32_t lx = pt.x - coords.x1;
        int32_t ly = pt.y - coords.y1;
        const int idx = (int)(w - s_ui.widgets);

        switch (code) {
        case LV_EVENT_PRESSED:
            w->last_pt = pt;
            s_ui.hooks.wasm_event(w->wasm_module, idx, CCP_EVT_PRESSED, lx, ly);
            break;
        case LV_EVENT_PRESSING:
            if (w->touch_mode == 2) {
                int32_t dx = pt.x - w->last_pt.x;
                int32_t dy = pt.y - w->last_pt.y;
                if (dx || dy) {
                    w->last_pt = pt;
                    s_ui.hooks.wasm_event(w->wasm_module, idx, CCP_EVT_DRAG, dx, dy);
                }
            }
            break;
        case LV_EVENT_RELEASED:
            s_ui.hooks.wasm_event(w->wasm_module, idx, CCP_EVT_RELEASED, lx, ly);
            break;
        case LV_EVENT_CLICKED:
            s_ui.hooks.wasm_event(w->wasm_module, idx, CCP_EVT_CLICKED, lx, ly);
            break;
        default:
            break;
        }
    }
}

/* -------------------------------------------------------------- styles */

static void apply_style(lv_obj_t *obj, const cJSON *style)
{
    if (!style) {
        return;
    }
    const char *c;
    if ((c = jstr(style, "bg_color", NULL))) {
        lv_obj_set_style_bg_color(obj, parse_color(c, lv_color_black()), 0);
        lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
    }
    if ((c = jstr(style, "text_color", NULL))) {
        lv_obj_set_style_text_color(obj, parse_color(c, lv_color_white()), 0);
    }
    if ((c = jstr(style, "border_color", NULL))) {
        lv_obj_set_style_border_color(obj, parse_color(c, lv_color_black()), 0);
    }
    const cJSON *it;
    if ((it = cJSON_GetObjectItem(style, "border_width")) && cJSON_IsNumber(it)) {
        lv_obj_set_style_border_width(obj, it->valueint, 0);
    }
    if ((it = cJSON_GetObjectItem(style, "radius")) && cJSON_IsNumber(it)) {
        lv_obj_set_style_radius(obj, it->valueint, 0);
    }
    if ((it = cJSON_GetObjectItem(style, "pad")) && cJSON_IsNumber(it)) {
        lv_obj_set_style_pad_all(obj, it->valueint, 0);
    }
    if ((it = cJSON_GetObjectItem(style, "opa")) && cJSON_IsNumber(it)) {
        lv_obj_set_style_opa(obj, it->valueint, 0);
    }
    if ((it = cJSON_GetObjectItem(style, "bg_opa")) && cJSON_IsNumber(it)) {
        lv_obj_set_style_bg_opa(obj, it->valueint, 0);
    }
    if ((c = jstr(style, "font", NULL))) {
        lv_obj_set_style_text_font(obj, parse_font(c), 0);
    }
    /* scale: multiplier on top of the font (1.0 = none). Lets a page go larger
     * than montserrat_48 by transform-scaling, like the native clock. Pivot at
     * top-left so the widget keeps its x/y anchor as it grows. */
    if ((it = cJSON_GetObjectItem(style, "scale")) && cJSON_IsNumber(it) && it->valuedouble > 0) {
        /* transform_scale enlarges a label beyond the max bitmap font (like the
         * native clock's 3x time). Size to content + clip so the transformed
         * draw has a tight box. NOTE: transform_scale must NOT share a screen
         * with an animated GIF widget — LVGL's transformed draw + the GIF
         * decoder corrupt each other and crash. Safe on text-only pages. */
        if (lv_obj_check_type(obj, &lv_label_class)) {
            lv_label_set_long_mode(obj, LV_LABEL_LONG_CLIP);
            lv_obj_set_width(obj, LV_SIZE_CONTENT);
            lv_obj_set_height(obj, LV_SIZE_CONTENT);
        }
        lv_obj_set_style_transform_scale(obj, (int)(it->valuedouble * 256.0 + 0.5), 0);
    }
    if ((c = jstr(style, "align", NULL))) {
        lv_text_align_t a = LV_TEXT_ALIGN_LEFT;
        if (!strcmp(c, "center")) a = LV_TEXT_ALIGN_CENTER;
        else if (!strcmp(c, "right")) a = LV_TEXT_ALIGN_RIGHT;
        lv_obj_set_style_text_align(obj, a, 0);
    }
}

/* ------------------------------------------------------------- factory */

static lv_obj_t *create_widget(lv_obj_t *parent, const cJSON *node, widget_ent_t *ent)
{
    const char *type = jstr(node, "type", "panel");
    const cJSON *props = cJSON_GetObjectItem(node, "props");
    lv_obj_t *obj = NULL;

    if (!strcmp(type, "label")) {
        obj = lv_label_create(parent);
        lv_label_set_text(obj, jstr(props, "text", ""));
        lv_label_set_long_mode(obj, LV_LABEL_LONG_WRAP);
    } else if (!strcmp(type, "button")) {
        obj = lv_button_create(parent);
        lv_obj_t *lbl = lv_label_create(obj);
        lv_label_set_text(lbl, jstr(props, "text", ""));
        lv_obj_center(lbl);
    } else if (!strcmp(type, "image") || !strcmp(type, "gif")) {
#if LV_USE_GIF
        if (!strcmp(type, "gif")) {
            obj = lv_gif_create(parent);
        }
#endif
        if (!obj) {
            obj = lv_image_create(parent);
        }
        const char *src_id = jstr(props, "src", NULL);
        const asset_ent_t *a = src_id ? find_asset(src_id) : NULL;
        if (a) {
            char path[220];
            asset_lv_path(a, path, sizeof(path));
#if LV_USE_GIF
            if (!strcmp(type, "gif")) {
                lv_gif_set_src(obj, path);
            } else
#endif
            {
                lv_image_set_src(obj, path);
            }
        }
    } else if (!strcmp(type, "arc")) {
        obj = lv_arc_create(parent);
        lv_arc_set_range(obj, (int)jnum(props, "min", 0), (int)jnum(props, "max", 100));
        lv_arc_set_value(obj, (int)jnum(props, "value", 0));
        if (jbool(props, "readonly", true)) {
            lv_obj_remove_flag(obj, LV_OBJ_FLAG_CLICKABLE);
        }
    } else if (!strcmp(type, "bar")) {
        obj = lv_bar_create(parent);
        lv_bar_set_range(obj, (int)jnum(props, "min", 0), (int)jnum(props, "max", 100));
        lv_bar_set_value(obj, (int)jnum(props, "value", 0), LV_ANIM_OFF);
    } else if (!strcmp(type, "slider")) {
        obj = lv_slider_create(parent);
        lv_slider_set_range(obj, (int)jnum(props, "min", 0), (int)jnum(props, "max", 100));
        lv_slider_set_value(obj, (int)jnum(props, "value", 0), LV_ANIM_OFF);
    } else if (!strcmp(type, "switch")) {
        obj = lv_switch_create(parent);
        if (jbool(props, "checked", false)) {
            lv_obj_add_state(obj, LV_STATE_CHECKED);
        }
    } else if (!strcmp(type, "checkbox")) {
        obj = lv_checkbox_create(parent);
        lv_checkbox_set_text(obj, jstr(props, "text", ""));
        if (jbool(props, "checked", false)) {
            lv_obj_add_state(obj, LV_STATE_CHECKED);
        }
    } else if (!strcmp(type, "dropdown") || !strcmp(type, "roller")) {
        char opts[256] = {0};
        const cJSON *arr = cJSON_GetObjectItem(props, "options");
        const cJSON *o;
        cJSON_ArrayForEach(o, arr) {
            if (cJSON_IsString(o)) {
                if (opts[0]) {
                    strlcat(opts, "\n", sizeof(opts));
                }
                strlcat(opts, o->valuestring, sizeof(opts));
            }
        }
        if (!strcmp(type, "dropdown")) {
            obj = lv_dropdown_create(parent);
            lv_dropdown_set_options(obj, opts);
        } else {
            obj = lv_roller_create(parent);
            lv_roller_set_options(obj, opts, LV_ROLLER_MODE_NORMAL);
            lv_roller_set_visible_row_count(obj, (int)jnum(props, "visible_rows", 3));
        }
    } else if (!strcmp(type, "chart")) {
        obj = lv_chart_create(parent);
        const char *kind = jstr(props, "kind", "line");
        lv_chart_set_type(obj, !strcmp(kind, "bar") ? LV_CHART_TYPE_BAR : LV_CHART_TYPE_LINE);
        lv_chart_set_point_count(obj, (int)jnum(props, "points", 64));
        lv_chart_set_update_mode(obj, LV_CHART_UPDATE_MODE_SHIFT);
        const cJSON *series = cJSON_GetObjectItem(props, "series");
        int n = cJSON_IsArray(series) ? cJSON_GetArraySize(series) : 1;
        if (n < 1) n = 1;
        for (int i = 0; i < n && i < 4; i++) {
            lv_color_t col = lv_palette_main(LV_PALETTE_AMBER);
            const cJSON *sdef = series ? cJSON_GetArrayItem(series, i) : NULL;
            const char *chex = sdef ? jstr(sdef, "color", NULL) : NULL;
            if (chex) {
                col = parse_color(chex, col);
            }
            lv_chart_add_series(obj, col, LV_CHART_AXIS_PRIMARY_Y);
        }
        if (!jbool(props, "auto_range", true)) {
            lv_chart_set_range(obj, LV_CHART_AXIS_PRIMARY_Y,
                               (int)jnum(props, "y_min", 0), (int)jnum(props, "y_max", 100));
        }
    } else if (!strcmp(type, "canvas")) {
        obj = lv_canvas_create(parent);
        int w = (int)jnum(node, "w", 100), h = (int)jnum(node, "h", 100);
        void *buf = heap_caps_malloc((size_t)w * h * 2, MALLOC_CAP_SPIRAM);
        if (buf) {
            lv_canvas_set_buffer(obj, buf, w, h, LV_COLOR_FORMAT_RGB565);
            lv_canvas_fill_bg(obj, parse_color(jstr(props, "bg", "#000000"), lv_color_black()),
                              LV_OPA_COVER);
        }
        strlcpy(ent->wasm_module, jstr(props, "wasm", ""), sizeof(ent->wasm_module));
        const char *touch = jstr(props, "touch", "click");
        ent->touch_mode = !strcmp(touch, "drag") ? 2 : (!strcmp(touch, "none") ? 0 : 1);
        if (ent->touch_mode) {
            lv_obj_add_flag(obj, LV_OBJ_FLAG_CLICKABLE);
        }
    } else if (!strcmp(type, "table")) {
        obj = lv_table_create(parent);
        const cJSON *cols = cJSON_GetObjectItem(props, "cols");
        const cJSON *rows = cJSON_GetObjectItem(props, "rows");
        int ci = 0;
        const cJSON *cit;
        cJSON_ArrayForEach(cit, cols) {
            lv_table_set_cell_value(obj, 0, ci, jstr(cit, "title", ""));
            const cJSON *cw = cJSON_GetObjectItem(cit, "width");
            if (cJSON_IsNumber(cw)) {
                lv_table_set_column_width(obj, ci, cw->valueint);
            }
            ci++;
        }
        int ri = 1;
        const cJSON *rit;
        cJSON_ArrayForEach(rit, rows) {
            int cj = 0;
            const cJSON *cell;
            cJSON_ArrayForEach(cell, rit) {
                if (cJSON_IsString(cell)) {
                    lv_table_set_cell_value(obj, ri, cj, cell->valuestring);
                }
                cj++;
            }
            ri++;
        }
    } else if (!strcmp(type, "list")) {
        obj = lv_list_create(parent);
        const cJSON *items = cJSON_GetObjectItem(props, "items");
        const cJSON *iit;
        cJSON_ArrayForEach(iit, items) {
            lv_list_add_button(obj, NULL, jstr(iit, "text", ""));
        }
    } else if (!strcmp(type, "tabs")) {
        obj = lv_tabview_create(parent);
        const cJSON *titles = cJSON_GetObjectItem(props, "titles");
        const cJSON *tit;
        cJSON_ArrayForEach(tit, titles) {
            if (cJSON_IsString(tit)) {
                lv_tabview_add_tab(obj, tit->valuestring);
            }
        }
    } else if (!strcmp(type, "qrcode")) {
#if LV_USE_QRCODE
        obj = lv_qrcode_create(parent);
        int sz = (int)jnum(node, "w", 120);
        lv_qrcode_set_size(obj, sz);
        lv_qrcode_set_dark_color(obj, parse_color(jstr(props, "dark", "#000000"), lv_color_black()));
        lv_qrcode_set_light_color(obj, parse_color(jstr(props, "light", "#FFFFFF"), lv_color_white()));
        const char *txt = jstr(props, "text", "");
        lv_qrcode_update(obj, txt, strlen(txt));
#else
        obj = lv_label_create(parent);
        lv_label_set_text(obj, "[qrcode disabled]");
#endif
    } else if (!strcmp(type, "textarea")) {
        obj = lv_textarea_create(parent);
        lv_textarea_set_placeholder_text(obj, jstr(props, "placeholder", ""));
        lv_textarea_set_one_line(obj, jbool(props, "one_line", true));
        lv_textarea_set_password_mode(obj, jbool(props, "password", false));
    } else if (!strcmp(type, "keyboard")) {
        obj = lv_keyboard_create(parent);
    } else if (!strcmp(type, "spinner")) {
        obj = lv_spinner_create(parent);
    } else if (!strcmp(type, "led")) {
        obj = lv_led_create(parent);
        if (jbool(props, "on", true)) {
            lv_led_on(obj);
        } else {
            lv_led_off(obj);
        }
    } else if (!strcmp(type, "scale")) {
        obj = lv_scale_create(parent);
        const char *mode = jstr(props, "mode", "round");
        lv_scale_set_mode(obj, !strcmp(mode, "horizontal") ? LV_SCALE_MODE_HORIZONTAL_BOTTOM :
                               !strcmp(mode, "vertical") ? LV_SCALE_MODE_VERTICAL_LEFT :
                               LV_SCALE_MODE_ROUND_INNER);
        lv_scale_set_range(obj, (int)jnum(props, "min", 0), (int)jnum(props, "max", 100));
        lv_scale_set_total_tick_count(obj, (int)jnum(props, "major_ticks", 11));
        lv_scale_set_major_tick_every(obj, (int)jnum(props, "label_every", 2));
    } else if (!strcmp(type, "spinbox")) {
        obj = lv_spinbox_create(parent);
        lv_spinbox_set_range(obj, (int)jnum(props, "min", 0), (int)jnum(props, "max", 100));
        lv_spinbox_set_value(obj, (int)jnum(props, "value", 0));
    } else if (!strcmp(type, "analog_clock")) {
        /* composite: round scale; needle animation arrives with M2 polish */
        obj = lv_scale_create(parent);
        lv_scale_set_mode(obj, LV_SCALE_MODE_ROUND_INNER);
        lv_scale_set_range(obj, 0, 60);
        lv_scale_set_total_tick_count(obj, 61);
        lv_scale_set_major_tick_every(obj, 5);
    } else { /* panel / unknown -> container */
        obj = lv_obj_create(parent);
        lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(obj, 0, 0);
        if (!jbool(props, "scrollable", false)) {
            lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
        }
    }

    return obj;
}

static void parse_bindings(const cJSON *node, int widget_idx)
{
    const cJSON *arr = cJSON_GetObjectItem(node, "bindings");
    const cJSON *b;
    cJSON_ArrayForEach(b, arr) {
        if (s_ui.binding_count >= UI_MAX_BINDINGS) {
            return;
        }
        const char *prop = jstr(b, "prop", "");
        const char *source = jstr(b, "source", "");
        int src_idx = -1;
        for (int i = 0; i < s_ui.source_count; i++) {
            if (!strcmp(s_ui.sources[i].id, source)) {
                src_idx = i;
                break;
            }
        }
        if (src_idx < 0) {
            continue;
        }
        binding_t *bd = &s_ui.bindings[s_ui.binding_count];
        memset(bd, 0, sizeof(*bd));
        bd->widget_idx = widget_idx;
        bd->source_idx = src_idx;
        bd->scale = (float)jnum(b, "scale", 1.0);
        strlcpy(bd->path, jstr(b, "path", "$"), sizeof(bd->path));
        strlcpy(bd->format, jstr(b, "format", ""), sizeof(bd->format));
        const cJSON *map = cJSON_GetObjectItem(b, "map");
        bd->map = map ? cJSON_Duplicate(map, 1) : NULL;

        if (!strcmp(prop, "text")) bd->prop = BIND_TEXT;
        else if (!strcmp(prop, "value")) bd->prop = BIND_VALUE;
        else if (!strcmp(prop, "visible")) bd->prop = BIND_VISIBLE;
        else if (!strcmp(prop, "src")) bd->prop = BIND_SRC;
        else if (!strcmp(prop, "style.text_color")) bd->prop = BIND_STYLE_TEXT_COLOR;
        else if (!strcmp(prop, "style.bg_color")) bd->prop = BIND_STYLE_BG_COLOR;
        else if (!strncmp(prop, "series.", 7)) {
            bd->prop = BIND_SERIES;
            bd->series_n = atoi(prop + 7);
        } else {
            continue;
        }
        s_ui.binding_count++;
    }
}

static void parse_actions(const cJSON *node, widget_ent_t *ent)
{
    const cJSON *arr = cJSON_GetObjectItem(node, "actions");
    int n = cJSON_IsArray(arr) ? cJSON_GetArraySize(arr) : 0;
    if (n <= 0) {
        return;
    }
    ent->actions = calloc(n, sizeof(ui_action_t));
    if (!ent->actions) {
        return;
    }
    const cJSON *a;
    cJSON_ArrayForEach(a, arr) {
        ui_action_t *act = &ent->actions[ent->action_count];
        strlcpy(act->on, jstr(a, "on", "clicked"), sizeof(act->on));
        strlcpy(act->act, jstr(a, "do", ""), sizeof(act->act));
        strlcpy(act->target, jstr(a, "target", ""), sizeof(act->target));
        const char *topic_suffix = jstr(a, "topic_suffix", "");
        if (topic_suffix[0]) {
            strlcpy(act->target, topic_suffix, sizeof(act->target));
        }
        strlcpy(act->asset, jstr(a, "asset", ""), sizeof(act->asset));
        act->event_id = (int)jnum(a, "event_id", 0);
        strlcpy(act->key, jstr(a, "key", ""), sizeof(act->key));
        const cJSON *v = cJSON_GetObjectItem(a, "payload");
        if (!v) {
            v = cJSON_GetObjectItem(a, "value");
        }
        if (cJSON_IsNumber(v)) {
            snprintf(act->value, sizeof(act->value), "%d", v->valueint);
        } else if (cJSON_IsString(v)) {
            strlcpy(act->value, v->valuestring, sizeof(act->value));
        } else if (v) {
            char *s = cJSON_PrintUnformatted(v);
            if (s) {
                strlcpy(act->value, s, sizeof(act->value));
                free(s);
            }
        }
        ent->action_count++;
    }
}

static void build_widget_tree(lv_obj_t *parent, const cJSON *node)
{
    if (s_ui.widget_count >= UI_MAX_WIDGETS) {
        ESP_LOGW(TAG, "widget limit reached");
        return;
    }
    widget_ent_t *ent = &s_ui.widgets[s_ui.widget_count];
    memset(ent, 0, sizeof(*ent));
    strlcpy(ent->id, jstr(node, "id", ""), sizeof(ent->id));
    strlcpy(ent->type, jstr(node, "type", ""), sizeof(ent->type));

    lv_obj_t *obj = create_widget(parent, node, ent);
    if (!obj) {
        return;
    }
    ent->obj = obj;
    s_ui.widget_count++;

    lv_obj_set_pos(obj, (int)jnum(node, "x", 0), (int)jnum(node, "y", 0));
    lv_obj_set_size(obj, (int)jnum(node, "w", 50), (int)jnum(node, "h", 50));
    apply_style(obj, cJSON_GetObjectItem(node, "style"));
    if (jbool(node, "hidden", false)) {
        lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
    }

    parse_bindings(node, (int)(ent - s_ui.widgets));
    parse_actions(node, ent);
    if (ent->action_count > 0 || ent->wasm_module[0]) {
        lv_obj_add_event_cb(obj, widget_event_cb, LV_EVENT_ALL, ent);
    }

    const cJSON *children = cJSON_GetObjectItem(node, "children");
    const cJSON *child;
    cJSON_ArrayForEach(child, children) {
        build_widget_tree(obj, child);
    }
}

/* -------------------------------------------------------------- layout */

static void free_layout(void)
{
    for (int i = 0; i < s_ui.binding_count; i++) {
        if (s_ui.bindings[i].map) {
            cJSON_Delete(s_ui.bindings[i].map);
        }
    }
    for (int i = 0; i < s_ui.widget_count; i++) {
        free(s_ui.widgets[i].actions);
    }
    for (int i = 0; i < s_ui.page_count; i++) {
        if (s_ui.pages[i].screen) {
            lv_obj_delete(s_ui.pages[i].screen);
        }
    }
    s_ui.widget_count = s_ui.page_count = s_ui.binding_count = 0;
    s_ui.source_count = s_ui.wasm_count = s_ui.asset_count = 0;
}

esp_err_t ui_renderer_load_json(const char *json, size_t len, const char *base_dir)
{
    cJSON *root = cJSON_ParseWithLength(json, len);
    ESP_RETURN_ON_FALSE(root, ESP_ERR_INVALID_ARG, TAG, "layout parse error");

    if (!display_engine_lock(0)) {
        cJSON_Delete(root);
        return ESP_ERR_TIMEOUT;
    }
    free_layout();
    strlcpy(s_ui.base_dir, base_dir ? base_dir : "", sizeof(s_ui.base_dir));

    /* assets */
    const cJSON *assets = cJSON_GetObjectItem(root, "assets");
    const cJSON *a;
    cJSON_ArrayForEach(a, assets) {
        if (s_ui.asset_count >= UI_MAX_ASSETS) break;
        asset_ent_t *ent = &s_ui.assets[s_ui.asset_count++];
        strlcpy(ent->id, jstr(a, "id", ""), sizeof(ent->id));
        strlcpy(ent->type, jstr(a, "type", ""), sizeof(ent->type));
        snprintf(ent->abs_path, sizeof(ent->abs_path), "%s/%s",
                 s_ui.base_dir, jstr(a, "path", ""));
    }

    /* data sources */
    const cJSON *sources = cJSON_GetObjectItem(root, "data_sources");
    const cJSON *src;
    cJSON_ArrayForEach(src, sources) {
        if (s_ui.source_count >= UI_MAX_SOURCES) break;
        source_ent_t *ent = &s_ui.sources[s_ui.source_count++];
        strlcpy(ent->id, jstr(src, "id", ""), sizeof(ent->id));
        strlcpy(ent->stream, jstr(src, "stream", ""), sizeof(ent->stream));
    }

    /* wasm modules */
    const cJSON *wasms = cJSON_GetObjectItem(root, "wasm");
    const cJSON *wm;
    cJSON_ArrayForEach(wm, wasms) {
        if (s_ui.wasm_count >= UI_MAX_WASM) break;
        ui_wasm_desc_t *d = &s_ui.wasm[s_ui.wasm_count++];
        memset(d, 0, sizeof(*d));
        strlcpy(d->id, jstr(wm, "id", ""), sizeof(d->id));
        snprintf(d->path, sizeof(d->path), "%s/%s", s_ui.base_dir, jstr(wm, "path", ""));
        d->tick_ms = (uint32_t)jnum(wm, "tick_ms", 0);
        d->memory_kb = (uint32_t)jnum(wm, "memory_kb", 256);
        const cJSON *cids = cJSON_GetObjectItem(wm, "canvas_ids");
        const cJSON *cid0 = cJSON_GetArrayItem((cJSON *)cids, 0);
        if (cJSON_IsString(cid0)) {
            strlcpy(d->canvas_id, cid0->valuestring, sizeof(d->canvas_id));
        }
    }

    /* pages */
    const cJSON *pages = cJSON_GetObjectItem(root, "pages");
    const cJSON *pg;
    cJSON_ArrayForEach(pg, pages) {
        if (s_ui.page_count >= UI_MAX_PAGES) break;
        page_ent_t *p = &s_ui.pages[s_ui.page_count++];
        strlcpy(p->id, jstr(pg, "id", ""), sizeof(p->id));
        p->screen = lv_obj_create(NULL);
        lv_obj_set_style_bg_color(p->screen,
                                  parse_color(jstr(pg, "bg", "#000000"), lv_color_black()), 0);
        const cJSON *widgets = cJSON_GetObjectItem(pg, "widgets");
        const cJSON *wnode;
        cJSON_ArrayForEach(wnode, widgets) {
            build_widget_tree(p->screen, wnode);
        }
    }

    /* note: no lv_screen_load here — home_ui owns the display and adopts
     * package screens into its page rotation (ui_renderer_main_screen) */
    display_engine_unlock();
    cJSON_Delete(root);

    ESP_LOGI(TAG, "layout loaded: %d pages, %d widgets, %d bindings, %d wasm",
             s_ui.page_count, s_ui.widget_count, s_ui.binding_count, s_ui.wasm_count);
    return ESP_OK;
}

esp_err_t ui_renderer_load_dir(const char *package_dir)
{
    char path[220];
    snprintf(path, sizeof(path), "%s/layout.json", package_dir);
    size_t len = 0;
    char *json = storage_read_file(path, &len);
    ESP_RETURN_ON_FALSE(json, ESP_ERR_NOT_FOUND, TAG, "no layout at %s", path);
    esp_err_t err = ui_renderer_load_json(json, len, package_dir);
    free(json);
    return err;
}

esp_err_t ui_renderer_init(const ui_hooks_t *hooks)
{
    if (hooks) {
        s_ui.hooks = *hooks;
    }
    return ESP_OK;
}

lv_obj_t *ui_renderer_main_screen(void)
{
    return s_ui.page_count > 0 ? s_ui.pages[0].screen : NULL;
}

esp_err_t ui_renderer_show_page(const char *page_id)
{
    for (int i = 0; i < s_ui.page_count; i++) {
        if (!strcmp(s_ui.pages[i].id, page_id)) {
            lv_screen_load(s_ui.pages[i].screen);
            return ESP_OK;
        }
    }
    return ESP_ERR_NOT_FOUND;
}

int ui_renderer_widget_index(const char *id)
{
    for (int i = 0; i < s_ui.widget_count; i++) {
        if (!strcmp(s_ui.widgets[i].id, id)) {
            return i;
        }
    }
    return -1;
}

lv_obj_t *ui_renderer_widget_by_index(int idx)
{
    if (idx < 0 || idx >= s_ui.widget_count) {
        return NULL;
    }
    return s_ui.widgets[idx].obj;
}

const char *ui_renderer_widget_id(int idx)
{
    if (idx < 0 || idx >= s_ui.widget_count) {
        return "";
    }
    return s_ui.widgets[idx].id;
}

int ui_renderer_get_streams(char out[][96], int max)
{
    int n = 0;
    for (int i = 0; i < s_ui.source_count && n < max; i++) {
        strlcpy(out[n++], s_ui.sources[i].stream, 96);
    }
    return n;
}

int ui_renderer_get_wasm_modules(const ui_wasm_desc_t **out)
{
    *out = s_ui.wasm;
    return s_ui.wasm_count;
}

/* --------------------------------------------------------- data intake */

static void apply_binding(const binding_t *b, const cJSON *value)
{
    lv_obj_t *obj = ui_renderer_widget_by_index(b->widget_idx);
    if (!obj || !value) {
        return;
    }

    double num = cJSON_IsNumber(value) ? value->valuedouble * b->scale : 0;
    const char *str = cJSON_IsString(value) ? value->valuestring : NULL;

    /* value mapping (exact match or numeric sign classes) */
    char mapped[64] = {0};
    if (b->map) {
        const cJSON *hit = NULL;
        if (cJSON_IsNumber(value)) {
            if (num < 0) hit = cJSON_GetObjectItem(b->map, "lt0");
            if (!hit && num >= 0) hit = cJSON_GetObjectItem(b->map, "gte0");
            if (!hit && num > 0) hit = cJSON_GetObjectItem(b->map, "gt0");
        }
        if (!hit && str) {
            hit = cJSON_GetObjectItem(b->map, str);
        }
        if (cJSON_IsString(hit)) {
            strlcpy(mapped, hit->valuestring, sizeof(mapped));
            str = mapped;
        }
    }

    switch (b->prop) {
    case BIND_TEXT: {
        char text[96];
        format_value(text, sizeof(text), b->format, num, str);
        const widget_ent_t *w = &s_ui.widgets[b->widget_idx];
        if (!strcmp(w->type, "button")) {
            lv_obj_t *lbl = lv_obj_get_child(obj, 0);
            if (lbl) {
                lv_label_set_text(lbl, text);
            }
        } else {
            lv_label_set_text(obj, text);
        }
        break;
    }
    case BIND_VALUE: {
        const widget_ent_t *w = &s_ui.widgets[b->widget_idx];
        int v = (int)num;
        if (!strcmp(w->type, "arc")) lv_arc_set_value(obj, v);
        else if (!strcmp(w->type, "bar")) lv_bar_set_value(obj, v, LV_ANIM_ON);
        else if (!strcmp(w->type, "slider")) lv_slider_set_value(obj, v, LV_ANIM_OFF);
        else if (!strcmp(w->type, "switch")) {
            if (v) lv_obj_add_state(obj, LV_STATE_CHECKED);
            else lv_obj_remove_state(obj, LV_STATE_CHECKED);
        }
        break;
    }
    case BIND_VISIBLE:
        if ((cJSON_IsBool(value) && cJSON_IsTrue(value)) || num != 0) {
            lv_obj_remove_flag(obj, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
        }
        break;
    case BIND_STYLE_TEXT_COLOR:
        if (str) {
            lv_obj_set_style_text_color(obj, parse_color(str, lv_color_white()), 0);
        }
        break;
    case BIND_STYLE_BG_COLOR:
        if (str) {
            lv_obj_set_style_bg_color(obj, parse_color(str, lv_color_black()), 0);
        }
        break;
    case BIND_SRC: {
        const asset_ent_t *asset = str ? find_asset(str) : NULL;
        if (asset) {
            char path[220];
            asset_lv_path(asset, path, sizeof(path));
            /* gif needs its own setter to (re)start animation; image otherwise */
            if (lv_obj_check_type(obj, &lv_gif_class)) {
                lv_gif_set_src(obj, path);
            } else {
                lv_image_set_src(obj, path);
            }
        }
        break;
    }
    case BIND_SERIES: {
        if (!cJSON_IsArray(value)) {
            break;
        }
        lv_chart_series_t *ser = NULL;
        int si = 0;
        do {
            ser = lv_chart_get_series_next(obj, ser);
        } while (ser && si++ < b->series_n);
        if (!ser) {
            break;
        }
        lv_chart_set_all_value(obj, ser, LV_CHART_POINT_NONE);
        const cJSON *pt;
        cJSON_ArrayForEach(pt, value) {
            if (cJSON_IsNumber(pt)) {
                lv_chart_set_next_value(obj, ser, (int32_t)(pt->valuedouble * b->scale));
            }
        }
        lv_chart_refresh(obj);
        break;
    }
    }
}

void ui_renderer_handle_data(const char *stream, const char *payload, size_t len)
{
    int src_idx = -1;
    for (int i = 0; i < s_ui.source_count; i++) {
        if (!strcmp(s_ui.sources[i].stream, stream)) {
            src_idx = i;
            break;
        }
    }
    if (src_idx < 0) {
        return;
    }
    cJSON *root = cJSON_ParseWithLength(payload, len);
    if (!root) {
        return;
    }
    if (display_engine_lock(100)) {
        for (int i = 0; i < s_ui.binding_count; i++) {
            const binding_t *b = &s_ui.bindings[i];
            if (b->source_idx == src_idx) {
                apply_binding(b, jsonpath(root, b->path));
            }
        }
        display_engine_unlock();
    }
    cJSON_Delete(root);
}

/* ----------------------------------------------------- system screens */

static lv_obj_t *system_screen_base(void)
{
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, lv_color_hex(0x0B0E11), 0);
    return scr;
}

void ui_renderer_show_boot_screen(const char *line1, const char *line2)
{
    if (!display_engine_lock(0)) {
        return;
    }
    lv_obj_t *scr = system_screen_base();
    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "CryptoClock Pro");
    lv_obj_set_style_text_color(title, lv_color_hex(0xF0B90B), 0);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(title, &lv_font_montserrat_28, 0);
#endif
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -30);

    lv_obj_t *l1 = lv_label_create(scr);
    lv_label_set_text(l1, line1 ? line1 : "");
    lv_obj_set_style_text_color(l1, lv_color_hex(0xEAECEF), 0);
    lv_obj_align(l1, LV_ALIGN_CENTER, 0, 10);

    lv_obj_t *l2 = lv_label_create(scr);
    lv_label_set_text(l2, line2 ? line2 : "");
    lv_obj_set_style_text_color(l2, lv_color_hex(0x6B7280), 0);
    lv_obj_align(l2, LV_ALIGN_CENTER, 0, 36);

    lv_screen_load(scr);
    if (s_ui.system_screen) {
        lv_obj_delete(s_ui.system_screen);
    }
    s_ui.system_screen = scr;
    display_engine_unlock();
}

void ui_renderer_show_provisioning_screen(const char *ap_ssid)
{
    if (!display_engine_lock(0)) {
        return;
    }
    lv_obj_t *scr = system_screen_base();
    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "WiFi Setup");
    lv_obj_set_style_text_color(title, lv_color_hex(0xF0B90B), 0);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(title, &lv_font_montserrat_28, 0);
#endif
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 16);

    char buf[128];
    snprintf(buf, sizeof(buf), "1. Join WiFi \"%s\"\n2. Open http://192.168.4.1\n3. Enter your WiFi details", ap_ssid);
    lv_obj_t *steps = lv_label_create(scr);
    lv_label_set_text(steps, buf);
    lv_obj_set_style_text_color(steps, lv_color_hex(0xEAECEF), 0);
    lv_obj_align(steps, LV_ALIGN_LEFT_MID, 20, 0);

#if LV_USE_QRCODE
    /* QR with WIFI: payload joins the AP in one tap */
    char qr[96];
    snprintf(qr, sizeof(qr), "WIFI:T:nopass;S:%s;;", ap_ssid);
    lv_obj_t *code = lv_qrcode_create(scr);
    lv_qrcode_set_size(code, 110);
    lv_qrcode_update(code, qr, strlen(qr));
    lv_obj_align(code, LV_ALIGN_RIGHT_MID, -20, 0);
#endif

    lv_screen_load(scr);
    if (s_ui.system_screen) {
        lv_obj_delete(s_ui.system_screen);
    }
    s_ui.system_screen = scr;
    display_engine_unlock();
}

void ui_renderer_show_lock_screen(void)
{
    if (!display_engine_lock(0)) {
        return;
    }
    lv_obj_t *scr = system_screen_base();
    lv_obj_t *l = lv_label_create(scr);
    lv_label_set_text(l, LV_SYMBOL_EYE_CLOSE "  Device locked\nContact your administrator");
    lv_obj_set_style_text_color(l, lv_color_hex(0xF6465D), 0);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(l);
    lv_screen_load(scr);
    if (s_ui.system_screen) {
        lv_obj_delete(s_ui.system_screen);
    }
    s_ui.system_screen = scr;
    display_engine_unlock();
}
