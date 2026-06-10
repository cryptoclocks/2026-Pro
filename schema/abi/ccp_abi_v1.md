# CCP Host ABI v1 — สัญญาระหว่าง Firmware (host) กับ WASM module (guest)

- Import module name: **`env`**, ทุกฟังก์ชัน prefix **`ccp_`**
- ทุก pointer คือ offset ใน linear memory ของ guest — host ตรวจ `wasm_runtime_validate_app_addr()` ก่อนแตะเสมอ
- Strings ส่งเป็น `(ptr, len)` ไม่อิง NUL
- Return `int32_t`: `>= 0` สำเร็จ, `< 0` คือ `CCP_ERR_*`
- **กฎเหล็ก:** host import ต้องไม่ block เกิน 100ms; งาน UI ถูก queue ไปทำใน LVGL task

## Error codes
| code | ความหมาย |
|---|---|
| `0` | OK |
| `-1` | CCP_ERR_INVAL — argument/pointer ไม่ถูกต้อง |
| `-2` | CCP_ERR_NOT_FOUND — ไม่พบ widget/key/asset |
| `-3` | CCP_ERR_NO_MEM |
| `-4` | CCP_ERR_BUSY |
| `-5` | CCP_ERR_DENIED — เกินสิทธิ์/ถูกล็อก |
| `-6` | CCP_ERR_IO |

## Imports — UI
```c
int32_t ccp_ui_get_widget(const char *id, uint32_t id_len);          // -> widget handle (>=0)
int32_t ccp_ui_set_text(int32_t w, const char *utf8, uint32_t len);
int32_t ccp_ui_set_value(int32_t w, int32_t value);                  // arc/bar/slider/switch/scale
int32_t ccp_ui_set_color(int32_t w, uint32_t argb8888, uint32_t part); // part: 0=bg 1=text 2=indicator
int32_t ccp_ui_set_visible(int32_t w, int32_t visible);
int32_t ccp_ui_show_page(const char *page_id, uint32_t len);
```

## Imports — Canvas (เส้นทางวาดเองสำหรับกราฟ/เกม)
```c
int32_t ccp_canvas_blit(int32_t w, int32_t x, int32_t y, int32_t bw, int32_t bh,
                        const void *rgb565, uint32_t byte_len);
int32_t ccp_canvas_fill_rect(int32_t w, int32_t x, int32_t y, int32_t rw, int32_t rh, uint32_t argb);
int32_t ccp_canvas_draw_line(int32_t w, int32_t x0, int32_t y0, int32_t x1, int32_t y1,
                             uint32_t argb, uint32_t width);
int32_t ccp_canvas_draw_text(int32_t w, int32_t x, int32_t y, const char *utf8, uint32_t len,
                             uint32_t argb, uint32_t font_size);
int32_t ccp_canvas_flush(int32_t w);   // invalidate -> LVGL redraw รอบถัดไป
```

## Imports — Data / KV / Audio / System
```c
int32_t  ccp_data_subscribe(const char *stream, uint32_t len);   // -> stream handle (>=0)
int32_t  ccp_data_unsubscribe(int32_t stream_handle);
int32_t  ccp_kv_get(const char *key, uint32_t klen, void *buf, uint32_t buf_len); // -> bytes read
int32_t  ccp_kv_set(const char *key, uint32_t klen, const void *val, uint32_t vlen);
int32_t  ccp_audio_play(const char *asset_id, uint32_t len, uint32_t flags);     // bit0 = loop
int32_t  ccp_audio_tone(uint32_t freq_hz, uint32_t dur_ms, uint32_t vol_0_100);
int32_t  ccp_audio_stop(void);
uint64_t ccp_time_ms(void);        // monotonic
uint64_t ccp_time_unix(void);      // epoch seconds (0 ถ้า SNTP ยังไม่ sync)
uint32_t ccp_rand(void);
void     ccp_log(int32_t level, const char *msg, uint32_t len);  // 0=err 1=warn 2=info 3=dbg
int32_t  ccp_request_tick(uint32_t interval_ms);   // 0 = หยุด tick; ขั้นต่ำ 16ms
```

## Exports — lifecycle ที่ module ต้อง implement
```c
int32_t ccp_on_init(uint32_t abi_version);   // คืน <0 = โหลดล้มเหลว
void    ccp_on_tick(uint64_t now_ms);
void    ccp_on_event(int32_t widget, uint32_t event, int32_t p0, int32_t p1);
void    ccp_on_data(int32_t stream_handle, uint32_t payload_ptr, uint32_t len);
void    ccp_on_destroy(void);
uint32_t ccp_malloc(uint32_t size);          // host ใช้วางพื้นที่ payload ของ on_data
void     ccp_free(uint32_t ptr);
```

### Event enum (`ccp_on_event.event`)
| value | event | p0, p1 |
|---|---|---|
| 1 | PRESSED | x, y |
| 2 | PRESSING | x, y |
| 3 | RELEASED | x, y |
| 4 | CLICKED | x, y |
| 5 | LONG_PRESSED | x, y |
| 6 | VALUE_CHANGED | value, 0 |
| 7 | GESTURE | dir (0=L 1=R 2=U 3=D), 0 |
| 8 | DRAG | dx, dy (สำหรับ pan กราฟ) |
| 100+ | APP_EVENT | event_id จาก layout action `wasm.event`, 0 |

## Watchdog deadlines (host บังคับ)
| call | deadline |
|---|---|
| `ccp_on_init` | 3000 ms |
| `ccp_on_event` / `ccp_on_data` | 250 ms |
| `ccp_on_tick` | 3 × interval (ขั้นต่ำ 100 ms) |

เกิน deadline → `wasm_runtime_terminate()` → reinstantiate (สูงสุด 3 ครั้ง) → fallback ไป package version ก่อนหน้า/recovery UI
