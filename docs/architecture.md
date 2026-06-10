# CryptoClock Pro — สถาปัตยกรรมและ Flow การทำงาน

## ภาพรวม

```
┌─────────────────────────── Server (Hub) ───────────────────────────┐
│  Next.js Builder ──▶ layout.json + assets + .wasm ──▶ bundle.zip   │
│  NestJS API ── Prisma/Postgres ── MinIO (bundles) ── Stripe        │
│  MQTT Bridge ◀──────────────── EMQX broker ─────────────────────┐  │
└─────────────────────────────────────────────────────────────────┼──┘
                                                                  │ MQTT (TLS)
┌──────────────────────────── ESP32-S3 ───────────────────────────┼──┐
│ connectivity (esp-mqtt) ◀────────────────────────────────────────┘ │
│      │ cmd:sync                                                    │
│      ▼                                                             │
│ sync_manager ── download ▶ sha256 ▶ unzip ▶ verify ▶ atomic swap   │
│      │ activated                       (SD: /sd/packages/<id>/<v>) │
│      ▼                                                             │
│ ui_renderer (layout.json ▶ LVGL 9) ◀─── display_engine (QSPI+TE)   │
│      │ events                ▲ canvas                              │
│      ▼                       │                                     │
│ wasm_engine (WAMR) ── ccp_* host ABI ── audio_engine (I2S)         │
└────────────────────────────────────────────────────────────────────┘
```

## Flow 1: บอร์ดได้รับ JSON Payload เพื่อเปลี่ยนหน้าจอ

1. Admin กด Assign/Publish ใน Hub → API สร้าง `PayloadVersion` (manifest + sha256 ครบทุกไฟล์) แล้วยิง MQTT
   `ccp/v1/{device}/cmd` = `{type:"sync", params:{package_id, version, bundle_url, bundle_sha256}}`
2. `connectivity` รับ cmd → `app_main.on_cmd` → enqueue ไป `sync_manager` (task แยก core 0 prio ต่ำ — UI ไม่สะดุด)
3. `sync_manager`:
   - ดาวน์โหลด zip ไป `/sd/cache/<sha>.zip` (HTTP Range ต่อได้ถ้าหลุด)
   - ตรวจ sha256 ของ zip → แตกด้วย miniz ลง `/sd/staging/` (กัน path traversal)
   - ตรวจ sha256 รายไฟล์ตาม `manifest.json` → `rename()` เข้า `/sd/packages/<id>/<ver>/` (immutable)
   - เขียน `current.txt` (จุด mutable เดียว) → callback `on_package_activated`
4. `ui_renderer.load_dir()`:
   - `lv_obj_delete` หน้าจอเก่าทั้งหมดภายใต้ `display_engine_lock()`
   - parse `layout.json` (cJSON) → สร้าง widget tree, bindings, actions → `lv_screen_load(page[0])`
5. ระบบ subscribe MQTT `data/{stream}` ตามที่ layout ประกาศ → ข้อมูล real-time วิ่งเข้า bindings ทันที
6. ครบ 60 วินาทีไม่มีปัญหา → `last_good.json` ถูกบันทึก / ถ้าพังกลางทาง → ของเก่ายังอยู่ครบ ไม่มีทาง brick

## Flow 2: บอร์ดได้รับไฟล์ .wasm เพื่อเปลี่ยน Logic

1. `.wasm` มากับ bundle เดียวกัน (ประกาศใน `layout.json` → `wasm:[{id, path, tick_ms, canvas_ids, memory_kb}]`)
2. หลัง layout โหลดเสร็จ `wasm_engine_load_modules()`:
   - อ่านไฟล์ → `wasm_runtime_load` → `instantiate` (linear memory จำกัดตาม `memory_kb`, จาก pool PSRAM 2MB)
   - เรียก export `ccp_on_init(abi_version)` — คืนค่าติดลบ = ปฏิเสธโหลด
3. Runtime loop:
   - `tick_ms` → esp_timer ยิง job `ccp_on_tick(now)` เข้า queue ของ `wasm_exec` task (core 1, prio ต่ำกว่า LVGL)
   - touch บน canvas → `ccp_on_event(widget, DRAG, dx, dy)` (ลากดูกราฟย้อนหลัง)
   - MQTT data → host วาง payload ใน guest memory ผ่าน `ccp_malloc` → `ccp_on_data(stream, ptr, len)`
   - WASM วาดผ่าน `ccp_canvas_blit/fill_rect/draw_line/draw_text` → `ccp_canvas_flush` → LVGL invalidate
4. **Memory Protection**: ทุก pointer จาก guest ถูก validate (`wasm_runtime_validate_app_addr` / WAMR `*~` signature)
   — guest ไม่มี WASI, ไม่มี filesystem, ไม่มี socket; ทุก I/O ผ่าน `ccp_*` เท่านั้น
5. **Watchdog**: supervisor (esp_timer 50ms) ตรวจ deadline (init 3s / event 250ms / tick 3×interval)
   → เกิน → `wasm_runtime_terminate()` → reinstantiate → 3 strikes = ปิด module + ถอย version → รายงาน server

## Responsibility Matrix

| หน้าที่ | Server | ESP32 |
|---|---|---|
| ไฟล์ UI/เสียง/WASM | ต้นฉบับใน MinIO + version registry | cache บน SD + เรียกใช้ |
| ความถูกต้อง | คำนวณ sha256 (zip + รายไฟล์) | ตรวจ sha256 ก่อน activate |
| ลำดับเวอร์ชัน | สั่งว่าใช้เวอร์ชันไหน (assignment) | ตัดสินใจ download/ใช้ cache, ถอย last-good เอง |
| Logic | คอมไพล์+แจก .wasm | รันใน WAMR sandbox + ฆ่าเมื่อค้าง |
| ตัวตน | mint device token ตอน claim, EMQX ACL ต่อเครื่อง | เก็บ token ใน NVS, ส่งทุกครั้ง |

## Concurrency / Memory (สรุปจากแผน)

- **Core 1**: `lvgl` (prio 10) > `wasm_exec` (prio 5) — UI ไม่มีวันค้างเพราะ WASM
- **Core 0**: mqtt (5), sync_worker (3), audio_decode (18), sysmon (2)
- PSRAM: framebuffer เต็มจอ 300KB + WAMR pool 2MB + LVGL heap + asset cache / Internal: DMA bounce 2×30KB
- จอ AXS15231B (QSPI) รับเฉพาะ stream เต็มเฟรมจากบนลงล่าง (CASET อย่างเดียว + RAMWR/RAMWRC)
  → LVGL ใช้ `RENDER_MODE_FULL` + flush แบ่ง band 48 แถว ping-pong ผ่าน bounce buffer พร้อม rotate+byte-swap ในรอบเดียว

## ความปลอดภัย

1. TLS ทุกช่องทาง (MQTT 8883 / HTTPS) + cert bundle ใน firmware
2. Device token ออกตอน claim (bcrypt hash ฝั่ง server), EMQX ACL = `ccp/v1/{ตัวเอง}/#`
3. WASM sandbox: pool แยก, bounds-check ทุก pointer, deadline supervisor, 3-strikes
4. OTA: `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` — image ใหม่ต้องผ่าน health gate 60s ก่อน mark valid
5. Remote lock/wipe ผ่าน cmd (lock เก็บใน NVS อยู่ข้ามรีบูต; wipe = format NVS+LittleFS)
6. v1.1: ed25519 signature ใน manifest (ช่องเตรียมไว้แล้วใน schema)
