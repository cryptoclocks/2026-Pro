# คู่มือเขียน Logic ของแต่ละหน้า (Page Logic Guide)

> คู่มือนี้ตอบ 3 คำถาม:
> 1. หน้านาฬิกาที่เห็นบนจอ "นับเวลา" ยังไง และทำไมไม่ตรงกับหน้า Clock ใน Builder
> 2. โค้ด Rust skeleton ที่เปิดเจอใน Builder (Edit Logic) แต่ละบรรทัดคืออะไร
> 3. จะเขียน logic ให้หน้าใหม่ "ทำงานจริง" ได้ยังไง (พร้อมตัวอย่างเต็ม 4 ตัว)

เอกสารที่เกี่ยวข้อง: [pages-guide.md](pages-guide.md) (แก้หน้า default ที่ไหน) ·
[schema/abi/ccp_abi_v1.md](../schema/abi/ccp_abi_v1.md) (สเปก ABI ทางการ) ·
[builder-and-billing.md](builder-and-billing.md) (flow ขายหน้า/สิทธิ์)

---

## 0. สิ่งสำคัญที่สุด: "หน้า" มี 2 โลก ที่ไม่ได้เชื่อมกัน

| | โลกที่ 1 — หน้า **native** | โลกที่ 2 — หน้า **Store/Builder** |
|---|---|---|
| หน้าไหนบ้าง | **clock, crypto, slideshow** (3 หน้า default) | หน้าที่ออกแบบใน `/builder` แล้ว publish |
| เขียนด้วย | ภาษา **C** ฝังในเฟิร์มแวร์ ([home_ui.c](../firmware/components/home_ui/home_ui.c)) | **layout.json + logic.wasm (Rust)** ส่งจาก server |
| แก้ layout/logic | ต้อง build + **flash** ใหม่ | แก้ใน Builder → Publish → ส่ง **OTA** ไม่ต้อง flash |
| ใครวาดจอ | `build_clock_page()` ฯลฯ ใน home_ui.c | `ui_renderer` (อ่าน layout.json) + `wasm_engine` (รัน logic.wasm) |

**ดังนั้น — คำตอบปัญหาที่ 1:** นาฬิกาที่เดินอยู่บนจอตอนนี้คือ **โลกที่ 1** (โค้ด C
ในเฟิร์มแวร์ — มีโลโก้ล่างจอเพราะ C โหลดไฟล์ `pages/clock/assets/logo.png` จาก SD เอง)
ส่วนหน้า "Clock" ที่เปิดใน Builder คือ **โลกที่ 2** — เป็นแค่ *template ตั้งต้น*
สำหรับออกแบบหน้าขายใหม่ มันไม่ใช่ต้นฉบับของนาฬิกาบนจอ และ logic ของมันคือ
skeleton เปล่า (no-op) จึง "ไม่ตรงกัน" เป็นเรื่องปกติของสถาปัตยกรรมตอนนี้
ไม่ใช่บั๊ก

---

## 1. หน้านาฬิกา native นับเวลายังไง (อธิบายโค้ดจริง)

โค้ดอยู่ที่ [home_ui.c](../firmware/components/home_ui/home_ui.c) ฟังก์ชัน
`clock_tick()` + `build_clock_page()`

### 1.1 แหล่งเวลา: ไม่มีถ่าน RTC — ใช้ SNTP จากเน็ต

บอร์ดไม่มีนาฬิกาแบตเตอรี่สำรอง เวลาจึงมาจากอินเทอร์เน็ต:

1. ต่อ WiFi สำเร็จ → ESP-IDF เริ่ม **SNTP** (Network Time Protocol) เทียบเวลากับ
   time server แล้วตั้งนาฬิการะบบของชิป
2. หลังจากนั้น `time(NULL)` จะคืน **epoch seconds (UTC)** — จำนวนวินาทีตั้งแต่
   1 ม.ค. 1970 และชิปจะเดินต่อเองด้วย crystal ภายใน (sync ซ้ำเป็นระยะ)

```c
static void clock_tick(lv_timer_t *t)
{
    time_t now = time(NULL);
    if (now < 1600000000) {            /* SNTP ยังไม่ sync */
        lv_label_set_text(s.lbl_time, "--:--");
        ...
        return;
    }
    now += (time_t)s.cfg.tz_offset_min * 60;   /* บวก timezone (ไทย = +420 นาที) */
    struct tm tm;
    gmtime_r(&now, &tm);               /* แตก epoch -> ปี/เดือน/วัน/ชม/นาที/วินาที */

    lv_label_set_text_fmt(s.lbl_time, "%02d:%02d", tm.tm_hour, tm.tm_min);
    lv_label_set_text_fmt(s.lbl_sec,  "%02d", tm.tm_sec);
    lv_label_set_text_fmt(s.lbl_date, "%s  %d %s %d", ...);
}
```

อธิบายทีละจุด:
- `now < 1600000000` — epoch 1600000000 ≈ ก.ย. 2020 ถ้าน้อยกว่านี้แปลว่านาฬิกา
  ระบบยังเป็นค่า default (1970) = **ยังไม่ได้ sync** → โชว์ `--:--` กับข้อความ
  "Syncing time..." / "Waiting for WiFi..."
- `tz_offset_min` มาจาก config (แอป/เว็บ admin ตั้งได้ ไม่ต้อง flash) เก็บเป็นนาที
  เช่นไทย = `+420` → คูณ 60 บวกเข้า epoch แล้วใช้ `gmtime_r` (ฝั่ง UTC) แทนการตั้ง
  TZ ของระบบ
- ตัวจุดชนวน: `lv_timer_create(clock_tick, 1000, NULL)` — สั่งให้ LVGL เรียก
  `clock_tick` **ทุก 1000ms** นี่แหละคือ "การนับเวลา" ของหน้านาฬิกา: ไม่ได้นับเอง
  แต่*อ่านนาฬิการะบบใหม่ทุกวินาที*แล้ววาดทับ

### 1.2 การวางผัง (ทำไมตัวเลขใหญ่ / วินาทีส้ม / โลโก้ล่าง)

ใน `build_clock_page()`:
- เวลาใช้ฟอนต์ Montserrat 48pt แล้ว**ขยายด้วย transform scale 780/256 ≈ 3.05 เท่า**
  (`CLOCK_TIME_SCALE 780`) — LVGL วัดขนาดกล่องข้อความจริงก่อน (`lv_obj_update_layout`)
  แล้วคำนวณครึ่งกว้าง/ครึ่งสูงที่มองเห็น (`vis_hw`, `vis_hh`) เพื่อวางชิ้นอื่นให้เกาะ
  ตัวเลขพอดีไม่ว่าฟอนต์จะกว้างแค่ไหน
- วินาที = label เล็กสีส้ม `0xFF9500` วางที่มุมขวาล่างของตัวเลขเวลา
  (`vis_hw + 12, CLOCK_TIME_Y + vis_hh - 32`)
- วันที่ = วางเหนือเวลา (`CLOCK_TIME_Y - vis_hh - 6`)
- **โลโก้**: ไล่หา `pages/clock/assets/logo.png` บน **SD ก่อน แล้วค่อย LittleFS**
  เจอที่ไหนก็สร้าง `lv_image` วางกลางล่าง (`LV_ALIGN_BOTTOM_MID, 0, -6`) —
  เพราะงั้นโลโก้คือ **asset บนการ์ด ไม่ใช่ของใน layout** เปลี่ยนรูปได้โดยไม่ flash
  และจะไม่มีวันไปโผล่ใน Builder template

### 1.3 อยากแก้หน้านาฬิกา native ต้องแก้ตรงไหน

| อยากแก้ | ที่ไหน | flash? |
|---|---|---|
| ขนาด/ตำแหน่งตัวเลข | มาโคร `CLOCK_TIME_SCALE`, `CLOCK_TIME_Y` ใน home_ui.c | ✅ |
| สีธีม | ตาราง `THEMES[]` หรือเปลี่ยน theme จากแอป/เว็บ | ❌ (เลือกธีม) |
| timezone | config `tz_offset_min` จากแอป/เว็บ | ❌ |
| โลโก้ | แทนที่ไฟล์ `pages/clock/assets/logo.png` (PNG) | ❌ |
| logic นับเวลา (เช่น 12 ชม., แสดง พ.ศ.) | `clock_tick()` | ✅ |

---

## 2. อธิบายโค้ด skeleton ใน Builder ทีละบรรทัด (โค้ดที่คุณเปิดเจอ)

โค้ดที่เปิดจากหน้า Clock ใน Builder คือ **`NOOP_LOGIC_SOURCE`** — logic เปล่า
ที่ Builder แปะให้ทุกหน้าใหม่ มันคือ "สัญญาขั้นต่ำ" ที่ทุก module ต้องมีตาม
[ABI v1](../schema/abi/ccp_abi_v1.md) แต่**ยังไม่ทำอะไรเลย** (หน้า Clock ใน Builder
จึงไม่เดินเวลา — ต้องเขียนเองตามตัวอย่างข้อ 5)

```rust
#![no_std]
```
ไม่ใช้ Rust standard library — บน ESP32 ไม่มี OS/heap ให้ std ใช้
ไฟล์ .wasm จะเล็กมาก (ไม่กี่ KB) และ allocator ต้องเขียนเอง (ดูล่าง)

```rust
const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;
```
ค่าคงที่ของสัญญา ABI: เวอร์ชัน 1, รหัสสำเร็จ/ผิดพลาด (ตรงกับตารางใน ccp_abi_v1.md)

```rust
#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION { return CCP_ERR_INVAL; }
    CCP_OK
}
```
- `#[no_mangle]` + `extern "C"` = ห้าม Rust เปลี่ยนชื่อฟังก์ชัน เพื่อให้เฟิร์มแวร์
  (WAMR runtime) หาเจอด้วยชื่อ `ccp_on_init` ตรงๆ
- เฟิร์มแวร์เรียก **ครั้งเดียวตอนโหลด module** พร้อมส่งเลขเวอร์ชัน ABI ที่ตัวเอง
  พูดได้ — ถ้าไม่ตรงให้คืนค่าติดลบ = ปฏิเสธการโหลด (กันเฟิร์มแวร์เก่ารัน module ใหม่)
- นี่คือที่ที่ปกติเราจะ: หา widget handle, subscribe data, ขอ tick (ดูตัวอย่างข้อ 5–7)

```rust
pub extern "C" fn ccp_on_tick(_now_ms: u64) {}
```
หัวใจของ logic ต่อเนื่อง — เฟิร์มแวร์เรียกซ้ำตามช่วงเวลาที่เราขอด้วย
`ccp_request_tick(interval_ms)` (ขั้นต่ำ 16ms, ส่ง 0 = หยุด) `now_ms` คือเวลานับ
จากเปิดเครื่อง (monotonic) — skeleton นี้ไม่ได้ขอ tick จึงไม่ถูกเรียกเลย

```rust
pub extern "C" fn ccp_on_event(_widget: i32, _event: u32, _p0: i32, _p1: i32) {}
```
ถูกเรียกเมื่อผู้ใช้แตะจอ: `widget` = handle ของ widget ที่โดน, `event` =
1 PRESSED / 4 CLICKED / 6 VALUE_CHANGED / 7 GESTURE ฯลฯ (ตารางเต็มข้อ 4.3),
`p0,p1` = พิกัด/ค่า แล้วแต่ event

```rust
pub extern "C" fn ccp_on_data(_stream_handle: i32, _payload_ptr: u32, _len: u32) {}
```
ถูกเรียกเมื่อมีข้อมูลเข้าจาก stream ที่เรา subscribe (เช่นราคาเหรียญจาก server
ผ่าน MQTT) — payload เป็น JSON วางไว้ในหน่วยความจำของ module ที่ตำแหน่ง
`payload_ptr` ยาว `len` ไบต์ (host วางให้โดยเรียก `ccp_malloc` ของเรา — ดูถัดไป)

```rust
pub extern "C" fn ccp_on_destroy() {}
```
เรียกก่อน unload (เปลี่ยนหน้า/อัปเดต package) — ไว้เก็บกวาด ถ้ามีอะไรต้องเซฟ
ให้ใช้ `ccp_kv_set` ที่นี่

### 2.1 ARENA — ทำไมต้องมี `ccp_malloc` / `ccp_free`

```rust
static mut ARENA: [u8; 4 * 1024] = [0; 4 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;
```
WASM ไม่มี heap ในตัว แต่ **host (เฟิร์มแวร์) ต้องการที่วางข้อมูลฝั่งเรา**
ก่อนเรียก `ccp_on_data` — มันจะเรียก `ccp_malloc(len)` ของเราเพื่อขอพื้นที่ใน
linear memory ของ module เอง, copy payload ลงไป, เรียก `ccp_on_data(ptr,len)`,
แล้วเรียก `ccp_free(ptr)` คืน

ตัวจัดสรรที่ใช้คือ **bump allocator** แบบง่ายที่สุด:

```rust
pub extern "C" fn ccp_malloc(size: u32) -> u32 {
    let size = ((size as usize) + 7) & !7;        // ปัดขึ้นเป็นพหุคูณ 8 (alignment)
    unsafe {
        if ARENA_TOP + size > ARENA.len() { return 0; }  // เต็ม -> คืน NULL
        ARENA_LAST = ARENA_TOP;                   // จำตำแหน่งก้อนล่าสุด
        let ptr = ARENA.as_mut_ptr().add(ARENA_TOP) as u32;
        ARENA_TOP += size;                        // ดัน "ยอด" ขึ้น
        ptr
    }
}

pub extern "C" fn ccp_free(ptr: u32) {
    unsafe {
        let last_ptr = ARENA.as_mut_ptr().add(ARENA_LAST) as u32;
        if ptr == last_ptr { ARENA_TOP = ARENA_LAST; }   // คืนได้เฉพาะก้อนล่าสุด
    }
}
```
- จองโดย "ดันยอด (top) ขึ้น" — เร็วมาก ไม่มี fragmentation
- คืน (free) ได้**เฉพาะก้อนล่าสุด** (LIFO) ซึ่งพอดีกับรูปแบบการใช้ของ host:
  malloc → on_data → free ทันที ก้อนอื่นที่ไม่ใช่ล่าสุดจะถูก "ลืม" ไป —
  ยอมรับได้เพราะ arena ถูกใช้วนแบบนี้ตลอด
- ขนาด 4KB คือเพดาน payload ต่อข้อความ — ถ้า stream ส่ง JSON ใหญ่กว่านี้ให้ขยาย
  เป็น `16 * 1024` แบบใน rust-ticker

```rust
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! { loop {} }
```
`no_std` บังคับให้กำหนดเองว่า panic แล้วทำอะไร — ที่นี่คือวนลูปเฉยๆ
แล้วปล่อยให้ **watchdog ของเฟิร์มแวร์ฆ่า module** (เกิน deadline →
`wasm_runtime_terminate()` → โหลดใหม่สูงสุด 3 ครั้ง → ถอยไปเวอร์ชันก่อน/หน้า recovery)
จอหลักไม่มีวันค้างเพราะ logic เรา panic — นี่คือเหตุผลที่เลือก WASM sandbox

---

## 3. วงจรชีวิตของ logic (เมื่อไหร่อะไรถูกเรียก)

```
ติดตั้ง package / เปิดเครื่อง
        │
        ▼
ccp_on_init(abi)  ←ครั้งเดียว: หา widget, subscribe stream, ขอ tick
        │
        ├──ทุก interval──▶ ccp_on_tick(now_ms)        ←เดินนาฬิกา/อนิเมชัน/นับถอยหลัง
        ├──ผู้ใช้แตะจอ──▶ ccp_on_event(w, evt, p0, p1) ←ปุ่ม/สไลเดอร์/gesture
        ├──ข้อมูลเข้า───▶ ccp_malloc → ccp_on_data → ccp_free  ←ราคาเหรียญ/อากาศ
        ▼
ccp_on_destroy()  ←ก่อน unload: เซฟ state ด้วย ccp_kv_set
```

**Deadline ที่ host บังคับ** (เกินแล้วโดนฆ่า): `on_init` 3000ms ·
`on_event`/`on_data` 250ms · `on_tick` 3×interval (ขั้นต่ำ 100ms)
→ ห้ามวนลูปหนักหรือรอ I/O ใน callback — แตกงานเป็นช่วงสั้นๆ ผ่าน tick แทน

---

## 4. Host API — เครื่องมือทั้งหมดที่ logic เรียกได้

ประกาศ import ใน Rust แบบนี้ (เลือกเฉพาะตัวที่ใช้):

```rust
#[link(wasm_import_module = "env")]
extern "C" {
    fn ccp_ui_get_widget(id: *const u8, id_len: u32) -> i32;
    fn ccp_ui_set_text(widget: i32, text: *const u8, len: u32) -> i32;
    fn ccp_ui_set_value(widget: i32, value: i32) -> i32;
    fn ccp_ui_set_color(widget: i32, argb: u32, part: u32) -> i32;
    fn ccp_ui_set_visible(widget: i32, visible: i32) -> i32;
    fn ccp_request_tick(interval_ms: u32) -> i32;
    fn ccp_time_unix() -> u64;
    fn ccp_time_ms() -> u64;
    fn ccp_data_subscribe(stream: *const u8, len: u32) -> i32;
    fn ccp_kv_get(k: *const u8, kl: u32, v: *mut u8, vl: u32) -> i32;
    fn ccp_kv_set(k: *const u8, kl: u32, v: *const u8, vl: u32) -> i32;
    fn ccp_audio_tone(freq_hz: u32, dur_ms: u32, vol_0_100: u32) -> i32;
    fn ccp_audio_play(path: *const u8, len: u32, flags: u32) -> i32;
    fn ccp_log(level: i32, msg: *const u8, len: u32);
    fn ccp_canvas_fill_rect(w: i32, x: i32, y: i32, rw: i32, rh: i32, argb: u32) -> i32;
    fn ccp_canvas_draw_line(w: i32, x0: i32, y0: i32, x1: i32, y1: i32, argb: u32, width: u32) -> i32;
    fn ccp_canvas_draw_text(w: i32, x: i32, y: i32, s: *const u8, len: u32, argb: u32, font: u32) -> i32;
    fn ccp_canvas_flush(w: i32) -> i32;
}
```

### 4.1 กลุ่ม UI (โยงกับ widget ที่วางใน Builder)

| ฟังก์ชัน | ทำอะไร | หมายเหตุ |
|---|---|---|
| `ccp_ui_get_widget("price")` | ขอ handle จาก **id ที่ตั้งใน Builder** | เรียกครั้งเดียวใน `on_init` เก็บใส่ static |
| `ccp_ui_set_text(w, ...)` | เปลี่ยนข้อความ label/ปุ่ม | string ส่งเป็น `(ptr, len)` ไม่ต้องมี `\0` |
| `ccp_ui_set_value(w, v)` | ตั้งค่า arc/bar/slider/switch | switch: 0/1 |
| `ccp_ui_set_color(w, 0xFF9500, part)` | เปลี่ยนสี | part: 0=พื้น 1=ตัวอักษร 2=indicator |
| `ccp_ui_set_visible(w, 0/1)` | ซ่อน/โชว์ | |
| `ccp_ui_show_page("settings")` | สลับไปอีกหน้าใน package เดียวกัน | |

### 4.2 กลุ่มเวลา / ระบบ

| ฟังก์ชัน | คืนค่า |
|---|---|
| `ccp_time_unix()` | epoch วินาที **UTC** (0 ถ้า SNTP ยังไม่ sync — ต้องเช็คก่อนใช้!) |
| `ccp_time_ms()` | มิลลิวินาทีจากเปิดเครื่อง (monotonic — ใช้จับช่วงเวลา) |
| `ccp_request_tick(ms)` | ขอให้เรียก `on_tick` ทุก `ms` (0 = หยุด, ขั้นต่ำ 16) |
| `ccp_rand()` | เลขสุ่ม 32 บิตจากฮาร์ดแวร์ |
| `ccp_log(2, ...)` | พิมพ์ลง serial log (`wasm_app: ...`) — 0=err 1=warn 2=info 3=dbg |
| `ccp_kv_get/set` | เก็บค่าถาวรข้ามการรีบูต (NVS) สูงสุด 4KB/ค่า |

### 4.3 ตาราง event (`ccp_on_event`)

| ค่า | ความหมาย | p0, p1 |
|---|---|---|
| 1 / 2 / 3 | PRESSED / PRESSING / RELEASED | x, y |
| **4** | **CLICKED** (ใช้บ่อยสุด) | x, y |
| 5 | LONG_PRESSED | x, y |
| 6 | VALUE_CHANGED (slider/switch/arc) | ค่าใหม่, 0 |
| 7 | GESTURE | ทิศ (0=ซ้าย 1=ขวา 2=ขึ้น 3=ลง), 0 |
| 8 | DRAG | dx, dy |
| 100+ | เหตุการณ์ที่ตั้งเองใน Builder (action `wasm.event` + event_id) | event_id, 0 |

### 4.4 Data stream (เชื่อมกับ "Data Sources" ใน Builder)

- ใน Builder แท็บ **Data Sources** ประกาศ id + stream เช่น `market.BTCUSDT.ticker`
- ใน logic: `ccp_data_subscribe(b"market.BTCUSDT.ticker".as_ptr(), 21)` →
  ได้ stream handle เมื่อ server ส่งข้อมูล (ผ่าน MQTT) เฟิร์มแวร์จะเรียก
  `ccp_on_data(handle, ptr, len)` พร้อม JSON
- stream เดียวกันยังใช้กับ **Binding** ใน Builder (ผูก path ของ JSON เข้า property
  ของ widget โดยตรง **ไม่ต้องเขียนโค้ด**) — ใช้ binding ถ้าแค่โชว์ค่า,
  ใช้ `on_data` ถ้าต้องคำนวณ/ตัดสินใจก่อนแสดง

---

## 4.5 Simulate ใน Builder = รันของจริง (อัปเดต 2026-06-11)

ปุ่ม **Simulate** ใน `/builder` ตอนนี้**รันไฟล์ .wasm ตัวเดียวกับที่นาฬิกาจะได้รับ**
(ไม่ใช่ mock อีกแล้ว):

1. กด Simulate → ถ้า logic ยังไม่ compile จะ compile ให้อัตโนมัติ (เห็นใน Log)
2. เบราว์เซอร์ instantiate wasm ด้วย host shim ที่ implement ABI v1 ครบทุกฟังก์ชัน
   ([wasmSim.ts](../server/apps/web/components/builder/wasmSim.ts)):
   `ccp_time_unix` = นาฬิกาจริงของเครื่อง, `ccp_request_tick` = timer จริง,
   คลิก widget = `ccp_on_event` จริง, `ccp_canvas_*` วาดลง `<canvas>` จริง
3. Data Sources ถูกป้อนข้อมูล**สด**: stream `market.<SYMBOL>.ticker` ดึงราคาจริงจาก
   Binance ทุก ~2 วิ (ออฟไลน์ = random walk), source `clock`/`time.*` ป้อนเวลาจริงทุกวิ,
   stream อื่นส่งเองได้จากช่อง **Send test payload**
4. ค่าที่ logic เขียน (text/สี/ค่า) เก็บเป็น *overlay* แยกจาก design — ออกจาก
   Simulate แล้วหน้าที่ออกแบบไว้กลับเป็นเหมือนเดิมเสมอ
5. Publish → เครื่องที่ได้สิทธิ์รับ layout + wasm ก้อนเดียวกับที่เพิ่งซิมูเลท
   (sha256 เดียวกัน)

Template **Clock** ตอนนี้ตรงกับหน้า native แล้ว (วันที่บน → เวลาใหญ่ → วินาทีส้ม
→ โลโก้ 48×48 ล่าง) และมากับ logic เดินเวลาจริง (`CLOCK_LOGIC_SOURCE` ใน
[store.ts](../server/apps/web/components/builder/store.ts) — โค้ดเดียวกับตัวอย่างข้อ 5)

## 5. ตัวอย่างที่ 1 — นาฬิกาดิจิทัลแบบ WASM (เดินเวลาได้จริง)

> โค้ดนี้คือ logic ตั้งต้นของ template Clock ใน Builder แล้ว (กด Simulate ดูได้เลย)
> — เก็บไว้ที่นี่พร้อมคำอธิบายเต็มสำหรับใช้เป็นแบบเรียน

**เตรียมใน Builder:** วาง label ตั้ง id เป็น `time`, `sec` และ `date`

```rust
#![no_std]

const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;
const TZ_OFFSET_MIN: i64 = 7 * 60;          // ไทย UTC+7 (แก้ตรงนี้ได้)

#[link(wasm_import_module = "env")]
extern "C" {
    fn ccp_ui_get_widget(id: *const u8, id_len: u32) -> i32;
    fn ccp_ui_set_text(widget: i32, text: *const u8, len: u32) -> i32;
    fn ccp_request_tick(interval_ms: u32) -> i32;
    fn ccp_time_unix() -> u64;
}

static mut W_TIME: i32 = -1;
static mut W_DATE: i32 = -1;
static mut LAST_SEC: u64 = u64::MAX;

#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION { return CCP_ERR_INVAL; }
    unsafe {
        W_TIME = ccp_ui_get_widget(b"time".as_ptr(), 4);   // id ตรงกับใน Builder
        W_DATE = ccp_ui_get_widget(b"date".as_ptr(), 4);
        ccp_request_tick(250);   // เช็ค 4 ครั้ง/วินาที ให้วินาทีเปลี่ยนไม่กระตุก
    }
    CCP_OK
}

#[no_mangle]
pub extern "C" fn ccp_on_tick(_now_ms: u64) {
    unsafe {
        let utc = ccp_time_unix();
        if utc == 0 {                       // SNTP ยังไม่ sync
            let msg = b"--:--:--";
            if W_TIME >= 0 { ccp_ui_set_text(W_TIME, msg.as_ptr(), msg.len() as u32); }
            return;
        }
        let local = utc as i64 + TZ_OFFSET_MIN * 60;
        if local as u64 == LAST_SEC { return; }   // วินาทียังไม่เปลี่ยน ไม่ต้องวาดซ้ำ
        LAST_SEC = local as u64;

        let secs_of_day = (local % 86400) as u32;
        let (h, m, s) = (secs_of_day / 3600, (secs_of_day / 60) % 60, secs_of_day % 60);

        // ประกอบ "HH:MM:SS" เอง (no_std ไม่มี format!)
        let mut buf = [0u8; 8];
        put2(&mut buf[0..2], h); buf[2] = b':';
        put2(&mut buf[3..5], m); buf[5] = b':';
        put2(&mut buf[6..8], s);
        if W_TIME >= 0 { ccp_ui_set_text(W_TIME, buf.as_ptr(), 8); }

        // วันที่: แปลงจำนวนวันตั้งแต่ 1970 -> ปี/เดือน/วัน (สูตร civil-from-days)
        let days = local.div_euclid(86400);
        let (y, mo, d) = civil_from_days(days);
        let mut db = [0u8; 10];                    // "DD/MM/YYYY"
        put2(&mut db[0..2], d); db[2] = b'/';
        put2(&mut db[3..5], mo); db[5] = b'/';
        put4(&mut db[6..10], y as u32);
        if W_DATE >= 0 { ccp_ui_set_text(W_DATE, db.as_ptr(), 10); }
    }
}

fn put2(out: &mut [u8], v: u32) { out[0] = b'0' + (v / 10 % 10) as u8; out[1] = b'0' + (v % 10) as u8; }
fn put4(out: &mut [u8], v: u32) {
    out[0] = b'0' + (v / 1000 % 10) as u8; out[1] = b'0' + (v / 100 % 10) as u8;
    out[2] = b'0' + (v / 10 % 10) as u8;   out[3] = b'0' + (v % 10) as u8;
}

/* แปลง "จำนวนวันตั้งแต่ 1970-01-01" เป็น (ปี, เดือน, วัน) — อัลกอริทึมมาตรฐาน
   ของ Howard Hinnant (ใช้ใน C++ <chrono>) ถูกต้องทุกปีอธิกสุรทิน */
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);                              // วันที่ใน era (0..146096)
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);           // วันที่ในปี
    let mp = (5 * doy + 2) / 153;                                // เดือนแบบ มี.ค.=0
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[no_mangle] pub extern "C" fn ccp_on_event(_w: i32, _e: u32, _p0: i32, _p1: i32) {}
#[no_mangle] pub extern "C" fn ccp_on_data(_h: i32, _p: u32, _l: u32) {}
#[no_mangle] pub extern "C" fn ccp_on_destroy() {}

static mut ARENA: [u8; 4 * 1024] = [0; 4 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;
#[no_mangle]
pub extern "C" fn ccp_malloc(size: u32) -> u32 {
    let size = ((size as usize) + 7) & !7;
    unsafe {
        if ARENA_TOP + size > ARENA.len() { return 0; }
        ARENA_LAST = ARENA_TOP;
        let ptr = ARENA.as_mut_ptr().add(ARENA_TOP) as u32;
        ARENA_TOP += size; ptr
    }
}
#[no_mangle]
pub extern "C" fn ccp_free(ptr: u32) {
    unsafe {
        let last = ARENA.as_mut_ptr().add(ARENA_LAST) as u32;
        if ptr == last { ARENA_TOP = ARENA_LAST; }
    }
}
#[panic_handler]
fn panic(_i: &core::panic::PanicInfo) -> ! { loop {} }
```

จุดที่ควรสังเกต:
- **เวลาไม่ได้ "นับ" ใน logic** — ถาม host (`ccp_time_unix`) ทุก tick แบบเดียวกับ
  หน้า native ถาม `time(NULL)` ดังนั้นไม่มีวันเพี้ยนสะสม
- `LAST_SEC` กันการวาดซ้ำ — เคารพกฎ "callback ต้องเร็ว"
- `no_std` ไม่มี `format!` เลยประกอบ string จาก byte ตรงๆ (`put2`/`put4`)

## 6. ตัวอย่างที่ 2 — ปุ่มกด (event) สลับสถานะ

มีให้แล้วใน Builder: template **LED Toggle** (และ
[wasm-apps/examples/led-toggle](../wasm-apps/examples/led-toggle/src/lib.rs))
แก่นของมัน:

```rust
static mut W_LED: i32 = -1;
static mut ON: bool = false;

// on_init: W_LED = ccp_ui_get_widget(b"led1".as_ptr(), 4);

#[no_mangle]
pub extern "C" fn ccp_on_event(widget: i32, event: u32, _p0: i32, _p1: i32) {
    const CLICKED: u32 = 4;
    unsafe {
        if event == CLICKED && widget == W_BTN {   // ปุ่มโดนกด
            ON = !ON;
            let color = if ON { 0x00E676 } else { 0x37474F };
            ccp_ui_set_color(W_LED, color, 0);     // part 0 = พื้นหลัง
            ccp_audio_tone(if ON { 880 } else { 440 }, 80, 50);
        }
    }
}
```

ทางเลือก: ใน Builder ตั้ง action ของปุ่มเป็น `wasm.event` + `event_id: 101` แล้วใน
logic เช็ค `event == 101` แทน — แบบนี้ logic ไม่ต้องรู้จัก widget ปุ่มเลย
(template LED Toggle ใช้วิธีนี้ — `EVT_LED_1 = 101`, `EVT_LED_2 = 102`)

## 7. ตัวอย่างที่ 3 — รับข้อมูลจาก server (`on_data`)

```rust
static mut H_PRICE: i32 = -1;

// on_init:
//   H_PRICE = ccp_data_subscribe(b"market.BTCUSDT.ticker".as_ptr(), 21);

#[no_mangle]
pub extern "C" fn ccp_on_data(stream: i32, payload_ptr: u32, len: u32) {
    unsafe {
        if stream != H_PRICE { return; }
        // payload คือ JSON ที่อยู่ "ในหน่วยความจำของเราเอง" (host วางผ่าน ccp_malloc)
        let bytes = core::slice::from_raw_parts(payload_ptr as *const u8, len as usize);
        // no_std: หา "price": แบบ manual หรือใช้ crate เช่น `microjson` ก็ได้
        if let Some(p) = find_json_number(bytes, b"\"price\":") {
            // ...แปลง/เปรียบเทียบ แล้ว ccp_ui_set_text / ccp_ui_set_color ตามต้องการ
        }
    }
}
```

ถ้าแค่จะ "โชว์ราคา" เฉยๆ ไม่ต้องเขียนแบบนี้ — ใช้ **Binding** ใน Builder
(source=stream, path=`price`, format=`$%.2f`) จอจะอัปเดตเองโดยไม่มีโค้ดสักบรรทัด
เขียน `on_data` เมื่อต้อง*ตัดสินใจ*จากข้อมูล เช่น เทียบเงื่อนไขแจ้งเตือน เปลี่ยนสีตามแรงซื้อขาย

## 8. ตัวอย่างที่ 4 — วาดกราฟเองด้วย canvas

วาง widget ชนิด **canvas** ใน Builder (ตั้ง id เช่น `chart`) แล้ว:

```rust
// on_init: W_CHART = ccp_ui_get_widget(b"chart".as_ptr(), 5);
// เมื่อมีข้อมูลใหม่:
unsafe {
    ccp_canvas_fill_rect(W_CHART, 0, 0, 444, 130, 0x101418);          // เคลียร์พื้น
    ccp_canvas_draw_line(W_CHART, x0, y0, x1, y1, 0x26A69A, 2);       // เส้นกราฟ
    ccp_canvas_draw_text(W_CHART, 8, 8, b"BTC".as_ptr(), 3, 0xEEEEEE, 14);
    ccp_canvas_flush(W_CHART);   // สั่งให้ LVGL วาดเฟรมนี้ขึ้นจอ (ห้ามลืม!)
}
```

แท่งเทียนเขียว/แดงของหน้า crypto native ก็ใช้หลักการเดียวกันนี้ (วาดสี่เหลี่ยม
body + เส้น wick ทีละแท่ง) — ดู `candle_render()` ใน home_ui.c เป็นแบบ

---

## 9. ส่งหน้าขึ้นจอจริง: pipeline ทั้งเส้น และจุดที่พังได้

```
Builder (ออกแบบ + Edit Logic)
   │  Compile Rust  → POST /payloads/compile-wasm  (server รัน rustc → logic.wasm)
   │  Save/Publish  → bundle.zip = layout.json + wasm/logic.wasm + manifest(sha256)
   ▼
Store item (PAGE) ถูกสร้างเป็น draft → admin กด publish ใน /store
   ▼
Fleet (/) → Rights → Grant ให้นาฬิกาเครื่องนั้น
   │  สร้าง Entitlement(deviceId×item) → push settings.entitlements (MQTT)
   │  ถ้า item ผูก payload อยู่ → assignPayload → ส่งคำสั่ง MQTT "sync"
   │      { package_id, version, bundle_url, bundle_sha256 }
   ▼
ESP32 รับ "sync" → ตอบ ok ทันที (= "รับคิวแล้ว" ไม่ใช่ "ติดตั้งแล้ว"!)
   │  ดาวน์โหลด bundle.zip จาก bundle_url → ตรวจ sha256 → แตก zip ลง SD
   ▼
เรียก load_active_or_recovery():
   มี package ติดตั้งอยู่ → ui_renderer วาด layout.json + wasm_engine รัน logic
   ไม่มี → กลับไปชุด native (clock/crypto/slideshow)
```

### จุดที่พังได้ (เช็คตามลำดับ)

1. **`bundle_url` ต้องเป็น IP ที่จอเข้าถึงได้** — server สร้าง URL จาก env
   `PUBLIC_API_URL` ถ้าไม่ตั้งจะ fallback เป็น `http://localhost:4000` ซึ่ง
   "localhost" ของจอคือตัวจอเอง → **ดาวน์โหลดล้มเหลวเงียบๆ เสมอ**
   → ตั้ง `PUBLIC_API_URL=http://<IP-LAN-ของ-Mac>:4000` ใน `server/apps/api/.env`
2. **IP ของ Mac เปลี่ยน (DHCP)** — เฟิร์มแวร์ฝัง `CCP_CFG_SERVER_BASE_URL`
   ([user_config.h](../firmware/main/user_config.h)) ไว้ใช้เช็ค settings ตอนบูต
   ถ้า IP จริงไม่ตรง ทั้ง settings-check ตอนบูตและ bundle download จะพัง
   → ล็อค IP ของ Mac ใน router (DHCP reservation) แล้วให้ env กับ user_config ตรงกัน
3. **ack `ok:true` ของคำสั่ง sync = รับคิวเท่านั้น** — ความจริงอยู่ใน serial log
   (`idf.py monitor`) มองหา tag `sync:` ว่าดาวน์โหลด/แตกไฟล์/activate สำเร็จไหม
4. **package จะ "แทนที่ทั้งจอ"** — สถาปัตยกรรมปัจจุบัน เมื่อ package ติดตั้งสำเร็จ
   `ui_renderer` เข้าควบคุมจอแทนชุด native ทั้งหมด (clock/crypto/slideshow หาย)
   ยังไม่มีการ "เพิ่มเป็นหน้าใหม่ต่อท้าย swipe" — อันนั้นคืองานอนาคต
   (`setup_pages_from_cfg()` ใน home_ui.c มี comment `/* unknown page id (future:
   purchased layout pages) */` รออยู่แล้ว)

---

## 10. ทำไม Grant สิทธิ์ "Weather" แล้วจอไม่แสดงหน้านั้น (คำตอบปัญหาที่ 2)

เพราะ **Weather ในตอนนี้คือ "สินค้าตัวอย่าง" (placeholder) — ยังไม่มีหน้าจริงอยู่ข้างหลัง**:

1. รายการ Weather/News/Calendar/Stocks/Fear&Greed ใน Store เป็นแค่ catalog ที่ seed
   ไว้ (ดู `CATALOG` ใน [marketplace.service.ts](../server/apps/api/src/marketplace/marketplace.service.ts))
   **ไม่มี `payload` (bundle layout+wasm) ผูกอยู่** — ตอน Grant เซิร์ฟเวอร์จึงทำได้แค่
   บันทึกสิทธิ์ + push `settings.entitlements=["weather", ...]` ไปที่จอ (อันนี้สำเร็จ)
   แต่ไม่มีอะไรจะส่งให้จอแสดง
2. ฝั่งเฟิร์มแวร์ ชุดหน้า native รู้จักแค่ `clock|crypto|slideshow` — id อื่นถูกข้าม
   (ตั้งใจเผื่ออนาคตไว้)
3. ต่างจาก `crypto-alerts` (FEATURE) ที่ "ปลดล็อคความสามารถในหน้าที่มีอยู่แล้ว" —
   อันนั้นเห็นผลทันทีเพราะโค้ด native เช็ค entitlement เอง ส่วน PAGE ต้องมี
   "ตัวหน้า" ส่งไปด้วย

**วิธีทำให้ Weather ขึ้นจอจริง (ลำดับงาน):**
1. ออกแบบหน้า Weather ใน `/builder` (label อุณหภูมิ, ไอคอน, Data Source
   เช่น `weather.bangkok`) + เขียน logic ตามคู่มือนี้ (หรือใช้ binding ล้วนๆ)
2. Save/Publish → ได้ package เช่น `com.ccp.weather@1.0.0` (Store จะมี draft ให้)
3. ผูก Store item `weather` กับ payload นี้ (หรือใช้ draft item ที่ Builder สร้าง)
   แล้วกด publish ใน `/store`
4. Grant ให้เครื่อง → คราวนี้ `grantItem` จะเจอ payload → ส่ง `sync` → จอดาวน์โหลด
   และแสดง (ภายใต้ข้อจำกัดข้อ 9.4: ตอนนี้จะแทนที่ทั้งจอ)
5. ฝั่ง server ยังต้องมีตัวป้อนข้อมูล stream `weather.*` (Node-RED ที่มีอยู่ทำได้)

> สรุปสั้น: **Grant = ให้ "สิทธิ์" ไม่ใช่ให้ "ตัวหน้า"** — สิทธิ์ไปถึงจอแล้วจริง
> (อยู่ใน `settings.entitlements`) แต่ตัวหน้า Weather ยังไม่ถูกสร้างขึ้นในระบบ
