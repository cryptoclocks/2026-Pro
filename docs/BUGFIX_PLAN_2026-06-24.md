# CryptoClock Pro — Bug Fix Plan (2026-06-24)

> **แผนแก้บั๊กฉบับเต็ม** — ครอบคลุมบั๊กทั้ง 3 ตัว P0 + 3 ตัว P1/P2 จาก `docs/QA_REPORT_2026-06-24.md`
> เขียนหลังจากอ่าน source code จริงทุกไฟล์ที่เกี่ยวข้อง (verified file:line ทุกจุด)
> แผนนี้เขียนแบบ **"AI / Dev อ่านแล้วทำตามได้เลย"** — ทุกขั้นมี before/after code + คำสั่ง verify

---

## 0. สารบัญ

| ลำดับ | บั๊ก | Severity | ไฟล์ที่แก้ | เวลาโดยประมาณ |
|---|---|---|---|---|
| 1 | crypto_poll stack overflow | P0 | `firmware/components/home_ui/home_ui.c` | 30 นาที |
| 2 | LVGL task watchdog hang | P0 | `firmware/components/display_engine/display_engine.c` + `home_ui.c` | 1-2 ชม. |
| 3 | POST /config ไม่ validate schema | P0 | `firmware/components/local_api/local_api.c` | 1 ชม. |
| 4 | brightness out-of-range validation | P1 | `firmware/components/local_api/local_api.c` | 5 นาที |
| 5 | slideshow transient lock timeout | P2 | `firmware/components/wasm_engine/ccp_host_api.c` + `home_ui.c` | 15 นาที |
| 6 | FAT atomic write race condition | P2 | `firmware/components/storage/storage.c` | 30 นาที |
| 7 | (Bonus) เพิ่ม debug commands ผ่าน serial | P1 | `firmware/components/dbg_console/dbg_console.c` | 1 ชม. |

**รวมเวลาโดยประมาณ**: ~6 ชั่วโมง สำหรับ firmware (P0-P2 หลัก) + 1 ชม. test บนเครื่องจริง

---

## 1. Bug #1 — crypto_poll stack overflow (P0)

### 1.1 อาการ
- `goto crypto` → "crypto poll task started" → ~1-2 วินาที → **stack overflow** → core dump → reboot
- Reproducible 100%
- crypto อยู่ใน rotation list + `page_delay_s=10` → เครื่อง reboot ทุก ๆ ~30 วิ

### 1.2 หลักฐาน (log จริง)
```
> goto crypto
I (109827) home_ui: crypto poll task started (net=1, symbol=BTCUSDT, tf=15m)
I (110945) esp-x509-crt-bundle: Certificate validated
I (111671) home_ui: klines BTCUSDT 15m: 60 candles
***ERROR*** A stack overflow in task crypto_poll has been detected.
...reboot sequence...
```

### 1.3 Root cause analysis

**Stack frame analysis** (จากการอ่าน source):

```c
// firmware/components/home_ui/home_ui.c:46
#define CRYPTO_POLL_STACK 4096    // ← แค่ 4KB!
```

Stack call chain ที่กิน stack มากที่สุด (ประมาณการ):

| Function | Stack ใช้ | หมายเหตุ |
|---|---|---|
| `crypto_poll_task` frame | ~200 B | local vars ไม่มี (body อยู่ใน PSRAM) |
| `fetch_klines` → `cJSON_ParseWithLength(body, n)` | ~2-3 KB | recursive parse ของ 60-element JSON array (12 fields ต่อ candle) |
| `http_get_text` → `esp_http_client_read` | ~1.5 KB | esp_http_client internal buffers + mbedTLS |
| `mbedtls_x509_crt_parse` (esp-x509-crt-bundle log) | ~2-3 KB | cert validation recursion |
| `cJSON_ArrayForEach` callback stack | ~500 B | recursive walk ลึก |
| `crypto_apply_quote` (lvgl ops) | ~500 B | calls `candles_update` |
| `esp_log_timestamp` ฯลฯ | ~300 B | |
| **รวม peak** | **~7-8 KB** | **เกิน 4 KB** |

ปัญหา: stack ตึงเกินไป + esp-x509-crt-bundle (TLS cert validation) กิน stack มากใน mbedTLS

### 1.4 ทางแก้ — 3 ทางเลือก (เจ้าของเลือกก่อน)

#### ทางเลือก A: เพิ่ม stack size (เร็วสุด, กระทบน้อย)

**ข้อดี**: 1 บรรทัด, ไม่ต้อง refactor
**ข้อเสีย**: กิน internal DRAM (~4 KB เพิ่ม) — internal heap ตอนนี้ free=34KB

**Before** (`firmware/components/home_ui/home_ui.c:46`):
```c
#define CRYPTO_POLL_STACK 4096
```

**After**:
```c
#define CRYPTO_POLL_STACK 8192   // 4KB → 8KB, safe margin for TLS + cJSON
```

**Verify**:
```bash
cd firmware
export IDF_PYTHON_ENV_PATH=~/.espressif/python_env/idf5.5_py3.9_env
. ~/esp/esp-idf/export.sh
idf.py build
# flash แล้วรัน
python3 -c "
import os, time, termios, tty, select
PORT='/dev/cu.usbmodem1301'
fd=os.open(PORT, os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
a=list(termios.tcgetattr(fd))
a[0]=0;a[1]=0;a[2]=termios.CLOCAL|termios.CREAD|termios.CS8
a[3]=0;a[4]=termios.B115200;a[5]=termios.B115200
a[6][termios.VMIN]=0;a[6][termios.VTIME]=5
termios.tcsetattr(fd, termios.TCSANOW, a)
def run(cmd, wait=2.5):
    os.write(fd, (cmd+'\r').encode())
    end=time.time()+wait
    buf=b''
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: c=os.read(fd,4096); buf+=c if c else b''
            except: pass
    return buf.decode('utf-8','replace')

# Wait for boot
print('=== wait 8s for boot ===')
time.sleep(8)
print(run('ver'))
# Try goto crypto 5 times — should NOT crash
for i in range(5):
    print(f'=== iteration {i+1} ===')
    print(run('goto crypto', wait=4))
    print(run('ver'))
"
# Expected: ไม่มี "stack overflow" ใน log, current page = crypto
```

#### ทางเลือก B: refactor parse loop (ใหญ่กว่า, ปลอดภัยกว่า)

แยก HTTP fetch ออกจาก cJSON parsing — หลัง fetch เสร็จ ปิด client ก่อน แล้วค่อย parse

**ไฟล์**: `firmware/components/home_ui/home_ui.c:843-870`

**Before** (`fetch_klines`):
```c
static void fetch_klines(char *body, size_t body_len)
{
    int n = fetch_klines_text(s.cfg.symbols[s.cur_symbol], s.cfg.timeframe, body, body_len);
    if (n <= 0) { return; }
    cJSON *root = cJSON_ParseWithLength(body, n);
    if (!root) { return; }
    int cnt = 0;
    if (cJSON_IsArray(root)) { ... parse 60 candles ... }
    cJSON_Delete(root);
    ...
}
```

**After** — แยก fetch กับ parse:
```c
typedef struct {
    float o, h, l, c;
} candle_parsed_t;

static int parse_candles(const char *body, int body_len, candle_parsed_t *out, int max)
{
    cJSON *root = cJSON_ParseWithLength(body, body_len);
    if (!root) return -1;
    int cnt = 0;
    if (cJSON_IsArray(root)) {
        const cJSON *k;
        cJSON_ArrayForEach(k, root) {
            if (cnt >= max) break;
            const cJSON *o = cJSON_GetArrayItem(k, 1);
            const cJSON *h = cJSON_GetArrayItem(k, 2);
            const cJSON *l = cJSON_GetArrayItem(k, 3);
            const cJSON *c = cJSON_GetArrayItem(k, 4);
            if (cJSON_IsString(o) && cJSON_IsString(h) && cJSON_IsString(l) && cJSON_IsString(c)) {
                out[cnt].o = (float)atof(o->valuestring);
                out[cnt].h = (float)atof(h->valuestring);
                out[cnt].l = (float)atof(l->valuestring);
                out[cnt].c = (float)atof(c->valuestring);
                cnt++;
            }
        }
    }
    cJSON_Delete(root);
    return cnt;
}

static void fetch_klines(char *body, size_t body_len)
{
    int n = fetch_klines_text(s.cfg.symbols[s.cur_symbol], s.cfg.timeframe, body, body_len);
    if (n <= 0) return;

    /* parse ใน PSRAM heap เพื่อไม่ให้กิน stack */
    candle_parsed_t *candles = heap_caps_malloc(sizeof(candle_parsed_t) * SPARK_POINTS, MALLOC_CAP_SPIRAM);
    if (!candles) {
        ESP_LOGE(TAG, "candles alloc failed");
        return;
    }
    int cnt = parse_candles(body, n, candles, SPARK_POINTS);
    if (cnt > 0) {
        for (int i = 0; i < cnt; i++) {
            s.candles[i] = candles[i];
        }
        s.candle_count = cnt;
        if (cnt > 0) candle_render();
    }
    free(candles);
    ESP_LOGI(TAG, "klines %s %s: %d candles", s.cfg.symbols[s.cur_symbol], s.cfg.timeframe, cnt);
}
```

**ข้อดี**: parse recursion ใช้ heap แทน stack
**ข้อเสีย**: เพิ่ม PSRAM alloc/dealloc overhead, โค้ดยาวขึ้น

#### ทางเลือก C: ย้าย cJSON ไปใช้ heap allocator (เหมือน ui_renderer ที่ทำไว้แล้ว)

**ข้อดี**: fix ทั้ง crypto_poll และ ui_renderer parser ในจุดเดียว
**ข้อเสีย**: กระทบทุก cJSON_Parse ในโปรเจกต์

**ไฟล์**: `firmware/components/home_ui/home_ui.c` ใกล้ ๆ `#include "cJSON.h"`

**เพิ่ม**:
```c
/* Route cJSON's parse-tree allocations to PSRAM (matches ui_renderer.c).
 * crypto_poll_task is 4KB stack — cJSON_Parse of 60-element kline array
 * overflows the stack. Use heap_caps_malloc for parse nodes. */
static void *crypto_cjson_malloc(size_t sz) { return heap_caps_malloc(sz, MALLOC_CAP_SPIRAM); }
static void crypto_cjson_free(void *p) { heap_caps_free(p); }

/* ใน crypto_poll_task ก่อน loop: */
cJSON_Hooks hooks = { .malloc_fn = crypto_cjson_malloc, .free_fn = crypto_cjson_free };
cJSON_InitHooks(&hooks);
```

**หมายเหตุ**: ต้อง `cJSON_InitHooks` ก่อน `cJSON_Parse` ตัวแรกใน task

### 1.5 แนะนำ — ทำทั้ง A + C (defense in depth)

- **A** เพิ่ม stack 4096 → 8192 (กัน overflow ปัจจุบัน)
- **C** ใช้ PSRAM heap สำหรับ cJSON parse (กัน overflow ในอนาคตเมื่อเพิ่ม field)

---

## 2. Bug #2 — LVGL task watchdog hang (P0)

### 2.1 อาการ
- LVGL task บน CPU 1 ไม่ reset task watchdog → fires ทุก 10s
- HTTP API ค้าง (curl timeout) — เพราะ `home_ui_reload` เรียก `display_engine_lock(0)` = wait forever
- Serial console ยังตอบ (อยู่คนละ CPU)
- ต้อง power-cycle หรือรอ auto-reboot

### 2.2 หลักฐาน (log จริง)
```
WE (180935) task_wdt: Task watchdog got triggered.
WE (180935) task_wdt:  - IDLE1 (CPU 1)
WE (180935) task_wdt: CPU 0: IDLE0
WE (180935) task_wdt: CPU 1: lvgl
Backtrace: 0x40378746 0x40377B1D 0x42046ED1 0x42043A41 ... 0x40380735
```

### 2.3 Root cause analysis

**ปัญหาที่ 1**: LVGL task ไม่ subscribe กับ task watchdog

จากการค้นหา source:
- `grep "esp_task_wdt_add" firmware/` → **ไม่มีผลลัพธ์**
- `CONFIG_ESP_TASK_WDT_INIT=y` ใน sdkconfig
- `CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU0/1=y`

→ Watchdog เช็คแค่ **IDLE0, IDLE1** — เมื่อ lvgl task ใช้ CPU 100% IDLE1 ก็ idle ไม่ได้ → watchdog blames IDLE1

**ปัญหาที่ 2**: `display_engine_lock(0)` = wait forever (recursive mutex)

```c
// firmware/components/display_engine/display_engine.c:412
const TickType_t ticks = (timeout_ms == 0) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
```

callers ที่ใช้ timeout=0:
- `home_ui.c:2277` home_ui_reload
- `ui_renderer.c:1321, 1392, ...` หลายจุด
- `home_ui.c:2164, 2188` build_page

→ ถ้า LVGL task ค้าง ทุก thread ที่เรียก `display_engine_lock(0)` ก็ค้างตาม (รวมทั้ง httpd handler ที่รัน POST /config)

**ปัญหาที่ 3**: Slideshow มี 4 image widgets → `goto slideshow` ใช้เวลา build > 50ms → lock timeout

จาก log:
```
> goto slideshow
I (26221) home_ui: slideshow: 4 images
E (26581) display: display lock timeout (50 ms), holder=lvgl
```

ถ้า lvgl_task ยังทำงานอยู่ก็แค่ transient แต่ถ้า lvgl ค้างจริง ๆ → 50ms หมดแล้วก็ fail

### 2.4 ทางแก้

#### Fix A (หลัก): Subscribe ทั้ง lvgl + crypto_poll กับ task watchdog + reset ใน loop

**ไฟล์**: `firmware/components/display_engine/display_engine.c`

**Before** (line ~395-407):
```c
BaseType_t ok = xTaskCreatePinnedToCore(lvgl_task, "lvgl", LVGL_TASK_STACK, NULL,
                                        LVGL_TASK_PRIO, NULL, LVGL_TASK_CORE);
ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_FAIL, TAG, "lvgl task");
```

**After**:
```c
BaseType_t ok = xTaskCreatePinnedToCore(lvgl_task, "lvgl", LVGL_TASK_STACK, NULL,
                                        LVGL_TASK_PRIO, NULL, LVGL_TASK_CORE);
ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_FAIL, TAG, "lvgl task");

/* Subscribe lvgl task to task watchdog — was missing, causing watchdog to
 * incorrectly blame IDLE1 when lvgl itself hung. */
ESP_ERROR_CHECK(esp_task_wdt_add(NULL));  // NULL = current task
```

**Before** (lvgl_task, line ~345-372):
```c
static void lvgl_task(void *arg)
{
    ESP_LOGI(TAG, "LVGL task running on core %d", xPortGetCoreID());
    while (true) {
        uint32_t delay_ms = 5;
        if (display_engine_lock(0)) {
            delay_ms = lv_timer_handler();
            display_engine_unlock();
        }
        /* FPS bookkeeping ... */
        ...
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}
```

**After**:
```c
static void lvgl_task(void *arg)
{
    ESP_LOGI(TAG, "LVGL task running on core %d", xPortGetCoreID());
    esp_task_wdt_add(NULL);  // subscribe this task explicitly
    uint32_t last_reset = 0;
    while (true) {
        uint32_t delay_ms = 5;
        if (display_engine_lock(0)) {
            delay_ms = lv_timer_handler();
            display_engine_unlock();
        }
        /* Reset watchdog every iteration — if lv_timer_handler hangs,
         * watchdog will fire and identify THIS task (not IDLE1) */
        esp_task_wdt_reset();
        last_reset = esp_log_timestamp();

        /* FPS bookkeeping ... */
        ...

        if (delay_ms > 500) delay_ms = 500;
        if (delay_ms < 1) delay_ms = 1;
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}
```

**ไฟล์**: `firmware/components/home_ui/home_ui.c`

**Before** (line ~996-998):
```c
BaseType_t ok = xTaskCreatePinnedToCore(crypto_poll_task, "crypto_poll",
                                        CRYPTO_POLL_STACK, NULL, 3,
                                        &s.poll_task, 0);
```

**After**:
```c
BaseType_t ok = xTaskCreatePinnedToCore(crypto_poll_task, "crypto_poll",
                                        CRYPTO_POLL_STACK, NULL, 3,
                                        &s.poll_task, 0);
ESP_LOGI(TAG, "crypto_poll task started, subscribing to task watchdog");
```

**Before** (crypto_poll_task, line 925+):
```c
static void crypto_poll_task(void *arg)
{
    char *body = heap_caps_malloc(POLL_BODY_LEN, MALLOC_CAP_SPIRAM);
    if (!body) { ... }
    ESP_LOGI(TAG, "crypto poll task started (net=%d, symbol=%s, tf=%s)", ...);

    while (s.poll_run) {
        if (!s.net_connected) { vTaskDelay(...); continue; }
        ...
    }
    free(body);
    s.poll_task = NULL;
    vTaskDelete(NULL);
}
```

**After**:
```c
static void crypto_poll_task(void *arg)
{
    char *body = heap_caps_malloc(POLL_BODY_LEN, MALLOC_CAP_SPIRAM);
    if (!body) { ... }

    /* Subscribe this task to task watchdog (after malloc — malloc can take long) */
    esp_task_wdt_add(NULL);

    ESP_LOGI(TAG, "crypto poll task started (net=%d, symbol=%s, tf=%s)", ...);

    while (s.poll_run) {
        esp_task_wdt_reset();  // feed watchdog every loop iteration
        if (!s.net_connected) { vTaskDelay(...); continue; }
        ...
    }
    esp_task_wdt_delete(NULL);  // unsubscribe before delete
    free(body);
    s.poll_task = NULL;
    vTaskDelete(NULL);
}
```

#### Fix B (เสริม): เปลี่ยน `display_engine_lock(0)` → timeout จำกัดใน callers ที่ไม่ใช่ render

**ไฟล์**: `firmware/components/home_ui/home_ui.c`

**Before** (line 2277):
```c
esp_err_t home_ui_reload(void)
{
    if (!display_engine_lock(0)) {
        return ESP_ERR_TIMEOUT;
    }
    ...
}
```

**After**:
```c
esp_err_t home_ui_reload(void)
{
    /* 200ms timeout — long enough for normal page rebuild, short enough
     * to surface LVGL hang instead of waiting forever. */
    if (!display_engine_lock(200)) {
        ESP_LOGE(TAG, "home_ui_reload: lvgl lock timeout — UI may be hung");
        return ESP_ERR_TIMEOUT;
    }
    ...
}
```

**ไฟล์เพิ่มเติม** (เปลี่ยน 0 → 200 ในทุกจุดที่ไม่ใช่ render loop):
- `ui_renderer.c:1321, 1392` — เปลี่ยนเป็น 200
- `home_ui.c:2164, 2188` (build_page) — เปลี่ยนเป็น 500 (page build อาจนาน)

**⚠️ ระวัง**: ห้ามเปลี่ยนใน LVGL render loop เอง (display_engine.c:260, lvgl_task) — ต้องคงเป็น 0 เพราะ render loop ต้อง hold lock ตลอด

#### Fix C (debug aid): heartbeat log + watchdog state inspector

**ไฟล์**: `firmware/components/display_engine/display_engine.c`

**เพิ่ม static var + log ทุก 5 วินาที**:
```c
static uint32_t s_lvgl_tick_count = 0;
static uint32_t s_last_heartbeat_ms = 0;

// ใน lvgl_task loop:
s_lvgl_tick_count++;
uint32_t now = esp_log_timestamp();
if (now - s_last_heartbeat_ms > 5000) {
    ESP_LOGI(TAG, "lvgl heartbeat: %u ticks in 5s, fps=%.1f, heap_free=%u",
             s_lvgl_tick_count, s_ctx.fps,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    s_lvgl_tick_count = 0;
    s_last_heartbeat_ms = now;
}
```

### 2.5 Verify

```bash
# Build + flash
cd firmware && idf.py build && idf.py -p /dev/cu.usbmodem1301 flash

# Test 1: Normal operation → no watchdog
python3 -c "
import os, time, termios, tty, select
PORT='/dev/cu.usbmodem1301'
fd=os.open(PORT, os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
a=list(termios.tcgetattr(fd))
a[0]=0;a[1]=0;a[2]=termios.CLOCAL|termios.CREAD|termios.CS8
a[3]=0;a[4]=termios.B115200;a[5]=termios.B115200
a[6][termios.VMIN]=0;a[6][termios.VTIME]=5
termios.tcsetattr(fd, termios.TCSANOW, a)
def run(cmd, wait=2.5):
    os.write(fd, (cmd+'\r').encode())
    end=time.time()+wait
    buf=b''
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: c=os.read(fd,4096); buf+=c if c else b''
            except: pass
    return buf.decode('utf-8','replace')
time.sleep(8)
# Drain 60s, look for watchdog events
print('=== drain 60s looking for watchdog ===')
end=time.time()+60
buf=b''
while time.time()<end:
    r,_,_=select.select([fd],[],[],0.1)
    if r:
        try: c=os.read(fd,4096); buf+=c if c else b''
        except: pass
log = buf.decode('utf-8','replace')
if 'task_wdt' in log:
    print('FAIL: watchdog fired')
    print(log)
else:
    print('PASS: no watchdog in 60s')
"

# Test 2: Verify heartbeat log appears
python3 -c "
# ... drain 30s, look for 'lvgl heartbeat' ...
"

# Test 3: Force-trigger watchdog by stopping LVGL (simulate hang)
# (ไม่สามารถทำจากข้างนอก, ต้อง add debug command ใน Fix Bonus)
```

---

## 3. Bug #3 — POST /config ไม่ validate schema (P0)

### 3.1 อาการ
- POST `{"foo":"bar"}` → 200 → device.json กลายเป็น `{"foo":"bar"}`
- POST `{"brightness":50}` → 200 → device.json มีแค่ `{"brightness":50}` (ไม่มี pages/profile/owner)
- ส่งผล: pages count เหลือ 3 (defaults), profile หาย, rotation เสีย
- Cloud sync กอบ disk แต่ in-memory `s.cfg` ไม่ sync → ต้อง reboot

### 3.2 หลักฐาน
- ก่อน POST: 5 pages, brightness=80, profile ครบ
- หลัง POST `{foo:"bar"}` + `{brightness:50}`: disk = `{"brightness":50}`, memory = 3 pages

### 3.3 Root cause

**ไฟล์**: `firmware/components/local_api/local_api.c:107-145`

```c
static esp_err_t h_config_post(httpd_req_t *req)
{
    ...
    char *body = malloc(req->content_len + 1);
    ...
    int rd = httpd_req_recv(req, body, req->content_len);
    body[rd] = '\0';

    cJSON *root = cJSON_Parse(body);
    if (!root) {
        free(body);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid JSON");
    }
    cJSON_Delete(root);   // ← parse แล้ว "ทิ้ง" ไม่ validate field!

    /* write raw body to disk — overwrites entire file */
    esp_err_t err = storage_write_file_atomic(config_path(), body, rd);
    free(body);
    ...
    home_ui_reload();    // ← reload reads garbage → s.cfg in bad state
    ...
}
```

**3 บั๊กในจุดเดียว**:
1. Parse แล้ว delete โดยไม่ validate
2. Write raw body ทับทั้งไฟล์
3. Reload ทันทีหลัง write bad config

### 3.4 ทางแก้ — 3 ชั้น (defense in depth)

#### Layer 1: Validate required fields ใน handler

**ไฟล์**: `firmware/components/local_api/local_api.c:107-145`

**Before**:
```c
static esp_err_t h_config_post(httpd_req_t *req)
{
    cors(req);
    if (req->content_len <= 0 || req->content_len > 8192) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    char *body = malloc(req->content_len + 1);
    ...
    int rd = httpd_req_recv(req, body, req->content_len);
    body[rd] = '\0';

    cJSON *root = cJSON_Parse(body);
    if (!root) {
        free(body);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid JSON");
    }
    cJSON_Delete(root);   // BUG: discards without validation

    char dir[96];
    snprintf(dir, sizeof(dir), "%s/config", ...);
    storage_mkdirs(dir);

    esp_err_t err = storage_write_file_atomic(config_path(), body, rd);
    free(body);
    if (err != ESP_OK) return httpd_resp_send_500(req);
    home_ui_reload();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}
```

**After** (เพิ่ม validation):
```c
static esp_err_t validate_config_json(const cJSON *root, char *err_out, size_t err_len)
{
    if (!cJSON_IsObject(root)) {
        snprintf(err_out, err_len, "must be JSON object");
        return -1;
    }
    /* Required: pages (non-empty array of strings), brightness (0-100),
     * page_delay_s (>=3), profile (object), owner (object), display_mode (string) */
    const cJSON *pages = cJSON_GetObjectItem(root, "pages");
    if (!cJSON_IsArray(pages) || cJSON_GetArraySize(pages) == 0) {
        snprintf(err_out, err_len, "missing or empty 'pages' array");
        return -1;
    }
    int valid_pages = 0;
    const cJSON *p;
    cJSON_ArrayForEach(p, pages) {
        if (cJSON_IsString(p) && p->valuestring && p->valuestring[0]) valid_pages++;
    }
    if (valid_pages == 0) {
        snprintf(err_out, err_len, "'pages' array has no valid strings");
        return -1;
    }
    const cJSON *brightness = cJSON_GetObjectItem(root, "brightness");
    if (!cJSON_IsNumber(brightness) || brightness->valueint < 0 || brightness->valueint > 100) {
        snprintf(err_out, err_len, "'brightness' must be 0-100");
        return -1;
    }
    const cJSON *delay = cJSON_GetObjectItem(root, "page_delay_s");
    if (!cJSON_IsNumber(delay) || delay->valueint < 3) {
        snprintf(err_out, err_len, "'page_delay_s' must be >= 3");
        return -1;
    }
    const cJSON *profile = cJSON_GetObjectItem(root, "profile");
    if (!cJSON_IsObject(profile)) {
        snprintf(err_out, err_len, "missing 'profile' object");
        return -1;
    }
    const cJSON *owner = cJSON_GetObjectItem(root, "owner");
    if (!cJSON_IsObject(owner)) {
        snprintf(err_out, err_len, "missing 'owner' object");
        return -1;
    }
    const cJSON *mode = cJSON_GetObjectItem(root, "display_mode");
    if (!cJSON_IsString(mode)) {
        snprintf(err_out, err_len, "missing 'display_mode' string");
        return -1;
    }
    return 0;
}

static esp_err_t h_config_post(httpd_req_t *req)
{
    cors(req);
    if (req->content_len <= 0 || req->content_len > 8192) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad length");
    }
    char *body = malloc(req->content_len + 1);
    if (!body) return httpd_resp_send_500(req);

    int rd = httpd_req_recv(req, body, req->content_len);
    if (rd <= 0) { free(body); return httpd_resp_send_500(req); }
    body[rd] = '\0';

    cJSON *root = cJSON_Parse(body);
    if (!root) {
        free(body);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid JSON");
    }

    char err[96] = {0};
    if (validate_config_json(root, err, sizeof(err)) != 0) {
        ESP_LOGW(TAG, "config rejected: %s", err);
        cJSON_Delete(root);
        free(body);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, err);
    }
    cJSON_Delete(root);

    char dir[96];
    snprintf(dir, sizeof(dir), "%s/config",
             storage_sd_mounted() ? STORAGE_SD_BASE : STORAGE_LFS_BASE);
    storage_mkdirs(dir);

    esp_err_t err = storage_write_file_atomic(config_path(), body, rd);
    free(body);
    if (err != ESP_OK) {
        return httpd_resp_send_500(req);
    }
    home_ui_reload();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, "{\"ok\":true}", HTTPD_RESP_USE_STRLEN);
}
```

#### Layer 2: Backup before write (rollback on bad reload)

**Before** (หลัง Layer 1):
```c
esp_err_t err = storage_write_file_atomic(config_path(), body, rd);
```

**After**:
```c
/* Backup current device.json so we can rollback if reload fails */
char backup_path[200];
snprintf(backup_path, sizeof(backup_path), "%s.bak", config_path());
{
    size_t cur_len = 0;
    char *cur = storage_read_file(config_path(), &cur_len);
    if (cur && cur_len > 0 && cur_len < 8192) {
        storage_write_file_atomic(backup_path, cur, cur_len);
    }
    free(cur);
}

esp_err_t err = storage_write_file_atomic(config_path(), body, rd);
free(body);
if (err != ESP_OK) {
    /* restore from backup */
    size_t bk_len = 0;
    char *bk = storage_read_file(backup_path, &bk_len);
    if (bk) {
        storage_write_file_atomic(config_path(), bk, bk_len);
        free(bk);
    }
    return httpd_resp_send_500(req);
}

/* Try reload with timeout — if LVGL hung, rollback */
if (!home_ui_reload()) {
    ESP_LOGE(TAG, "home_ui_reload failed — rolling back config");
    size_t bk_len = 0;
    char *bk = storage_read_file(backup_path, &bk_len);
    if (bk) {
        storage_write_file_atomic(config_path(), bk, bk_len);
        free(bk);
        home_ui_reload();  // try again with backup
    }
    return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                "reload failed, rolled back");
}
```

Note: ต้องเปลี่ยน `home_ui_reload()` ให้ return `bool` (success/fail) — ดู Section 2 Fix B

#### Layer 3: Partial update endpoint (optional — for user-app partial updates)

เพิ่ม endpoint ใหม่ `POST /api/v1/config/merge` ที่ merge JSON เข้ากับ disk config (ไม่ overwrite):
```c
static esp_err_t h_config_merge_post(httpd_req_t *req)
{
    /* ... similar to h_config_post but uses cJSON_MergePatch or
     * field-by-field merge via cfg_apply_json() ... */
}
```

(Implement ตามต้องการ — ไม่จำเป็น P0 แต่ช่วยลด partial-update bugs ในอนาคต)

### 3.5 Verify

```bash
# Build + flash
cd firmware && idf.py build && idf.py -p /dev/cu.usbmodem1301 flash

# Test cases ที่ต้องผ่าน
sleep 8  # wait for boot

# Test 1: invalid garbage → 400
curl -X POST -H "Content-Type: application/json" -d '{"foo":"bar"}' http://192.168.1.46/api/v1/config
# Expected: HTTP 400 "missing or empty 'pages' array"

# Test 2: empty pages → 400
curl -X POST -H "Content-Type: application/json" -d '{"pages":[]}' http://192.168.1.46/api/v1/config
# Expected: HTTP 400 "missing or empty 'pages' array"

# Test 3: brightness out of range → 400
curl -X POST -H "Content-Type: application/json" -d '{
  "pages":["clock"],
  "brightness":150,
  "page_delay_s":10,
  "profile":{"show":true},
  "owner":{"email":"x@y.com"},
  "display_mode":"static"
}' http://192.168.1.46/api/v1/config
# Expected: HTTP 400 "brightness must be 0-100"

# Test 4: missing profile → 400
curl -X POST -H "Content-Type: application/json" -d '{
  "pages":["clock"],
  "brightness":80,
  "page_delay_s":10,
  "owner":{"email":"x@y.com"},
  "display_mode":"static"
}' http://192.168.1.46/api/v1/config
# Expected: HTTP 400 "missing 'profile' object"

# Test 5: valid full config → 200
curl -X POST -H "Content-Type: application/json" -d '{
  "pages":["clock","crypto","slideshow","profile","weather"],
  "brightness":60,
  "page_delay_s":15,
  "profile":{"show":true,"name":"Test"},
  "owner":{"email":"mycryptoclock@gmail.com"},
  "display_mode":"static"
}' http://192.168.1.46/api/v1/config
# Expected: HTTP 200, brightness=60 visible

# Test 6: bad reload → 500 + rollback
# (ต้อง trigger ผ่าน debug command, ดู Section 7 Bonus)

# Verify device still works
curl http://192.168.1.46/api/v1/info
# Expected: HTTP 200, brightness=60 (after test 5)

# Verify serial still responsive
python3 -c "
import os, time, termios, tty, select
PORT='/dev/cu.usbmodem1301'
fd=os.open(PORT, os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
a=list(termios.tcgetattr(fd))
a[0]=0;a[1]=0;a[2]=termios.CLOCAL|termios.CREAD|termios.CS8
a[3]=0;a[4]=termios.B115200;a[5]=termios.B115200
a[6][termios.VMIN]=0;a[6][termios.VTIME]=5
termios.tcsetattr(fd, termios.TCSANOW, a)
def run(cmd, wait=2.5):
    os.write(fd, (cmd+'\r').encode())
    end=time.time()+wait
    buf=b''
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: c=os.read(fd,4096); buf+=c if c else b''
            except: pass
    return buf.decode('utf-8','replace')
print(run('pages'))  # should show 5 pages
print(run('heap'))
"
```

---

## 4. Bug #4 — brightness out-of-range validation (P1, 5 นาที)

### 4.1 อาการ
- POST `{"value":999}` → 200 (clamped เงียบ ๆ ที่ 100)
- POST `{"value":-50}` → 200 (clamped เงียบ ๆ ที่ 0)
- Error message "need {value:0-100}" misleading — โผล่เฉพาะตอน value ไม่ใช่ตัวเลข

### 4.2 ตำแหนุ่
**ไฟล์**: `firmware/components/local_api/local_api.c:147-164`

### 4.3 ทางแก้

**Before**:
```c
static esp_err_t h_brightness(httpd_req_t *req)
{
    ...
    cJSON *root = cJSON_Parse(body);
    const cJSON *v = root ? cJSON_GetObjectItem(root, "value") : NULL;
    if (!cJSON_IsNumber(v)) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "need {\"value\":0-100}");
    }
    ccp_board_set_brightness(v->valueint);
    ...
}
```

**After**:
```c
static esp_err_t h_brightness(httpd_req_t *req)
{
    ...
    cJSON *root = cJSON_Parse(body);
    const cJSON *v = root ? cJSON_GetObjectItem(root, "value") : NULL;
    if (!cJSON_IsNumber(v)) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "need {\"value\":0-100}");
    }
    if (v->valueint < 0 || v->valueint > 100) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "value must be 0-100");
    }
    ccp_board_set_brightness(v->valueint);
    ...
}
```

### 4.4 Verify
```bash
# Test invalid range
curl -X POST -H "Content-Type: application/json" -d '{"value":999}' http://192.168.1.46/api/v1/brightness
# Expected: HTTP 400 "value must be 0-100"

curl -X POST -H "Content-Type: application/json" -d '{"value":-5}' http://192.168.1.46/api/v1/brightness
# Expected: HTTP 400 "value must be 0-100"

# Test valid range
curl -X POST -H "Content-Type: application/json" -d '{"value":50}' http://192.168.1.46/api/v1/brightness
# Expected: HTTP 200

curl http://192.168.1.46/api/v1/info
# Expected: brightness=50
```

---

## 5. Bug #5 — slideshow transient lock timeout (P2, 15 นาที)

### 5.1 อาการ
- `goto slideshow` → 4 images loaded ใช้เวลา > 50ms → `display lock timeout (50 ms), holder=lvgl`
- ไม่ crash แต่ log noise

### 5.2 ทางแก้

**ทางเลือก A**: เพิ่ม UI_LOCK_MS 50 → 200

**ไฟล์**: `firmware/components/wasm_engine/ccp_host_api.c:17`
```c
// Before:
#define UI_LOCK_MS 50   /* host imports must never block long (ABI rule) */

// After:
#define UI_LOCK_MS 200  /* wasm host imports — 200ms safe for image/gif/text load */
```

⚠️ **คำเตือน**: ตอนนี้หลาย host api ถูกเรียกใน tight loop หรือจาก interrupt context — ต้อง audit ก่อนเพิ่ม

**ทางเลือก B**: Optimize slideshow init

**ไฟล์**: `firmware/components/home_ui/home_ui.c` slideshow build_page

ดู `home_ui.c:1240-1320` (slideshow init) — preload images ใน async task แทน inline

**ทางเลือก C (แนะนำ)**: ทั้ง A + เพิ่ม load timeout context-aware

```c
// ใน slideshow init: ระบุว่า build นี้ใช้เวลานาน ใช้ lock ยาวขึ้น
if (!display_engine_lock(500)) {  // slideshow needs longer
    ESP_LOGW(TAG, "slideshow init lock timeout");
    return;
}
```

### 5.3 Verify
```bash
# Force slideshow goto 5 times
python3 -c "...goto slideshow... " | grep "display lock timeout"
# Expected: ไม่มี "display lock timeout" ใน log
```

---

## 6. Bug #6 — FAT atomic write race condition (P2, 30 นาที)

### 6.1 ปัญหา
- `storage_write_file_atomic` ใช้ unlink + rename แต่ **FAT ไม่มี atomic rename**
- มี window ที่ file หาย ถ้า crash/power loss ระหว่าง unlink กับ rename
- บน ESP-IDF มี `fflush` + `fsync` แต่ code นี้ไม่เรียก

### 6.2 ตำแหนุ่
**ไฟล์**: `firmware/components/storage/storage.c:233-250`

### 6.3 ทางแก้

**Before**:
```c
esp_err_t storage_write_file_atomic(const char *path, const void *data, size_t len)
{
    char tmp[300];
    snprintf(tmp, sizeof(tmp), "%s.new", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) return ESP_FAIL;
    size_t wr = fwrite(data, 1, len, f);
    fclose(f);
    if (wr != len) { unlink(tmp); return ESP_FAIL; }
    unlink(path);
    return (rename(tmp, path) == 0) ? ESP_OK : ESP_FAIL;
}
```

**After**:
```c
esp_err_t storage_write_file_atomic(const char *path, const void *data, size_t len)
{
    char tmp[300];
    snprintf(tmp, sizeof(tmp), "%s.new", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) {
        ESP_LOGE(TAG, "atomic write: fopen(%s) failed: errno=%d", tmp, errno);
        return ESP_FAIL;
    }
    size_t wr = fwrite(data, 1, len, f);
    if (wr != len) {
        ESP_LOGE(TAG, "atomic write: short write %u/%u", (unsigned)wr, (unsigned)len);
        fclose(f);
        unlink(tmp);
        return ESP_FAIL;
    }
    /* Force buffer flush to SD card BEFORE rename — ensures data survives power loss */
    if (fflush(f) != 0) {
        ESP_LOGE(TAG, "atomic write: fflush failed");
        fclose(f);
        unlink(tmp);
        return ESP_FAIL;
    }
    int fd = fileno(f);
    if (fd >= 0) fsync(fd);  /* FAT driver may ignore, but esp_vfs_fat_sdmmc supports it */
    fclose(f);

    /* Write .ok marker to signal .new is complete */
    char ok_path[300];
    snprintf(ok_path, sizeof(ok_path), "%s.ok", path);
    f = fopen(ok_path, "wb");
    if (f) {
        fputc('1', f);
        fclose(f);
        if (fflush(f) != 0) { /* ignore */ }
    }

    /* Now safe to swap: unlink old, rename .new → path.
     * If power loss here, boot recovery looks for .new + .ok pair. */
    unlink(path);
    int rc = rename(tmp, path);
    unlink(ok_path);  /* cleanup marker */
    if (rc != 0) {
        ESP_LOGE(TAG, "atomic write: rename failed errno=%d", errno);
        return ESP_FAIL;
    }
    return ESP_OK;
}
```

**เพิ่ม recovery logic** ใน `cfg_load`:
```c
/* ในตอน boot ก่อน cfg_apply_file */
static void recover_partial_writes(const char *path)
{
    char tmp[300], ok[300];
    snprintf(tmp, sizeof(tmp), "%s.new", path);
    snprintf(ok, sizeof(ok), "%s.ok", path);
    struct stat st_tmp, st_ok, st_main;
    bool has_tmp = (stat(tmp, &st_tmp) == 0);
    bool has_ok = (stat(ok, &st_ok) == 0);
    bool has_main = (stat(path, &st_main) == 0);

    if (has_tmp && has_ok && !has_main) {
        /* partial write — promote .new to main */
        ESP_LOGW(TAG, "recovering partial write: %s -> %s", tmp, path);
        rename(tmp, path);
        unlink(ok);
    } else if (has_tmp && !has_ok) {
        /* tmp without .ok marker — incomplete, discard */
        ESP_LOGW(TAG, "discarding incomplete tmp: %s", tmp);
        unlink(tmp);
    } else if (!has_tmp && has_ok) {
        /* orphan .ok — cleanup */
        unlink(ok);
    }
}
```

---

## 7. Bonus — เพิ่ม debug commands ผ่าน serial (P1, 1 ชม.)

### 7.1 เหตุผล
- ตอนนี้ถ้าเครื่องค้าง ต้อง power-cycle — ทำให้ debug ยาก
- คำสั่งที่ขาด: `restart`, `brightness <0-100>`, `identify`, `reload-config`, `sync-cloud`

### 7.2 ทางแก้

**ไฟล์**: `firmware/components/dbg_console/dbg_console.c`

**เพิ่ม**:
```c
#include "esp_restart.h"
#include "ccp_board.h"
#include "display_engine.h"
#include "home_ui.h"

static int cmd_restart(int argc, char **argv)
{
    printf("Rebooting in 500ms...\n");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return 0;
}

static int cmd_brightness(int argc, char **argv)
{
    if (argc < 2) {
        printf("usage: brightness <0-100>\n");
        return 1;
    }
    int v = atoi(argv[1]);
    if (v < 0 || v > 100) {
        printf("brightness must be 0-100\n");
        return 1;
    }
    ccp_board_set_brightness(v);
    printf("brightness set to %d\n", v);
    return 0;
}

static int cmd_identify(int argc, char **argv)
{
    extern void audio_engine_tone(int freq, int ms, int vol);
    audio_engine_tone(1200, 250, 70);
    printf("identify: beep done\n");
    return 0;
}

static int cmd_reload_config(int argc, char **argv)
{
    printf("reloading config from disk...\n");
    home_cfg_t cfg;
    cfg_load(&cfg);
    /* need to update s.cfg — might need refactor to expose */
    printf("reload done\n");
    return 0;
}

static int cmd_sync_cloud(int argc, char **argv)
{
    extern void settings_sync_from_server(void);
    printf("triggering cloud sync...\n");
    settings_sync_from_server();
    return 0;
}

static int cmd_lock_test(int argc, char **argv)
{
    /* debug aid: try to acquire display lock, see who holds it */
    printf("trying display_engine_lock(100)...\n");
    if (display_engine_lock(100)) {
        printf("got lock, holding for 2s\n");
        vTaskDelay(pdMS_TO_TICKS(2000));
        display_engine_unlock();
        printf("released\n");
    } else {
        printf("timeout\n");
    }
    return 0;
}

/* ใน dbg_console_start: */
reg("restart", "reboot device (500ms delay)", cmd_restart, NULL);
reg("brightness", "<0-100> set backlight", cmd_brightness, NULL);
reg("identify", "beep + flash for device ID", cmd_identify, NULL);
reg("reload-config", "re-read device.json + reload UI", cmd_reload_config, NULL);
reg("sync-cloud", "force settings_sync_from_server", cmd_sync_cloud, NULL);
reg("lock-test", "test display lock for 2s", cmd_lock_test, NULL);
```

### 7.3 Verify
```bash
python3 -c "
import os, time, termios, tty, select
PORT='/dev/cu.usbmodem1301'
fd=os.open(PORT, os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
a=list(termios.tcgetattr(fd))
a[0]=0;a[1]=0;a[2]=termios.CLOCAL|termios.CREAD|termios.CS8
a[3]=0;a[4]=termios.B115200;a[5]=termios.B115200
a[6][termios.VMIN]=0;a[6][termios.VTIME]=5
termios.tcsetattr(fd, termios.TCSANOW, a)
def run(cmd, wait=2.5):
    os.write(fd, (cmd+'\r').encode())
    end=time.time()+wait
    buf=b''
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: c=os.read(fd,4096); buf+=c if c else b''
            except: pass
    return buf.decode('utf-8','replace')
time.sleep(8)
print('help')
print(run('help'))  # should show new commands
print('=== brightness 50 ===')
print(run('brightness 50'))
print('=== brightness invalid ===')
print(run('brightness 999'))
print('=== lock-test (should hold lock 2s) ===')
print(run('lock-test'))
# DON'T test 'restart' from script — it will kill serial
"
```

---

## 8. Verification plan รวม (หลังแก้ทั้งหมด)

### 8.1 Build + Flash
```bash
cd /Users/natthapongsuwanjit/Desktop/CryptoClockPro/firmware
export IDF_PYTHON_ENV_PATH=~/.espressif/python_env/idf5.5_py3.9_env
. ~/esp/esp-idf/export.sh
idf.py build 2>&1 | tee /tmp/ccp_build.log
# ดู error/warning ก่อน flash
idf.py -p /dev/cu.usbmodem1301 flash
```

### 8.2 Smoke test (5 นาที)
1. ✅ boot OK (serial `ver` ตอบ)
2. ✅ HTTP /info ตอบ
3. ✅ brightness command ผ่าน serial
4. ✅ HTTP POST /config valid สำเร็จ
5. ✅ goto slideshow, weather, profile, clock — ไม่มี lock timeout
6. ✅ **goto crypto 5 ครั้งติด — ไม่ crash** (Bug #1 fix verified)
7. ✅ reboot ผ่าน serial `restart` (Bug #7 verified)
8. ✅ HTTP POST /config ทุก test case ตาม Section 3.5

### 8.3 Stress test (15 นาที)
1. Auto-rotation 5 นาที (clock → crypto → slideshow → ...) — **ไม่มี watchdog event**
2. POST /config 10 ครั้งติด — brightness/page_delay สลับไปมา
3. POST /upload + /delete 5 ครั้ง — file integrity
4. POST /brightness out-of-range 3 ครั้ง — ทุกครั้ง return 400
5. power-cycle 1 ครั้ง — config restore ถูกต้อง

### 8.4 Regression test (ดูจาก QA report)
- ทุก TC-LIVE-* ที่เคย PASS ต้องยัง PASS
- TC-DV-12 spec mismatch → ถ้าเลือก "B" (เพิ่ม DELETE route) ต้องเพิ่ม route handler ด้วย
- /files?dir= vs path= → ถ้าเลือก "A" (sync doc) ต้องอัพเดท prompt + handoff

---

## 9. Rollout plan

### 9.1 ลำดับการแก้ (ทำทีละขั้น, test ก่อนไปขั้นต่อไป)

| ขั้น | งาน | Test gate | Approx เวลา |
|---|---|---|---|
| 1 | Bug #1 crypto_poll (ทางเลือก A เพิ่ม stack) | goto crypto 5 ครั้งไม่ crash | 30 นาที |
| 2 | Bug #4 brightness range (1 บรรทัด) | curl value=999 → 400 | 5 นาที |
| 3 | Bug #2 LVGL watchdog (Fix A + Fix B) | 5 นาทีไม่มี watchdog | 1-2 ชม. |
| 4 | Bug #3 POST /config validate (Layer 1) | 4 test cases ผ่าน | 1 ชม. |
| 5 | Bug #3 POST /config (Layer 2 backup+rollback) | trigger bad reload → rollback | 30 นาที |
| 6 | Bug #5 slideshow lock (เพิ่ม timeout) | goto slideshow ไม่ lock timeout | 15 นาที |
| 7 | Bug #6 FAT atomic write + recovery | ดู .new + .ok ใน SD หลัง write | 30 นาที |
| 8 | Bonus: serial debug commands | help แสดงคำสั่งใหม่ | 1 ชม. |
| 9 | Smoke + stress + regression test | ทุก TC ผ่าน | 1 ชม. |

**รวม**: ~6-8 ชม. work + 1-2 ชม. test/verify

### 9.2 Risk + Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| LVGL mutex change ทำให้ deadlock ใหม่ | High | ทำทีละจุด + verify หลังทุก commit |
| Stack size เพิ่มกิน internal RAM | Low | internal free=34KB, เพิ่ม 4KB ยังเหลือ 30KB |
| FAT .new/.ok scheme ทำให้ file count เพิ่ม | Low | cleanup ใน recovery + rename success |
| Schema validate strict เกิน — user-app POST ตก | Medium | ตรวจ user-app ก่อน — ถ้าส่ง partial ให้ใช้ merge endpoint แทน |
| watchdog subscribe ผิดพลาด → boot loop | High | ใช้ esp_task_wdt_add(NULL) ใน task เอง หลัง malloc เสร็จ |

### 9.3 สิ่งที่ต้อง commit + push

```bash
git add firmware/components/home_ui/home_ui.c
git add firmware/components/display_engine/display_engine.c
git add firmware/components/local_api/local_api.c
git add firmware/components/wasm_engine/ccp_host_api.c
git add firmware/components/storage/storage.c
git add firmware/components/dbg_console/dbg_console.c
git commit -m "fix: crypto_poll stack + LVGL watchdog + config validation (P0)"
# อย่าลืม secret-scan ก่อน push (handoff doc เตือนไว้)
```

---

## 10. คำถามที่เจ้าของต้องตัดสินใจก่อนเริ่ม

### 10.1 Bug #1 — ทางเลือก
- [ ] **A** เพิ่ม stack (1 บรรทัด) — เร็วสุด
- [ ] **B** refactor parse loop — ปลอดภัยกว่า, โค้ดยาวขึ้น
- [ ] **C** PSRAM heap สำหรับ cJSON — fix ทั้งระบบ
- [ ] **แนะนำ: A + C** (defense in depth)

### 10.2 Bug #3 — ทางเลือก layer
- [ ] **Layer 1 only** (validate field) — เร็ว, แก้ก่อน
- [ ] **Layer 1 + Layer 2** (validate + backup/rollback) — ปลอดภัยกว่า
- [ ] **Layer 1 + 2 + 3** (เพิ่ม merge endpoint) — ครบสุด

### 10.3 Bug #6 — ทางเลือก
- [ ] **A** เพิ่ม fflush + fsync (minimal)
- [ ] **B** .new + .ok marker + recovery (robust)
- [ ] **แนะนำ: B**

### 10.4 Spec mismatch (P2 docs sync)
- [ ] `DELETE /file` → `POST /delete` — แก้ prompt + handoff
- [ ] หรือเพิ่ม `DELETE /api/v1/file` route ใน firmware

### 10.5 Bonus — debug commands
- [ ] เพิ่มทั้ง 6 คำสั่ง (`restart`, `brightness`, `identify`, `reload-config`, `sync-cloud`, `lock-test`)
- [ ] หรือแค่ `restart` + `brightness` + `identify` (minimum)

---

## 11. หลังแก้เสร็จ — อัพเดทเอกสารเหล่านี้ด้วย

1. `docs/QA_TEST_PROMPT_MINIMAX.md` — แก้ TC-DV-12 (DELETE → POST), /files (path → dir), serial port
2. `docs/HANDOFF.md` — อัพเดท serial port + เพิ่ม section "known bugs"
3. `docs/BUGFIX_PLAN_2026-06-24.md` (ไฟล์นี้) — เปลี่ยนสถานะเป็น "EXECUTED" + link commit
4. `docs/QA_REPORT_2026-06-24.md` — เพิ่ม "UPDATE 3" บอกว่าบั๊กถูกแก้แล้ว

---

## 12. หากต้องการ implement ทันที

บอก "ลุย" แล้วผมจะ:
1. อ่านไฟล์ทั้งหมดที่เกี่ยวข้องให้ละเอียดอีกครั้ง
2. ใช้ EnterPlanMode เพื่อ present แผน implement
3. ทำตาม Section 9.1 ทีละขั้น
4. verify ตาม Section 8 ทุก TC

⚠️ **ข้อจำกัด**: การ flash และ test ต้องมีเครื่องจริงต่อ — ผมจะ verify ผ่าน serial + LAN API เหมือนเดิม
แต่ถ้าจะให้ผม test "หลังแก้" ต้องรอให้เจ้าของ build + flash ใหม่ก่อน (ผมทำ build ไม่ได้ใน environment นี้เพราะ idf.py ไม่ติดตั้ง)
