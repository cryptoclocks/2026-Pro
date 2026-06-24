# CryptoClock Pro — QA Test Prompt (สำหรับ Minimax M3)

> ไฟล์นี้คือ **พรอมท์** ที่ส่งให้ AI ตัวอื่น (Minimax M3) ใช้เทสระบบทั้งหมด
> ทีละหน้า: **เวปแอดมิน + เวป user + เครื่อง CCP ของจริง** พร้อมกัน
> เริ่มอ่านจากหัวข้อ **0. พรอมท์หลัก** แล้วทำตามลำดับ Test Case ไปเรื่อย ๆ

---

## 0. พรอมท์หลัก (วางให้ Minimax M3 อ่านก่อน)

```
บทบาทของนาย: นายคือ QA Engineer ที่กำลังเทสระบบ CryptoClock Pro
(ESP32-S3 IoT display + cloud backend). มีของจริง 3 ส่วนทำงานพร้อมกัน:
  1) เวปแอดมิน (Next.js)  — คุมกองอุปกรณ์ทั้งหมด
  2) เวป user (Vite)      — เจ้าของเครื่องตั้งค่าเครื่องตัวเอง
  3) เครื่อง CCP จริง 1 ตัว — ESP32-S3 จอแสดงผล ต่อ WiFi/MQTT/HTTPS

เป้าหมาย: เทสทุกหน้า ทุกฟีเจอร์ ทุกฟังก์ชัน ทีละขั้น และยืนยัน
"loop การเชื่อมต่อจริง" — เปลี่ยนค่าบนเวป → เครื่องจริงต้องเปลี่ยนตาม,
เครื่องจริงออนไลน์ → ต้องเห็นบนแอดมิน.

กติกาเหล็ก (ห้ามทำ):
  - ห้ามแตะ Caddy / broker / Node-RED core flow บน OCI
  - ห้าม restart/ลบ container ที่ไม่เกี่ยวข้องบน OCI
  - ห้าม flash firmware ใหม่ (เครื่องถูก flash ไว้แล้ว) — เทสด้วยของที่มี
  - ห้ามแก้ AES key / topic legacy ของ ESP32 รุ่นเก่า
  - ถ้าจะรันคำสั่งที่ไม่ย้อนกลับ (ลบ device, wipe) ให้ถามเจ้าของก่อน

วิธีรายงาน: ทุก Test Case ให้ตอบเป็น 1 บรรทัด:
  [PASS|FAIL|BLOCKED]  <TC-id>  <ชื่อ>  — <สิ่งที่เห็นจริง>
ถ้า FAIL ให้แนบ: response code / error text / log / screenshot ที่เกี่ยวข้อง
และเดาสาเหตุสั้น ๆ 1 บรรทัด. อย่าข้าม TC — ถ้าทำไม่ได้ให้ใส่ BLOCKED + เหตุผล.
```

---

## 1. สภาพแวดล้อม (Environment) — กรอกค่าจริงก่อนเริ่ม

| สิ่งที่ต้องรู้ | ค่า |
|---|---|
| เวปแอดมิน | `https://2026-pro-admin.vercel.app` |
| เวป user | `https://2026-pro-user.vercel.app` |
| Hub API (public) | `https://api.cashlessthailand.com/api/v1` |
| Supabase project | `uadjxvagcnaebksaztpn` |
| Broker (MQTT over WSS) | ผ่าน Caddy บน OCI (เวปต่อให้อัตโนมัติ) |
| Device ID ของเครื่องเทส | `<DEVICE_ID>` ← ดูจากเมนู Settings บนเครื่อง หรือหน้า Fleet |
| Device MAC | `<MAC>` (เช่น `5C:01:3B:66:D8:70`) |
| Claim code | `<CLAIM_CODE>` ← ได้ตอน provision (8 ตัวอักษร) |
| Admin email | `mycryptoclock@gmail.com` (Google login) |
| User ทดสอบ (เจ้าของเครื่อง) | gmail อะไรก็ได้ที่ login ได้ |

> หมายเหตุ: ถ้ายังไม่รู้ `<DEVICE_ID>` / `<CLAIM_CODE>` ให้ทำ **ภาค A (Operational prereqs)** ก่อน

---

## 2. ทำความเข้าใจ "Provision" และ "Token" (เคยงงตรงนี้)

**Provision = แอดมินเปิดเครื่องใหม่เข้าระบบทีละเครื่องตอนขาย** (ผ่านสาย/หน้าแอดมิน) แล้วระบบจะ:

1. แจกหมายเลขซีเรียลถัดไปแบบรันนิ่ง: `CCP000001`, `CCP000002`, … (API gen ให้ ไม่ใช้ Google Sheet แล้ว)
2. สร้าง **claimCode** (8 ตัว) — ไว้ให้ "ผู้ซื้อ" เอาไปผูกบัญชี (claim) ในเวป user
3. **mint device token** (32 ตัว, สุ่ม) — เก็บใน DB แบบ **hash (bcrypt)** ฝั่งเซิร์ฟเวอร์ ส่วนตัวจริงคืนให้แอดมินครั้งเดียวเพื่อยัดลงเครื่อง (NVS)
4. ตั้ง entitlement หน้าเริ่มต้น (clock/crypto/slideshow/weather/profile/calendar)

**Token ใช้ทำอะไร:** firmware เอา token นี้แนบ header เวลาดึง config จากคลาวด์:

```
GET /api/v1/device/bootstrap
   X-Device-Id: <DEVICE_ID>
   X-Device-Token: <token ตัวจริง>
```

- เซิร์ฟเวอร์เทียบ token กับ hash ใน DB (`verifyDeviceToken`)
- ตรง → คืน config + manifest (หรือ `204` ถ้า revision ปัจจุบันทันสมัยอยู่แล้ว)
- ไม่มี token / ผิด → `401` → เครื่อง **ไม่พัง** แต่ใช้ config ใน NVS เดิมต่อไป (graceful)

> สรุปสั้น: **provision = ลงทะเบียนเครื่อง + แจก token; token = บัตรผ่านให้เครื่องดึง config ทาง HTTPS**
> Loop การคุมเครื่องแบบ realtime ใช้ **MQTT** (เวป → API → broker → เครื่อง); ส่วน bootstrap/asset ใช้ **HTTPS + token**

---

## ภาค A — Operational Prereqs (สิ่งที่ "คน/แอดมิน" ต้องทำก่อน Minimax เริ่ม)

> ถ้าข้อใดทำแล้วให้ติ๊กผ่าน. ภาคนี้ทำครั้งเดียว.

- **A1. Redeploy API บน OCI** — ให้มี endpoint `/device/*`, `/devices/provision`, `/devices/:id/pages/:slug`, assets พร้อม
  ตรวจ: `GET https://api.cashlessthailand.com/api/v1/market/BTCUSDT/ticker24h` ต้องได้ JSON ราคา (พิสูจน์ API ตื่น)
- **A2. รัน backfill ครั้งเดียว** (admin token):
  `POST /api/v1/devices/backfill-config` → ย้าย `Device.settings` เดิมเข้า config ตารางใหม่ (คาดหวัง `{ migrated: n }`)
- **A3. Provision เครื่องเทส** ให้มี token: หน้า Fleet → **Provision device** (ดู TC-AD-02) → จดค่า `deviceId / token / claimCode`
- **A4. ยัด token ลงเครื่องจริง** ผ่าน local API ของเครื่อง (เครื่องกับคนทดสอบอยู่วง LAN เดียวกัน):
  ```
  POST http://<device-lan-ip>/api/v1/provision
  { "deviceId": "<DEVICE_ID>", "token": "<token>", "apiBase": "https://api.cashlessthailand.com/api/v1" }
  ```
  เครื่องเขียน NVS แล้ว reboot → หลัง boot จะลอง `/device/bootstrap` เอง
- **A5. ยืนยันเครื่องออนไลน์** — เปิดหน้า Fleet ในแอดมิน เครื่องต้องโชว์จุดเขียว/online ภายใน ~30 วิ

---

## ภาค B — เวปแอดมิน (https://2026-pro-admin.vercel.app)

> Login: ปุ่ม **Sign in** → Google → ใช้ `mycryptoclock@gmail.com`
> เมนูบน: **Fleet · Builder · Store · Users · Approvals** (เห็นเมื่อเป็น admin เท่านั้น)

### B1. Auth / Gate
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-AD-00a | เปิดแอดมินแบบยังไม่ login | ถูกเด้งไป `/login`, เห็นปุ่ม Sign in |
| TC-AD-00b | Login ด้วย gmail admin | กลับเข้าหน้า Fleet, มุมขวาเห็น pill **Admin** + อีเมล + สถานะ **MQTT connected** (เขียว) |
| TC-AD-00c | Login ด้วย gmail ที่ไม่ใช่ admin | เข้าได้แต่ "ไม่เห็น" เมนู Fleet/Builder/Users (links ว่าง) — สิทธิ์ถูกกั้น |

### B2. หน้า Fleet (`/`) — กองอุปกรณ์
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-AD-01 | ดูตาราง/การ์ดอุปกรณ์ | เห็นเครื่องเทส, deviceId, owner email, สถานะ online/offline, payload version |
| TC-AD-02 | กด **Provision device** กรอก MAC + ชื่อผู้ซื้อ/บริษัท/ตำแหน่ง/coin → Submit | ได้ผลลัพธ์มี **deviceId (CCP00000x) + token + claimCode**; เครื่องใหม่โผล่ในตาราง (จดค่าไว้ทำ A4) |
| TC-AD-03 | กด **Rights/Owner** ของเครื่อง → ใส่อีเมล user → Assign | owner ของเครื่องเปลี่ยนเป็นอีเมลนั้น (รีเฟรชแล้วยังอยู่) |
| TC-AD-04 | เปิด **Settings modal** ของเครื่อง | เห็นค่า config ปัจจุบัน (display mode, page delay, brightness ฯลฯ) |
| TC-AD-05 | สั่ง **Identify** | ⟶ **เครื่องจริงต้องกระพริบ/แสดง identify** ภายในไม่กี่วินาที (พิสูจน์ MQTT cmd) |
| TC-AD-06 | สั่ง **Reload / Sync** | เครื่องดึง config ใหม่ (ดู log เครื่อง: bootstrap หรือ settings applied) |
| TC-AD-07 | สั่ง **Brightness** (เช่น 30%) จาก cmd | ⟶ จอเครื่องจริงหรี่ลงทันที |
| TC-AD-08 | สั่ง **Reboot** | เครื่องรีบูต (จอดับ→boot ใหม่→กลับ online) — **ทำเป็นข้อท้าย ๆ** |
| TC-AD-09 | สั่ง **show_page crypto** | เครื่องสลับไปหน้า crypto |

> cmd ทั้งหมดที่รองรับ: `ping, reboot, brightness, identify, show_page, sync, reload, settings, ota, lock, unlock, wipe`
> **lock/unlock/wipe/ota** = อันตราย → เทสเฉพาะถ้าเจ้าของอนุญาต (wipe ล้างเครื่อง!)

### B3. หน้า Builder (`/builder`)
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-AD-10 | เปิด Builder | โหลด builder pages/templates ได้ ไม่มี error console |
| TC-AD-11 | แก้ widget แล้ว validate/compile | `POST /payloads/validate` + `/payloads/compile-wasm` คืน OK (compiled bundle) |
| TC-AD-12 | Publish compiled แล้ว rollout ให้เครื่อง | `publish-compiled` + `versions/:id/rollout` สำเร็จ; เครื่องได้รับ payload version ใหม่ (เห็นใน Fleet) |
| TC-AD-13 | เช็คว่า user-set settings ไม่ถูกล้าง | หลัง publish: ค่าที่ user ตั้งไว้ + รูปที่อัปโหลด **ต้องไม่หาย** (ดู memory: user-edits-survive-publish) |

### B4. หน้า Store (`/store`) — admin จัดการแคตตาล็อก
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-AD-14 | เปิด Store admin | เห็นรายการ items (`GET /store/admin/items`) |
| TC-AD-15 | แก้ราคา/สถานะ item แล้วบันทึก | `PATCH /store/admin/items/:id` สำเร็จ, ค่าเปลี่ยนหลังรีเฟรช |

### B5. หน้า Users (`/users`)
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-AD-16 | เปิด Users | เห็นรายชื่อ users (`GET /admin/users`) |
| TC-AD-17 | เปิด user รายตัว → ดู devices ของเขา | `GET /admin/users/:id` คืนข้อมูล + อุปกรณ์ |
| TC-AD-18 | **Grant** item ให้ user → แล้ว **Revoke** | `POST /admin/users/:id/grant` + `/revoke` สำเร็จ; entitlement เปลี่ยนตาม |

### B6. หน้า Approvals (`/approvals`)
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-AD-19 | เปิด Approvals | เห็น feature-requests ที่รออนุมัติ (`GET /admin/feature-requests`) |
| TC-AD-20 | กด **Approve** / **Reject** อันหนึ่ง | `POST /admin/feature-requests/:id/approve|reject` สำเร็จ; รายการอัปเดตสถานะ |

---

## ภาค C — เวป user (https://2026-pro-user.vercel.app)

> Login: **Google OAuth** หรือ **email OTP**
> หน้า/แท็บ: **Connect · System · Profile · Clock · Crypto · Photos · Weather · Calendar · Store**
> ก่อนเทสหน้าตั้งค่า ต้อง **claim เครื่อง** ให้ user คนนี้เป็นเจ้าของก่อน

### C0. Login + Claim
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-00a | กด Sign in with Google | เด้ง Google → กลับมา login สำเร็จ (ถ้า error "Invalid URL" = VITE_SUPABASE_URL ไม่ถูกตั้งบน Vercel) |
| TC-US-00b | ลอง email OTP | ได้รหัสทางอีเมล, กรอกแล้วเข้าได้ |
| TC-US-01 | หน้า **Connect** → ใส่ `<DEVICE_ID>` + `<CLAIM_CODE>` → Claim (หรือสแกน QR/เปิดกล้อง) | claim สำเร็จ, เครื่องผูกกับ user; ถ้า claim ซ้ำเครื่องที่มีเจ้าของแล้ว → **409** (กันแย่งเครื่อง) |
| TC-US-02 | หน้า Connect → เลือกโหมด **Cloud (MQTT)** | เชื่อม broker ผ่าน WSS, สถานะ connected; (อีกโหมดคือ **LAN IP** ตรงเข้าเครื่องในวงเดียวกัน) |

### C1. หน้า System
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-03 | เปิด System | เห็น deviceId, firmware, IP, MAC, WiFi RSSI, หน้า/เพจปัจจุบัน — ตรงกับที่เครื่องโชว์ในเมนู Settings |

### C2. หน้า Profile — **(จุดที่เคยบั๊ก)**
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-04 | กรอก **Name / Nickname / Role / Company** → Save | `PUT /devices/:id/pages/profile` สำเร็จ |
| TC-US-05 | ดูบนจอเครื่องจริง หน้า Profile | **บรรทัด 1 = Name (ไม่ใช่ Nickname!)**, **บรรทัด 2 = (Nickname) Role**, **บรรทัด 3 = Company** |
| TC-US-06 | อัปโหลด **รูป avatar** (โหมด Cloud) | รูปถูกย่อเป็น ~132×132 PNG → `POST .../pages/profile/assets/...` → ขึ้นบนจอเครื่องจริง |
| TC-US-07 | บันทึกหลายครั้ง / รีเฟรช | ค่าที่กรอก + รูป **ไม่หาย** (persist) |

### C3. หน้า Clock
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-08 | เปลี่ยนรูปแบบนาฬิกา/timezone/ฟอนต์ → Save | `PUT /devices/:id/pages/clock` OK; **จอเครื่องจริงเปลี่ยนตาม** |
| TC-US-09 | ลองส่งค่าพร้อมกันสองแท็บ (optimistic concurrency) | แท็บหลังที่ baseRevision เก่า → **409 CONFIG_REVISION_CONFLICT** |

### C4. หน้า Crypto
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-10 | เลือกเหรียญ (เช่น BTC, ETH) → Save | `PUT .../pages/crypto` OK; เครื่องแสดงราคาคู่ที่เลือก |
| TC-US-11 | ตรวจราคา live | `GET /market/BTCUSDT/ticker24h` + `/klines/:interval` คืนข้อมูล; ราคาบนจอตรงกับตลาด |

### C5. หน้า Photos (Slideshow)
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-12 | อัปโหลดรูป 2–3 รูป → Save | อัปโหลดผ่าน asset API; เครื่องเล่นสไลด์รูปที่อัปโหลด |
| TC-US-13 | ลบรูปหนึ่ง | `DELETE .../assets/:key` สำเร็จ; รูปหายจากสไลด์เครื่อง |
| TC-US-14 | ตั้ง delay ต่อรูป | เครื่องเปลี่ยนรูปตามเวลาที่ตั้ง |

### C6. หน้า Weather
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-15 | ตั้งเมือง/หน่วย → Save | `PUT .../pages/weather` OK; จอแสดงอากาศเมืองนั้น |
| TC-US-16 | อัปโหลด **weather GIF** (โหมด Cloud) | GIF อัปขึ้น cloud asset → เครื่องเล่น GIF อากาศ |

### C7. หน้า Calendar
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-17 | ตั้งค่า calendar (รูปแบบ/เริ่มสัปดาห์) → Save | `PUT .../pages/calendar` OK; จอแสดงปฏิทินตามตั้ง |

### C8. หน้า Store (ฝั่ง user)
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-18 | เปิด Store | เห็น items ที่ขาย (`GET /store/items`) |
| TC-US-19 | กดซื้อ/checkout 1 รายการ | `POST /store/checkout` เริ่ม flow ชำระเงิน (อย่ายืนยันจ่ายจริงถ้าไม่จำเป็น) |
| TC-US-20 | หลังได้สิทธิ์ | entitlement ใหม่ขึ้นบนอุปกรณ์ (`GET /devices/:id/entitlements`) และหน้าที่ปลดล็อกใช้งานได้ |

### C9. Feature request (ถ้ามีปุ่มในเวป user)
| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-US-21 | ส่ง feature request | `POST /me/feature-requests` สำเร็จ → ไปโผล่ใน **Approvals** ของแอดมิน (เชื่อมกับ TC-AD-19) |

---

## ภาค D — เครื่อง CCP จริง (บนตัวเครื่อง)

> เทสที่ "ตัวเครื่อง" โดยตรง (กดที่จอ/ปุ่ม) ไม่ผ่านเวป

| TC | ขั้นตอน | ผลที่คาดหวัง |
|---|---|---|
| TC-DV-01 | ปล่อยเครื่องหมุนหน้าเอง | สลับ clock → crypto → slideshow → … ตาม page delay |
| TC-DV-02 | เปิดเมนู **Settings** บนเครื่อง | เห็น DEVICE ID, firmware, IP, MAC, WiFi dBm, หน้าปัจจุบัน + สไลเดอร์ brightness |
| TC-DV-03 | เลื่อน **brightness** บนเครื่อง | จอสว่าง/หรี่ตามทันที |
| TC-DV-04 | toggle เปิด/ปิดหน้า ในเมนู | หน้าโดนเอาออก/ใส่กลับในวงหมุน |
| TC-DV-05 | **WiFi reset** จากเมนู | เครื่องเข้าโหมดตั้ง WiFi ใหม่ (ทำเป็นข้อท้าย เพราะต้องต่อเน็ตใหม่) |
| TC-DV-06 | เครื่อง boot ใหม่ | ดึง `/device/bootstrap` (มี token) → ได้ config ล่าสุด หรือ 204; ไม่มี token → ใช้ NVS เดิม ไม่แครช |

### Local API ของเครื่อง (วง LAN เดียวกัน, `http://<device-ip>/api/v1/...`)
| TC | endpoint | ผลที่คาดหวัง |
|---|---|---|
| TC-DV-07 | `GET /info` | คืน deviceId/fw/ip/mac/heap |
| TC-DV-08 | `GET /config` | คืน config ปัจจุบันบนเครื่อง |
| TC-DV-09 | `POST /brightness` | จอเปลี่ยนความสว่าง |
| TC-DV-10 | `POST /identify` | จอกระพริบ identify |
| TC-DV-11 | `GET /files` + `GET /file?...` | ลิสต์/อ่านไฟล์ asset บนเครื่อง |
| TC-DV-12 | `POST /upload` + `DELETE /file` | อัป/ลบไฟล์ภายในเครื่อง |
| TC-DV-13 | `POST /provision` | (ทำใน A4) เขียน NVS + reboot |

---

## ภาค E — End-to-End Loop (ข้อสำคัญที่สุด — พิสูจน์ของจริงเชื่อมกัน)

| TC | สถานการณ์ | ผลที่คาดหวัง |
|---|---|---|
| TC-E2E-01 | user เปลี่ยน Profile ในเวป → Save | ภายใน ~5 วิ **จอเครื่องจริง** อัปเดต Name/Role/Company + รูป |
| TC-E2E-02 | admin สั่ง Identify จาก Fleet | เครื่องจริง identify (เวป→API→broker→เครื่อง) |
| TC-E2E-03 | ถอดปลั๊กเครื่อง / ดับเน็ต | ภายใน ~30–60 วิ Fleet โชว์ **offline** |
| TC-E2E-04 | เสียบกลับ / เน็ตคืน | เครื่องกลับ **online**, สถานะ sync, ดึง config ล่าสุด |
| TC-E2E-05 | admin publish payload ใหม่ (Builder) | เครื่องรับเวอร์ชันใหม่ **โดยค่าที่ user ตั้ง + รูป ไม่หาย** |
| TC-E2E-06 | user เปลี่ยนเหรียญ crypto | จอแสดงคู่เหรียญใหม่ + ราคา live ถูกต้อง |
| TC-E2E-07 | admin assign owner เป็น user อื่น | user เดิมหมดสิทธิ์ตั้งค่า, user ใหม่เห็นเครื่องในรายการของตน |

---

## ภาค F — API ตรง (ทดสอบ endpoint แบบไม่ผ่าน UI, optional แต่ครบ)

> ทุก route อยู่ใต้ prefix `/api/v1`. ต้องมี Bearer JWT (user/admin) ยกเว้น `/device/*` ใช้ device token, `/market/*` และ `/store/items` เป็น public

- **auth:** `GET /auth/me`
- **market (public):** `GET /market/:symbol/ticker24h`, `GET /market/:symbol/klines/:interval`
- **store:** `GET /store/items`, `POST /store/checkout`, `GET /store/admin/items`, `PATCH /store/admin/items/:id`
- **payloads:** `POST /payloads/validate`, `/payloads/compile-wasm`, `GET /payloads/builder-pages`, `/payloads/builder-pages/:packageId/latest`, `POST /payloads/publish-compiled`, `/payloads/versions/:id/rollout`, `/payloads/publish`, `GET /packages/:packageId/:version/manifest`, `/packages/:packageId/:version/bundle.zip`
- **features:** `POST /me/feature-requests`, `GET /me/feature-requests`, `GET /admin/feature-requests`, `POST /admin/feature-requests/:id/approve`, `/reject`
- **social:** `POST /social/resolve`, `/social/parse`
- **admin users:** `GET /admin/users`, `/admin/users/:id`, `POST /admin/users/:id/grant`, `/revoke`
- **device (device-token):** `GET /device/bootstrap`, `POST /device/config-ack`, `/device/config-error`, `GET /device/assets/:versionId/file?did=&token=`
- **devices (user/admin JWT):** `POST /devices/claim`, `/devices/provision`, `/devices/:hwId/assign-owner`, `/devices/backfill-config`, `GET /devices`, `/devices/:hwId/entitlements`, `POST /devices/:hwId/entitlements/sync`, `/devices/:hwId/grant`, `/revoke`, `/devices/:id/assign`, `GET /devices/:hwId/config`, `/devices/:hwId/pages/:slug`, `PUT /devices/:hwId/pages/:slug`, `GET|POST|GET-file|DELETE /devices/:hwId/pages/:slug/assets[/:assetKey][/file]`, `GET /devices/:hwId/settings`, `PUT /devices/:hwId/settings`, `POST /devices/:hwId/cmd`
- **billing:** `POST /billing/webhook`

สำหรับแต่ละ endpoint ให้เช็ค: (1) auth ถูกบังคับจริง (เรียกแบบไม่มี token → 401/403), (2) happy-path คืน 2xx + รูปร่าง JSON ถูก, (3) input ผิด → 4xx ที่อ่านรู้เรื่อง (ไม่ใช่ 500).

---

## ภาค G — สรุปผล (ให้ Minimax เติมตอนจบ)

```
สรุปการเทส CryptoClock Pro
วันที่/เวลา:
firmware version บนเครื่อง:
API reachable: yes/no   |  MQTT connected: yes/no

ผลรวม: PASS __ / FAIL __ / BLOCKED __  (จากทั้งหมด __ TC)

FAIL ที่ต้องแก้ (เรียงความสำคัญ):
1.
2.

ข้อสังเกต/ความเสี่ยง:
-
```

---

### หมายเหตุสำหรับผู้ส่งพรอมท์
- ค่า `<DEVICE_ID> / <MAC> / <CLAIM_CODE> / token` ต้องเติมจริงในภาค 1 ก่อนส่งให้ Minimax
- ถ้า Minimax ไม่มีสิทธิ์ยิง API ตรง (ไม่มี token) ให้ทำเฉพาะภาค B–E ผ่าน UI ก็พอ; ภาค F ทำเท่าที่มีสิทธิ์
- TC ที่อันตราย (wipe/ota/lock/reboot/wifi-reset) — ให้ Minimax **ขออนุญาตเจ้าของก่อน** ทุกครั้ง
