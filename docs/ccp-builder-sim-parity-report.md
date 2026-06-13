# รายงานตรวจ Builder / Simulate / CCP Parity

วันที่ตรวจ: 2026-06-13 18:08 +07  
อุปกรณ์ที่ตรวจ: `ccp-983daee91478` (`CryptoClock จอทดสอบ`)  
ต่อไปในเอกสารนี้เรียก CryptoClockPro ว่า `CCP`

## สรุปผู้บริหาร

| เรื่องที่ตรวจ | ผลตรวจ |
|---|---|
| หน้า Builder ที่ publish แล้วทั้งหมด | Web Simulate เปิดได้ทุกหน้าที่ตรวจ ไม่มี console error หลัก |
| หน้าที่แสดงจริงบน CCP ตอนตรวจ | `clock`, `crypto`, `slideshow`, `profile` |
| package ที่ active จริงบน CCP | `com.ccp.profile@1.0.1` |
| package ที่อยู่บน SD แต่ไม่แสดงตอนนี้ | `com.ccp.weather@1.4.9` มีไฟล์และ GIF asset ครบ แต่ไม่ได้เป็น active package |
| จุดไม่ตรงหลักระหว่าง Sim กับ CCP | CCP firmware แสดง Builder package ได้ทีละ 1 active package; ตอนนี้ active คือ `profile` ดังนั้น `weather` อยู่ใน settings แต่ถูก skip จากหน้า swipe |
| Profile page parity | ตำแหน่ง/ขนาดบน CCP ตรงกับ layout; ค่า text ใน Sim default ไม่ตรง เพราะ Sim ยังไม่ auto-feed `settings.profile` จาก device |
| Weather page parity | Sim แสดง layout/GIF ได้ และ asset อยู่บน CCP แล้ว แต่ยังไม่ได้แสดงจริงใน rotation เพราะ active package เป็น `profile` |
| Crypto coin setting | ค่า config บน CCP มี 4 เหรียญจริง: `BTCUSDT`, `ETHUSDT`, `BNBUSDT`, `DOGEUSDT`; เป็น native page จึงไม่มี Builder Sim ให้เทียบ |
| รูป/GIF | Weather GIF asset ครบใน package; Slideshow มี `sample1.png`-`sample3.png`; Clock มี `logo.png`; Crypto ไม่มี coin logo PNG บน SD ตอนตรวจ มีแค่ `alert.wav` |

## วิธีตรวจ

| ฝั่ง | วิธีที่ใช้ |
|---|---|
| Web Admin / Builder | เปิด `localhost:3000`, load saved Builder pages, กด Simulate, ตรวจ artboard 480x320, widget, asset, console |
| API / DB | ตรวจ device settings, entitlements, active payload, published payload versions, marketplace items |
| AppUser | อ่านโค้ด Flutter user app ว่าหน้า setting/store ส่งค่าอะไรไปที่ CCP และ Hub |
| CCP / ESP32 native | ต่อ serial debug ที่ `/dev/cu.usbmodem21301`, ใช้คำสั่ง `ver`, `pages`, `widgets`, `ls`, `cat`, `heap` แบบอ่านอย่างเดียว |
| Firmware renderer | อ่านโค้ด `home_ui` และ `ui_renderer` เพื่อยืนยันว่า layout จาก Builder ถูกวางบนจออย่างไร |

## สถานะจริงบน CCP

Serial debug ล่าสุด:

```text
ver
fw=7d0060e-dirty
package=com.ccp.profile@1.0.1
dir=/sd/packages/com.ccp.profile/1.0.1
sd=yes
```

```text
pages
pages(4) current=0:
  [0]clock *
  [1]crypto
  [2]slideshow
  [3]profile (pkg)
```

ค่า config จริงบน CCP:

```json
{
  "clock": { "theme": "neon" },
  "owner": { "email": "mycryptoclock@gmail.com" },
  "pages": ["clock", "crypto", "slideshow", "weather", "calendar", "profile"],
  "crypto": {
    "style": "chart",
    "symbols": ["BTCUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT"],
    "currency": "USD",
    "timeframe": "15m",
    "fetch_interval_s": 10
  },
  "display_mode": "static",
  "entitlements": ["weather", "calendar", "profile"],
  "profile": {
    "nickname": "HAL FINNEY",
    "role": "(SAT) CYPHERPUNK",
    "name_color": "#F0B90B",
    "show": true
  }
}
```

หมายเหตุสำคัญ: settings มี `weather` และ `calendar` อยู่ใน `pages` แต่ serial `pages` แสดงแค่ `profile` เป็น package page เพราะ firmware รับ active package ได้ทีละตัวเท่านั้น และตอนนี้ active คือ `com.ccp.profile`.

## ตารางตรวจหน้า Builder ที่ publish แล้ว

| Package | Version ล่าสุด | Widget / asset | Store item | อยู่บน CCP SD | แสดงจริงบน CCP ตอนตรวจ | Web Simulate | ผลเทียบ Sim vs CCP |
|---|---:|---|---|---|---|---|---|
| `com.ccp.profile` | `1.0.1` | 4 labels + WASM + settings schema | `profile` published | มี | แสดงจริง | ผ่าน | ทำงานจริง แต่ Sim default ไม่ดึงค่า device settings จึงแสดง `SATOSHI NAKAMOTO` แทน `HAL FINNEY` ถ้าไม่ป้อน stream เอง |
| `com.ccp.weather` | `1.4.9` | 7 widgets + 7 GIF assets + WASM | `weather` published และมี duplicate draft `com-ccp-weather` | มี | ไม่แสดงตอนนี้ | ผ่าน | Sim ผ่านและ asset อยู่บน SD แต่ CCP ไม่โชว์เพราะ active package เป็น `profile` |
| `com.ccp.webtest290533` | `1.0.0` | LED demo 5 widgets + WASM | `com-ccp-webtest290533` published | ไม่มี | ไม่แสดง | ผ่าน | Publish แล้ว แต่ไม่ได้ install/active บน CCP |
| `com.ccp.test-led` | `1.0.0` | LED demo 5 widgets + WASM | ไม่พบ marketplace item | ไม่มี | ไม่แสดง | ผ่าน | Publish เป็น payload แต่ไม่มี store item ให้ grant/install ตาม flow ปกติ |
| `com.ccp.my-page` | `1.0.0` | button + label | `com-ccp-my-page` draft | ไม่มี | ไม่แสดง | ผ่าน | Publish แล้ว แต่ store item ยัง draft และไม่ได้ install บน CCP |
| `com.ccp.apisaved678991` | `1.0.0` | 2 labels | `com-ccp-apisaved678991` draft | ไม่มี | ไม่แสดง | ผ่าน | Publish แล้ว แต่ store item ยัง draft และไม่ได้ install บน CCP |

## ตารางตรวจหน้าที่อยู่ใน CCP rotation

| หน้า | ชนิด | แหล่ง layout | แสดงบน CCP | เทียบกับ Web Simulate | สถานะจริง |
|---|---|---|---|---|---|
| `clock` | native firmware | `firmware/components/home_ui/home_ui.c` | ใช่ | ไม่มี Builder Sim เพราะไม่ใช่ Builder page | ทำงานเป็น native page; มี `logo.png` บน SD |
| `crypto` | native firmware | `firmware/components/home_ui/home_ui.c` | ใช่ | ไม่มี Builder Sim เพราะไม่ใช่ Builder page | config เหรียญทำงานระดับ settings; coin logo PNG ยังไม่มีบน SD ตอนตรวจ |
| `slideshow` | native firmware | `firmware/components/home_ui/home_ui.c` | ใช่ | ไม่มี Builder Sim เพราะไม่ใช่ Builder page | มีรูป `sample1.png`, `sample2.png`, `sample3.png` บน SD |
| `profile` | Builder package | `/sd/packages/com.ccp.profile/1.0.1/layout.json` | ใช่ | มี Sim | layout ตรงจริง; data setting ใน Sim ยังไม่ auto-seed จาก CCP |
| `weather` | Builder package | `/sd/packages/com.ccp.weather/1.4.9/layout.json` | ไม่ใช่ตอนนี้ | มี Sim | install อยู่ แต่ไม่ active จึงไม่เข้า rotation |
| `calendar` | entitlement/page id | ไม่พบ payload package | ไม่ใช่ | ไม่มี Sim ที่ตรวจ | อยู่ใน settings/entitlement แต่ไม่มี active/installed package ให้แสดง |

## รายละเอียดรายหน้า

### 1. Profile (`com.ccp.profile@1.0.1`)

สถานะ: ทำงานจริงบน CCP

Serial `widgets` ยืนยันตำแหน่ง/ขนาด/font line-height บน CCP:

```text
widgets(4) base=/sd/packages/com.ccp.profile/1.0.1:
  verify label @230,24 230x24 lh=22 "DON'T TRUST VERIFY"
  time   label @230,54 230x92 lh=58 "18:08"
  name   label @18,210 444x36 lh=30 "HAL FINNEY"
  role   label @18,250 444x26 lh=22 "(SAT) CYPHERPUNK"
```

| จุดตรวจ | ผล |
|---|---|
| ตำแหน่ง widget | ตรงกับ layout จริงบน CCP เพราะ firmware ใช้ `lv_obj_set_pos(x,y)` จาก `layout.json` |
| ขนาด widget | ตรงกับ layout จริงบน CCP เพราะ firmware ใช้ `lv_obj_set_size(w,h)` |
| ฟอนต์ | ใช้ font mapping บน CCP ได้จริง; serial เห็น line-height `22`, `58`, `30`, `22` |
| ค่า profile | CCP แสดง `HAL FINNEY` และ `(SAT) CYPHERPUNK` จาก config จริง |
| Web Simulate default | แสดงค่า default ของ page (`SATOSHI NAKAMOTO`, `(SAT) FOUNDER`) ถ้าไม่ได้ feed `settings.profile` เอง |
| สรุป parity | layout ตรง, data ไม่ตรงใน Sim default เพราะ Sim ยังไม่โหลด device settings |

สาเหตุที่ Sim default ไม่ตรง: Browser Sim feeder มี auto-feed สำหรับ time / Binance / fx / weather / mock แต่ stream `settings.profile` เป็น manual stream ดังนั้นหน้า Profile ใน Sim ไม่รู้ค่า config จริงของ CCP เว้นแต่ผู้ใช้ป้อน payload เอง

payload ที่ต้องป้อนใน Sim เพื่อให้ตรง CCP:

```json
{
  "nickname": "HAL FINNEY",
  "role": "(SAT) CYPHERPUNK",
  "name_color": "#F0B90B",
  "show": true
}
```

### 2. Weather (`com.ccp.weather@1.4.9`)

สถานะ: Simulate ผ่าน, package และ GIF asset อยู่บน CCP, แต่ยังไม่แสดงจริงตอนตรวจ

ไฟล์บน CCP:

```text
/sd/packages/com.ccp.weather/1.4.9/
  layout.json
  wasm
  assets/
    clear.gif
    partly.gif
    cloudy.gif
    rain.gif
    thunder.gif
    snow.gif
    fog.gif
  manifest.json
```

| จุดตรวจ | ผล |
|---|---|
| Web Simulate | ผ่าน; artboard 480x320; GIF แสดงผ่าน browser `<img>` |
| Data source | Sim และ server ใช้ weather payload shape เดียวกัน |
| GIF asset | มีครบทั้งใน web public assets และใน package บน SD |
| CCP live display | ยังไม่แสดง เพราะ active package เป็น `profile` |
| ความเสี่ยงเฉพาะ GIF | firmware มี warning ว่า `style.scale` กับ animated GIF อยู่จอเดียวกันอาจ crash; Weather layout ที่ตรวจไม่พบการใช้ scale บน GIF จึงไม่ติด risk นี้ |
| สรุป parity | ยังสรุป pixel parity บนจอจริงไม่ได้จนกว่าจะสลับ active package เป็น Weather; แต่ bundle/asset พร้อมและ Sim ผ่าน |

### 3. Web Test / Test LED pages

Packages:

- `com.ccp.webtest290533@1.0.0`
- `com.ccp.test-led@1.0.0`

| จุดตรวจ | ผล |
|---|---|
| Web Simulate | ผ่าน; LED/button interaction ไม่เจอ error หลัก |
| WASM | มีใน payload |
| CCP SD | ไม่พบ package folder บน CCP ตอนตรวจ |
| Store/entitlement | `webtest290533` มี published item; `test-led` ไม่พบ marketplace item |
| สรุป | ใช้งานได้ใน Sim แต่ไม่ได้ทำงานจริงบน CCP เครื่องนี้ตอนตรวจ |

### 4. My Page (`com.ccp.my-page@1.0.0`)

| จุดตรวจ | ผล |
|---|---|
| Web Simulate | ผ่าน; button + label render ได้ |
| CCP SD | ไม่พบ package folder |
| Store item | draft |
| สรุป | Publish แล้วใน Hub แต่ยังไม่ใช่หน้าที่ CCP เครื่องนี้ติดตั้ง/แสดง |

### 5. API Saved 678991 (`com.ccp.apisaved678991@1.0.0`)

| จุดตรวจ | ผล |
|---|---|
| Web Simulate | ผ่าน; 2 labels render ได้ |
| CCP SD | ไม่พบ package folder |
| Store item | draft |
| สรุป | Publish แล้วใน Hub แต่ยังไม่ใช่หน้าที่ CCP เครื่องนี้ติดตั้ง/แสดง |

## รูป, GIF, asset และการแสดงผล

| พื้นที่ | ไฟล์ที่พบจริงบน CCP | ผล |
|---|---|---|
| Clock native | `/sd/pages/clock/assets/logo.png` | มีไฟล์ logo จริง |
| Crypto native | `/sd/pages/crypto/assets/alert.wav` | มีเสียง alert; ไม่พบ `btc.png`, `eth.png`, `bnb.png`, `doge.png` ตอนตรวจ ดังนั้น coin logo จะถูกซ่อนตาม logic |
| Slideshow native | `/sd/pages/slideshow/assets/sample1.png`, `sample2.png`, `sample3.png` | มีรูปตัวอย่างจริง |
| Weather Builder | `/sd/packages/com.ccp.weather/1.4.9/assets/*.gif` | มี GIF ครบ 7 ไฟล์ |
| Profile Builder | ไม่มี image/GIF asset | เป็น text-only page |

ข้อสังเกตเรื่อง image parity:

- Web Simulate ใช้ browser `<img>` และ `object-fit: contain`
- CCP ใช้ LVGL image/GIF decoder
- ตำแหน่งกรอบ widget จะตรงจาก `x/y/w/h` แต่การ scale ภายในรูปอาจไม่ pixel-perfect 100% ระหว่าง browser กับ LVGL โดยเฉพาะ GIF/image ที่ขนาดจริงไม่เท่ากับ widget
- Slideshow native ใช้ `LV_IMAGE_ALIGN_CONTAIN`; จึงไม่ใช่ Builder Sim path

## การตั้งค่าเปลี่ยนเหรียญ

| ฝั่ง | ผลตรวจ |
|---|---|
| Current CCP config | `symbols` เป็น `BTCUSDT`, `ETHUSDT`, `BNBUSDT`, `DOGEUSDT` |
| AppUser | หน้า Crypto มี chip เพิ่ม/ลบเหรียญได้สูงสุด 4 เหรียญ แล้ว `save()` ส่ง config ไป CCP ผ่าน LAN API `/api/v1/config` |
| Admin/API | `PUT /api/v1/devices/{id}/settings` เพิ่ม `settingsVersion` และ push MQTT command `settings` ให้ CCP |
| Firmware | `cfg_load` อ่าน `crypto.symbols`; ปุ่ม symbol บน native crypto page วนเหรียญจาก list นี้ |
| เทียบกับ Builder Sim | เทียบไม่ได้โดยตรง เพราะ Crypto เป็น native firmware page ไม่ใช่ Builder page |

ข้อสังเกต: ตอนตรวจ `/sd/pages/crypto/assets` มี `alert.wav` เท่านั้น ถ้าต้องการให้ icon เหรียญขึ้น ต้องมีไฟล์เช่น `btc.png`, `eth.png`, `bnb.png`, `doge.png` ขนาดตามที่ firmware คาดไว้

## Admin Web vs AppUser vs CCP

| Flow | Web Admin | AppUser | CCP | ผลจริง |
|---|---|---|---|---|
| Builder Save/Publish | สร้าง payload version ได้ | ไม่เกี่ยว | รอ assign/sync | ทำงานฝั่ง Hub แต่ไม่ได้แปลว่าทุก package จะอยู่บน CCP |
| Grant page right | Admin grant entitlement ได้ | Store/checkout ขอสิทธิ์ได้ถ้า login/payment พร้อม | settings.pages ถูก append | สิทธิ์ถูก mirror ลง settings แต่ firmware ยังแสดง active package ได้ทีละตัว |
| Active package sync | Admin/API assign payload แล้วส่ง `sync` | Store purchase ควรพาไป flow นี้ผ่าน Hub | sync_manager เปลี่ยน active package | ทำงาน แต่ active ได้ทีละ package ทำให้ package เก่าที่ติดตั้งไว้ไม่แสดง |
| Profile settings | Admin/API config มี `profile.nickname/role/name_color/show` | AppUser Profile ตอนนี้แก้ `profile.name` สำหรับ clock native เท่านั้น | Builder Profile ใช้ `settings.profile.nickname/role/name_color/show` | AppUser ยังแก้ค่า Builder Profile ไม่ครบ |
| Crypto symbols | Admin/API ตั้งได้ | AppUser ตั้งได้ | Native crypto อ่านได้ | ทำงานระดับ config; ไม่ใช่ Builder Sim |
| Photos/slideshow | Admin/API config ได้ | AppUser upload/reorder ได้ | Native slideshow อ่าน SD assets | มี sample images จริง |
| Weather GIF | Builder/Hub มี asset | Store entitlement มีได้ | Package อยู่บน SD แต่ไม่ active | ยังไม่แสดงจริงตอนตรวจ |

## สาเหตุทางโค้ดที่สำคัญ

| จุดโค้ด | ความหมาย |
|---|---|
| `firmware/components/home_ui/home_ui.c` `package_page_available()` | ตรวจว่า page id ใน settings ต้องตรง suffix ของ active package เช่น `com.ccp.profile` กับ `profile` เท่านั้น |
| `firmware/components/home_ui/home_ui.c` `setup_pages_from_cfg()` | ถ้า page id ไม่ใช่ native และไม่ตรง active package จะ `continue` หรือ skip |
| `firmware/components/ui_renderer/ui_renderer.c` `build_widget_tree()` | วางตำแหน่งและขนาด widget จาก `layout.json` ตรง ๆ ด้วย `lv_obj_set_pos` และ `lv_obj_set_size` |
| `firmware/components/ui_renderer/ui_renderer.c` `create_widget()` | `gif` ใช้ `lv_gif_create` / `lv_gif_set_src` ถ้าเปิด `LV_USE_GIF` |
| `server/apps/web/components/builder/BuilderCanvas.tsx` | Web Simulate ใช้ absolute div ที่ `left/top/width/height` ตาม layout และ artboard 480x320 |
| `server/apps/web/components/builder/wasmSim.ts` | Sim auto-feed บาง stream แต่ `settings.profile` ยังเป็น manual |
| `server/apps/api/src/devices/devices.service.ts` `grantItem()` | grant page แล้ว assign latest payload ของ item นั้นเป็น active payload |
| `server/apps/api/src/devices/devices.service.ts` `syncEntitlements()` | append page entitlement เข้า `settings.pages` แต่ไม่ได้แก้ข้อจำกัด active package เดียวใน firmware |

## ข้อจำกัด / risk ที่พบ

| Risk | ผลกระทบ |
|---|---|
| Active package เดียว | ซื้อ/ติดตั้งหลาย Builder pages แล้ว settings มีหลายหน้าได้ แต่ CCP แสดงได้แค่ package ที่ active ล่าสุด |
| Sim ไม่ seed settings ของ device | หน้า Profile ใน Sim ดูเหมือนไม่ตรง ทั้งที่ CCP แสดงค่าจริงจาก config |
| Store copy บอกว่า new swipeable page appears | สำหรับหลาย package พร้อมกันยังไม่จริงเต็มที่ เพราะ package ก่อนหน้าอาจถูก skip |
| AppUser Profile แก้คนละ field กับ Builder Profile | ผู้ใช้แก้ชื่อใน AppUser แล้วอาจไม่เปลี่ยนข้อความบน Builder Profile |
| Crypto coin logos ไม่มีบน SD | native crypto page จะซ่อน logo แม้เปลี่ยนเหรียญได้ |
| Internal heap fragment | Serial `heap` ล่าสุด: internal free `8963`, largest `4352`; page ที่ใช้ GIF/WASM อาจไวต่อ memory fragmentation |

## Fix log (แก้ตามรายงาน)

อัปเดต: 2026-06-14

| ข้อ | สถานะ | รายละเอียดการแก้ |
|---|---|---|
| #4 Sim ไม่ seed `settings.<slug>` | ✅ แก้แล้ว + verify บน browser | Builder Simulate auto-feed stream `settings.*` ด้วยค่าจาก `settings_schema` (default + ค่าที่กรอกในฟอร์ม Preview) ผ่าน `withDefaults` — ตอนนี้ Sim แสดงค่าจริงเหมือนที่อุปกรณ์ได้รับตอน boot ไม่ใช่ค่า default ของ widget. ไฟล์: `wasmSim.ts` (feeder branch `settings` + mode ใหม่ "page settings"), `store.ts` (`settingsPreview` แชร์ระหว่าง panel กับ sim), `app/builder/page.tsx` (ส่ง `settingsValues` เข้า `SimSession.start`). ทดสอบ: เพิ่ม field `nickname`=HAL FINNEY + data source `settings.test` → Simulate → stream panel แสดง `page settings · {"nickname":"HAL FINNEY"}` |
| #1/#2/#3 active package เดียว | ✅ แก้แล้ว + verify บนเครื่องจริง (2026-06-14) | เปลี่ยนเป็น **multi-page lazy-swap**: ทุกหน้าที่ติดตั้ง (≤5) เข้า swipe rotation; โหลด package เข้า renderer เฉพาะหน้าที่ swipe ไปถึง (ครั้งละ 1 → ไม่กิน memory เพิ่ม) แล้ว unload/หยุดงานหน้าเดิม. ตาม product decision ของ user (UserApp คัดกรอง ≤5 หน้า, ทำงานทีละหน้า). **ทดสอบบน `ccp-983daee91478`:** `pages` แสดง 5 หน้า (clock,crypto,slideshow,weather,profile); `goto weather` → โหลด weather จริง (7 widgets+GIF, Bangkok 31°C); `goto profile` → profile (HAL FINNEY); crypto poll เริ่มตอนเข้า/หยุดตอนออก; heap นิ่ง (internal free ~11-17KB); MQTT ติดปกติ. ไฟล์: `sync_manager.{c,h}` (`installed_dir_for_slug` + reuse sync worker สำหรับ swap), `home_ui.c` (rotation + lifecycle + lazy swap), `app_main.c` (`do_page_swap` บน sync worker). หมายเหตุ: ยังพบ phantom touch ทำให้สลับหน้าเองบ้าง (เป็นปัญหา touch i2c pull-up เดิม ไม่เกี่ยวโค้ดนี้); sys_monitor telemetry ยัง OOM (non-fatal). ฝั่ง UserApp ต้องทำ UI จำกัด ≤5 หน้า (chunk ถัดไป) |
| #5 AppUser แก้ field ของ Builder Profile | 📋 backlog (Flutter) | ต้องเพิ่ม field `nickname/role/name_color/show` ในแอป (mirror `SchemaForm`) — อยู่ใน roadmap |
| #6 dump widget ของ inactive package | ❌ ไม่ทำ | ต้องโหลด package ที่ไม่ active เข้า renderer ซึ่งชนกับ active screen + เสี่ยง memory; คุณค่าต่ำกว่าความเสี่ยง |
| #7 coin logo PNG บน SD | 📋 backlog (asset/feature) | firmware รองรับแล้ว (`/pages/crypto/assets/<base>.png`, resize 32px) แต่ยังไม่มีไฟล์รูป — ต้องทำ dynamic fetch ตอนเปลี่ยนเหรียญ (roadmap) หรืออัปโหลดรูปจริง |
| #8 visual QA สลับ active เป็น Weather | 📋 ขึ้นกับ decision #1 | ทำได้เมื่อสรุปโมเดล package แล้ว |

## ข้อเสนอแนะก่อนแก้โค้ด

| ลำดับ | ข้อเสนอ |
|---:|---|
| 1 | ตัดสินใจ product behavior ก่อนว่า CCP ต้องรองรับ Builder packages หลายหน้าพร้อมกันหรือยอมรับ active package เดียว |
| 2 | ถ้าต้องรองรับหลายหน้า ต้องแก้ firmware/sync model จาก active package เดียวเป็น installed package registry ต่อ page |
| 3 | ถ้ายัง active package เดียว ให้ Admin/AppUser แสดงข้อความชัดว่า package ล่าสุดที่ assign จะเป็นหน้า package เดียวที่แสดง |
| 4 | เพิ่ม Sim option “Load settings from device” สำหรับ stream `settings.<slug>` เพื่อให้ Profile/Settings pages ตรง CCP |
| 5 | เพิ่ม AppUser fields สำหรับ Builder Profile: `nickname`, `role`, `name_color`, `show` หรือแยกชัดว่า Profile native กับ Builder Profile คนละตัว |
| 6 | เพิ่ม serial/debug command สำหรับ dump widget ของ inactive installed package หรือ temporary preview package เพื่อเทียบ pixel parity โดยไม่ต้องเปลี่ยน entitlement |
| 7 | เติม coin logo assets ลง `/pages/crypto/assets` ถ้าต้องการให้ native crypto แสดงรูปเหรียญ |
| 8 | ทำ visual QA รอบต่อไปโดยสลับ active package เป็น Weather ชั่วคราว แล้วถ่ายภาพ/serial widget dump เพื่อยืนยัน GIF บน LVGL จริง |

## สรุปสุดท้าย

Web Simulate ของหน้า Builder ที่ publish แล้วทำงานได้ในฝั่งเว็บ แต่บน CCP เครื่องนี้มีเพียง `Profile` ที่เป็น Builder page และทำงานจริงใน rotation ตอนตรวจ ส่วน `Weather` ถูกติดตั้งพร้อม asset/GIF แล้วแต่ไม่แสดงเพราะไม่ใช่ active package ปัจจุบัน หน้าอื่น ๆ ยังอยู่ระดับ published payload / store item และไม่ได้ deploy ลง CCP เครื่องนี้

ดังนั้นคำตอบของ “เหมือน simulate ในเว็บทุกหน้าไหม” คือ:

- `Profile`: layout/font/position ตรงบน CCP, แต่ข้อมูล default ใน Sim ไม่ตรงจนกว่าจะ feed settings จริง
- `Weather`: Sim ดูถูกต้องและ asset ครบ แต่ยังไม่ได้แสดงจริงบน CCP ตอนนี้
- `My Page`, `API Saved`, `Web Test`, `Test LED`: Sim ผ่าน แต่ยังไม่ทำงานจริงบน CCP เครื่องนี้
- `Clock`, `Crypto`, `Slideshow`: ทำงานเป็น native pages, ไม่ใช่ Builder pages จึงไม่มี Sim parity แบบเดียวกัน
