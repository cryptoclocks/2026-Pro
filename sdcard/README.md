# SD Card Template — copy ทั้งโฟลเดอร์นี้ลง root ของ SD card (FAT32)

```
/config/device.json              <- ตั้งค่าเครื่อง (แก้ชื่อ/เหรียญ/ธีมได้เลย)
/pages/clock/assets/avatar.jpg   <- รูปโปรไฟล์ (สี่เหลี่ยมจัตุรัส ~96px)
/pages/crypto/assets/btc.png ... <- logo เหรียญ (ชื่อไฟล์ = ตัวเหรียญพิมพ์เล็ก)
/pages/slideshow/assets/1.jpg .. <- รูปสไลด์ 320x240 (PNG/JPG สูงสุด 8 รูป)
```

วิธี copy (macOS — เสียบ SD เข้าเครื่อง):
```bash
cp -R sdcard/* /Volumes/<ชื่อการ์ด>/
```
