# คู่มืออธิบายโค้ด "แต่ละหน้า" (Page Code Walkthrough)

อธิบายโค้ดของหน้าจริงที่ออกแบบใน Builder แล้ว publish เป็น package (layout.json +
logic.wasm) — ต่างจาก [logic-guide.md](logic-guide.md) ที่สอน *วิธีเขียน* logic
ทั่วไป เอกสารนี้เดินผ่าน *หน้าที่มีอยู่จริง* 3 หน้า ทีละส่วน

ทุกหน้าอยู่ในไฟล์เดียว: ค่าคงที่ `*_LOGIC_SOURCE` ใน
[`server/apps/web/components/builder/store.ts`](../server/apps/web/components/builder/store.ts)
และ widget ใน [`templates.ts`](../server/apps/web/components/builder/templates.ts)

> โครงร่วมของทุกหน้า: `ccp_on_init` (หา widget + subscribe + ขอ tick) →
> `ccp_on_data` (รับ stream) → `ccp_on_tick` (วาด/อัปเดตต่อเนื่อง) +
> bump-allocator (`ccp_malloc/free`) + `panic_handler`. ดูเหตุผลแต่ละบรรทัดใน
> [logic-guide.md §2](logic-guide.md)

---

## 1. หน้า Clock (`CLOCK_LOGIC_SOURCE`)

**Widget:** label `date`, `time`, `sec` + image `logo` — เลียนหน้า native
(วันที่บน, เวลาใหญ่, วินาทีส้มชิดฐานนาที, โลโก้ล่าง)

**Logic ย่อ:**
- `on_init`: หา handle ของ `time/sec/date`, `ccp_request_tick(250)` (เช็ค 4 ครั้ง/วิ
  ให้วินาทีไม่กระตุก)
- `on_tick`: `ccp_time_unix()` → บวก `TZ_OFFSET_MIN` (ไทย +420) → แตกเป็น ชม./นาที/วินาที
  เอง (no_std ไม่มี `format!` ใช้ `put2` ประกอบเลข) — กัน redraw ซ้ำด้วย `LAST`
  (วินาทีเดิมไม่วาดใหม่)
- วันที่: `civil_from_days` (อัลกอริทึม Howard Hinnant) แปลงจำนวนวันตั้งแต่ 1970 →
  ปี/เดือน/วัน ถูกต้องทุกปีอธิกสุรทิน
- **เวลาไม่ได้ "นับ" เอง** — ถาม host ทุก tick เหมือนหน้า native ถาม `time()` จึงไม่เพี้ยนสะสม

---

## 2. หน้า Crypto (`CRYPTO_LOGIC_SOURCE`)

**Widget:** ปุ่ม `sym_btn`(เลือกเหรียญ) / `cur_btn`(USD↔THB) / `tf_btn`(timeframe),
led `dot`(สถานะ), label `price`/`change`/`updated`, **canvas `candles`** (กราฟแท่งเทียน)

**State หลัก:** `SYM_IDX`(เหรียญปัจจุบัน 0..3), `TF_IDX`(15m/1h/4h/1d), `THB`(บูลีน),
`RATE`(เรท USD→THB), `PRICE`/`CHG`, อาเรย์ OHLC `CO/CH/CL/CC` + `NCANDLES`

**Logic ย่อ:**
- `on_init`: หา widget, subscribe **`market.<เหรียญ>.ticker` ทั้ง 4 ตัว** + `fx.USDTHB` +
  `market.<เหรียญ>.klines.<TF>` (ผ่าน `sub_klines`), ขอ data, วาดเริ่มต้น
- `on_event` (จากปุ่มผ่าน action `wasm.event`):
  - `101` เปลี่ยนเหรียญ → reset แท่งเทียน + `sub_klines` ใหม่
  - `102` สลับ THB ↔ USD → `render_price`
  - `103` เปลี่ยน timeframe → subscribe klines TF ใหม่
- `on_data` (แยกตาม handle):
  - klines → parse อาเรย์ `o/h/l/c` ด้วย `key_array` → `render_candles`
  - fx → เก็บ `RATE` → `render_price`
  - ticker (เฉพาะเหรียญที่เลือก) → เก็บราคา/`%24h`, **อัปเดตแท่งล่าสุด** (close/high/low)
    แบบ real-time แล้ววาดใหม่, จุด `dot` เขียว
- `render_price`: ถ้า `THB && RATE>0` คูณเรท + prefix `THB ` ไม่งั้น `$`; ฟอร์แมตเลข
  พร้อม comma (`fmt_price`); `%24h` สีเขียว/แดงตามทิศ
- `render_candles`: **อัลกอริทึมเดียวกับ `candle_render()` ใน home_ui.c** — หา min/max,
  pad 6%, body กว้าง 7/10 slot, wick 1px, เขียว `c≥o` แดงถ้าน้อยกว่า — วาดผ่าน
  `ccp_canvas_fill_rect`/`draw_line`
- JSON parser จิ๋ว (`find`/`parse_f64`/`key_f64`/`key_array`) — payload เป็นข้อมูลที่เชื่อถือได้จาก server

> THB เคยมีบั๊ก 2 จุด (race เรทยังไม่มา + กล่องราคาแคบตัดเลขล้านบาททิ้ง) แก้แล้ว
> commit `49b8b32`

---

## 3. หน้า Weather (`WEATHER_LOGIC_SOURCE`) — หน้าน่ารักเคลื่อนไหว

**Widget:** **canvas `scene`** เต็มจอ (480×320, wasm วาด bg + ไอคอน), label
`city`/`time`/`temp`/`desc`/`humidity` กึ่งโปร่งแสง (`opa` 210–235) ทับด้านบน

**ใครทำอะไร:**
- ข้อความ `city/temp/desc/humidity` มาจาก **binding** (source `weather`, ดึงตรงจาก
  payload) — ไม่ต้องเขียน wasm
- **นาฬิกา + พื้นหลัง + แอนิเมชัน** มาจาก wasm

**Logic ย่อ:**
- `on_init`: หา `scene`/`time`, subscribe `weather.bangkok`, `ccp_request_tick(120)` (~8fps), วาดฉากแรก
- `on_data`: หา `"theme":"…"` ใน payload → ตั้ง `THEME` (clear/partly/cloudy/rain/thunder/snow/fog)
- `on_tick`: `FRAME++`, อัปเดตนาฬิกา (เหมือนหน้า Clock), `draw_scene()`
- `draw_scene`:
  - **พื้นหลังไล่สี** 32 แถบ — lerp สี top→bottom ตาม `palette(THEME)` (แดด=ฟ้า→ทอง,
    เมฆ=เทา, ฝน=น้ำเงินเข้ม, พายุ=ม่วง, หิมะ=ฟ้าอ่อน, หมอก=เทาหม่น)
  - **ไอคอนตามธีม** วาดเอง (procedural — ทำงานบนจอจริงได้เลย ไม่ต้องรอ asset/Lottie):
    - แดด: `draw_sun` วงกลม (`fill_disc` วาด disc จริงด้วย `isqrt`) + แฉก 12 เส้นหมุน
      (ตาราง `TRIG` 24 มุม indexd ด้วย `FRAME`)
    - มีเมฆ: `draw_cloud` (disc 3 ลูก + ฐานสี่เหลี่ยม)
    - ฝน: `draw_rain` เส้นเฉียงตก y เลื่อนตาม `FRAME`
    - หิมะ: `draw_snow` จุดตกพร้อม drift
    - พายุ: เมฆ + ฝน + `draw_bolt` (สายฟ้า + แฟลชเต็มจอทุก ~48 เฟรม)
    - หมอก: `draw_fog` เส้นแนวนอนเลื่อน
- **ทำไมไม่ใช้ Lottie จริง:** LVGL build นี้ไม่ได้เปิด `lv_lottie`/ThorVG และ asset
  upload pipeline ยังไม่ทำ — การวาดบน canvas ให้เอฟเฟกต์น่ารักเทียบเท่า และรันบน
  ESP32 ได้ทันทีโดยไม่ต้องส่งไฟล์แอนิเมชัน

**ข้อมูล:** `FeedsService` ฝั่ง server ดึง open-meteo (`temperature_2m`,
`relative_humidity_2m`, `weather_code`) ทุก 10 นาที → map รหัส WMO เป็น
`desc`+`theme` (ฟังก์ชัน `weatherPayload`/`wmoToDescTheme`) → publish เข้า
`weather.bangkok` — Simulator ใน Builder ใช้ payload หน้าตาเดียวกันเป๊ะ

**พิสูจน์บนเครื่องจริง:** activate `com.ccp.weather@1.1.0` →
`ui: layout loaded: 1 pages, 6 widgets, 4 bindings, 1 wasm` ·
`pages in rotation: clock,crypto,slideshow,weather` · ไม่มี wasm error

---

## เพิ่มเมืองอื่น / ปรับแต่ง

- เมือง: เพิ่มใน `FeedsService.CITIES` (+ `CITIES` ใน wasmSim.ts) แล้วเปลี่ยน stream
  เป็น `weather.<slug>` ทั้งใน data_source และที่ wasm subscribe
- สีธีม: แก้ตาราง `palette()` ใน `WEATHER_LOGIC_SOURCE`
- เฟรมเรต: `ccp_request_tick(120)` (เลขมาก = ช้าลง/กินแรงน้อยลง)
