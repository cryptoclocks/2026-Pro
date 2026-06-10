/*
 * ═══════════════════════════════════════════════════════════════════
 *  CryptoClock Pro — USER CONFIG (แก้ค่าได้ที่ไฟล์นี้ไฟล์เดียว)
 * ═══════════════════════════════════════════════════════════════════
 *  ค่าในไฟล์นี้คือ "ค่าเริ่มต้น" — ถูก override ได้ตามลำดับ:
 *    1. ไฟล์ /sd/config/device.json บน SD card
 *    2. คำสั่งจาก Server ผ่าน MQTT / LAN API จากแอปมือถือ
 *  แก้แล้วต้อง build + flash ใหม่ (idf.py build flash)
 */
#pragma once

/* ---------- Server / MQTT ---------- */
/* IP เครื่องที่รัน docker compose / mosquitto (พอร์ต 1883 = ไม่เข้ารหัส dev) */
#define CCP_CFG_MQTT_BROKER_URI   "mqtt://192.168.1.100:1883"

/* Base URL ของ Hub API (NestJS) */
#define CCP_CFG_SERVER_BASE_URL   "http://192.168.1.100:4000"

/* ---------- เวลา ---------- */
/* ไทย = UTC+7 = 420 นาที */
#define CCP_CFG_TZ_OFFSET_MIN     420
#define CCP_CFG_SNTP_SERVER       "pool.ntp.org"

/* ---------- หน้าจอ ---------- */
#define CCP_CFG_DEFAULT_BRIGHTNESS  80      /* 0-100 */

/* ---------- หน้า Crypto (หน้า 2) ---------- */
/* คู่เหรียญตามรูปแบบ Binance เช่น BTCUSDT, ETHUSDT, DOGEUSDT */
#define CCP_CFG_CRYPTO_SYMBOL       "BTCUSDT"
#define CCP_CFG_CRYPTO_DISPLAY      "BTC/USDT"
/* ดึงราคาตรงจาก Binance ทุกกี่วินาที (เมื่อไม่มีข้อมูลจาก server) */
#define CCP_CFG_CRYPTO_POLL_S       5

/* ---------- หน้า Clock (หน้า 1) ---------- */
#define CCP_CFG_PROFILE_NAME        "CryptoClock"
#define CCP_CFG_PROFILE_TITLE       "Pro Edition"

/* ---------- หน้า Slideshow (หน้า 3) ---------- */
#define CCP_CFG_SLIDE_INTERVAL_S    5
#define CCP_CFG_SLIDE_RETURN_FIRST  1   /* ครบทุกรูปแล้วกลับหน้า 1 */
