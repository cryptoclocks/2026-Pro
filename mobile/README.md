# CryptoClock Pro — Mobile Apps (Flutter / Android)

| แอป | กลุ่มผู้ใช้ | ทำอะไร |
|---|---|---|
| [user-app](user-app/) | เจ้าของจอ | ค้นหาจอในวง WiFi (mDNS) → ตั้งค่า WiFi ครั้งแรก, ปรับหน้า/เหรียญ/ความสว่าง, identify, รีเซ็ต WiFi — คุยกับจอ**ตรงๆ ผ่าน LAN API** ไม่ต้องมี server |
| [admin-app](admin-app/) | แอดมินระบบ | จัดการ fleet ทั้งหมดผ่าน **Hub API** (NestJS) — ดูสถานะ online/แบต/FPS, สั่ง sync/reboot/lock/wipe, assign payload |

## วิธี build (ต้องมี Flutter SDK + Android SDK)

```bash
# ติดตั้ง Flutter: https://docs.flutter.dev/get-started/install/macos
cd mobile/user-app        # หรือ admin-app
flutter create . --platforms=android --project-name ccp_user_app   # สร้างไฟล์ android/ ครั้งแรก
flutter pub get
flutter run               # ต่อมือถือ Android + เปิด USB debugging
flutter build apk --release
```

> หมายเหตุ: ใน repo เก็บเฉพาาะโค้ด Dart (`lib/` + `pubspec.yaml`) — โฟลเดอร์ `android/` ให้ `flutter create .` generate ในเครื่องคุณ (ยังไม่ได้ทดสอบ build บนเครื่องนี้เพราะไม่มี Flutter/Android SDK)

## Permissions ที่แอปต้องการ (เพิ่มใน AndroidManifest.xml หลัง flutter create)
```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE"/>
<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE"/>  <!-- mDNS -->
```

## Flow การตั้งค่าจอใหม่ (user-app)
1. จอแสดงหน้า WiFi Setup → ผู้ใช้กดปุ่ม "Setup new device" ในแอป
2. แอปพาไปหน้า WiFi settings ให้ต่อ `CCP-Setup-XXXX` → เปิด `http://192.168.4.1` (in-app WebView/บราวเซอร์) → กรอก WiFi
3. จอรีบูตเข้า WiFi บ้าน → แอปสแกน mDNS หา `_ccp._tcp` → เจอจอ → หน้า Device Settings
