import type { WidgetNode } from "@ccp/shared";

export type TemplateKey = "blank" | "clock" | "crypto" | "crypto_big" | "weather" | "profile" | "welcome" | "led_toggle";

/** One social button (bottom-right) + its info card + QR, all toggled by
 *  widget.set visibility. Followers/likes are mock for now; the QR data is the
 *  link the User App will set per platform. */
function socialButton(
  id: string, x: number, bg: string, glyph: string,
  label: string, followers: string, likes: string, url: string,
): WidgetNode[] {
  const others = ["fb", "yt", "tt", "ig"].filter((p) => p !== id);
  const hideOthers = others.flatMap((p) => [
    { on: "clicked" as const, do: "widget.set" as const, target: `pop_${p}_card`, key: "visible", value: "0" },
    { on: "clicked" as const, do: "widget.set" as const, target: `pop_${p}_qr`, key: "visible", value: "0" },
  ]);
  return [
    {
      type: "button", id: `btn_${id}`, x, y: 262, w: 48, h: 48,
      props: { text: glyph },
      style: { bg_color: bg, text_color: "#FFFFFF", radius: 24, font: "montserrat_20", border_width: 0 },
      actions: [
        { on: "clicked", do: "widget.set", target: `pop_${id}_card`, key: "visible", value: "1" },
        { on: "clicked", do: "widget.set", target: `pop_${id}_qr`, key: "visible", value: "1" },
        { on: "clicked", do: "widget.set", target: "pop_close", key: "visible", value: "1" },
        ...hideOthers,
      ],
    },
    {
      // info card: title + followers + likes (mock) baked into one label
      type: "label", id: `pop_${id}_card`, x: 40, y: 60, w: 250, h: 196,
      props: { text: `${label}\n\nFollowers\n${followers}\n\nLikes\n${likes}` },
      style: { bg_color: "#161B22", text_color: "#EAECEF", radius: 14, border_width: 1, border_color: bg, align: "center", font: "montserrat_20" },
      hidden: true,
    },
    {
      type: "qrcode", id: `pop_${id}_qr`, x: 308, y: 96, w: 128, h: 128,
      props: { data: url, size: 128 }, style: {},
      hidden: true,
    },
  ];
}

const PROFILE_SOCIAL: WidgetNode[] = [
  ...socialButton("fb", 256, "#1877F2", "f", "Facebook", "12,345", "6,789", "https://facebook.com/yourpage"),
  ...socialButton("yt", 312, "#FF0000", ">", "YouTube", "98,765", "45,210", "https://youtube.com/@yourchannel"),
  ...socialButton("tt", 368, "#111418", "T", "TikTok", "54,321", "210,987", "https://tiktok.com/@yourhandle"),
  ...socialButton("ig", 424, "#C13584", "O", "Instagram", "23,456", "33,012", "https://instagram.com/yourhandle"),
];

/** Starter layouts — the "old pages" a designer can load and tweak. */
export const TEMPLATES: Record<TemplateKey, { name: string; widgets: WidgetNode[] }> = {
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

  /* "Don't trust, verify" profile page: avatar, big clock (wasm), name/role/
     company from settings.profile, and 4 social buttons bottom-right. Tapping
     a social button shows that platform's followers/likes (mock) + a QR to the
     link the User App configured — all via widget.set visibility (no wasm). */
  profile: {
    name: "Profile",
    widgets: [
      {
        type: "label", id: "bg", x: 0, y: 0, w: 480, h: 320,
        props: { text: "" }, style: { bg_color: "#0B0E11" },
      },
      {
        // round avatar placeholder (real photo via asset/settings later)
        type: "label", id: "avatar", x: 24, y: 30, w: 132, h: 132,
        props: { text: "" },
        style: { bg_color: "#161B22", radius: 66, border_width: 2, border_color: "#F0B90B" },
      },
      {
        type: "label", id: "verify", x: 172, y: 28, w: 286, h: 22,
        props: { text: "DON'T TRUST  VERIFY" },
        style: { text_color: "#F0B90B", align: "right", font: "montserrat_20" },
      },
      {
        // big clock, driven by the clock wasm (drives the "time" label)
        type: "label", id: "time", x: 172, y: 52, w: 286, h: 92,
        props: { text: "00:00" },
        style: { text_color: "#EAECEF", align: "right", font: "montserrat_80" },
      },
      {
        type: "label", id: "name", x: 24, y: 176, w: 360, h: 36,
        props: { text: "SATOSHI NAKAMOTO" },
        style: { text_color: "#EAECEF", align: "left", font: "montserrat_28" },
        bindings: [{ prop: "text", source: "settings", path: "nickname" }],
      },
      {
        type: "label", id: "role", x: 24, y: 214, w: 360, h: 24,
        props: { text: "(SAT) CYPHERPUNK" },
        style: { text_color: "#848E9C", align: "left", font: "montserrat_20" },
        bindings: [{ prop: "text", source: "settings", path: "role" }],
      },
      {
        type: "label", id: "company", x: 24, y: 240, w: 220, h: 22,
        props: { text: "Acme Capital" },
        style: { text_color: "#F0B90B", align: "left", font: "montserrat_20" },
        bindings: [{ prop: "text", source: "settings", path: "company" }],
      },
      ...PROFILE_SOCIAL,
      {
        // shared close button for whichever social popup is open
        type: "button", id: "pop_close", x: 412, y: 64, w: 36, h: 36,
        props: { text: "X" },
        style: { bg_color: "#2B3139", text_color: "#EAECEF", radius: 18, border_width: 0 },
        hidden: true,
        actions: [
          { on: "clicked", do: "widget.set", target: "pop_fb_card", key: "visible", value: "0" },
          { on: "clicked", do: "widget.set", target: "pop_fb_qr", key: "visible", value: "0" },
          { on: "clicked", do: "widget.set", target: "pop_yt_card", key: "visible", value: "0" },
          { on: "clicked", do: "widget.set", target: "pop_yt_qr", key: "visible", value: "0" },
          { on: "clicked", do: "widget.set", target: "pop_tt_card", key: "visible", value: "0" },
          { on: "clicked", do: "widget.set", target: "pop_tt_qr", key: "visible", value: "0" },
          { on: "clicked", do: "widget.set", target: "pop_ig_card", key: "visible", value: "0" },
          { on: "clicked", do: "widget.set", target: "pop_ig_qr", key: "visible", value: "0" },
          { on: "clicked", do: "widget.set", target: "pop_close", key: "visible", value: "0" },
        ],
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

