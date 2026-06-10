# CryptoClock Pro

Smart IoT Display platform บน ESP32-S3 (JC3248W535C) แบบ **Zero-Flash / Dynamic UI** —
หน้าจอถูกกำหนดด้วย `layout.json`, Logic ส่งเป็น `.wasm`, อัปเดตผ่าน Server โดยไม่ต้องแฟลชบอร์ด

```
schema/        ★ Single source of truth: JSON Schemas (layout/manifest/MQTT) + Host ABI spec
firmware/      ESP-IDF v5.5 project (LVGL 9 + WAMR + Captive Portal + OTA + SD sync)
wasm-apps/     Guest SDK (ccp_abi.h / ccp_app.h) + ตัวอย่าง .wasm
server/        CryptoClock Pro Hub — pnpm monorepo (NestJS API + Next.js Builder + Prisma)
docs/          สถาปัตยกรรมและ flow การทำงาน
JC3248W535EN/  เอกสาร/โค้ดตัวอย่างจากผู้ผลิตจอ (อ้างอิงเท่านั้น)
```

## Quick start — Firmware (ESP32-S3)

```bash
# ติดตั้งครั้งแรก (ทำแล้วบนเครื่องนี้): ESP-IDF v5.5 ที่ ~/esp/esp-idf
source ~/esp/esp-idf/export.sh
cd firmware
idf.py set-target esp32s3
idf.py build flash monitor          # เสียบบอร์ดผ่าน USB-C
```

- ครั้งแรกบอร์ดจะเปิด Captive Portal: ต่อ WiFi `CCP-Setup-XXXX` → เปิด `http://192.168.4.1` → กรอก WiFi
- ตั้งค่า MQTT broker เริ่มต้นได้ที่ `idf.py menuconfig` → CryptoClock Pro
- Pin map ทั้งหมดอยู่ที่ [ccp_board.h](firmware/components/board_bsp/include/ccp_board.h)

## Quick start — Server (Hub)

```bash
cd server
cp .env.example .env
docker compose up -d                # Postgres + Redis + EMQX + MinIO (ต้องมี Docker Desktop)
pnpm install
pnpm --filter @ccp/api exec prisma migrate dev   # สร้าง DB schema
pnpm dev                            # api :4000, web :3000
```

เปิด `http://localhost:3000/builder` → ลาก widget ลง artboard 480×320 → **Export layout.json**

## Quick start — WASM app

```bash
# ติดตั้งแล้วที่ ~/sdk/wasi-sdk
wasm-apps/toolchain/build.sh wasm-apps/examples/hello/main.c hello.wasm
```

ABI ทั้งหมดดูที่ [ccp_abi_v1.md](schema/abi/ccp_abi_v1.md)

## สถานะ Milestone

- [x] **M0** Toolchain + scaffold + display driver port (AXS15231B QSPI + LVGL 9) — *รอทดสอบบนบอร์ดจริง*
- [ ] **M1** Captive Portal บน iPhone จริง + MQTT TLS + telemetry soak
- [ ] **M2** ui_renderer ครบทุก widget + hot-reload soak test
- [ ] **M3** candle_chart/tetris ตัวอย่าง + AOT ประเมิน
- [ ] **M4** MP3 (helix) + OTA rollback ทดสอบดับไฟ
- [ ] **M5** Claim flow + EMQX auth/ACL + MinIO presigned bundle
- [ ] **M6** Fleet dashboard SSE + builder bindings/actions inspector
- [ ] **M7** Stripe live flow + Ads + เกม 30fps

แผนละเอียด: [docs/architecture.md](docs/architecture.md)
