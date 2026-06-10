# Builder, การส่งหน้าไปยังจอ, ระบบจ่ายเงิน & สิทธิ์

## 1. ออกแบบหน้าใน Builder (`/builder`)

1. **เลือก template** จากดรอปดาวน์ "Load template…" (Clock / Crypto / Welcome / Blank) — โหลดหน้าเดิมมาเป็นจุดเริ่ม
2. ลาก widget จาก palette ลง artboard (480×320) ปรับตำแหน่ง/ขนาดใน Inspector
3. **ใส่ฟังก์ชัน (Data binding):** ใน Inspector เลือก widget → ส่วน "Data binding"
   - `source`: `clock` / `crypto` / `weather` / `device`
   - `path`: เช่น `BTCUSDT.price`, `hhmm`
   - `format`: เช่น `$%s`
   - widget ที่ผูกข้อมูลจะมีไอคอน ⛓ และตอนรันบนจอจะแสดงค่าจริง
4. **กำหนดแหล่งข้อมูล (Data Sources):** แผงล่างของ Builder ระบุ `id`, `stream`, `format`
   - ตัวอย่าง `id=crypto`, `stream=market.BTCUSDT.ticker`, `format=json`
   - `id` นี้คือชื่อที่ widget binding ใช้เป็น `source`
5. **กำหนด WASM Logic:** กด **Edit Logic** เพื่อเขียน Rust source ของหน้านี้ในเว็บ หรือใช้แผงล่างเพื่อระบุ module `id`, `path`, `tick_ms`, `memory_kb`, และ `canvas_ids`
   - ตัวอย่าง `id=logic`, `path=wasm/rust-ticker.wasm`, `tick_ms=1000`, `memory_kb=256`
   - firmware โหลด module แล้วเรียก lifecycle ตาม `schema/abi/ccp_abi_v1.md`
   - ปุ่ม **Compile Rust** จะเรียก API `POST /api/v1/payloads/compile-wasm` ให้ server compile เป็น `wasm/logic.wasm` พร้อม `sha256`
6. **ทดสอบในเว็บ:** กดปุ่ม **▶ Simulate** — artboard จะแสดงข้อมูลจำลอง (ราคา/เวลา/กราฟแท่งเทียน/ปุ่ม LED toggle) เหมือนบนจอจริง
   - กลับมาแก้ property/logic ด้วยปุ่ม **Edit**
   - เลือก widget จากแผง **Layers** ได้เสมอ แม้กำลัง simulate
7. กด **Publish…** → ระบบ validate กับ schema ของจอ, zip `layout.json` + compiled wasm, สร้าง manifest/hash, บันทึก `PayloadVersion`, และเปิด bundle URL สำหรับ ESP32 ดาวน์โหลดแบบ zero-flash

### Rust WASM quick start

ตัวอย่าง Rust อยู่ที่ `wasm-apps/examples/rust-ticker/` เป็น `no_std` module ที่ export
`ccp_on_init`, `ccp_on_tick`, `ccp_on_data`, `ccp_on_event`, `ccp_on_destroy`,
`ccp_malloc`, `ccp_free` ตาม ABI v1

```sh
cd wasm-apps/examples/rust-ticker
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
```

ถ้าเครื่องใช้ Homebrew `rustc` เป็น default แล้ว cargo หา target ไม่เจอ ให้บังคับ rustc ของ rustup:

```sh
RUSTC=$HOME/.rustup/toolchains/1.79.0-aarch64-apple-darwin/bin/rustc \
  $HOME/.rustup/toolchains/1.79.0-aarch64-apple-darwin/bin/cargo build \
  --release --target wasm32-unknown-unknown
```

## 1.1 ตัวอย่าง logic: ปุ่ม 2 ปุ่ม + LED 2 ดวง

ตัวอย่างพร้อมลองอยู่ใน Builder template **LED Toggle** และโค้ดจริงอยู่ที่
`wasm-apps/examples/led-toggle/`

ถ้าต้องแก้ logic เฉพาะหน้านี้ ไม่ต้องแก้ไฟล์โปรเจค:

1. เปิด `/builder`
2. เลือก template **LED Toggle**
3. กด **Edit Logic**
4. แก้ Rust source ใน textarea
5. กด **Compile Rust**
6. ถ้า compile ผ่าน Builder จะผูก `wasm/logic.wasm` เข้า layout ให้อัตโนมัติ
7. กด **Publish…** เพื่อสร้าง bundle ที่ ESP32 จะดึงผ่าน `cmd:sync`

## Logic model ที่ Builder ใช้

Builder แยก logic เป็น 3 ชั้น:

| ต้องการทำอะไร | ใช้อะไรใน Builder | ต้องเขียน WASM ไหม |
|---|---|---|
| กดแล้วเปลี่ยนสี/text/value/visible ของ widget อื่น | `Actions / Logic` → `widget.set` | ไม่ต้อง |
| กดแล้วเปลี่ยนหน้า | `Actions / Logic` → `page.show` | ไม่ต้อง |
| กดแล้วส่ง event ไป server ผ่าน MQTT | `Actions / Logic` → `mqtt.publish` | ไม่ต้อง |
| รับ MQTT/API จาก server แล้วเอาค่ามาแสดง | `Data Sources` + widget `Data Binding` | ไม่ต้อง |
| มี if/loop/state ซับซ้อน, วาด canvas, คำนวณเอง | `wasm.event` + Rust WASM | ต้อง |

ตัวอย่าง no-code action:

- เปลี่ยนข้อความ label: `do=widget.set`, `widget=label_1`, `property=text`, `value=Hello`
- เปลี่ยนสี widget: `do=widget.set`, `widget=led_1`, `property=style.bg_color`, `value=#F6465D`
- ซ่อน widget: `do=widget.set`, `widget=panel_1`, `property=visible`, `value=0`
- ส่ง MQTT: `do=mqtt.publish`, `topic=button`, `payload={"button":"A"}`

ตัวอย่างรับข้อมูลจาก server/MQTT/API:

1. เพิ่ม Data Source: `id=price`, `stream=market.BTCUSDT.ticker`, `format=json`
2. เลือก label ที่ต้องการให้แสดงราคา
3. เพิ่ม Data Binding:
   - `target=text`
   - `source=price`
   - `path=$.last`
   - `format=$%,.2f`
4. ถ้า server ส่ง payload เช่น `{"last": 104500.25, "color": "#0ECB81"}` เข้าสตรีมนี้ widget จะ update เอง
5. ถ้าต้องเปลี่ยนสีจากข้อมูลเดียวกัน เพิ่ม binding อีกอัน:
   - `target=style.text_color`
   - `source=price`
   - `path=$.color`

ข้อมูลจาก API ภายนอกควรให้ server เป็นตัวดึง แล้ว publish เป็น MQTT/data stream ลง device.
ตัวจอไม่ควรเรียก API เยอะเองถ้าไม่จำเป็น เพราะต้องคุม rate limit, token, cache, และ offline behavior.

### Layout contract

- widget `led_1` = LED ดวงซ้าย
- widget `led_2` = LED ดวงขวา
- widget `btn_1` มี action `clicked -> wasm.event`, `target=logic`, `event_id=101`
- widget `btn_2` มี action `clicked -> wasm.event`, `target=logic`, `event_id=102`
- WASM module `logic` ใช้ path `wasm/led-toggle.wasm`

แก้ว่า “ปุ่มไหนเรียก logic อะไร” ได้ที่ Builder โดยกด **Edit** แล้วเลือกปุ่มบน artboard
หรือเลือกจากแผง **Layers** จากนั้นดูแผง
**Inspector → Actions / Logic**:

- `on` = event จาก widget เช่น `clicked`
- `do` = สิ่งที่จะทำ เช่น `wasm.event`
- `target` = id ของ WASM module เช่น `logic`
- `event id` = เลขที่ส่งเข้า `ccp_on_event(...)` เช่น `101` หรือ `102`

### Logic ฝั่ง Rust

หลักการคือ firmware ส่ง event จากปุ่มเข้า `ccp_on_event(...)` แล้ว Rust toggle state ในตัวเอง:

```rust
const EVT_LED_1: u32 = 101;
const EVT_LED_2: u32 = 102;

#[no_mangle]
pub extern "C" fn ccp_on_event(_widget: i32, event: u32, _p0: i32, _p1: i32) {
    unsafe {
        match event {
            EVT_LED_1 => {
                LED_1_ON = !LED_1_ON;
                set_led(LED_1, LED_1_ON, 0xFF0ECB81);
            }
            EVT_LED_2 => {
                LED_2_ON = !LED_2_ON;
                set_led(LED_2, LED_2_ON, 0xFFF0B90B);
            }
            _ => {}
        }
    }
}
```

### วิธีลอง

1. เปิด `/builder`
2. เลือก template **LED Toggle**
3. กด **Simulate**
4. คลิก `Toggle LED 1` หรือ `Toggle LED 2` เพื่อดู LED ติด/ดับในเว็บก่อน publish
5. กด **Edit Logic** → **Compile Rust** เพื่อ build เป็น `wasm/logic.wasm`
6. กด **Publish…** เพื่อสร้าง `PayloadVersion` และ bundle URL
7. ตั้งราคาและเปิดขายในหน้า Store หรือ assign `PayloadVersion` ให้เครื่องโดยตรง

## 1.2 Flow ขายจริง + admin อนุญาตเครื่อง

แนวคิดที่ควรใช้กับ feature/page ที่เสียเงินจริง:

```text
Builder -> validate layout -> publish PayloadVersion
Admin Store -> สร้าง/แก้ MarketplaceItem -> ตั้งราคา -> Published
User จ่ายเงินผ่าน Stripe -> server grant Entitlement(user x item)
Admin ตรวจ Users -> เลือก user/device -> grant หรือ assign package ให้เครื่องที่อนุญาต
Server POST /devices/{deviceDbId}/assign -> MQTT cmd:sync -> เครื่องโหลดหน้า
```

**Entitlement เป็นระดับ `device x item` (per-CryptoClock) แล้ว** — ตาราง `Entitlement`
มี `deviceId` (unique `[deviceId,itemId]`). ซื้อ/ปลดล็อกครั้งหนึ่งติดเฉพาะเครื่องนั้น
ไม่ลามไปทุกเครื่องของ user. catalog (pages + features) ถูก seed ลง `MarketplaceItem`
ตอน server boot โดยมี `kind = PAGE | FEATURE`.

## 2. ขั้นตอนให้หน้าไปปรากฏบนแต่ละจอ

```
ออกแบบใน Builder
   │  Edit Logic/Compile Rust (optional)
   │  Publish (validate + bundle.zip + manifest + PayloadVersion)
   ▼
POST /api/v1/payloads/publish-compiled
   │  server stores: storage/payloads/<package>/<version>/bundle.zip
   │
   ▼
assign:  POST /api/v1/devices/{id}/assign   หรือ  ขายผ่าน Store
   │  server ส่ง MQTT cmd:sync ไปยังจอ
   ▼
จอดาวน์โหลด bundle -> ตรวจ sha256 -> สลับหน้าใหม่ทันที (zero-flash, ไม่ต้อง reflash)
```

> หมายเหตุ: local dev ตอนนี้ API โฮสต์ bundle จาก filesystem แล้ว (`PAYLOAD_STORAGE_DIR` หรือ `server/apps/api/storage` ตาม cwd ตอนรัน). Production ยังควรย้าย bundle ไป MinIO/S3 + presigned URL เพื่อ scale และควบคุมสิทธิ์ดาวน์โหลด.

## 3. จ่ายเงิน & สิทธิ์ — ผูกกับ "เครื่อง" (per-CryptoClock)

สิทธิ์ทุกอย่างผูกกับ **เครื่องใดเครื่องหนึ่ง** ไม่ใช่ user แบบเหมารวม. user ที่มี 2 เครื่อง
ต้องเลือกเครื่อง (ในแอปจะมี device picker) แล้วซื้อ/ปลดล็อกแยกทีละเครื่อง.

| สิ่งที่ดู | ที่ไหน |
|---|---|
| เครื่องไหนมีสิทธิ์อะไร | เว็บ **CryptoClock** (`/`) → การ์ดเครื่อง → ป้าย Rights / ปุ่ม **Rights** (grant/revoke) |
| user คนไหนซื้ออะไรให้เครื่องไหน | เว็บ **Users** → คลิก user → "Rights per device" |
| ราคา/เปิด-ปิดขาย | เว็บ **Store** (admin) → แก้ราคา / Published |
| user ซื้อเอง | แอป → เลือกเครื่อง → ฟีเจอร์ที่ล็อกจะเทาๆ + ราคา + ปุ่ม **Unlock** → Stripe |

**ขั้นตอนเงินไหล (Stripe, per-device):**
```
user เลือกเครื่อง + กดซื้อ -> POST /api/v1/store/checkout {slug, deviceId}
   -> Stripe Checkout (metadata: slug, deviceId, userId)
   -> webhook checkout.session.completed
   -> server สร้าง Entitlement(deviceId × item)
   -> devices.syncEntitlements: เขียน settings.entitlements ของเครื่องนั้น + push MQTT
   -> เครื่องเปิดใช้สิทธิ์ทันที (และดาวน์โหลด bundle ถ้าเป็น PAGE)
```
- **admin แจก/ถอนต่อเครื่อง:** `/` → Rights modal (Grant/Revoke) หรือ `/users` → Rights per device
- API: `POST /devices/{hwId}/grant|revoke {slug}` · `GET /devices/{hwId}/entitlements`
- ตั้ง Stripe จริงใน `server/.env` — ถ้ายังไม่ตั้ง ปุ่ม Unlock จะบอกให้ admin อนุมัติแทน

## 4. ฟีเจอร์เสริมต้องให้แอดมินอนุมัติ (manual) — ผูกเครื่อง

ตัวอย่าง: **Price Alerts ของหน้า Crypto** (slug `crypto-alerts`, kind FEATURE)

```
user เลือกเครื่อง -> ฟีเจอร์ alert ล็อกอยู่ (เทาๆ + ราคา + ปุ่ม Request approval / Unlock)
   กด "Request approval"
   -> POST /api/v1/me/feature-requests {deviceId, page:crypto, feature:alerts}  (PENDING)
   -> เข้าคิวเว็บ Admin หน้า "Approvals"
   -> แอดมิน Approve
       -> server สร้าง Entitlement(deviceId × crypto-alerts)  ← เก็บใน DB
       -> syncEntitlements: settings.entitlements = [...,"crypto-alerts"] + push MQTT
   -> เครื่อง self-gate: firmware เปิด alert เฉพาะเมื่อมี "crypto-alerts" ใน entitlements
   -> ถ้า Reject: ไม่ให้สิทธิ์, เครื่องไม่เปิด alert
```

- **การตรวจสิทธิ์อยู่ 2 จุด:** (1) แอปอ่าน `GET /devices/{id}/entitlements` → ฟีเจอร์ที่ไม่มี
  ขึ้นเทา + ปุ่มซื้อ/ขออนุมัติ; (2) firmware อ่าน `settings.entitlements` เอง → ไม่เปิดฟีเจอร์ที่ไม่มีสิทธิ์
  (พิสูจน์แล้ว: มี `crypto-alerts` → alert ทำงาน, ไม่มี → ไม่ทำงาน)
- คิวอนุมัติ: เว็บ **Approvals** · API `GET /admin/feature-requests`, `POST .../{id}/approve|reject`
- บนจอ: หน้า alert มีปุ่ม **Snooze 5 นาที** และ **Stop**

## 5. บัญชี & สิทธิ์ (RBAC)

- ล็อกอินด้วยอีเมล ทั้งเว็บและแอป — ยืนยันผ่าน Supabase. เว็บรับทั้งลิงก์ในอีเมล
  (จับ token จาก URL hash อัตโนมัติ) และรหัส OTP. ลิงก์ใช้ครั้งเดียว/หมดอายุ —
  ถ้าเจอ `otp_expired` ให้ขอลิงก์ใหม่แล้วคลิกครั้งเดียว.
- อีเมลใน `ADMIN_EMAILS` (`server/.env`) = **admin** (`mycryptoclock@gmail.com`) เห็น Users/Approvals/Store/CryptoClock management; endpoint admin ถูกกันด้วย `AdminGuard`.
- user ทั่วไป: `GET /api/v1/auth/me` คืน devices + entitlements ราย device.
- endpoint admin ทั้งหมดป้องกันด้วย `AdminGuard` (401 ถ้าไม่ล็อกอิน, 403 ถ้าไม่ใช่ admin)
