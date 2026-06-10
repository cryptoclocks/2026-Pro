# คู่มือแอดมิน CryptoClock Pro Hub

> สำหรับผู้ดูแลระบบ/เจ้าของแพลตฟอร์ม — คู่มือผู้ใช้ทั่วไปอยู่ที่ [manual.md](manual.md)

## 1. สถาปัตยกรรมโดยย่อ

```
[จอ ESP32] ←MQTT(1883/8883)→ [EMQX] ←→ [NestJS API :4000] ←→ [Postgres / Redis / MinIO]
     ↑                                        ↑
     └─HTTP: ดาวน์โหลด bundle / settings      └─ [Next.js Builder+Dashboard :3000]
     └─LAN API :80 (ในวง WiFi เดียวกัน สำหรับแอป user)
```
รายละเอียดเต็ม: [architecture.md](architecture.md)

## 2. ติดตั้ง Server

```bash
cd server && cp .env.example .env       # แก้ secrets ก่อนใช้จริงทุกตัว!
docker compose up -d                    # postgres, redis, emqx, minio
pnpm install
pnpm --filter @ccp/api exec prisma migrate dev
pnpm dev                                # api :4000, web :3000
```
- EMQX dashboard: `http://localhost:18083` (admin/public — **เปลี่ยนรหัสทันที**)
- MinIO console: `http://localhost:9001`
- Production: ใช้ MQTT TLS (8883) + ใส่ JWT_SECRET/STRIPE keys จริงใน `.env`

## 3. การจัดการ Device

### Claim (ผูกเครื่องกับ user)
```bash
curl -X POST localhost:4000/api/v1/devices/claim \
  -H 'Content-Type: application/json' \
  -d '{"userId":"<uid>","deviceId":"ccp-983daee91478","code":"E91478","name":"จอหน้าร้าน"}'
# -> ได้ token (แสดงครั้งเดียว) — เครื่องเก็บใน NVS, server เก็บแค่ hash
```

### ส่งคำสั่ง (Command Center)
```bash
curl -X POST localhost:4000/api/v1/devices/ccp-983daee91478/cmd \
  -H 'Content-Type: application/json' -d '{"type":"identify"}'
```
| type | params | ผล |
|---|---|---|
| `ping` / `identify` | - | ทดสอบ/บี๊บหาเครื่อง |
| `reboot` | - | รีสตาร์ท |
| `brightness` | `{value:0-100}` | ปรับไฟ |
| `show_page` | `{page_id}` | สลับหน้า (layout package) |
| `sync` | `{package_id, version, bundle_url, bundle_sha256}` | ติดตั้ง package |
| `settings` | `{version, config}` | push ตั้งค่า 3 หน้า default |
| `reload` | - | โหลด UI ใหม่ |
| `ota` | `{fw_url, fw_sha256}` | อัปเดต firmware (มี rollback) |
| `lock` / `unlock` / `wipe` | - | ล็อก/ปลดล็อก/ล้างเครื่อง ⚠️ |

### Settings 3 หน้า default (สำคัญ)
เครื่อง**เช็คตอนเปิดทุกครั้ง**: `GET /api/v1/devices/{id}/settings` เทียบ `version` กับที่จำไว้ — ไม่ตรงจะดึงของ server มาทับ device.json แล้ว reload ทันที / แอดมินตั้งจาก server:
```bash
curl -X PUT localhost:4000/api/v1/devices/ccp-983daee91478/settings \
  -H 'Content-Type: application/json' \
  -d '{"config":{"pages":["clock","crypto"],"clock":{"theme":"neon"},
       "crypto":{"symbols":["BTCUSDT","SOLUSDT"],"currency":"THB","fetch_interval_s":30}}}'
# บันทึก + bump version + push MQTT ไปเครื่องที่ออนไลน์ทันที
```
ลำดับความสำคัญ config บนเครื่อง: **server settings > SD device.json > per-page config.json > user_config.h**

## 4. Payload/Package (Dynamic UI เต็มรูปแบบ)

1. ออกแบบใน Builder (`localhost:3000/builder`) → Export `layout.json`
2. แพ็กเป็น zip: `python3 firmware/tools/make_package.py <dir> bundle.zip` (สร้าง manifest + sha256 ให้)
3. Publish: `POST /api/v1/payloads/publish` → assign: `POST /api/v1/devices/{dbId}/assign`
4. เครื่องโหลด → ตรวจ hash → สลับ UI โดยไม่รีบูต (zero-flash)

## 5. MQTT Topics (debug ด้วย mosquitto_sub)

```bash
mosquitto_sub -h localhost -t 'ccp/v1/+/status' -t 'ccp/v1/+/telemetry' -v
```
| topic | ทิศ | เนื้อหา |
|---|---|---|
| `ccp/v1/{id}/cmd` | S→D | คำสั่ง (qos1) |
| `ccp/v1/{id}/cmd/res` | D→S | ผลคำสั่ง |
| `ccp/v1/{id}/status` | D→S | retained + LWT (`online:false` เมื่อหลุด) |
| `ccp/v1/{id}/telemetry` | D→S | heap/psram/แบต/fps/SD ทุก 30s |
| `ccp/v1/{id}/data/{stream}` | S→D | ข้อมูล real-time เข้า widget bindings |

## 6. ความปลอดภัย (production checklist)

- [ ] เปลี่ยนรหัส EMQX dashboard + เปิด HTTP auth hook ชี้ `/api/v1/emqx/auth` (M5)
- [ ] MQTT ใช้ TLS 8883 + per-device credentials (ออกตอน claim)
- [ ] เปลี่ยน `JWT_SECRET`, Postgres/MinIO passwords ใน `.env`
- [ ] LAN API ของจอยังไม่มี auth (v1) — ใช้ในวง LAN ที่ไว้ใจได้เท่านั้น
- [ ] เปิด Stripe webhook secret จริง + ทดสอบด้วย `stripe trigger checkout.session.completed`
- [ ] GitHub token / API keys ห้าม commit — `.env` อยู่ใน .gitignore แล้ว

## 7. Monitoring & แก้ปัญหา

| อาการ | เช็ค |
|---|---|
| เครื่อง offline | `status` retained ใน MQTT, ไฟ/WiFi, LWT จะ set `online:false` เอง |
| sync ไม่ลง | `cmd/res` error, พื้นที่ SD (`telemetry.sd_free_kb`), sha256 ตรงไหม |
| heap ลดเรื่อยๆ | `telemetry.heap_min` — แจ้งทีมเฟิร์มแวร์พร้อม log |
| WASM พัง | `telemetry.wasm_crashes` เพิ่ม = module โดน terminate (3 ครั้ง = ปิดถาวรจนกว่า reload) |
| ดู log บนเครื่อง | เสียบ USB → `idf.py -p /dev/cu.usbmodem* monitor` |
