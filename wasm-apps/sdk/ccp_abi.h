/*
 * CryptoClock Pro — guest-side ABI header (imports from "env").
 * Contract: schema/abi/ccp_abi_v1.md   ABI version: 1
 *
 * Build with wasi-sdk clang:
 *   clang --target=wasm32 -nostdlib -O2 \
 *     -Wl,--no-entry -Wl,--export=ccp_on_init ... -o app.wasm app.c
 * (see wasm-apps/toolchain/build.sh)
 */
#pragma once

#include <stdint.h>

#define CCP_ABI_VERSION 1

#define CCP_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define CCP_EXPORT(name) __attribute__((export_name(#name), visibility("default")))

/* error codes */
#define CCP_OK             0
#define CCP_ERR_INVAL     (-1)
#define CCP_ERR_NOT_FOUND (-2)
#define CCP_ERR_NO_MEM    (-3)
#define CCP_ERR_BUSY      (-4)
#define CCP_ERR_DENIED    (-5)
#define CCP_ERR_IO        (-6)

/* events (ccp_on_event) */
#define CCP_EVT_PRESSED        1
#define CCP_EVT_PRESSING       2
#define CCP_EVT_RELEASED       3
#define CCP_EVT_CLICKED        4
#define CCP_EVT_LONG_PRESSED   5
#define CCP_EVT_VALUE_CHANGED  6
#define CCP_EVT_GESTURE        7
#define CCP_EVT_DRAG           8
#define CCP_EVT_APP_BASE       100

/* log levels */
#define CCP_LOG_ERR  0
#define CCP_LOG_WARN 1
#define CCP_LOG_INFO 2
#define CCP_LOG_DBG  3

/* ---- UI ---- */
CCP_IMPORT(ccp_ui_get_widget)   int32_t ccp_ui_get_widget(const char *id, uint32_t id_len);
CCP_IMPORT(ccp_ui_set_text)     int32_t ccp_ui_set_text(int32_t w, const char *utf8, uint32_t len);
CCP_IMPORT(ccp_ui_set_value)    int32_t ccp_ui_set_value(int32_t w, int32_t value);
CCP_IMPORT(ccp_ui_set_color)    int32_t ccp_ui_set_color(int32_t w, uint32_t argb8888, uint32_t part);
CCP_IMPORT(ccp_ui_set_visible)  int32_t ccp_ui_set_visible(int32_t w, int32_t visible);
CCP_IMPORT(ccp_ui_show_page)    int32_t ccp_ui_show_page(const char *page_id, uint32_t len);

/* ---- canvas ---- */
CCP_IMPORT(ccp_canvas_blit)      int32_t ccp_canvas_blit(int32_t w, int32_t x, int32_t y,
                                                         int32_t bw, int32_t bh,
                                                         const void *rgb565, uint32_t byte_len);
CCP_IMPORT(ccp_canvas_fill_rect) int32_t ccp_canvas_fill_rect(int32_t w, int32_t x, int32_t y,
                                                              int32_t rw, int32_t rh, uint32_t argb);
CCP_IMPORT(ccp_canvas_draw_line) int32_t ccp_canvas_draw_line(int32_t w, int32_t x0, int32_t y0,
                                                              int32_t x1, int32_t y1,
                                                              uint32_t argb, uint32_t width);
CCP_IMPORT(ccp_canvas_draw_text) int32_t ccp_canvas_draw_text(int32_t w, int32_t x, int32_t y,
                                                              const char *utf8, uint32_t len,
                                                              uint32_t argb, uint32_t font_size);
CCP_IMPORT(ccp_canvas_flush)     int32_t ccp_canvas_flush(int32_t w);

/* ---- data / kv / audio / system ---- */
CCP_IMPORT(ccp_data_subscribe)   int32_t  ccp_data_subscribe(const char *stream, uint32_t len);
CCP_IMPORT(ccp_data_unsubscribe) int32_t  ccp_data_unsubscribe(int32_t stream_handle);
CCP_IMPORT(ccp_kv_get)           int32_t  ccp_kv_get(const char *key, uint32_t klen,
                                                     void *buf, uint32_t buf_len);
CCP_IMPORT(ccp_kv_set)           int32_t  ccp_kv_set(const char *key, uint32_t klen,
                                                     const void *val, uint32_t vlen);
CCP_IMPORT(ccp_audio_play)       int32_t  ccp_audio_play(const char *asset_path, uint32_t len,
                                                         uint32_t flags);
CCP_IMPORT(ccp_audio_tone)       int32_t  ccp_audio_tone(uint32_t freq_hz, uint32_t dur_ms,
                                                         uint32_t vol_0_100);
CCP_IMPORT(ccp_audio_stop)       int32_t  ccp_audio_stop(void);
CCP_IMPORT(ccp_time_ms)          uint64_t ccp_time_ms(void);
CCP_IMPORT(ccp_time_unix)        uint64_t ccp_time_unix(void);
CCP_IMPORT(ccp_rand)             uint32_t ccp_rand(void);
CCP_IMPORT(ccp_log)              void     ccp_log(int32_t level, const char *msg, uint32_t len);
CCP_IMPORT(ccp_request_tick)     int32_t  ccp_request_tick(uint32_t interval_ms);

/* tiny helpers */
static inline uint32_t ccp_strlen(const char *s)
{
    uint32_t n = 0;
    while (s[n]) {
        n++;
    }
    return n;
}
#define CCP_STR(s) (s), ccp_strlen(s)
#define ccp_logs(level, s) ccp_log((level), (s), ccp_strlen(s))
