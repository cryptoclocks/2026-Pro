# CryptoClock Pro — Project Overview

## What it is
A commercial **Smart IoT Display platform**. A small ESP32-S3 touchscreen shows
swipeable pages (Clock, live Crypto, Photo slideshow, and purchasable extras).
Owners configure it from a phone app or a cloud admin console; new pages are
delivered over the air ("Zero-Flash / Dynamic UI") and can be sold via Stripe.

## The three products
1. **Firmware** (`firmware/`) — ESP-IDF v5.5 + LVGL 9.5 + WAMR. Runs the built-in
   pages and renders server-delivered `layout.json` packages.
2. **Hub** (`server/`) — pnpm monorepo: NestJS API (`apps/api`) + Next.js admin
   web (`apps/web`) + shared zod schema (`packages/shared`). Postgres via Prisma.
3. **Mobile app** (`mobile/user-app`) — Flutter (Android/iOS). Configures a display
   over the LAN and talks to the Hub for login, Store, and feature requests.

## Hardware
- Board **JC3248W535C**: ESP32-S3, AXS15231B 320×480 QSPI panel (used landscape
  **480×320**), capacitive touch (same chip, I²C 0x3B), SD (SDMMC 1-bit), NS4168 I²S audio.
- Device id format `ccp-xxxxxxxxxxxx`. Test unit: `ccp-983daee91478`.

## Architecture (data flow)
```
 Phone app ──LAN HTTP (mDNS _ccp._tcp)──► Display  (config, photo upload, identify)
 Phone app ──HTTPS──► Hub API ──► Postgres            (login, Store, feature requests)
 Display ──MQTT (Node-RED broker)──► Hub API          (status, telemetry, cmd/res)
 Hub API ──MQTT cmd:settings/sync──► Display          (live config + OTA pages)
 Display ──HTTPS──► Binance / exchange-rate / placehold.co  (prices, klines, seed imgs)
```
- **MQTT broker:** `node-red.cashlessthailand.com:1883` (user-owned Node-RED, aedes).
- **Config precedence:** server settings > SD `device.json` > per-page `config.json` > `user_config.h`.
  Device re-checks the server at every boot (`GET /devices/{id}/settings`, version-compared).

## Built-in pages
- **Clock** — big time (montserrat_48 scaled), orange seconds tucked at the minutes'
  baseline, date above, brand logo (48×48) bottom-center. 3 themes (gold/mint/neon).
- **Crypto** — live price + **green/red candlestick chart** (Binance klines OHLC on an
  lv_canvas), symbol-cycle + currency (USD/THB) + timeframe (15m/1h/4h/1d) buttons,
  per-coin logos, 8 price **alerts** (full-screen + sound, Snooze/Stop) — alerts are
  **gated by manual admin approval**.
- **Slideshow** — fullscreen 480×320 **PNG** photos (LVGL's JPEG path renders blank on
  this panel — PNG only), fade/slide effects, app uploads re-encoded to PNG.

## Key services & accounts
- **Auth:** Supabase (email OTP). Admin allowlist via `ADMIN_EMAILS` (currently
  `mycryptoclock@gmail.com`). Web + app verify the user token against `/auth/v1/user`.
- **Payments:** Stripe Checkout → webhook → `Entitlement` (user × page) → MQTT push.
- **Secrets:** Supabase keys & `.env` are **gitignored** (`mobile/**/lib/secrets.dart`,
  `server/**/.env*`). Never commit them.

## Repo map
```
firmware/         ESP-IDF project (components/home_ui = the built-in pages)
  main/user_config.h      single user-editable defaults (broker, server URL, tz)
server/apps/api         NestJS: auth, devices, marketplace, features, billing, mqtt
server/apps/web         Next.js admin: /, /login, /users, /approvals, /store, /builder
server/packages/shared  zod LayoutSchema + MQTT message types (CJS-compatible)
mobile/user-app         Flutter app (LAN config + Hub login/Store/alerts)
sdcard/                 SD card template (config + per-page assets)
docs/                   manuals + this overview + progress + handoff
schema/                 JSON Schemas (layout, manifest, mqtt, widget props)
```

## Docs index
- [project-progress.md](project-progress.md) — what's done / pending / milestones
- [ai-handoff-prompt.md](ai-handoff-prompt.md) — prompt to hand off to another AI
- [manual.md](manual.md) — end-user manual (Thai)
- [admin-manual.md](admin-manual.md) — admin/operator manual (Thai)
- [pages-guide.md](pages-guide.md) — what to edit per page (code/asset/server)
- [builder-and-billing.md](builder-and-billing.md) — Builder, publish flow, billing, approvals
- [architecture.md](architecture.md) — deeper architecture & milestones
