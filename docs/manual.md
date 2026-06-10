# คู่มือ CryptoClock Pro (ฉบับผู้ใช้และผู้ดูแล)

## 1. ตัวแปรที่ต้องตั้งก่อนใช้งาน

แก้ที่ไฟล์เดียว: **[firmware/main/user_config.h](../firmware/main/user_config.h)**

| ตัวแปร | ความหมาย | ค่าเริ่มต้น |
|---|---|---|
| `CCP_CFG_MQTT_BROKER_URI` | IP/พอร์ตของ MQTT broker (เครื่องที่รัน server) | `mqtt://192.168.1.100:1883` |
| `CCP_CFG_SERVER_BASE_URL` | URL ของ Hub API | `http://192.168.1.100:4000` |
| `CCP_CFG_TZ_OFFSET_MIN` | timezone (ไทย = 420) | `420` |
| `CCP_CFG_CRYPTO_SYMBOL` | คู่เหรียญหน้า 2 (รูปแบบ Binance) | `BTCUSDT` |
| `CCP_CFG_DEFAULT_BRIGHTNESS` | ความสว่างเริ่มต้น 0-100 | `80` |

แก้แล้ว build + flash ใหม่:
```bash
source ~/esp/esp-idf/export.sh
cd firmware && idf.py build flash
```
> ไม่อยาก flash ใหม่? ทุกค่า override ได้จากไฟล์ `device.json` บน SD card (ข้อ 3) หรือผ่านแอปมือถือ/LAN API (ข้อ 5)

## 2. การใช้งานครั้งแรก (WiFi Setup)

1. เปิดเครื่อง → เห็นหน้า **Welcome** แล้วเข้าหน้า **WiFi Setup** อัตโนมัติ (ถ้ายังไม่เคยตั้ง WiFi)
2. มือถือสแกน QR บนจอ (หรือต่อ WiFi ชื่อ `CCP-Setup-XXXX`)
3. เปิด `http://192.168.4.1` → กรอกชื่อ/รหัส WiFi บ้าน → Save
4. เครื่องรีบูตและต่อ WiFi เอง → เข้าหน้า Home

รีเซ็ต WiFi ภายหลัง: เปิดเมนู (ปุ่มมุมขวาบน) → กดค้างที่ **Reset WiFi**

## 3. หน้าจอ Default 3 หน้า + SD Card

**ปัดซ้าย/ขวา** เพื่อเปลี่ยนหน้า · **ปุ่ม ≡ มุมขวาบน** เปิดเมนู (เปลี่ยนหน้า/ความสว่าง/ข้อมูลเครื่อง/รีเซ็ต WiFi)

| หน้า | สิ่งที่แสดง | โฟลเดอร์ asset บน SD |
|---|---|---|
| 1. Clock | นาฬิกาใหญ่ + วันที่ + การ์ดโปรไฟล์ (avatar+ชื่อ) | `/pages/clock/assets/avatar.png` (สี่เหลี่ยมจัตุรัส) |
| 2. Crypto | ราคาเหรียญสด (Binance ทุก 5 วิ) + กราฟ + %24h | `/pages/crypto/assets/` |
| 3. Slideshow | วนรูป PNG/JPG **320x240** ทุก 5 วิ พร้อม fade — ครบทุกรูปกลับหน้า 1 | `/pages/slideshow/assets/*.png` (สูงสุด 8 รูป) |

### โครงไฟล์ SD card
```
/config/device.json            <- config หลักของเครื่อง
/pages/clock/config.json       <- override เฉพาะหน้า (ไม่บังคับ)
/pages/clock/assets/avatar.png
/pages/crypto/config.json      <- เช่นเปลี่ยนเป็น ETH
/pages/slideshow/assets/1.png 2.png 3.png
/packages/...                  <- ระบบ sync จาก server ใช้เอง (อย่าแก้มือ)
```

### ตัวอย่าง `/config/device.json`
```json
{
  "pages": ["clock", "crypto", "slideshow"],
  "tz_offset_min": 420,
  "brightness": 80,
  "profile": { "name": "Natthapong", "title": "CryptoClock Pro" },
  "crypto": { "symbol": "ETHUSDT", "display": "ETH/USDT" },
  "slideshow": { "interval_s": 5, "return_to_first": true }
}
```
ลำดับการอ่าน config ตอนเปิดเครื่อง: ค่าใน `user_config.h` → `/lfs/config/device.json` (ในเครื่อง) → **SD `/config/device.json`** → `/pages/<หน้า>/config.json` (ทับเป็นรายหน้า) — และ sync จาก server ทับได้อีกชั้นเมื่อออนไลน์

## 4. รัน Server บนเครื่องตัวเอง (local)

**ได้ครับ** — มี 2 ทาง:

### ทาง A: Docker (แนะนำ — ครบทุกตัวในคำสั่งเดียว)
```bash
# ติดตั้ง Docker Desktop ก่อน: https://docker.com/products/docker-desktop
cd server && cp .env.example .env
docker compose up -d        # Postgres + Redis + EMQX + MinIO
pnpm install
pnpm --filter @ccp/api exec prisma migrate dev
pnpm dev                    # API :4000 / เว็บ Builder :3000
```

### ทาง B: ไม่ใช้ Docker (Homebrew)
```bash
brew install postgresql@16 redis mosquitto
brew services start postgresql@16 redis mosquitto
createdb cryptoclock && createuser ccp
# แก้ DATABASE_URL ใน server/.env ให้ตรง แล้ว:
cd server && pnpm install
pnpm --filter @ccp/api exec prisma migrate dev
pnpm dev
```
> ทาง B ใช้ mosquitto แทน EMQX (พอร์ต 1883 เท่ากัน — จอใช้ได้เลย) และยังไม่มี MinIO (ระบบ marketplace bundle ใช้ตอน M5)

จากนั้นตั้ง `CCP_CFG_MQTT_BROKER_URI` ในข้อ 1 ให้ชี้ IP เครื่องคุณ (ดู IP ด้วย `ipconfig getifaddr en0`)

## 5. LAN API (สำหรับแอปมือถือ / curl)

เมื่อจอต่อ WiFi แล้ว จะเปิด API ในวง LAN + ประกาศตัวเองผ่าน mDNS (`_ccp._tcp`):

```bash
curl http://ccp-983daee91478.local/api/v1/info
curl http://<IP จอ>/api/v1/config
curl -X POST http://<IP จอ>/api/v1/config -d @device.json
curl -X POST http://<IP จอ>/api/v1/brightness -d '{"value":50}'
curl -X POST http://<IP จอ>/api/v1/identify          # บี๊บหาเครื่อง
curl -X POST http://<IP จอ>/api/v1/wifi/reset
```

## 6. ดู log / แก้ปัญหา

| อาการ | วิธีแก้ |
|---|---|
| จอดำ | เช็คไฟเข้า → ดู log (`idf.py -p /dev/cu.usbmodem* monitor`) — จอรุ่นนี้ console ออกทาง USB เดียวกับที่ flash |
| ไม่เห็นรูป slideshow | รูปต้องเป็น PNG/JPG ใน `/pages/slideshow/assets/` และ SD เป็น FAT32 |
| ราคาเหรียญไม่ขึ้น | ต้องต่อ WiFi ก่อน · เช็ค symbol ให้ตรงรูปแบบ Binance (BTCUSDT) |
| เวลาไม่ตรง | รอ SNTP sync ~10 วิหลังต่อเน็ต · เช็ค `tz_offset_min` |
| SD อ่านไม่ได้ | format FAT32, ลองการ์ดอื่น (บางการ์ดไม่ compatible กับ SDMMC 1-bit) |

## 7. แอป Android

ดู [mobile/README.md](../mobile/README.md) — มี 2 แอป (Flutter):
- **user-app**: ค้นหาจอในวง LAN (mDNS) + ตั้งค่า WiFi/หน้า/ความสว่าง
- **admin-app**: จัดการ fleet ผ่าน Hub API + ส่งคำสั่ง (sync/reboot/lock)
