# คู่มือแก้ไขแต่ละหน้า (โค้ด / asset / แก้ผ่าน Server)

อธิบายว่าแต่ละหน้าของ CryptoClock Pro แก้ที่ไหนได้บ้าง — แยกเป็น 3 ระดับ:

| ระดับ | แก้อะไรได้ | ต้อง flash ใหม่ไหม | ช่องทาง |
|---|---|---|---|
| **โค้ด (layout/logic)** | หน้าตา ตำแหน่ง พฤติกรรม | ✅ ต้อง build + flash | แก้ไฟล์ C ใน firmware |
| **Asset (รูป/เสียง)** | โลโก้ รูป slideshow โลโก้เหรียญ เสียง alert | ❌ ไม่ต้อง | วางไฟล์บน SD / อัปโหลดผ่านแอป / Server |
| **Config (ค่าตั้ง)** | ธีม เหรียญ สกุลเงิน interval อะไรเปิด/ปิด | ❌ ไม่ต้อง | แอปมือถือ (LAN) หรือ Admin Server (MQTT) |

> **3 หน้า default (clock/crypto/slideshow) เป็นโค้ด C ในเฟิร์มแวร์** — เปลี่ยน "หน้าตา" ต้อง flash แต่เปลี่ยน "ค่า" กับ "รูป" ไม่ต้อง flash
> **หน้าที่ซื้อจาก Store** เป็น package (layout.json + .wasm) ส่งจาก Server → ติดตั้ง over-the-air ไม่ต้อง flash เลย

ทุกหน้าหลักอยู่ในไฟล์เดียว: [`firmware/components/home_ui/home_ui.c`](../firmware/components/home_ui/home_ui.c)

> 📘 อยากเขียน **logic** ของหน้า (ทั้ง native C และหน้า Builder/WASM แบบ Rust)
> ดูคู่มือละเอียดทีละบรรทัดที่ [logic-guide.md](logic-guide.md)

---

## 1. หน้า Clock (นาฬิกา)

| สิ่งที่แก้ | ที่ไหน |
|---|---|
| layout (ขนาดเวลา ตำแหน่งวินาที/วันที่) | `build_clock_page()` — มาโคร `CLOCK_TIME_SCALE`, `CLOCK_TIME_Y` |
| ธีมสี | ตาราง `THEMES[]` (gold/mint/neon) — **เปลี่ยนได้จากแอป/Server โดยไม่ flash** |
| โลโก้กลางล่าง | ไฟล์ `pages/clock/assets/logo.png` บน SD (วางเองหรืออัปโหลด) |
| ชื่อโปรไฟล์ | config `profile.name` — **แก้จากแอป (Profile) / Server** |

**Server แก้ได้:** ธีม, ชื่อโปรไฟล์
**ต้อง flash:** ขนาด/ตำแหน่งตัวเลข, ฟอนต์

## 2. หน้า Crypto

| สิ่งที่แก้ | ที่ไหน |
|---|---|
| layout (ปุ่ม กราฟ ตำแหน่งราคา) | `build_crypto_page()` |
| logic ดึงราคา/กราฟ klines | `crypto_poll_task()`, `fetch_klines()` |
| โลโก้เหรียญ | `pages/crypto/assets/<เหรียญ>.png` เช่น `btc.png` (ตัวเล็ก) |
| เสียงแจ้งเตือน | `pages/crypto/assets/alert.wav` (16-bit PCM WAV) |
| เหรียญ / สไตล์ / สกุลเงิน / interval / timeframe / **alert 8 รายการ** | config `crypto.*` — **แก้จากแอป (Crypto) / Server** |

**Server แก้ได้:** `symbols[]`, `style` (chart/big), `currency` (USD/THB), `fetch_interval_s`, `timeframe`, `alerts[]`
**ต้อง flash:** หน้าตาปุ่ม/กราฟ, แหล่งข้อมูล (Binance)

## 3. หน้า Slideshow (รูปภาพ)

| สิ่งที่แก้ | ที่ไหน |
|---|---|
| layout / เอฟเฟกต์ | `build_slideshow_page()`, `slide_show_current()` |
| รูปภาพ | `pages/slideshow/assets/*.png` — **PNG ขนาด 480×320** (อัปโหลดจากแอปได้) |
| เอฟเฟกต์ / interval / ลำดับ | config `slideshow.*` — **แก้จากแอป (Photo slideshow) / Server** |

> ⚠️ ใช้ **PNG เท่านั้น** — ตัวถอดรหัส JPEG ของ LVGL บนจอนี้แสดงไม่ขึ้น (แอปแปลงรูปเป็น PNG 480×320 ให้อัตโนมัติตอนอัปโหลด)

**Server แก้ได้:** `effect`, `interval_s`, `order[]`
**ต้อง flash:** เอฟเฟกต์แบบใหม่

---

## แก้ผ่าน Admin Server ได้แค่ไหน?

**ได้** — ทุกอย่างที่เป็น **config** กับ **asset** ผ่าน:

1. **เว็บ Admin** (`http://localhost:3000`) → การ์ดเครื่อง → ปุ่ม **Settings** → แก้ pages/theme/เหรียญ/สกุลเงิน/interval → **Push to display** (ส่งผ่าน MQTT จอ reload ใน ~วินาที)
2. **REST API:** `PUT /api/v1/devices/{id}/settings` body `{"config":{...}}` (ดู [admin-manual.md](admin-manual.md) ข้อ 3)
3. **แอปมือถือ user** (ในวง LAN เดียวกับจอ) — เมนูแยกแต่ละหน้า: System / Profile / Clock / Crypto / Photo slideshow / Store

ลำดับความสำคัญของ config: **Server settings > SD `device.json` > per-page `config.json` > `user_config.h`**
ตอนเปิดเครื่องจอจะเช็คกับ Server เสมอ (`GET /devices/{id}/settings`) ถ้า version ใหม่กว่าจะดึงมาทับแล้ว reload

**ไม่ได้ (ต้อง flash firmware):** การเปลี่ยน layout/logic ของ 3 หน้า default, การเพิ่มหน้าชนิดใหม่แบบ native
**ทางเลือกแทนการ flash:** หน้าใหม่แบบ **Store package** (layout.json + .wasm) — ออกแบบใน Builder, ขายผ่าน Store, ติดตั้ง OTA
