# คู่มือแอดมิน — CryptoClock Pro (ระบบคลาวด์)

> สำหรับผู้ดูแล/เจ้าของแพลตฟอร์ม · คู่มือผู้ใช้ทั่วไป (เจ้าของเครื่อง) อยู่ที่ [manual.md](manual.md)
> อัปเดตล่าสุดให้ตรงกับระบบจริงที่ deploy บนคลาวด์ (ไม่ใช่ docker local แบบเดิมแล้ว)

## 1. ภาพรวมระบบ (Production)

```
[จอ ESP32-S3] ──MQTT/WSS──┐
   │  └─HTTPS bootstrap+asset (X-Device-Token)
   │                        ▼
[เวปแอดมิน Next.js] ──► [Hub API NestJS บน OCI] ──► [Supabase Postgres]
[เวป user Vite]      ──►  api.cashlessthailand.com        └ assets เก็บบน OCI volume
        └──MQTT/WSS──► [Broker หลัง Caddy บน OCI] ──cmd──► จอ
```

| ส่วน | URL |
|---|---|
| เวปแอดมิน | `https://2026-pro-admin.vercel.app` |
| เวป user (เจ้าของเครื่อง) | `https://2026-pro-user.vercel.app` |
| Hub API | `https://api.cashlessthailand.com/api/v1` |

- **MQTT** = คุมเครื่องแบบ realtime (identify/reboot/brightness/sync) เวป→API→broker→จอ
- **HTTPS + device token** = จอดึง config/asset เอง (`/device/bootstrap`)
- topic จอ: subscribe `ccp/v1/<encId>/cmd` · publish `ccp/v1/<encId>/status|cmd/res|telemetry`
  โดย `encId = AES-128-CBC(<deviceId>-<MAC>)`

---

## 2. เข้าสู่ระบบแอดมิน

1. เปิด `https://2026-pro-admin.vercel.app` → กด **Sign in** → เลือก Google `mycryptoclock@gmail.com`
2. เข้าได้แล้วมุมขวาบนต้องเห็น: pill **Admin** · อีเมล · สถานะ **MQTT connected** (สีเขียว)
3. เมนูบน: **Fleet · Builder · Store · Users · Approvals** (โผล่เฉพาะบัญชี admin)

> ถ้า login แล้วไม่เห็นเมนูพวกนี้ = บัญชีนั้นยังไม่ใช่ ADMIN (ไป Users → grant role ก่อน)

---

## 3. ⭐ เพิ่มเครื่องใหม่ / เครื่องเปล่า เข้าระบบ (Provision)

> **คำถามที่พบบ่อย: "อัพโหลดเข้าเครื่องเปล่า จากเวปแอดมินได้จากหน้าไหน?"**
> **ตอบ: หน้า Fleet (หน้าแรกหลัง login) → ปุ่ม `+ Provision device` มุมขวาบน**

Provision คือการลงทะเบียนเครื่องเข้าระบบ + แจกหมายเลขซีเรียล + mint token + claim code ทำตามนี้:

### ขั้นตอนเต็ม

**เตรียมเครื่องเปล่า**
1. เปิดเครื่อง → ตั้ง WiFi ให้เครื่องเข้าวง **LAN เดียวกับคอมแอดมิน** (ดูวิธีใน [manual.md ข้อ 2](manual.md))
2. จด **MAC** ของเครื่อง — ดูได้จาก **เมนู Settings บนจอ** หรือ
   `GET http://<device-ip>/api/v1/info` (คืน deviceId/fw/ip/**mac**/heap)

**ลงทะเบียนบนเวปแอดมิน**
3. ไปหน้า **Fleet** (`/`) → กด **`+ Provision device`** (มุมขวาบน)
4. กรอกฟอร์ม:
   | ช่อง | จำเป็น | หมายเหตุ |
   |---|---|---|
   | **MAC address** | ✅ | เช่น `98:3D:AE:E9:14:78` (รูปแบบตัวพิมพ์ใหญ่ คั่น `:`) |
   | First / Last name | – | ชื่อผู้ซื้อ |
   | Position / Role · Company | – | ขึ้นการ์ดโปรไฟล์บนจอ |
   | Name of customer | – | ป้ายชื่อเครื่อง (device label) |
   | **Buyer Gmail** | – | ถ้าใส่ → ผูก owner ให้อัตโนมัติ (ผู้ซื้อไม่ต้อง claim เอง) |
   | WiFi SSID / password / Old SSID | – | บันทึกไว้ในประวัติเครื่อง |
   | Coin 1 / Coin 2 | – | คู่เหรียญเริ่มต้น เช่น `BTCUSDT` / `ETHUSDT` |
   | Ads · Permission | – | Permission: Active(1) / Locked(0) |
5. กด **Provision** → ป๊อปอัป **"Device provisioned ✓"** จะแสดง 3 ค่า **(คัดลอกเก็บทันที)**:
   - **Device ID** เช่น `CCP000007` (ซีเรียลรันนิ่งที่ระบบแจกให้)
   - **Claim code** (8 ตัว) — ให้ผู้ซื้อเอาไปผูกบัญชี
   - **Device token** (32 ตัว) — บัตรผ่านให้เครื่องดึง config (server เก็บแค่ hash)

**ยัด identity ลงเครื่องเปล่า** (ทำให้เครื่องกลายเป็น `CCP000007`)
6. ยิงเข้า local API ของเครื่อง (อยู่วง LAN เดียวกัน):
   ```
   POST http://<device-ip>/api/v1/provision
   Content-Type: application/json
   { "deviceId": "CCP000007", "token": "<device token จากข้อ 5>" }
   ```
   → เครื่องตอบ `{"ok":true,"rebooting":true}` แล้ว **reboot เอง**
   → หลัง boot เครื่องใช้ id ใหม่ + subscribe topic encId ใหม่ + ลอง `/device/bootstrap` ด้วย token

**ยืนยัน**
7. กลับหน้า **Fleet** → เครื่อง `CCP000007` ต้องขึ้น **online** (จุดเขียว) ภายใน ~30 วิ
8. กด **Identify** ที่การ์ดเครื่อง → จอจริงต้องกระพริบ (พิสูจน์ MQTT loop ครบวง)
9. ถ้าไม่ได้ใส่ Buyer Gmail → ส่ง **Device ID + Claim code** ให้ผู้ซื้อไป claim ในเวป user เอง

> **สรุปสั้น:** Fleet → `+ Provision device` → กรอก MAC → ได้ id/token/claim → `POST /api/v1/provision` เข้าเครื่อง → เครื่อง reboot เป็นเครื่องใหม่
>
> **หมายเหตุ token:** ถ้าเครื่องไม่มี token (หรือ token ผิด) → `/device/bootstrap` ตอบ 401 → เครื่อง **ไม่พัง** แต่ใช้ config เดิมใน NVS ต่อไป

---

## 4. หน้า Fleet — จัดการเครื่อง

ในการ์ดแต่ละเครื่องมี:

### 4.1 Command Center (ปุ่มคำสั่ง / `POST /devices/:id/cmd`)
| คำสั่ง | ผล |
|---|---|
| `ping` / `identify` | ทดสอบ / ทำให้จอกระพริบหาเครื่อง |
| `brightness` | ปรับความสว่าง (จอหรี่/สว่างทันที) |
| `show_page` | สลับไปหน้าที่ระบุ (clock/crypto/...) |
| `sync` / `reload` | ดึง config/payload ใหม่ + reload UI |
| `reboot` | รีสตาร์ทเครื่อง |
| `settings` | push ค่าตั้งหน้า |
| `ota` | อัปเดต firmware (มี rollback) ⚠️ |
| `lock` / `unlock` | ล็อก/ปลดล็อกเครื่อง ⚠️ |
| `wipe` | ล้างเครื่องกลับค่าโรงงาน ⚠️ **อันตราย** |

### 4.2 Settings modal
แก้ config ของเครื่อง (display mode, page delay, brightness, เหรียญ ฯลฯ) → กด Save → bump revision + push ไปจอผ่าน MQTT ทันที

### 4.3 Rights / Owner
- **Assign owner**: ใส่อีเมล user → ผูก/ย้ายเจ้าของเครื่อง (`/devices/:id/assign-owner`)
- **Grant / Revoke**: เปิด/ปิดสิทธิ์ใช้ item รายเครื่อง (เช่นปลดล็อกหน้า/ฟีเจอร์)

---

## 5. หน้า Builder — ออกแบบ UI (Dynamic Layout)

1. เปิด **Builder** → จัด widget ของแต่ละหน้า
2. **Validate / Compile** → `POST /payloads/validate` + `/payloads/compile-wasm`
3. **Publish compiled** → **Rollout** ให้เครื่อง (`/payloads/versions/:id/rollout`)
4. เครื่องรับเวอร์ชันใหม่โดยไม่รีบูต (zero-flash)

> **สำคัญ:** การ publish ต้อง**ไม่ลบ**ค่าที่ user ตั้งไว้ + รูปที่อัปโหลด — ต้อง persist เสมอ

---

## 6. หน้า Store / Users / Approvals

| หน้า | ทำอะไร | endpoint หลัก |
|---|---|---|
| **Store** | ดู/แก้ราคา/สถานะ item ในแคตตาล็อก | `GET /store/admin/items` · `PATCH /store/admin/items/:id` |
| **Users** | ดูรายชื่อ user, อุปกรณ์ของแต่ละคน, grant/revoke item & role | `GET /admin/users` · `/admin/users/:id` · `POST .../grant\|revoke` |
| **Approvals** | อนุมัติ/ปฏิเสธ feature request ที่ user ส่งมา | `GET /admin/feature-requests` · `POST .../:id/approve\|reject` |

---

## 7. MQTT / debug

| topic | ทิศ | เนื้อหา |
|---|---|---|
| `ccp/v1/<encId>/cmd` | S→D | คำสั่ง |
| `ccp/v1/<encId>/cmd/res` | D→S | ผลคำสั่ง |
| `ccp/v1/<encId>/status` | D→S | retained + LWT (`online:false` เมื่อหลุด) มี `id`+`mac` |
| `ccp/v1/<encId>/telemetry` | D→S | heap/psram/แบต/WiFi RSSI ทุก ~30s |

- เวป RPC: `ccp/web/user/<uid>/request` / `response/<id>`
- API map deviceId↔encId จาก DB (`refreshDeviceMap`) และยังเรียนรู้จาก `status.id` ที่จอส่งมา

---

## 8. แก้ปัญหา (Troubleshooting)

| อาการ | เช็ค |
|---|---|
| เครื่องไม่ขึ้น online | จอต่อ WiFi ไหม · status retained ใน broker · MAC ที่ provision ตรงกับเครื่องจริงไหม |
| สั่ง cmd แล้วเครื่องไม่ตอบ | firmware รุ่นเก่าอาจ subscribe topic plaintext เดิม — ต้องเป็นรุ่นที่ใช้ encId · ดูสถานะ MQTT บนแอดมินเป็นเขียว |
| `/device/bootstrap` 401 | เครื่องไม่มี token / token ไม่ตรง hash ใน DB → ทำข้อ 3.6 (push token) ใหม่ |
| provision แล้ว id ไม่เปลี่ยนบนจอ | ยังไม่ได้ยิง `POST http://<device-ip>/api/v1/provision` หรือเครื่องไม่อยู่วง LAN เดียวกัน |
| config ที่ user ตั้งหาย | ตรวจ revision/optimistic concurrency · publish payload ต้องไม่ทับค่า user |
| ดู log บนเครื่อง | เสียบ USB → `idf.py -p /dev/cu.usbmodem* monitor` |

> เอกสารเชิงลึก: [SUPABASE_DEVICE_CONFIG_SCHEMA.md](SUPABASE_DEVICE_CONFIG_SCHEMA.md) · [DEVICE_PROVISIONING_SPEC.md](DEVICE_PROVISIONING_SPEC.md) · [CLOUD_DEPLOY_HANDOFF.md](CLOUD_DEPLOY_HANDOFF.md) · แผนทดสอบ: [QA_TEST_PROMPT_MINIMAX.md](QA_TEST_PROMPT_MINIMAX.md)
