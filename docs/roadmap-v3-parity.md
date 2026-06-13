# Roadmap — V3 feature parity + new pages

_Created 2026-06-13. Source of truth for "what the device should do" vs. what's
built. Derived from the V3 reference UI
(`CryptoClockV3/.../V414_CDC/sd/4.1.4/System/website/settings.html`) and the
reference screenshots the user provided (pet / YouTube counter / BTC alert /
"Don't trust verify" profile clock / fortune menu)._

Legend: ✅ done · 🟡 partial · ⬜ not started

---

## 1. Per-page settings → User App (the big one)

The V3 `settings.html` exposes 4 tabs of settings. We want the **same controls**,
but driven by a per-page `settings_schema` so the User App + Admin web render the
form automatically (no app rebuild). Design is in
[settings-and-assets-plan.md](settings-and-assets-plan.md). **Status: ⬜ not built**
(layout schema has no `settings_schema` yet).

### Settings catalog to port (from the V3 reference)

**Profile tab** — nickname, position, company, motto; region (global/thailand);
timezone; contacts (email / LINE id / phone / WhatsApp); socials (YouTube,
Facebook, Instagram, TikTok URLs); wallets (BTC / USDT / CCT / PromptPay /
Stripe); colors (background, date-time, detail, motto, name/position/company);
profile image upload; show-toggle + duration(sec).

**Coin tab** — 4 coin slots, each: coin select, market select, currency select
(USD/EUR/THB/JPY/CNY/KRW/HKD/SGD/GBP/AUD/CAD/CHF/INR/IDR/MYR/LBP/LAK/USDT/USDC/SET),
type, indice; API config; per-slot colors; show-toggle + duration.

**Alert tab** — enable alerts; alert currency; 4 alert groups (coin + high/low
thresholds); lottery alert toggle.

**Page tab** — page mode; `dynamicPages` (which pages are in the rotation);
screensaver toggle + duration; CDC toggle + duration.

> Mapping to our model: each becomes a field in the page's `settings_schema`;
> values live in `settings.<page-slug>` (existing device settings JSON + MQTT
> push). Firmware exposes them to a page's wasm via reserved stream
> `settings.<slug>` (per the plan). Admin Fleet modal + Flutter render a
> `SchemaForm`. **Effort: large (schema + admin form renderer + Flutter dynamic
> form + firmware settings stream).**

---

## 2. Crypto coin logo (selected coin shown on screen)

- ✅ Native crypto page shows a coin logo from SD `/pages/crypto/assets/<base>.png`.
- ✅ **64×64 source + ESP32 auto-resize**: the logo widget now scales any source
  to its 36px slot via `lv_image_set_scale` (LVGL, no re-encode) — commit in this
  batch. Ship 64×64 PNGs; they fit automatically.
- ⬜ **Dynamic fetch when the app changes coin**: when a selected symbol has no
  logo on SD, fetch one and save it. Design: device downloads
  `https://assets.coincap.io/assets/icons/<base>@2x.png` (≈64px PNG) on a
  background worker (NOT the LVGL task — blocking HTTPS there trips the WDT),
  writes `/sd/pages/crypto/assets/<base>.png`, then the page re-renders. Trigger
  on symbol change / settings sync. (Alternative: a server endpoint
  `GET /api/v1/assets/coin/:base.png` that proxies+caches+resizes, so the device
  hits one trusted host — preferred for production.)

---

## 3. New pages requested (with specs from the reference screenshots)

All are buildable as **Builder packages** (layout + optional wasm) using the
existing pipeline + the new asset upload — except where they need a data feed or
a new widget. None need a firmware reflash unless a new native widget is required.

- ⬜ **Crypto "big number" page (non-chart)** — like the `HIGH:BTC … 1,800,000`
  and YouTube-counter screenshots: large 7-seg style number, label row, no
  candlestick. Doable now: labels + the `montserrat_80`/7-seg font, bindings to
  `market.<sym>.ticker`. Needs a 7-seg font asset (or reuse montserrat_80).
- ⬜ **Alert page** — like the `HIGH:BTC 00:00:00 / SNOOZE / DISMISS` screenshot:
  big coin/price, blinking time, two action buttons (snooze/dismiss → wasm
  events). Doable: labels + 2 buttons + wasm. (Native crypto already has an alert
  overlay; this is the standalone page version.)
- ⬜ **Profile page** — like "DON'T TRUST VERIFY / 9:41 / SATOSHI NAKAMOTO":
  avatar image (asset), big clock (wasm `ccp_time_unix` + `montserrat_80`),
  name/role lines from profile settings. Doable now.
- ⬜ **Pet page** — like the NOPPO pet screenshot: animated pet sprite (GIF
  asset), level label, a row of action icons (feed/clean/play/etc. as image
  buttons → wasm events that mutate pet state in `kv_*`). Needs pet GIFs +
  pet-state wasm. Medium.
- ⬜ **Fortune / ดูดวง (4 variants)** — like the HORO menu (TARO 3/5/7/DAILY):
  a menu page + 4 result pages. Needs a fortune data source (server feed or
  on-device RNG) + result text/images. Medium.
- ⬜ **Social page** — show follower/subscriber + total views with the
  YouTube-counter look. Needs a social-stats feed (see §4).

---

## 4. Follower count + total views (on every page)

- ⬜ A reserved data stream, e.g. `social.stats`, carrying
  `{youtube_subs, youtube_views, ...}`, published by a new server feeder that
  reads the YouTube Data API (and others) using the channel ids from the
  Profile settings. Any page binds labels to it (e.g. a small subs/views chip).
- Server: add to `FeedsService` a `social.*` fetcher (needs API keys in
  `.env`, per-device channel from settings). Device: subscribe + bind, same as
  weather/market.

---

## Suggested build order (each is its own session)

1. **settings_schema vertical slice** (§1) for ONE page (e.g. profile) →
   Admin form + Flutter form + device `settings.<slug>` — unblocks every page's
   configurability and the wallets/socials/colors catalog.
2. **Dynamic coin logo fetch** (§2) — finish the one concrete half-done feature.
3. **Profile + Crypto-big-number + Alert pages** (§3) — pure Builder packages,
   no firmware, reuse montserrat_80 + asset upload.
4. **social.stats feeder + Social page + follower/views chips** (§4).
5. **Pet + Fortune pages** (§3) — need state/data design.

> Reality check: this is multi-session work. This session delivered the docs +
> the coin-logo auto-resize; the rest is specced above so any contributor can
> pick up a numbered item.
