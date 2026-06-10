# CryptoClock Pro — Project Progress

_Last updated: 2026-06-11_

Legend: ✅ done & verified · 🟡 partial / needs more · ⬜ not started

## Firmware (`firmware/`)
- ✅ Boot pipeline, WiFi captive-portal provisioning, net_worker task model
- ✅ Display driver (AXS15231B QSPI, FULL render mode, touch, rotation 90°)
- ✅ Built-in UI: Welcome / WiFi setup / Clock / Crypto / Slideshow + swipe + menu
- ✅ Clock: large time, **orange seconds** at minutes baseline, **date above**, **48×48 logo**, 3 themes
- ✅ Crypto: live price, **green/red candlestick chart** (klines OHLC on lv_canvas),
  symbol/currency/timeframe buttons, per-coin logos
- ✅ Crypto **price alerts** (8 rules), full-screen alert + WAV sound, **Snooze 5m / Stop**
- ✅ Slideshow: fullscreen **PNG** 480×320, auto-seed from placehold.co, fade/slide
- ✅ LAN API (port 80) + mDNS, file upload/delete, brightness, identify, wifi reset
- ✅ MQTT connectivity, status/telemetry, cmd handling (settings/reload/identify/…)
- ✅ Boot settings-sync with server (version-compared)
- 🟡 OTA package rendering (ui_renderer) — engine exists; local Hub bundle host works, device render path still needs full hardware validation
- 🟡 WASM logic (WAMR up; host bindings stubbed) — for marketplace pages (M7)

## Hub API (`server/apps/api`)
- ✅ Prisma schema + Postgres (local: brew postgresql@16, db `cryptoclock`)
- ✅ Devices: list, claim, settings GET/PUT (MQTT push), cmd, assign
- ✅ MQTT bridge (connects to Node-RED broker)
- ✅ **Auth**: Supabase token verify + admin allowlist + RBAC guards (`/auth/me`)
- ✅ **Users API**: list, detail, grant/revoke entitlements (admin)
- ✅ **Marketplace**: store catalog, Stripe checkout, admin price/publish CRUD
- ✅ **Feature requests**: create (user) + approve/reject (admin) → merge to device + MQTT push
- ✅ **Billing**: Stripe webhook → Entitlement → MQTT sync (code present)
- ✅ Payload publish pipeline (validate + Rust compile + local bundle.zip host + manifest/hash + PayloadVersion)
- ⬜ Ads / campaigns (M7), notifications, audit-log surfacing

## Admin Web (`server/apps/web`)
- ✅ Branding (new teal logo, favicon), dark theme, auth-gated nav
- ✅ `/login` (email OTP), session in localStorage, `/auth/me`
- ✅ `/` Fleet dashboard (live cards, settings push modal, identify/reload)
- ✅ `/users` manager (purchases, devices, feature requests, grant/revoke)
- ✅ `/approvals` queue (approve/reject feature requests)
- ✅ `/store` (catalog + admin price/publish)
- ✅ `/builder`: templates, drag-drop overlay, Inspector + **data-binding**, **Data Sources**, **WASM module config**, **Edit Logic**, **Simulate**, **Publish**
- ✅ Builder logic demo: **LED Toggle** template + simulate button→LED events + property reselect after simulate
- ✅ Builder publish → server bundle: edit Rust in browser → compile wasm → publish `bundle.zip` + manifest → bundle URL
- 🟡 Builder publish → live device: API/device sync path exists; needs real ESP32 hardware validation for layout/WASM rendering
- ✅ Rust WASM example (`wasm-apps/examples/rust-ticker`) builds against ABI v1
- ✅ Rust WASM LED toggle example (`wasm-apps/examples/led-toggle`) builds against ABI v1

## Mobile app (`mobile/user-app`)
- ✅ Flutter project (Android built+installed; iOS folders generated, unbuilt)
- ✅ mDNS/LAN discovery, per-page nested settings (System/Profile/Clock/Crypto/Photos)
- ✅ Supabase email-OTP login, Store screen (Stripe checkout launch)
- ✅ Photo upload re-encoded to 480×320 PNG, reorder, effects
- ✅ Crypto alerts editor → **Submit for admin approval** (Hub feature-request)
- ⬜ iOS build (no Mac iOS toolchain set up), admin-app (fleet) is source-only

## Infra / deployment
- ✅ Local Hub runs without Docker (`cd server && pnpm dev`; Postgres via brew)
- ✅ MQTT = Node-RED broker (port 1883 open, 8883 closed)
- 🟡 Vercel + Supabase deploy track (planned; env wiring documented, not deployed)
- 🟡 MinIO/S3 object store (M5) — local filesystem bundle hosting works; production should move bundles to object storage
- ⬜ Production MQTT TLS (8883) + per-device credentials

## Known constraints / gotchas (don't regress)
- Slideshow images **must be PNG** (LVGL tjpgd renders blank on this panel).
- `CONFIG_LV_CACHE_DEF_SIZE` must be non-zero; `CONFIG_FATFS_LFN_HEAP=y` (long SD names).
- `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y` or HTTPS fails (TLS from PSRAM).
- Never delete LVGL's active screen (home_ui_reload parks on a blank screen first).
- Internal DIRAM ~334KB — keep big buffers in PSRAM.
- `@ccp/shared` must stay CJS-compatible (NestJS `require`).
- Secrets gitignored: `mobile/**/lib/secrets.dart`, `server/**/.env*`.

## Verified end-to-end (2026-06-10, board ccp-983daee91478)
Clock/crypto candlestick/slideshow render; settings push via web → device reloads;
device telemetry in Postgres; APK installs & runs; web admin pages all 200.

## Verified server/builder (2026-06-11, local)
- `pnpm --filter @ccp/shared typecheck`
- `pnpm --filter @ccp/web typecheck`
- `pnpm --filter @ccp/api typecheck`
- `pnpm --filter @ccp/api build`
- `POST /api/v1/payloads/compile-wasm` compiled Rust LED logic to `wasm/logic.wasm`
- `POST /api/v1/payloads/publish-compiled` created/updated `PayloadVersion` for `com.ccp.test-led@1.0.0`
- `GET /api/v1/packages/com.ccp.test-led/1.0.0/manifest` returned layout + wasm hashes
- `GET /api/v1/packages/com.ccp.test-led/1.0.0/bundle.zip` returned a valid zip containing `layout.json` and `wasm/logic.wasm`; downloaded bundle sha256 matched server response
- Browser `/builder`: LED Toggle template loaded, Inspector actions re-opened after selection changes, Edit Logic compiled Rust from UI, Simulate toggled LED on/off
