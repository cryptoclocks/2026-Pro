# แผน: Asset Pipeline (อัปโหลดรูป/GIF/เสียงต่อหน้า → ลง SD ของนาฬิกา)

เป้าหมาย: แอดมินแนบไฟล์ (GIF จาก lottiefiles, PNG, WAV) ในหน้าที่ออกแบบใน Builder
→ กด Publish → ไฟล์ถูกใส่ใน bundle.zip → นาฬิกาดาวน์โหลดลง SD → widget อ้างถึงได้

## สถานะปัจจุบัน (อะไรพร้อม / อะไรขาด)

**พร้อมแล้ว (ฝั่งเครื่อง):**
- `sync_manager` แตกไฟล์ *ทุกไฟล์* ใน bundle.zip ลง `/sd/packages/<pkg>/<ver>/` อยู่แล้ว
- `ui_renderer` มี `gif` + `image` widget และ `find_asset()` — อ้าง asset ด้วย `src`
- `verify_manifest` ตรวจ sha256 ทุกไฟล์ใน manifest → asset ต้องอยู่ใน manifest ด้วย

**ต้องสร้าง:**
1. **Builder UI** — ส่วน "Assets" ต่อหน้า: อัปโหลดไฟล์ (input type=file) → เก็บเป็น
   base64 ใน store (`assets: {path, mime, base64, sizeBytes}[]`); แสดงรายการ + ลบได้
2. **Widget src เลือก asset** — Inspector ของ gif/image: dropdown เลือกจาก assets ที่
   อัปโหลด (เซ็ต `props.src = "assets/<name>.gif"`)
3. **exportLayout** — ใส่ `assets: [{id, path}]` ใน layout.json (schema มี asset map อยู่แล้ว
   ดู `find_asset` ใช้ id/path) ให้ ui_renderer map id→path
4. **publish-compiled endpoint** — รับ `assetFiles: [{path, base64}]` เพิ่มจาก `wasmFiles`;
   เขียนลง bundle เหมือน wasm (มี `assertBundlePath` + `MAX_*_BYTES` กันไฟล์ใหญ่/เกิน);
   ใส่ใน manifest อัตโนมัติ (buildManifest วน files อยู่แล้ว)
5. **Sim rendering** — BuilderCanvas: gif/image ที่ src ขึ้นต้น `assets/` → หา asset
   base64 ใน store แล้ว render เป็น `<img src={dataURL}>` (เห็นใน Simulate ตรงกับเครื่อง)

## จุดที่ต้องระวัง

- **ขนาด bundle**: GIF อาจใหญ่ (หลาย MB) — sync_manager เพดาน `MAX_BUNDLE_BYTES = 16MB`
  ตั้งเพดานต่อไฟล์ใน endpoint (เช่น 4MB/asset) + เตือนใน UI
- **PNG/GIF เท่านั้น** สำหรับรูป (จอนี้ decode JPEG ไม่ขึ้น — ดู HARD RULE #8); GIF ใช้
  `lv_gif` ได้ (decoder เปิดอยู่)
- **manifest sha256**: ต้อง include asset ใน manifest ไม่งั้น `verify_manifest` fail
  (buildManifest ครอบทุก file อยู่แล้ว — แค่ต้องส่ง asset เข้า `files[]`)
- **เสียง**: WAV 16-bit PCM (ดู pages-guide) — เล่นผ่าน `ccp_audio_play("assets/x.wav")`
  ซึ่ง host map ผ่าน find_asset อยู่แล้ว

## Lottie → GIF (ฝั่งผู้ใช้)

ผมเข้าถึง lottiefiles.com ไม่ได้ (เป็นเว็บภายนอก) — **ผู้ใช้โหลด Lottie แล้ว export เป็น
GIF** (lottiefiles มีปุ่ม Download → GIF) หรือใช้ `lottie → gif` ของ python
`lottie` lib ฝั่ง server ภายหลัง ไฟล์ GIF ที่ได้เอามาอัปใน Builder ผ่าน pipeline นี้

แนวคิดต่อยอด: ทำ endpoint `POST /assets/lottie-to-gif` รับ Lottie JSON แล้วแปลงเป็น GIF
ฝั่ง server (ใช้ `python-lottie` หรือ puppeteer+lottie-web) เพื่อให้ผู้ใช้อัป JSON ตรงๆ ได้

## ลำดับทำ (ทำทีละชั้น verify ได้)

1. endpoint รับ assetFiles + ใส่ bundle + manifest (เทสต์: publish + unzip ดูไฟล์)
2. Builder store: assets[] + upload UI
3. Inspector: gif/image src เลือก asset
4. exportLayout: assets map
5. Sim: render gif จาก base64
6. Hardware: publish หน้าใส่ GIF → ดูบนจอ (gif widget เล่นจาก SD)

> ระหว่างยังไม่เสร็จ: หน้า Weather ใช้ canvas animation ที่วาดเอง (commit a7e69a0)
> ซึ่งทำงานบนจอจริงแล้ว — ไม่ต้องรอ pipeline นี้
