# Builder, การส่งหน้าไปยังจอ, ระบบจ่ายเงิน & สิทธิ์

## 1. ออกแบบหน้าใน Builder (`/builder`)

1. **เลือก template** จากดรอปดาวน์ "Load template…" (Clock / Crypto / Welcome / Blank) — โหลดหน้าเดิมมาเป็นจุดเริ่ม
2. ลาก widget จาก palette ลง artboard (480×320) ปรับตำแหน่ง/ขนาดใน Inspector
3. **ใส่ฟังก์ชัน (Data binding):** ใน Inspector เลือก widget → ส่วน "Data binding"
   - `source`: `clock` / `crypto` / `weather` / `device`
   - `path`: เช่น `BTCUSDT.price`, `hhmm`
   - `format`: เช่น `$%s`
   - widget ที่ผูกข้อมูลจะมีไอคอน ⛓ และตอนรันบนจอจะแสดงค่าจริง
4. **ทดสอบในเว็บ:** กดปุ่ม **▶ Simulate** — artboard จะแสดงข้อมูลจำลอง (ราคา/เวลา/กราฟแท่งเทียน) เหมือนบนจอจริง
5. กด **Publish…** → ระบบ validate กับ schema ของจอ + ดาวน์โหลด `layout.json` + แสดงขั้นตอนส่งขึ้นจอ

## 2. ขั้นตอนให้หน้าไปปรากฏบนแต่ละจอ

```
ออกแบบใน Builder
   │  Publish (validate + layout.json)
   ▼
package:  python3 firmware/tools/make_package.py <dir> bundle.zip   (สร้าง manifest + sha256)
   │
   ▼
POST /api/v1/payloads/publish     (อัปโหลด bundle + manifest -> เก็บใน object store)
   │
   ▼
assign:  POST /api/v1/devices/{id}/assign   หรือ  ขายผ่าน Store
   │  server ส่ง MQTT cmd:sync ไปยังจอ
   ▼
จอดาวน์โหลด bundle -> ตรวจ sha256 -> สลับหน้าใหม่ทันที (zero-flash, ไม่ต้อง reflash)
```

> หมายเหตุ: การโฮสต์ bundle ใช้ object store (MinIO/S3) ซึ่งเปิดในเฟส M5 — ตอนนี้ publish จะ validate + บันทึก layout ให้ก่อน

## 3. ระบบจ่ายเงิน & สิทธิ์เข้าถึงหน้า (per user)

| สิ่งที่ดู | ที่ไหน |
|---|---|
| ใครจ่าย/ซื้ออะไร | เว็บ **Users** → คลิก user → "Pages owned" (มาจากตาราง `Entitlement`) |
| ราคา/เปิด-ปิดขายหน้า | เว็บ **Store** (admin) → แก้ราคา / Published |
| user ซื้อเอง | แอปมือถือ → Store → ปุ่มราคา → Stripe Checkout |

**ขั้นตอนเงินไหล (Stripe):**
```
user กดซื้อในแอป -> POST /api/v1/store/checkout -> Stripe Checkout URL
   -> จ่ายเงิน -> Stripe webhook checkout.session.completed
   -> server สร้าง Entitlement(user × item)  (สิทธิ์เข้าถึงหน้านั้น)
   -> push MQTT cmd:sync ให้จอของ user ดาวน์โหลดหน้าที่ซื้อ
```
- **admin แจกฟรีได้:** Users → user → "+ grant <page>" (Entitlement source = GIFT) / ถอนด้วย "Revoke"
- ตั้ง Stripe จริงใน `server/.env` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) — ถ้ายังไม่ตั้ง ปุ่มซื้อจะขึ้น "coming soon"

## 4. ฟีเจอร์เสริมที่ต้องให้แอดมินอนุมัติ (manual)

ตัวอย่าง: **Price Alerts ของหน้า Crypto**

```
user ตั้ง alert ในแอป -> "Submit for admin approval"
   -> POST /api/v1/me/feature-requests   (status = PENDING)
   -> เข้าคิวที่เว็บ Admin หน้า "Approvals"
   -> แอดมินกด Approve
       -> server merge alert config เข้า settings ของจอ + bump version
       -> push MQTT settings -> จอเปิดใช้ alert ทันที
   -> ถ้า Reject: ไม่ส่งอะไรไปจอ
```

- ดูคิวอนุมัติ: เว็บ **Approvals** (กรอง PENDING / APPROVED / REJECTED)
- API: `GET /api/v1/admin/feature-requests`, `POST .../{id}/approve|reject`
- บนจอ: หน้า alert มีปุ่ม **Snooze 5 นาที** และ **Stop** (ปิด alert นั้น)

## 5. บัญชี & สิทธิ์ (RBAC)

- ล็อกอินด้วยอีเมล (รหัส OTP) ทั้งเว็บและแอป — ยืนยันผ่าน Supabase
- อีเมลใน `ADMIN_EMAILS` (`server/.env`) = **admin** (ปัจจุบัน `mycryptoclock@gmail.com`) เห็นเมนู Users/Approvals + จัดการ Store
- user ทั่วไป: เห็นเฉพาะหน้า/สิทธิ์ของตัวเอง (`GET /api/v1/auth/me` คืน entitlements)
- endpoint admin ทั้งหมดป้องกันด้วย `AdminGuard` (401 ถ้าไม่ล็อกอิน, 403 ถ้าไม่ใช่ admin)
