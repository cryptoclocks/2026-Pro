# AI Handoff Prompt — CryptoClock Pro

Paste the block below to another AI assistant so it can continue this project
when the current model runs out of quota. Then attach (or let it read) the repo.

---

## PROMPT (copy from here)

You are a Senior Embedded + Full-Stack engineer taking over **CryptoClock Pro**, a
commercial IoT display platform. Read `docs/project-overview.md` and
`docs/project-progress.md` first — they are the source of truth. Work in small,
verified steps; build/flash/test before claiming done; commit with clear messages.

### The product
ESP32-S3 touchscreen (board JC3248W535C, panel used landscape **480×320**) showing
swipeable pages (Clock / Crypto candlestick / Photo slideshow / purchasable extras).
Configured via a Flutter app (LAN) and a Next.js admin web; pages/config delivered
over MQTT; extra pages sold via Stripe. Three codebases: `firmware/`, `server/`
(NestJS API + Next.js web + shared zod schema), `mobile/user-app` (Flutter).

### Environment / how to run
- Firmware: `source ~/esp/esp-idf/export.sh` then `cd firmware && idf.py build` and
  `idf.py -p /dev/cu.usbmodem11301 flash`. Board id `ccp-983daee91478`.
  Console is USB-Serial-JTAG; capture serial with pyserial at 115200 (toggle DTR/RTS
  to reset). `grep` for the `EXIT:` line — build "failed" notifications can be false.
- Hub: `cd server && pnpm dev` → API `:4000`, web `:3000`. Postgres via Homebrew
  (`brew services start postgresql@16`; psql at `/opt/homebrew/opt/postgresql@16/bin`;
  db `cryptoclock`, role `ccp`). Prisma migrate after schema edits.
- App: `cd mobile/user-app && flutter build apk --release`;
  install with `~/Library/Android/sdk/platform-tools/adb -s R5CY50MEVBN install -r <apk>`.
- MQTT broker (already running, user-owned): `mqtt://node-red.cashlessthailand.com:1883`.

### Where things live
- Built-in pages: `firmware/components/home_ui/home_ui.c` (one file: clock/crypto/slideshow).
- User-editable firmware defaults: `firmware/main/user_config.h`.
- API modules: `server/apps/api/src/{auth,devices,marketplace,features,billing,mqtt}`.
- Web admin: `server/apps/web/app/{page,login,users,approvals,store,builder}`.
- Builder internals: `server/apps/web/components/builder/*`.
- App screens: `mobile/user-app/lib/*` (device_controller, settings_pages, store_screen, hub_api, auth).

### HARD RULES (do not regress — these were hard-won)
1. **Slideshow images must be PNG.** LVGL's tjpgd (JPEG) renders blank on this panel;
   lodepng (PNG) works. Seed = placehold.co PNG; app re-encodes uploads to 480×320 PNG.
2. `CONFIG_LV_CACHE_DEF_SIZE` must be non-zero (3MB), `CONFIG_FATFS_LFN_HEAP=y`,
   `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y` (TLS from PSRAM, else HTTPS dies -0x7F00).
3. Never delete LVGL's active screen — `home_ui_reload()` parks on a blank screen first,
   else the render task spins → task_wdt.
4. Never do UI/MQTT/httpd work in WiFi event handlers (tiny stack → crash loop);
   use `net_worker_task` + event group.
5. Internal DIRAM ~334KB only — keep big buffers (images, candle canvas) in PSRAM.
6. AXS15231B driver `disp_on_off` semantics were inverted vs esp_lcd and fixed in our
   copy — black screen? check that first.
7. `@ccp/shared` must stay CJS-compatible (NestJS `require`); no `"type":"module"`.
8. **Secrets are gitignored and must never be committed:** `mobile/**/lib/secrets.dart`,
   `server/**/.env*`. Always scan `git diff --cached` for the Supabase anon key before
   pushing. Token-in-URL git pushes are blocked by policy — use `gh auth login`.

### Config & data model
- Config precedence: server settings > SD `device.json` > per-page `config.json` > `user_config.h`.
  Device re-syncs from server every boot. Push settings: `PUT /api/v1/devices/{id}/settings`.
- Auth: Supabase email OTP; admin = email in `ADMIN_EMAILS` (`server/.env`). Guards in
  `auth/auth.guards.ts`. RBAC: admin endpoints under `/admin/*` and `/me/*` (user).
- Billing: Stripe checkout → webhook → `Entitlement(user×MarketplaceItem)` → MQTT sync.
- Optional features (e.g. crypto alerts) need **manual admin approval**:
  app `POST /me/feature-requests` → web `/approvals` → approve merges into device settings.

### Suggested next work (see project-progress.md 🟡/⬜)
- M5: stand up object store (MinIO/S3) so the Builder's Publish actually delivers OTA
  page bundles to devices (package → upload → assign → cmd:sync → device renders layout.json).
- Implement real widget rendering in `ui_renderer` for server layouts + WASM host bindings.
- Deploy Hub to Vercel + Supabase (env wiring is documented); production MQTT TLS (8883).
- Build iOS app; finish the admin fleet app.
- Wire Stripe live keys; verify checkout→entitlement→device end-to-end.

Always confirm changes on real hardware/servers where possible, keep secrets out of
git, and update `docs/project-progress.md` as you complete items.

## (end prompt)
