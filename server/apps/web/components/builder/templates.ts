import type { WidgetNode } from "@ccp/shared";

export type TemplateKey = "blank" | "clock" | "crypto" | "crypto_big" | "slideshow" | "weather" | "profile" | "welcome" | "led_toggle";

export const PROFILE_SOCIAL_ASSETS = [
  { id: "profile_avatar", type: "image" as const, path: "assets/profile/avatar.png", src: "/profile-social/avatar.png" },
  { id: "profile_fb", type: "image" as const, path: "assets/profile/fb.png", src: "/profile-social/fb.png" },
  { id: "profile_yt", type: "image" as const, path: "assets/profile/yt.png", src: "/profile-social/yt.png" },
  { id: "profile_tt", type: "image" as const, path: "assets/profile/tt.png", src: "/profile-social/tt.png" },
  { id: "profile_ig", type: "image" as const, path: "assets/profile/ig.png", src: "/profile-social/ig.png" },
  { id: "profile_qr_fb", type: "image" as const, path: "assets/profile/qr-fb.png", src: "/profile-social/qr-fb.png" },
  { id: "profile_qr_yt", type: "image" as const, path: "assets/profile/qr-yt.png", src: "/profile-social/qr-yt.png" },
  { id: "profile_qr_tt", type: "image" as const, path: "assets/profile/qr-tt.png", src: "/profile-social/qr-tt.png" },
  { id: "profile_qr_ig", type: "image" as const, path: "assets/profile/qr-ig.png", src: "/profile-social/qr-ig.png" },
] as const;

export const SLIDESHOW_ASSETS = [
  { id: "slideshow_sample1", type: "image" as const, path: "assets/slideshow/sample1.png", src: "/slideshow-samples/sample1.png" },
  { id: "slideshow_sample2", type: "image" as const, path: "assets/slideshow/sample2.png", src: "/slideshow-samples/sample2.png" },
  { id: "slideshow_sample3", type: "image" as const, path: "assets/slideshow/sample3.png", src: "/slideshow-samples/sample3.png" },
] as const;

const SOCIAL_PAGE_THEMES = {
  fb: { bg: "#3B6FD6", accent: "#1877F2", text: "#0B1F33", muted: "#35506A", card: "#FFFFFF", border: "#B7D6FF" },
  yt: { bg: "#A8ADB4", accent: "#FF0000", text: "#241010", muted: "#6B3940", card: "#FFFFFF", border: "#FFD0D0" },
  tt: { bg: "#101216", accent: "#22D3EE", text: "#FFFFFF", muted: "#81A9AF", card: "#111418", border: "#26464D" },
  ig: { bg: "#C13584", accent: "#C13584", text: "#2A1020", muted: "#70405B", card: "#FFFFFF", border: "#F4C0D8" },
} as const;

/** A bottom-right social button (image) on the main profile page that navigates
 *  to that platform's detail page. It uses a built-in PNG asset by default so
 *  the template previews and the published bundle both show the logo. */
function socialNavButton(id: string, x: number, bg: string): WidgetNode {
  return {
    type: "image", id: `btn_${id}`, x, y: 262, w: 48, h: 48,
    props: { src: `profile_${id}` },
    style: { bg_color: bg, radius: 24 },
    actions: [{ on: "clicked", do: "page.show", target: `social_${id}` }],
  };
}

/** A full social detail page: title, followers/likes (mock), a QR to the link,
 *  and a Back button to the main profile page. Widget ids are platform-prefixed
 *  so they stay unique across pages. */
function socialPage(
  id: keyof typeof SOCIAL_PAGE_THEMES, bg: string, label: string, followers: string, likes: string, url: string,
): { id: string; name: string; widgets: WidgetNode[] } {
  const qrSize = 140;
  const logoSize = 34;
  const theme = SOCIAL_PAGE_THEMES[id];
  return {
    id: `social_${id}`,
    name: label,
    widgets: [
      { type: "label", id: `${id}_bg`, x: 0, y: 0, w: 480, h: 320, props: { text: "" }, style: { bg_color: theme.bg } },
      {
        type: "button", id: `${id}_back`, x: 12, y: 12, w: 104, h: 40, props: { text: "< Back" },
        style: { bg_color: theme.card, text_color: theme.accent, radius: 10, border_width: 1, border_color: theme.border, font: "montserrat_20" },
        actions: [{ on: "clicked", do: "page.show", target: "main" }],
      },
      { type: "label", id: `${id}_title`, x: 20, y: 66, w: 300, h: 40, props: { text: label }, style: { text_color: theme.accent, align: "left", font: "montserrat_28" } },
      { type: "label", id: `${id}_fl`, x: 20, y: 126, w: 240, h: 22, props: { text: "Followers" }, style: { text_color: theme.muted, align: "left", font: "montserrat_20" } },
      {
        type: "label", id: `${id}_fv`, x: 20, y: 150, w: 260, h: 40, props: { text: followers }, style: { text_color: theme.text, align: "left", font: "montserrat_28" },
        bindings: [{ prop: "text", source: "settings", path: `${id}_followers` }],
      },
      {
        type: "label", id: `${id}_ll`, x: 20, y: 202, w: 240, h: 22, props: { text: "Following" }, style: { text_color: theme.muted, align: "left", font: "montserrat_20" },
        bindings: [{ prop: "text", source: "settings", path: `${id}_secondary_label` }],
      },
      {
        type: "label", id: `${id}_lv`, x: 20, y: 226, w: 260, h: 40, props: { text: likes }, style: { text_color: theme.text, align: "left", font: "montserrat_28" },
        bindings: [{ prop: "text", source: "settings", path: `${id}_following` }],
      },
      {
        type: "qrcode", id: `${id}_qr`, x: 322, y: 92, w: qrSize, h: qrSize,
        props: { data: url, size: qrSize },
        style: {},
        bindings: [{ prop: "data", source: "settings", path: `${id}_url` }],
      },
      {
        type: "image", id: `${id}_qr_logo`, x: 322 + (qrSize - logoSize) / 2, y: 92 + (qrSize - logoSize) / 2, w: logoSize, h: logoSize,
        props: { src: `profile_qr_${id}` },
        style: { bg_color: bg, radius: 8, pad: 3 },
      },
    ],
  };
}

const PROFILE_SOCIAL_BTNS: WidgetNode[] = [
  socialNavButton("fb", 256, "#1877F2"),
  socialNavButton("yt", 312, "#FF0000"),
  socialNavButton("tt", 368, "#111418"),
  socialNavButton("ig", 424, "#C13584"),
];

/** Main profile page widgets (avatar, big clock, motto, name/role/company + social nav). */
const PROFILE_MAIN_WIDGETS: WidgetNode[] = [
  {
    type: "label", id: "bg", x: 0, y: 0, w: 480, h: 320, props: { text: "" },
    style: { bg_color: "#0B0E11" },
    bindings: [{ prop: "style.bg_color", source: "settings", path: "bg_color" }],
  },
  {
    type: "image", id: "avatar", x: 24, y: 30, w: 132, h: 132,
    props: { src: "profile_avatar" },
    style: { bg_color: "#161B22", radius: 66, border_width: 2, border_color: "#F0B90B" },
    bindings: [{ prop: "src", source: "settings", path: "avatar" }],
  },
  {
    type: "label", id: "motto", x: 172, y: 28, w: 286, h: 22, props: { text: "DON'T TRUST  VERIFY" },
    style: { text_color: "#F0B90B", align: "right", font: "montserrat_20" },
    bindings: [
      { prop: "text", source: "settings", path: "motto" },
      { prop: "style.text_color", source: "settings", path: "verify_color" },
    ],
  },
  { type: "label", id: "time", x: 172, y: 52, w: 286, h: 92, props: { text: "00:00" }, style: { text_color: "#EAECEF", align: "right", font: "montserrat_80" } },
  {
    type: "label", id: "name", x: 24, y: 176, w: 360, h: 36, props: { text: "SATOSHI NAKAMOTO" },
    style: { text_color: "#EAECEF", align: "left", font: "montserrat_28" },
    bindings: [
      { prop: "text", source: "settings", path: "nickname" },
      { prop: "style.text_color", source: "settings", path: "name_color" },
    ],
  },
  {
    type: "label", id: "role", x: 24, y: 214, w: 360, h: 24, props: { text: "(SAT) CYPHERPUNK" },
    style: { text_color: "#848E9C", align: "left", font: "montserrat_20" },
    bindings: [
      { prop: "text", source: "settings", path: "role" },
      { prop: "style.text_color", source: "settings", path: "role_color" },
    ],
  },
  {
    type: "label", id: "company", x: 24, y: 240, w: 220, h: 22, props: { text: "Acme Capital" },
    style: { text_color: "#F0B90B", align: "left", font: "montserrat_20" },
    bindings: [
      { prop: "text", source: "settings", path: "company" },
      { prop: "style.text_color", source: "settings", path: "company_color" },
    ],
  },
  ...PROFILE_SOCIAL_BTNS,
];

/** Profile = main page + one detail page per platform (page.show navigation). */
const PROFILE_PAGES = [
  { id: "main", name: "Profile", widgets: PROFILE_MAIN_WIDGETS },
  socialPage("fb", "#1877F2", "Facebook", "12,345", "6,789", "https://facebook.com/yourpage"),
  socialPage("yt", "#FF0000", "YouTube", "98,765", "45,210", "https://youtube.com/@yourchannel"),
  socialPage("tt", "#22D3EE", "TikTok", "54,321", "210,987", "https://tiktok.com/@yourhandle"),
  socialPage("ig", "#C13584", "Instagram", "23,456", "33,012", "https://instagram.com/yourhandle"),
];

/** Starter layouts. Most are single-page (`widgets`); `pages` adds extra pages
 *  reachable with page.show (the profile's per-platform social pages). */
export const TEMPLATES: Record<TemplateKey, { name: string; widgets: WidgetNode[]; pages?: { id: string; name: string; widgets: WidgetNode[] }[] }> = {
  blank: { name: "Blank", widgets: [] },

  /* Mirrors the native clock page (home_ui.c): date above, big time, small
     orange seconds at the minutes' baseline, 48x48 brand logo bottom-center.
     Driven by CLOCK_LOGIC_SOURCE (real wasm) — not by mock bindings. */
  clock: {
    name: "Clock",
    widgets: [
      {
        type: "label", id: "date", x: 40, y: 92, w: 400, h: 26,
        props: { text: "Wednesday  11 Jun 2026" },
        style: { text_color: "#848E9C", align: "center", font: "montserrat_20" },
      },
      {
        type: "label", id: "time", x: 40, y: 126, w: 400, h: 60,
        props: { text: "--:--" },
        style: { text_color: "#00D1FF", align: "center", font: "montserrat_48" },
      },
      {
        type: "label", id: "sec", x: 318, y: 160, w: 40, h: 26,
        props: { text: "" },
        style: { text_color: "#FF9500", align: "left", font: "montserrat_20" },
      },
      {
        type: "image", id: "logo", x: 216, y: 266, w: 48, h: 48,
        props: { src: "A:/pages/clock/assets/logo.png" }, style: {},
      },
    ],
  },

  /* Faithful copy of the native crypto page (home_ui.c build_crypto_page):
     symbol-cycle button, USD/THB toggle, live dot, 48pt price, 24h change,
     444x130 candlestick canvas (drawn by CRYPTO_LOGIC_SOURCE wasm), timeframe
     cycle button, "Binance · live" status. Same colors/positions as the C code. */
  crypto: {
    name: "Crypto",
    widgets: [
      {
        type: "button", id: "sym_btn", x: 50, y: 8, w: 150, h: 36,
        props: { text: "BTC/USDT" },
        style: { bg_color: "#161B22", text_color: "#EAECEF", radius: 8, border_width: 1, border_color: "#2B3139", font: "montserrat_20" },
        actions: [{ on: "clicked", do: "wasm.event", target: "logic", event_id: 101 }],
      },
      {
        type: "button", id: "cur_btn", x: 366, y: 8, w: 58, h: 32,
        props: { text: "USD" },
        style: { bg_color: "#161B22", text_color: "#F0B90B", radius: 8, border_width: 1, border_color: "#F0B90B" },
        actions: [{ on: "clicked", do: "wasm.event", target: "logic", event_id: 102 }],
      },
      {
        type: "led", id: "dot", x: 208, y: 22, w: 10, h: 10,
        props: { on: false, color: "#848E9C" }, style: {},
      },
      {
        type: "label", id: "price", x: 18, y: 58, w: 444, h: 58,
        props: { text: "--" },
        style: { text_color: "#EAECEF", align: "left", font: "montserrat_48" },
      },
      {
        type: "label", id: "change", x: 20, y: 116, w: 280, h: 26,
        props: { text: "loading..." },
        style: { text_color: "#848E9C", align: "left", font: "montserrat_20" },
      },
      {
        type: "canvas", id: "candles", x: 18, y: 152, w: 444, h: 130,
        props: {}, style: { bg_color: "#161B22", radius: 12, border_width: 1, border_color: "#2B3139" },
      },
      {
        type: "button", id: "tf_btn", x: 16, y: 286, w: 64, h: 30,
        props: { text: "15m" },
        style: { bg_color: "#161B22", text_color: "#EAECEF", radius: 8, border_width: 1, border_color: "#2B3139" },
        actions: [{ on: "clicked", do: "wasm.event", target: "logic", event_id: 103 }],
      },
      {
        type: "label", id: "updated", x: 280, y: 286, w: 184, h: 18,
        props: { text: "connecting..." },
        style: { text_color: "#848E9C", align: "right" },
      },
    ],
  },

  /* "Big number" crypto page (non-chart): just the pair, a huge live price and
     the 24h change. Bindings-only (no wasm) — price/change come straight from
     the market.<sym>.ticker stream (priceFmt / change are top-level so the
     device's jsonpath and the browser sim both resolve them). */
  crypto_big: {
    name: "Crypto Big",
    widgets: [
      {
        type: "label", id: "bg", x: 0, y: 0, w: 480, h: 320,
        props: { text: "" }, style: { bg_color: "#0B0E11" },
      },
      {
        type: "label", id: "pair", x: 40, y: 44, w: 400, h: 34,
        props: { text: "BTC / USDT" },
        style: { text_color: "#848E9C", align: "center", font: "montserrat_28" },
      },
      {
        type: "label", id: "price", x: 20, y: 112, w: 440, h: 64,
        props: { text: "$--" },
        style: { text_color: "#EAECEF", align: "center", font: "montserrat_48" },
        bindings: [{ prop: "text", source: "btc", path: "priceFmt", format: "$%s" }],
      },
      {
        type: "label", id: "change", x: 20, y: 190, w: 440, h: 40,
        props: { text: "--" },
        style: { text_color: "#0ECB81", align: "center", font: "montserrat_28" },
        bindings: [{ prop: "text", source: "btc", path: "change" }],
      },
      {
        type: "label", id: "caption", x: 20, y: 236, w: 440, h: 24,
        props: { text: "24h change" },
        style: { text_color: "#848E9C", align: "center", font: "montserrat_20" },
      },
    ],
  },

  /* Cute animated Weather page. Background is a full-screen panel whose color
     follows the weather theme (binding style.bg_color ← weather.bg); the icon is
     an animated Lottie→GIF (src ← weather.icon); the big clock is wasm-driven;
     city/temp/humidity/desc come from bindings on stream weather.bangkok.
     (No canvas — keeps memory free so the clock can transform-scale safely.) */
  weather: {
    name: "Weather",
    widgets: [
      {
        // full-screen themed background; initial bg_color sets bg_opa=COVER so
        // the runtime style.bg_color binding stays visible
        type: "label", id: "bg", x: 0, y: 0, w: 480, h: 320,
        props: { text: "" }, style: { bg_color: "#27384B" },
        bindings: [{ prop: "style.bg_color", source: "weather", path: "bg" }],
      },
      {
        // animated weather icon (Lottie→GIF); src swaps to the asset matching
        // weather.icon (clear/partly/cloudy/rain/thunder/snow/fog)
        type: "gif", id: "icon", x: 286, y: 70, w: 160, h: 160,
        props: { src: "clear" }, style: {},
        bindings: [{ prop: "src", source: "weather", path: "icon" }],
      },
      {
        type: "label", id: "city", x: 18, y: 16, w: 280, h: 24,
        props: { text: "Bangkok" },
        style: { text_color: "#FFFFFF", align: "left", font: "montserrat_20", opa: 220 },
        bindings: [{ prop: "text", source: "weather", path: "city" }],
      },
      {
        // big clock: custom montserrat_80 font (digits + colon baked into the
        // firmware's ccp_fonts component), driven by wasm. A real larger font
        // instead of transform-scale, which crashes LVGL alongside a GIF.
        type: "label", id: "time", x: 18, y: 36, w: 320, h: 92,
        props: { text: "--:--" },
        style: { text_color: "#FFFFFF", align: "left", font: "montserrat_80", opa: 235 },
      },
      {
        type: "label", id: "temp", x: 18, y: 140, w: 220, h: 40,
        props: { text: "31°C" },
        style: { text_color: "#FFFFFF", align: "left", font: "montserrat_28", opa: 235 },
        bindings: [{ prop: "text", source: "weather", path: "temp" }],
      },
      {
        type: "label", id: "desc", x: 18, y: 190, w: 260, h: 22,
        props: { text: "Partly cloudy" },
        style: { text_color: "#EAF2FF", align: "left", font: "montserrat_20", opa: 210 },
        bindings: [{ prop: "text", source: "weather", path: "desc" }],
      },
      {
        type: "label", id: "humidity", x: 18, y: 216, w: 260, h: 22,
        props: { text: "Humidity 68%" },
        style: { text_color: "#EAF2FF", align: "left", font: "montserrat_20", opa: 210 },
        bindings: [{ prop: "text", source: "weather", path: "humidity", format: "Humidity %s" }],
      },
    ],
  },

  /* "Don't trust, verify" profile: a main page (avatar, big clock, motto, name/role/
     company from settings.profile) with 4 social buttons bottom-right; each
     navigates (page.show) to that platform's own detail page (followers/likes
     mock + QR + Back). Multi-page — designed one page at a time in the Builder. */
  profile: {
    name: "Profile",
    widgets: PROFILE_MAIN_WIDGETS,
    pages: PROFILE_PAGES,
  },

  /* Native-style slideshow starter: a full-screen photo slot backed by the
     same asset pipeline as the mobile app's slideshow manager. */
  slideshow: {
    name: "Slideshow",
    widgets: [
      {
        type: "image", id: "photo", x: 0, y: 0, w: 480, h: 320,
        props: { src: "slideshow_sample1" }, style: {},
      },
    ],
  },

  welcome: {
    name: "Welcome",
    widgets: [
      {
        type: "image", id: "logo", x: 200, y: 70, w: 80, h: 80,
        props: { src: "A:/pages/clock/assets/logo.png" }, style: {},
      },
      {
        type: "label", id: "hello", x: 40, y: 170, w: 400, h: 40,
        props: { text: "Welcome to CryptoClock" },
        style: { text_color: "#15C3A6", align: "center" },
      },
    ],
  },

  led_toggle: {
    name: "LED Toggle",
    widgets: [
      {
        type: "label", id: "title", x: 40, y: 22, w: 400, h: 34,
        props: { text: "LED Toggle Demo" },
        style: { text_color: "#EAECEF", align: "center", font: "montserrat_28" },
      },
      {
        type: "led", id: "led_1", x: 110, y: 92, w: 64, h: 64,
        props: { on: false, color: "#0ECB81", brightness: 255 },
        style: {},
      },
      {
        type: "led", id: "led_2", x: 306, y: 92, w: 64, h: 64,
        props: { on: false, color: "#F0B90B", brightness: 255 },
        style: {},
      },
      {
        type: "button", id: "btn_1", x: 72, y: 190, w: 140, h: 54,
        props: { text: "Toggle LED 1", checkable: true, checked: false },
        style: { bg_color: "#18232A", text_color: "#EAECEF", radius: 8 },
        actions: [{ on: "clicked", do: "wasm.event", target: "logic", event_id: 101 }],
      },
      {
        type: "button", id: "btn_2", x: 268, y: 190, w: 140, h: 54,
        props: { text: "Toggle LED 2", checkable: true, checked: false },
        style: { bg_color: "#221E12", text_color: "#EAECEF", radius: 8 },
        actions: [{ on: "clicked", do: "wasm.event", target: "logic", event_id: 102 }],
      },
    ],
  },
};

/** Mock data used to simulate bindings in the browser preview. */
export const MOCK: Record<string, Record<string, unknown>> = {
  clock: { hhmm: "14:30", date: "Tue 10 Jun 2026", seconds: "42" },
  crypto: {
    "BTCUSDT.price": "64,231.50",
    "BTCUSDT.change": "+2.4%",
    "ETHUSDT.price": "3,180.25",
  },
  weather: { temp: "31°C", city: "Bangkok", desc: "Partly cloudy" },
  device: { name: "Lobby display", battery: "92%" },
};
