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
- ✅ Devices: list, claim, settings GET/PUT (MQTT push), cmd, assign, per-device grant/revoke with PAGE auto-assign
- ✅ MQTT bridge (connects to Node-RED broker)
- ✅ **Auth**: Supabase token verify + Google OAuth entry + email magic link/OTP + admin allowlist + RBAC guards (`/auth/me`)
- ✅ Local-only dev auth (`CCP_DEV_AUTH=1` + signed `ccpdev.*` token) for repeatable admin UI tests without email magic-link friction
- ✅ **Users API**: list, detail, grant/revoke entitlements (admin)
- ✅ **Marketplace**: store catalog, Stripe checkout, admin price/publish CRUD, Clock Alarm add-on (`clock-alarm`) at 99 THB
- ✅ **Feature requests**: create (user) + approve/reject (admin) → merge to device + MQTT push
- ✅ **Billing**: Stripe webhook → Entitlement → MQTT sync (code present)
- ✅ Payload publish pipeline (validate + Rust compile + local bundle.zip host + manifest/hash + PayloadVersion + draft Store item + Builder saved-page load)
- ⬜ Ads / campaigns (M7), notifications, audit-log surfacing

## Admin Web (`server/apps/web`)
- ✅ Branding (new teal logo, favicon), dark theme, auth-gated nav
- ✅ `/login` (Google OAuth + email OTP/magic link), session in localStorage, `/auth/me`
- ✅ `/` Fleet dashboard (live cards, settings push modal, identify/reload, Rights grant/revoke)
- ✅ `/users` manager (purchases, devices, feature requests, grant/revoke)
- ✅ `/approvals` queue (approve/reject feature requests)
- ✅ `/store` (catalog + admin price/publish)
- ✅ `/builder`: starter templates, saved-page opener, drag-drop overlay, Inspector + **data-binding**, **Data Sources**, **WASM module config**, **Edit Logic**, **Edit Properties/Simulate toggle**, **Save / Publish**
- ✅ Builder logic demo: **LED Toggle** template + simulate button→LED events + property reselect after simulate
- ✅ **Real WASM simulator** (2026-06-11): Simulate now executes the exact compiled wasm in the browser via a JS host shim implementing the full ABI v1 (`components/builder/wasmSim.ts`) — auto-compiles on entering Simulate, real ticks (`ccp_request_tick`), real time (`ccp_time_unix`), widget clicks → `ccp_on_event`, stream payloads → `ccp_malloc`/`ccp_on_data`/`ccp_free`, canvas imports draw on a real `<canvas>`, logs panel + manual payload sender + Restart; wasm writes go to a separate override layer so exiting Simulate restores the design
- ✅ Live sim data feeds: `market.<SYM>.ticker` polls Binance REST (offline → random walk), `clock`/`time.*` feeds real wall-clock JSON every second, other streams manual
- ✅ Device-exact rendering in Builder (2026-06-11): artboard uses Montserrat Medium (same face LVGL ships) and labels honor `style.font` exactly (montserrat_14/20/28/48 → same px), top-aligned like lv_label; chart widget in Simulate now draws a real line chart from live Binance klines via the `series` binding (what lv_chart shows on-device); verified clock = 20/48/20px and 48-point BTC polyline
- 📋 Plan written, awaiting go-ahead: `docs/settings-and-assets-plan.md` — (A) per-page settings_schema → schema-driven settings UI auto-appearing in Admin Fleet modal + Flutter app (no app rebuild), values via existing settings JSON + new reserved stream `settings.<slug>`; (B) per-page asset upload → bundle `assets/` → SD (firmware side already complete: asset registry + zip extract + audio hook)
- ✅ Clock template now mirrors the native clock (date above, big time, orange seconds at minutes baseline, 48×48 logo bottom) and ships with working time-keeping Rust logic (`CLOCK_LOGIC_SOURCE`, compiles to ~2.9KB wasm); verified in browser: seconds tick with real time, correct date from `civil_from_days`, LED toggle works through the real module, exit restores design, zero console errors
- ✅ Builder publish → server bundle: edit Rust in browser → compile wasm → publish `bundle.zip` + manifest → bundle URL
- ✅ Builder publish → admin Store → device Rights grant: verified through web UI; server sent MQTT `settings` + `sync`, ESP32 returned `ok:true`
- ✅ **Dynamic purchased pages on hardware (2026-06-12)**: granting a PAGE right now adds its slug to `settings.pages` (syncEntitlements) and the firmware adopts the installed package's ui_renderer screen as an extra swipe page — serial-verified on ccp-983daee91478: `pages in rotation: clock,crypto,slideshow,weather` after granting Weather. Fixes that made it work: (1) server now ships `manifest.json` inside bundle.zip (firmware sync_manager required it), (2) wasm_exec worker converted to a real pthread (WAMR asserts `pthread_self` on raw FreeRTOS tasks — latent, first-ever module load exposed it), (3) ui_renderer no longer auto-loads its first screen; home_ui owns the display and adopts `ui_renderer_main_screen()` (external screens are never deleted by home_ui, gesture cb detached on rebuild; `home_ui_park()` guards renderer reloads), (4) boot order: package loads → `home_ui_show_home()` → `home_ui_reload()` re-enumerates pages. Current limit: ONE active package at a time (sync_manager single-slot) — multi-package storage is the next step.
- ✅ **Live data feeder** (`api/src/feeds/feeds.service.ts`): walks assigned payload layouts, fetches each declared stream on a per-pattern cadence (ticker 5s / klines 60s / weather 10min / fx 6h) and publishes to `ccp/v1/{device}/data/{stream}` — same JSON shapes as the Builder simulator, so published pages behave identically on hardware. Broker-verified: `weather.bangkok → {"city":"Bangkok","temp":"27°C","desc":"Overcast"}` (open-meteo; Binance + open.er-api for market/fx)
- ✅ **Weather page redesigned — cute + animated (2026-06-12)**: `com.ccp.weather@1.1.0`. Full-screen `scene` canvas painted by `WEATHER_LOGIC_SOURCE` wasm: weather-themed gradient bg (clear=blue→gold, overcast=grey, rain=navy, thunder=purple, snow, fog) + procedurally-animated icon (sun w/ rotating rays via a 24-entry trig table + `fill_disc`/`isqrt`, drifting clouds, falling rain/snow, lightning flash, fog lines). Semi-transparent labels (opa 210–235) overlay: city/temp/desc/humidity via bindings, clock driven by wasm `ccp_time_unix`. Lottie was requested but `lv_lottie`/ThorVG isn't in this build and the asset pipeline is unbuilt — canvas animation gives the same cute effect and runs on-device today. Hardware-verified: activates `1.1.0`, `6 widgets, 4 bindings, 1 wasm`, no wasm errors. Feeder now sends `relative_humidity_2m` + WMO→theme mapping (`weatherPayload`/`wmoToDescTheme`, shared shape with the sim). Also fixed: BuilderCanvas gave labels a default dark fill (device labels are transparent) → now only explicit bg_color fills.
- ✅ **Asset pipeline + real Lottie weather icons (2026-06-13)**: `com.ccp.weather@1.2.0`. Per-page asset uploads now ship inside the bundle: `publish-compiled` accepts `assetFiles:[{path,base64}]` (4MB/file cap, auto-added to manifest, carried forward on re-publish like wasm); `main.ts` JSON limit raised to 24MB. Builder store has `assets[]` (+ exportLayout `assets` map + onPublish fetches each asset → base64); BuilderCanvas resolves gif/image `src` to a store asset (by id/path) and renders the real `<img>`; sim applies `src` bindings. Weather page now uses an animated **GIF icon** (Lottie→GIF, 7 themes, 128px transparent, ~16–38KB each) bound to `weather.icon`; the wasm only paints the gradient + thunder flash now. Firmware: enabled `CONFIG_LV_USE_GIF` (was off — gif widget never actually worked before), and `BIND_SRC` now calls `lv_gif_set_src` for gif widgets so runtime src swaps animate. Hardware-verified: device downloaded the 215KB bundle, `layout loaded: 1 pages, 7 widgets, 5 bindings, 1 wasm`, no gif/decode errors. GIFs converted locally via puppeteer+lottie-web+ImageMagick (script + theme map in `server/apps/api/seed-assets/weather/`). **Still pending: a Builder "Assets" upload widget** so admins can add arbitrary GIF/PNG to any page (weather assets are built-in for now) — see task chip / `docs/asset-pipeline-plan.md`.
- ✅ New doc `docs/pages-code.md`: line-by-line walkthrough of the three published page logics (Clock/Crypto/Weather wasm).
- ✅ Weather 1.0.0 (initial): `com.ccp.weather` published (layout + noop wasm, 4.9KB bundle), linked to Store item `weather` (payloadId), grant → download → activate → shows on the clock. Builder has a Weather starter template.
- ✅ Crypto starter template is now a faithful copy of the native page: candlestick canvas drawn by CRYPTO_LOGIC_SOURCE wasm (same algorithm as home_ui candle_render), symbol cycle / USD↔THB / timeframe buttons (wasm.event 101/102/103), 24h change colored, live dot, "Binance · live". Sim feeders: `market.<SYM>.klines.<TF>` (Binance OHLC), `fx.USDTHB` (open.er-api, fallback 36.5), dynamic `ccp_data_subscribe` streams get feeders on the fly. Verified in browser: live candles, ETH cycle, THB conversion at the real rate.
- ✅ Pricing policy: catalog PAGE items are Free, everything THB (no USD anywhere); `crypto-alerts` ฿49, `clock-alarm` ฿99; seed update now overwrites price/currency on boot; web store shows "Free" for 0.
- ✅ `CCP_DEV_AUTH=1` enabled in `server/apps/api/.env`; firmware `CCP_CFG_SERVER_BASE_URL` fixed to `192.168.1.39` (boot settings HTTP sync verified, "settings in sync")
- 🔎 Root causes found (2026-06-11) why a granted PAGE never appears on the device:
  1. `bundle_url` in the MQTT `sync` cmd came from `PUBLIC_API_URL` env (unset → fell back to `http://localhost:4000`, unreachable from the ESP32). Now set to `http://192.168.1.39:4000` in `server/apps/api/.env` — must track the Mac's LAN IP (or add a DHCP reservation).
  2. Firmware `CCP_CFG_SERVER_BASE_URL` is `http://192.168.1.139:4000` but the Mac is currently `192.168.1.39` → boot-time settings HTTP check is broken until user_config.h is fixed + reflashed (MQTT pushes still work).
  3. Seeded catalog PAGE items (weather/news-ticker/calendar/stocks/fear-greed) are placeholders with **no payload bundle attached** — grant stores the entitlement + pushes `settings.entitlements`, but there is nothing to display. A real page must be built in Builder, published, linked to the Store item, then granted.
  4. The sync cmd ack `ok:true` only means "queued"; install success/failure is only visible in the serial log (`sync:` tag). An installed package currently **replaces the whole UI** (ui_renderer takes over from the native clock/crypto/slideshow suite); adding purchased pages into the native swipe rotation is future work (`setup_pages_from_cfg`).
- 📘 New doc: `docs/logic-guide.md` — per-page logic manual (native clock time-keeping explained, WASM ABI skeleton line-by-line, host API, 4 worked Rust examples, publish pipeline failure checklist)
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
- Fleet regression fixed: admin `/api/v1/devices` no longer 500s on BigInt telemetry (`sdFreeKb`); web shows `1 Devices / 1 Online` for `ccp-983daee91478`
- Store seed verified: `clock-alarm` exists as `FEATURE`, price `9900`, currency `thb`, web displays `฿99.00`
- `POST /api/v1/payloads/compile-wasm` compiled Rust LED logic to `wasm/logic.wasm`
- `POST /api/v1/payloads/publish-compiled` created/updated `PayloadVersion` for `com.ccp.test-led@1.0.0`
- `GET /api/v1/packages/com.ccp.test-led/1.0.0/manifest` returned layout + wasm hashes
- `GET /api/v1/packages/com.ccp.test-led/1.0.0/bundle.zip` returned a valid zip containing `layout.json` and `wasm/logic.wasm`; downloaded bundle sha256 matched server response
- Browser `/builder`: default/Clock logic is no-op per page; LED Toggle logic appears only for LED template; Inspector appears only in Edit Properties; Simulate shows Simulation panel; Add binding source starts blank and tooltip `?` help is present
- End-to-end web test: Builder published `com.ccp.webtest290533@1.0.0` (`PayloadVersion cmq8k0m21000n76n6egdtjhex`, bundle 3805 bytes) → Store item `com-ccp-webtest290533` created draft → admin published it in `/store` → Fleet Rights granted it to `ccp-983daee91478`
- After grant, API returned device entitlement `{slug:"com-ccp-webtest290533", kind:"PAGE"}` and `activePayloadVersionId=cmq8k0m21000n76n6egdtjhex`; MQTT log showed `cmd settings` and `cmd sync` both acknowledged `ok:true` by the ESP32

## Verified auth/builder save-edit (2026-06-11, local)
- `/login` shows **Sign in with Google** plus email link fallback. Google button redirects to Supabase OAuth (`/auth/v1/authorize?provider=google&redirect_to=/login`); Supabase redirect must be allowlisted in the project.
- `Save / Publish` no longer downloads `layout.json` when logged out; it validates and asks the admin to sign in. `Export layout.json` remains the explicit local-download button.
- API `GET /api/v1/payloads/builder-pages` returns saved Builder pages for the logged-in admin.
- API `GET /api/v1/payloads/builder-pages/:packageId/latest` opens the latest saved layout back into Builder.
- New saved page test: `com.ccp.apisaved678991@1.0.0` created Store draft `com-ccp-apisaved678991`; latest layout loads back with `builder.logic_source` preserved and 2 widgets.
- Legacy page behavior: pages published before `builder.logic_source` existed still open for widget/property edits; Builder shows a source-unavailable placeholder and server carries forward the old wasm file when saving without recompiling.

## Weather clock fix + scale limits (2026-06-13)
- ✅ **Root-cause fix: wasm `on_tick` never fired** for pages that call `ccp_request_tick()` inside `on_init` (clock/weather). The tick timer was only created from `desc.tick_ms` (layout config); the request_tick value set during init was ignored because the timer didn't exist yet. Fixed in `wasm_engine.c` (commit 90a7b95) — honors either source. This is why the Weather/Clock wasm clocks showed "--:--" on-device while working in the sim.
- ✅ Weather page reworked to be lighter/stable: dropped the 480×320 canvas; background is now a full-screen label whose `style.bg_color` binds to `weather.bg` (themed color from the feeder); clock-only wasm; Lottie GIF icon via `weather.icon`. Device stable on boot (health gate passes, no crash), running `com.ccp.weather@1.3.5`.
- ❌ **Bigger-than-48pt clock not achievable on the Weather page**: `transform_scale` (the native clock's trick) crashes LVGL when an animated GIF shares the screen — the transformed draw and the GIF decoder corrupt each other (reproduced repeatedly: PC=0x28 / IllegalInstruction). `scale` style support is kept in ui_renderer/schema/sim for text-only pages (works there), but the Weather clock stays at montserrat_48. Going bigger needs a custom large font (firmware) or dropping the GIF.
- ⚠️ Known: pushing a new package version while the Weather page is **on-screen** (its GIF actively reading the SD card) can crash `sdmmc_host_do_transaction` during bundle extraction (SD contention). The device auto-recovers — it reboots and loads the new version from SD. Not seen when another page is foreground during the push.

## Big Weather clock via custom font (2026-06-13)
- ✅ **Real larger clock font** `montserrat_80` (digits + colon, ~35KB) generated from LVGL's Montserrat-Medium.ttf with lv_font_conv, in a new `firmware/components/ccp_fonts` component; ui_renderer `parse_font` maps `"montserrat_80"`. Weather time now uses it (no transform-scale). Builder sim renders it via the existing `montserrat_(\d+)` fontPx rule. Device-verified: 80pt clock renders on a screen with the animated GIF, stable on boot, 0 crashes.
- ✅ Hardening: `wasm_engine` worker now holds an `exec_lock` mutex while inside a job; `unload_all` waits on it before deinstantiating, so a reload can't free a module out from under an in-flight `on_tick`.
- ⚠️ Live-OTA-push of a Weather update still briefly crashes + reboots when the Weather page (its GIF actively reading the SD card) is foreground during the unzip — SD bus contention in `sdmmc_host_do_transaction`. The device auto-recovers into the new version on reboot. Proper fix (pause the GIF / display before `sync_manager` extracts) is a follow-up.
