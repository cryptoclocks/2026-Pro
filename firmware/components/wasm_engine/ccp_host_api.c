#include "ccp_host_api.h"
#include "ui_renderer.h"
#include "display_engine.h"
#include "storage.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "esp_timer.h"
#include "esp_random.h"
#include "esp_log.h"

static const char *TAG = "ccp_abi";

#define UI_LOCK_MS 200  /* wasm host imports — 200ms safe for image/gif/text load
                          * during LVGL busy periods (slideshow PNG decode,
                          * screen-load anims can hold lock > 50ms). The ABI
                          * rule is "must not block long"; 200ms still
                          * qualifies — human-perceptible UI is fine at 5 FPS
                          * worst-case during one tick. */

/* WAMR '*~' signature pairs arrive pre-validated as native pointers. */

static char *dup_str(const char *s, uint32_t len, char *buf, size_t buf_len)
{
    if (!s || len == 0 || len >= buf_len) {
        return NULL;
    }
    memcpy(buf, s, len);
    buf[len] = '\0';
    return buf;
}

/* ----------------------------------------------------------------- UI */

static int32_t n_ui_get_widget(wasm_exec_env_t env, const char *id, uint32_t len)
{
    char buf[40];
    if (!dup_str(id, len, buf, sizeof(buf))) {
        return CCP_ERR_INVAL;
    }
    int idx = ui_renderer_widget_index(buf);
    return idx >= 0 ? idx : CCP_ERR_NOT_FOUND;
}

static int32_t n_ui_set_text(wasm_exec_env_t env, int32_t w, const char *utf8, uint32_t len)
{
    lv_obj_t *obj = ui_renderer_widget_by_index(w);
    if (!obj) {
        return CCP_ERR_NOT_FOUND;
    }
    char buf[256];
    if (!dup_str(utf8, len, buf, sizeof(buf))) {
        return CCP_ERR_INVAL;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    /* buttons carry their label as first child */
    lv_obj_t *target = lv_obj_check_type(obj, &lv_label_class) ? obj : lv_obj_get_child(obj, 0);
    if (target && lv_obj_check_type(target, &lv_label_class)) {
        lv_label_set_text(target, buf);
    } else if (lv_obj_check_type(obj, &lv_label_class)) {
        lv_label_set_text(obj, buf);
    }
    display_engine_unlock();
    return CCP_OK;
}

static int32_t n_ui_set_value(wasm_exec_env_t env, int32_t w, int32_t value)
{
    lv_obj_t *obj = ui_renderer_widget_by_index(w);
    if (!obj) {
        return CCP_ERR_NOT_FOUND;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    if (lv_obj_check_type(obj, &lv_arc_class)) lv_arc_set_value(obj, value);
    else if (lv_obj_check_type(obj, &lv_bar_class)) lv_bar_set_value(obj, value, LV_ANIM_OFF);
    else if (lv_obj_check_type(obj, &lv_slider_class)) lv_slider_set_value(obj, value, LV_ANIM_OFF);
    else if (lv_obj_check_type(obj, &lv_switch_class)) {
        if (value) lv_obj_add_state(obj, LV_STATE_CHECKED);
        else lv_obj_remove_state(obj, LV_STATE_CHECKED);
    }
    display_engine_unlock();
    return CCP_OK;
}

static int32_t n_ui_set_color(wasm_exec_env_t env, int32_t w, uint32_t argb, uint32_t part)
{
    lv_obj_t *obj = ui_renderer_widget_by_index(w);
    if (!obj) {
        return CCP_ERR_NOT_FOUND;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    lv_color_t c = lv_color_hex(argb & 0xFFFFFF);
    switch (part) {
    case 1:  lv_obj_set_style_text_color(obj, c, 0); break;
    case 2:  lv_obj_set_style_bg_color(obj, c, LV_PART_INDICATOR); break;
    default: lv_obj_set_style_bg_color(obj, c, 0);
             lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
             break;
    }
    display_engine_unlock();
    return CCP_OK;
}

static int32_t n_ui_set_visible(wasm_exec_env_t env, int32_t w, int32_t visible)
{
    lv_obj_t *obj = ui_renderer_widget_by_index(w);
    if (!obj) {
        return CCP_ERR_NOT_FOUND;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    if (visible) lv_obj_remove_flag(obj, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
    display_engine_unlock();
    return CCP_OK;
}

static int32_t n_ui_show_page(wasm_exec_env_t env, const char *id, uint32_t len)
{
    char buf[40];
    if (!dup_str(id, len, buf, sizeof(buf))) {
        return CCP_ERR_INVAL;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    esp_err_t err = ui_renderer_show_page(buf);
    display_engine_unlock();
    return err == ESP_OK ? CCP_OK : CCP_ERR_NOT_FOUND;
}

/* ------------------------------------------------------------- canvas */

static lv_obj_t *canvas_by_handle(int32_t w)
{
    lv_obj_t *obj = ui_renderer_widget_by_index(w);
    if (!obj || !lv_obj_check_type(obj, &lv_canvas_class)) {
        return NULL;
    }
    return obj;
}

static int32_t n_canvas_blit(wasm_exec_env_t env, int32_t w, int32_t x, int32_t y,
                             int32_t bw, int32_t bh, const void *rgb565, uint32_t byte_len)
{
    lv_obj_t *cv = canvas_by_handle(w);
    if (!cv) {
        return CCP_ERR_NOT_FOUND;
    }
    if (bw <= 0 || bh <= 0 || byte_len < (uint32_t)(bw * bh * 2)) {
        return CCP_ERR_INVAL;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    lv_draw_buf_t *db = lv_canvas_get_draw_buf(cv);
    if (!db) {
        display_engine_unlock();
        return CCP_ERR_IO;
    }
    const int cw = (int)db->header.w, ch = (int)db->header.h;
    const uint32_t stride = db->header.stride;
    const uint16_t *src = rgb565;
    for (int row = 0; row < bh; row++) {
        int dy = y + row;
        if (dy < 0 || dy >= ch) {
            continue;
        }
        int sx = 0, dx = x, count = bw;
        if (dx < 0) { sx = -dx; count += dx; dx = 0; }
        if (dx + count > cw) { count = cw - dx; }
        if (count <= 0) {
            continue;
        }
        uint16_t *dst = (uint16_t *)(db->data + (size_t)dy * stride) + dx;
        memcpy(dst, src + (size_t)row * bw + sx, (size_t)count * 2);
    }
    display_engine_unlock();
    return CCP_OK;
}

static inline uint16_t argb_to_rgb565(uint32_t argb)
{
    return (uint16_t)(((argb >> 8) & 0xF800) | ((argb >> 5) & 0x07E0) | ((argb >> 3) & 0x001F));
}

static int32_t n_canvas_fill_rect(wasm_exec_env_t env, int32_t w, int32_t x, int32_t y,
                                  int32_t rw, int32_t rh, uint32_t argb)
{
    lv_obj_t *cv = canvas_by_handle(w);
    if (!cv) {
        return CCP_ERR_NOT_FOUND;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    lv_draw_buf_t *db = lv_canvas_get_draw_buf(cv);
    if (!db) {
        display_engine_unlock();
        return CCP_ERR_IO;
    }
    const int cw = (int)db->header.w, ch = (int)db->header.h;
    const uint16_t col = argb_to_rgb565(argb);
    for (int row = 0; row < rh; row++) {
        int dy = y + row;
        if (dy < 0 || dy >= ch) {
            continue;
        }
        int dx = x < 0 ? 0 : x;
        int end = x + rw > cw ? cw : x + rw;
        uint16_t *dst = (uint16_t *)(db->data + (size_t)dy * db->header.stride);
        for (int i = dx; i < end; i++) {
            dst[i] = col;
        }
    }
    display_engine_unlock();
    return CCP_OK;
}

static int32_t n_canvas_draw_line(wasm_exec_env_t env, int32_t w, int32_t x0, int32_t y0,
                                  int32_t x1, int32_t y1, uint32_t argb, uint32_t width)
{
    lv_obj_t *cv = canvas_by_handle(w);
    if (!cv) {
        return CCP_ERR_NOT_FOUND;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    lv_draw_buf_t *db = lv_canvas_get_draw_buf(cv);
    if (!db) {
        display_engine_unlock();
        return CCP_ERR_IO;
    }
    const int cw = (int)db->header.w, ch = (int)db->header.h;
    const uint16_t col = argb_to_rgb565(argb);
    const int half = width > 1 ? (int)width / 2 : 0;

    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    while (true) {
        for (int oy = -half; oy <= half; oy++) {
            for (int ox = -half; ox <= half; ox++) {
                int px = x0 + ox, py = y0 + oy;
                if (px >= 0 && px < cw && py >= 0 && py < ch) {
                    ((uint16_t *)(db->data + (size_t)py * db->header.stride))[px] = col;
                }
            }
        }
        if (x0 == x1 && y0 == y1) {
            break;
        }
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
    display_engine_unlock();
    return CCP_OK;
}

static int32_t n_canvas_draw_text(wasm_exec_env_t env, int32_t w, int32_t x, int32_t y,
                                  const char *utf8, uint32_t len, uint32_t argb, uint32_t font_size)
{
    lv_obj_t *cv = canvas_by_handle(w);
    if (!cv) {
        return CCP_ERR_NOT_FOUND;
    }
    char buf[128];
    if (!dup_str(utf8, len, buf, sizeof(buf))) {
        return CCP_ERR_INVAL;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    lv_layer_t layer;
    lv_canvas_init_layer(cv, &layer);
    lv_draw_label_dsc_t dsc;
    lv_draw_label_dsc_init(&dsc);
    dsc.color = lv_color_hex(argb & 0xFFFFFF);
    dsc.text = buf;
#if LV_FONT_MONTSERRAT_28
    dsc.font = font_size >= 28 ? &lv_font_montserrat_28 : LV_FONT_DEFAULT;
#else
    dsc.font = LV_FONT_DEFAULT;
#endif
    lv_area_t coords = { x, y, x + 400, y + 60 };
    lv_draw_label(&layer, &dsc, &coords);
    lv_canvas_finish_layer(cv, &layer);
    display_engine_unlock();
    return CCP_OK;
}

static int32_t n_canvas_flush(wasm_exec_env_t env, int32_t w)
{
    lv_obj_t *cv = canvas_by_handle(w);
    if (!cv) {
        return CCP_ERR_NOT_FOUND;
    }
    if (!display_engine_lock(UI_LOCK_MS)) {
        return CCP_ERR_BUSY;
    }
    lv_obj_invalidate(cv);
    display_engine_unlock();
    return CCP_OK;
}

/* ------------------------------------------------- data / kv / audio */

static int32_t n_data_subscribe(wasm_exec_env_t env, const char *stream, uint32_t len)
{
    char buf[96];
    if (!dup_str(stream, len, buf, sizeof(buf))) {
        return CCP_ERR_INVAL;
    }
    int h = wasm_engine_subscribe_current(env, buf);
    return h >= 0 ? h : CCP_ERR_NO_MEM;
}

static int32_t n_data_unsubscribe(wasm_exec_env_t env, int32_t handle)
{
    return wasm_engine_unsubscribe_current(env, handle) == 0 ? CCP_OK : CCP_ERR_INVAL;
}

/* per-package NVS namespace comes later (M3 polish); shared ns for now */
#define WASM_KV_NS "wasmkv"

static int32_t n_kv_get(wasm_exec_env_t env, const char *key, uint32_t klen,
                        void *out, uint32_t out_len)
{
    char kbuf[32];
    if (!dup_str(key, klen, kbuf, sizeof(kbuf))) {
        return CCP_ERR_INVAL;
    }
    int n = storage_kv_get_blob(WASM_KV_NS, kbuf, out, out_len);
    return n >= 0 ? n : CCP_ERR_NOT_FOUND;
}

static int32_t n_kv_set(wasm_exec_env_t env, const char *key, uint32_t klen,
                        const void *val, uint32_t vlen)
{
    char kbuf[32];
    if (!dup_str(key, klen, kbuf, sizeof(kbuf))) {
        return CCP_ERR_INVAL;
    }
    if (vlen > 4096) {
        return CCP_ERR_INVAL;
    }
    return storage_kv_set_blob(WASM_KV_NS, kbuf, val, vlen) == ESP_OK ? CCP_OK : CCP_ERR_IO;
}

static int32_t n_audio_play(wasm_exec_env_t env, const char *path, uint32_t len, uint32_t flags)
{
    char buf[160];
    if (!dup_str(path, len, buf, sizeof(buf))) {
        return CCP_ERR_INVAL;
    }
    const wasm_engine_hooks_t *hooks = wasm_engine_get_hooks();
    if (!hooks->audio_play) {
        return CCP_ERR_IO;
    }
    return hooks->audio_play(buf, (flags & 1) != 0) == 0 ? CCP_OK : CCP_ERR_IO;
}

static int32_t n_audio_tone(wasm_exec_env_t env, uint32_t freq, uint32_t dur_ms, uint32_t vol)
{
    const wasm_engine_hooks_t *hooks = wasm_engine_get_hooks();
    if (!hooks->audio_tone) {
        return CCP_ERR_IO;
    }
    return hooks->audio_tone(freq, dur_ms, vol) == 0 ? CCP_OK : CCP_ERR_IO;
}

static int32_t n_audio_stop(wasm_exec_env_t env)
{
    const wasm_engine_hooks_t *hooks = wasm_engine_get_hooks();
    if (hooks->audio_stop) {
        hooks->audio_stop();
    }
    return CCP_OK;
}

/* -------------------------------------------------------------- misc */

static uint64_t n_time_ms(wasm_exec_env_t env)
{
    return (uint64_t)(esp_timer_get_time() / 1000);
}

static uint64_t n_time_unix(wasm_exec_env_t env)
{
    time_t now = 0;
    time(&now);
    return now > 1600000000 ? (uint64_t)now : 0; /* 0 until SNTP synced */
}

static uint32_t n_rand(wasm_exec_env_t env)
{
    return esp_random();
}

static void n_log(wasm_exec_env_t env, int32_t level, const char *msg, uint32_t len)
{
    char buf[200];
    if (!dup_str(msg, len, buf, sizeof(buf))) {
        return;
    }
    switch (level) {
    case 0:  ESP_LOGE("wasm_app", "%s", buf); break;
    case 1:  ESP_LOGW("wasm_app", "%s", buf); break;
    case 3:  ESP_LOGD("wasm_app", "%s", buf); break;
    default: ESP_LOGI("wasm_app", "%s", buf); break;
    }
}

static int32_t n_request_tick(wasm_exec_env_t env, uint32_t interval_ms)
{
    return wasm_engine_request_tick_current(env, interval_ms) == 0 ? CCP_OK : CCP_ERR_INVAL;
}

/* --------------------------------------------------------- registration */

static NativeSymbol s_natives[] = {
    { "ccp_ui_get_widget",    n_ui_get_widget,    "(*~)i",      NULL },
    { "ccp_ui_set_text",      n_ui_set_text,      "(i*~)i",     NULL },
    { "ccp_ui_set_value",     n_ui_set_value,     "(ii)i",      NULL },
    { "ccp_ui_set_color",     n_ui_set_color,     "(iii)i",     NULL },
    { "ccp_ui_set_visible",   n_ui_set_visible,   "(ii)i",      NULL },
    { "ccp_ui_show_page",     n_ui_show_page,     "(*~)i",      NULL },
    { "ccp_canvas_blit",      n_canvas_blit,      "(iiiii*~)i", NULL },
    { "ccp_canvas_fill_rect", n_canvas_fill_rect, "(iiiiii)i",  NULL },
    { "ccp_canvas_draw_line", n_canvas_draw_line, "(iiiiiii)i", NULL },
    { "ccp_canvas_draw_text", n_canvas_draw_text, "(iii*~ii)i", NULL },
    { "ccp_canvas_flush",     n_canvas_flush,     "(i)i",       NULL },
    { "ccp_data_subscribe",   n_data_subscribe,   "(*~)i",      NULL },
    { "ccp_data_unsubscribe", n_data_unsubscribe, "(i)i",       NULL },
    { "ccp_kv_get",           n_kv_get,           "(*~*~)i",    NULL },
    { "ccp_kv_set",           n_kv_set,           "(*~*~)i",    NULL },
    { "ccp_audio_play",       n_audio_play,       "(*~i)i",     NULL },
    { "ccp_audio_tone",       n_audio_tone,       "(iii)i",     NULL },
    { "ccp_audio_stop",       n_audio_stop,       "()i",        NULL },
    { "ccp_time_ms",          n_time_ms,          "()I",        NULL },
    { "ccp_time_unix",        n_time_unix,        "()I",        NULL },
    { "ccp_rand",             n_rand,             "()i",        NULL },
    { "ccp_log",              n_log,              "(i*~)",      NULL },
    { "ccp_request_tick",     n_request_tick,     "(i)i",       NULL },
};

esp_err_t ccp_host_api_register(void)
{
    if (!wasm_runtime_register_natives("env", s_natives,
                                       sizeof(s_natives) / sizeof(s_natives[0]))) {
        ESP_LOGE(TAG, "native registration failed");
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "registered %d ccp_* host functions",
             (int)(sizeof(s_natives) / sizeof(s_natives[0])));
    return ESP_OK;
}
