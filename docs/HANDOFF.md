# CryptoClock Pro — Handoff (2026-06-15)

Single source of truth for the next contributor (human or AI). Read this first,
then `docs/project-progress.md` and `docs/roadmap-v3-parity.md`.

## System map
- **firmware/** — ESP32-S3 (ESP-IDF 5.5, LVGL 9, WAMR). Device `ccp-983daee91478`,
  serial `/dev/cu.usbmodem21301` @115200. Build: `export IDF_PYTHON_ENV_PATH=~/.espressif/python_env/idf5.5_py3.9_env && . ~/esp/esp-idf/export.sh && idf.py build` then `idf.py -p /dev/cu.usbmodem21301 flash`.
- **server/apps/api** — NestJS Hub (:4000). `cd server && pnpm --filter @ccp/api dev`. Prisma + Stripe + MQTT.
- **server/apps/web** — Next.js admin + **Builder** (:3000). `pnpm --filter @ccp/web dev`. Auto-deploys to Vercel on push to `origin/main` (`cryptoclocks/2026-Pro` → `2026-pro-psi.vercel.app`).
- **mobile/user-app** — Flutter (3.44). Android `com.cryptoclock.ccp_user_app`. Build: `flutter build apk --debug` then `adb install -r build/app/outputs/flutter-apk/app-debug.apk`. **secrets.dart is gitignored** (Supabase + Hub URL + Google web client id); it holds the Supabase anon key — NEVER commit it. Before every push, secret-scan the diff for the known canary fragment (recorded in the local memory note `cryptoclock-pro-project` / `push-after-big-changes`, not repeated here) — it must return 0.

## Builder data model (key to most pending work)
- A package = `pages[]` (multi-page, added this session). Store: `server/apps/web/components/builder/store.ts` (`pages`, `currentPageId`, `addPage/switchPage/renamePage/removePage/syncedPages`, `widgets` = current page's working copy).
- Templates: `components/builder/templates.ts` (single-page = `widgets`; multi-page adds `pages`). The **Profile** template is multi-page (main + 4 social pages).
- Canvas/Sim: `components/builder/BuilderCanvas.tsx` (renders widgets, click→`select`/actions; `page.show` navigates sim page). Sim runtime: `components/builder/wasmSim.ts` (`applyBindings` handles text/value/series/src/**style.text_color/style.bg_color**; settings.<slug> seeded).
- Export: `components/builder/exportLayout.ts` (emits all pages). Layout schema (Zod): `server/packages/shared/src/layout.ts` (widget types, `ActionSchema` do-enum incl `page.show`/`widget.set`, style incl `bg_image`).
- Firmware renderer: `firmware/components/ui_renderer/ui_renderer.c` — `build_widget_tree`, `apply_binding` (BIND_TEXT/VALUE/VISIBLE/SRC/SERIES/STYLE_TEXT_COLOR/STYLE_BG_COLOR), `run_action` (page.show/widget.set/wasm.event/...), `find_asset`. Asset pipeline: `firmware/components/sync_manager`.
- Per-page settings: admin declares `settings_schema` in Builder → publish → app/Fleet edit values → MQTT → firmware `deliver_page_settings()` feeds `settings.<slug>` → bindings update. Slug = package id after last dot.

## Verified working (this session)
- Multi-page packages + lazy-swap rotation on device (≤5 pages, one loaded at a time).
- Builder: page tabs, edit each page, `page.show` nav in Sim + device.
- **Inspector fix**: clicking a widget now selects it (added a 4px drag activation constraint to DndContext — `app/builder/page.tsx`).
- Profile page: avatar + 4 social buttons are **image widgets**; firmware makes any action-bearing widget `CLICKABLE` (`ui_renderer.c`).
- **Per-part colours** editable from app: bg/name/role/company/verify bind to `settings.profile.*_color` (firmware already supports style colour bindings). App has a Colours card with live-swatch hex fields (`mobile/user-app/lib/settings_pages.dart`).
- Profile **Motto** is now separate from Role. User App and Admin Fleet settings save `settings.profile.motto`; Profile bundle `com.ccp.profile` **1.0.9** binds the top-right label to `motto`, while Role remains the lower-left subtitle.
- Profile avatar upload is wired in User App: picks/crops/resizes to 132x132 PNG, uploads to `pages/profile/assets/avatar.png`, and binds `settings.profile.avatar`. Firmware can resolve dynamic SD-relative image paths.
- Social QR pages bind QR `data` from User-App/Admin URLs and show the platform logo centered over each QR. Social detail pages now have per-platform colour themes (Facebook blue/white, YouTube red, TikTok dark/cyan, Instagram pink), and follower/secondary metric labels bind to `settings.profile.{fb,yt,tt,ig}_followers`, `_following`, `_secondary_label`.
- Hub API has a best-effort public social resolver: `POST /api/v1/social/resolve` (URL fetch, allowlisted social hosts) and `POST /api/v1/social/parse` (provided/rendered HTML). Admin Fleet and User App Profile settings can refresh social stats from URLs and save them into device profile settings. Facebook mobile public HTML exposes `og:*` metadata reliably for `likes`/`talkingAbout`; rendered desktop snippets can expose exact `followers`/`following` when available.
- Slideshow manager previews uploaded SD photos via device `/api/v1/file?path=...`; firmware local API serves files with MIME types.
- App **WelcomeScreen + login gate** (`mobile/user-app/lib/main.dart` `AuthGate`/`WelcomeScreen`; logout returns to gate). Verified on the Samsung device.
- Google Sign-In (native idToken) in app — works once the Google **Android** OAuth client (pkg `com.cryptoclock.ccp_user_app` + debug SHA-1 `32:39:BF:A3:0D:0D:7A:E0:D1:E7:76:F1:16:0A:FA:C3:60:68:FE:88`) propagates. Web client id is in `secrets.dart` as `googleWebClientId`.
- Admin/Web :3000 500/`_next/static` 404 was a stale `.next` dev cache (`Cannot find module './859.js'`). Cache was moved aside and dev server restarted; localhost `/` verifies `200` and Browser console is clean.

## PENDING — specs for the next contributor

### 1. Widget image source = file picker + mode + resize-on-publish + static/dynamic (BIG)
Today a widget's image `src` is a text field (paste a path). Required behaviour:
- **Pick a file** in the Inspector (file input, not paste) — reuse the Assets-panel upload flow (`app/builder/page.tsx` `AssetsPanel` / store `addAsset`; `AssetEntry` has base64 `src`). Wire the Inspector's image `src` field to open a file picker and create an asset, then set the widget's `props.src` to that asset id.
- **Image mode**: add a prop (e.g. `props.fit` = `cover` (fill widget) | `contain` (center/fit)). Render it in BuilderCanvas (`object-fit`) and in firmware (`lv_image_set_inner_align` + scale; see the native crypto coin-logo code in `home_ui.c` `crypto_update_header` for the resize/align pattern).
- **Resize on publish → SD**: on publish, each referenced image must be resized to the widget's `w×h` and shipped in the bundle so the device shows it 1:1. The server has **`sharp@0.34.5`** installed (image resize) — do the resize in the publish path (`server/apps/api/src/payloads/payloads.service.ts` `publishCompiled`, which already bundles `assetFiles` into `bundle.zip`). Device extracts assets via `sync_manager`.
- **static vs dynamic** per image widget: add a prop (e.g. `props.image_mode = "static" | "dynamic"`).
  - **static** (e.g. the 4 social logos): baked into the bundle, user can't change.
  - **dynamic** (e.g. the profile avatar): user picks a file in the **User App** → uploaded to the device SD as the widget's asset → `src` bound to `settings.<slug>.<key>`. The app already uploads images for the slideshow (`mobile/user-app/lib/slideshow_manager.dart`, `image_picker` + `image` deps + device `/api/v1/...` upload) — reuse that pipeline. Firmware `apply_binding` BIND_SRC already swaps an image from a settings value; make it empty-safe (keep default if the asset is missing).

### 2. Font/position mismatch: clock sits lower in the web Builder than on the device
The montserrat_80 clock renders at a different vertical position in the web artboard vs LVGL on the device (CSS font baseline/line-height ≠ LVGL font metrics). Fix options, pick one:
- Make BuilderCanvas render big fonts with the same baseline/line-height LVGL uses (per-font vertical offset table), OR
- Add a per-font render correction in `BuilderCanvas.tsx` `WidgetInner`/`fontPx` so montserrat_80/48 match the device, OR
- Document the offset and adjust template `y`. The device line-heights are known from serial `widgets` (montserrat_80 lh≈58 in a 92px box). Verify by comparing a serial `widgets` dump to the web artboard at the same y.

### 3. Carry-over (roadmap-v3-parity.md)
Official/API-backed social stats (Meta/YouTube/TikTok/Instagram tokens and permissions for exact counts), dynamic coin-logo fetch, the other new pages (alert/pet/fortune×4/social).

## How to verify
- Web: dev server :3000 (HMR) or push → Vercel. Load a template in Builder, Simulate, drive via DOM/preview tools.
- Firmware: flash, then serial console (`pages`, `goto <id>`, `widgets`, `heap`, `ver`).
- Mobile: `flutter build apk --debug` + `adb install -r`; screenshot via `adb exec-out screencap -p`.

## Gotchas (do not regress)
- Internal DRAM is tight — never add internal task stacks / move boot allocs earlier (hangs boot on "Starting…" or OOMs MQTT). See `docs/project-progress.md`.
- pnpm strict node_modules: `express` is a direct dep of the API now (was transitive); if the API won't boot run `pnpm install --force` + `pnpm --filter @ccp/api prisma:generate`.
- Push significant commits to `origin/main` (auto-deploys); secret-scan first.
