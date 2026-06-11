# แผน: Page Settings Schema + Per-page Assets

> สถานะ: **แผน — รอไฟเขียวก่อนลงมือ** (เขียน 2026-06-11)
> ตอบโจทย์ 2 ข้อ: (1) แอดมินสร้าง "หน้าตั้งค่า" ของแต่ละหน้าได้ และ publish แล้วไปโผล่ใน
> Flutter User App อัตโนมัติ (2) โฟลเดอร์ asset ต่อหน้า server ↔ นาฬิกา

---

## Feature A — Page Settings Schema (ตั้งค่าหน้าได้ทั้งจาก Admin และ User App)

**ทำได้ไหม: ได้ 100%** — หัวใจคือ *ไม่ generate โค้ด Flutter* แต่ให้แอป (และเว็บ admin)
**render ฟอร์มจาก schema** ที่แอดมินประกาศไว้ตอนสร้างหน้า — แอปตัวเดิม รองรับหน้าใหม่ทุกหน้า
โดยไม่ต้องออก APK ใหม่ (= "publish แล้วสร้างใน Flutter อัตโนมัติ" ตามที่ต้องการ)

### สถาปัตยกรรม

```
Builder: แอดมินประกาศ settings_schema ของหน้า   ┐
  เช่น {key:"symbols", type:"symbols", max:4}    │ publish
      {key:"theme", type:"select", options:[..]} ┘
        ▼
layout.json (settings_schema) → PayloadVersion.layout (คอลัมน์มีแล้ว ✓)
        ▼                                  ▼
Admin Fleet → Settings modal          Flutter app → เมนูหน้า Store pages
  render SchemaForm จาก schema          render DynamicSettingsPage จาก schema
        └──────────── เขียนค่าเดียวกัน: settings[<page-slug>] ────────────┘
        ▼
PUT /devices/:id/settings (มีแล้ว ✓) → MQTT push (มีแล้ว ✓)
        ▼
firmware: ส่ง settings[<slug>] เข้า stream สงวนชื่อ "settings.<slug>"
        → wasm logic รับใน ccp_on_data + binding ใช้ได้เหมือน stream อื่น
```

### งานที่ต้องทำ (เรียงตามลำดับ)

| # | ชิ้นงาน | ที่ไหน | ขนาด |
|---|---|---|---|
| A1 | เพิ่ม `settings_schema` ใน layout.schema.json + `@ccp/shared` type + exportLayout | schema/, packages/shared | S |
| A2 | Builder section "Page Settings": ฟอร์มสร้าง field (key/label/type/default/options) | web components/builder | M |
| A3 | Field types ชุดแรก: `text` `number` `toggle` `select` `color` `symbols` (เลือกเหรียญ Binance สูงสุด n ตัว — ใช้ logic เดียวกับ symbol_picker ของแอป) | — | — |
| A4 | API: แนบ `settings_schema` ไปกับ `GET /devices/:id/entitlements` + `GET /store/items` (อ่านจาก latest PayloadVersion.layout) | api marketplace/devices | S |
| A5 | เว็บ: component กลาง `SchemaForm.tsx` + ฝังใน Fleet Settings modal (section ต่อ page entitlement) → save เข้า `settings[<slug>]` → push | web app/page.tsx | M |
| A6 | Flutter: `DynamicSettingsPage` widget render จาก schema + เพิ่ม section "Store pages" ใน device menu (ดึง entitlements+schema จาก hub) → save ผ่าน flow เดิม | mobile settings_pages.dart, hub_api.dart | M |
| A7 | Firmware: หลัง apply settings + หลัง load package → ยิง JSON `settings[<slug>]` เข้า `ui_renderer_handle_data`/`wasm_engine_on_data` บน stream `settings.<slug>` (~30 บรรทัดใน app_main.c) | firmware main | S |
| A8 | Simulator: แสดง SchemaForm ใน Simulate panel → แก้ค่าแล้ว deliver เข้า stream `settings.<slug>` ทันที = ทดสอบ logic ตอบสนอง settings ในเบราว์เซอร์ | web wasmSim | S |

**ตัวอย่างการใช้:** หน้า crypto custom — แอดมินประกาศ `symbols` (type symbols, max 4)
→ user เปิดแอป เลือกเหรียญ → ค่าลง `settings["com-ccp-crypto-custom"].symbols`
→ MQTT → logic ในหน้ารับผ่าน `ccp_on_data("settings.com-ccp-crypto-custom")` → เปลี่ยนเหรียญที่ดึง

## Feature B — Per-page Assets (รูป/เสียง ต่อหน้า)

**ทำได้ไหม: ได้ — ฝั่งเฟิร์มแวร์เสร็จอยู่แล้วเกือบทั้งหมด** (ออกแบบรอไว้แล้ว):
- layout.json มี `assets: [{id, type: image|gif|audio|font|lottie|bin, path: "assets/x.png"}]` ในสคีมาแล้ว ✓
- ui_renderer มี asset registry แล้ว: image `src` = **asset id** → แปลงเป็น `A:<โฟลเดอร์ package บน SD>/assets/x.png` ✓; action `audio.play` อ้าง asset id ได้แล้ว ✓
- sync_manager แตก bundle.zip **ทั้งก้อน** ลงโฟลเดอร์เฉพาะของ package บน SD — ไฟล์ assets/ ตามไปอัตโนมัติ = "โฟลเดอร์ที่ตรงกันบนนาฬิกา" มีแล้วโดย design ✓
- เสียงเล่นจาก SD ผ่าน audio_engine hook แล้ว ✓ (WAV 16-bit PCM)

**ที่เหลือคือฝั่ง server + Builder เท่านั้น:**

| # | ชิ้นงาน | ที่ไหน | ขนาด |
|---|---|---|---|
| B1 | API upload: `POST /payloads/assets/:packageId` (multipart, admin) → เก็บ `storage/builder-assets/<packageId>/` ; รูป→แปลง PNG (≤480×320, ใช้ sharp), เสียง→รับ .wav ; `GET /payloads/assets/:packageId` list+serve | api payloads | M |
| B2 | Builder panel "Assets": upload/list/ลบ + thumbnail; Inspector ของ image: เลือก src จากรายการ asset (เก็บ **asset id** ไม่ใช่ path); action `audio.play` เลือกจาก asset เสียง | web builder | M |
| B3 | exportLayout ใส่ `assets[]` + publishCompiled รวมไฟล์จาก builder-assets ลง zip ใต้ `assets/` | web + api | S |
| B4 | Simulator: image src=asset id → แสดงรูปจริงจาก URL server; `ccp_audio_play(asset)` → เล่นเสียงจริงในเบราว์เซอร์ | web wasmSim/BuilderCanvas | S |
| B5 | Clock template: เปลี่ยน logo เป็น asset id `logo` + seed รูปโลโก้ default ให้อัตโนมัติ | web builder | S |

## ข้อจำกัดที่ควรรู้ (มีผลกับ "เหมือนทุกประการ")

1. **กราฟ widget `chart` บนเครื่อง = lv_chart เส้น/แท่ง (สีเดียว)** — กราฟแท่งเทียนเขียว/แดง
   แบบหน้า crypto native ต้องวาดผ่าน `canvas` + wasm (`ccp_canvas_*` มีครบแล้วทั้งเครื่องและ
   simulator) → เสนอทำ starter logic "crypto-candles" เป็นของแถม Feature A/B (ขนาด M)
2. **ฟอนต์บนเครื่องมีแค่ montserrat 14/20/28/48** — ตัวเลขยักษ์แบบหน้านาฬิกา native
   (48×3.05) ต้องเพิ่ม `transform_scale` ใน ui_renderer (แก้เฟิร์มแวร์ ขนาด S) ถ้าต้องการ
   ให้หน้า clock ที่ publish ใหญ่เท่า native
3. รูปใหญ่ๆ ควรเก็บบน SD เสมอ (PSRAM cache 3MB) — pipeline B1 แปลง PNG ≤480×320 ช่วยคุมแล้ว

## ลำดับที่แนะนำ

1. **B ก่อน A** (asset สั้นกว่า และ Clock template จะสมบูรณ์ทันที: โลโก้ขึ้นทั้ง sim และเครื่องจริง)
2. ตามด้วย A1→A8 (settings schema)
3. ของแถม: crypto-candles canvas logic + transform_scale

รวมประมาณ 2–3 วันงาน AI; ไม่มี migration DB (ใช้คอลัมน์ JSON เดิมทั้งหมด), แก้เฟิร์มแวร์
จุดเดียว (A7) + ทางเลือก (transform_scale)
