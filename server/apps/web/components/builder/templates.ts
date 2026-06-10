import type { WidgetNode } from "@ccp/shared";

export type TemplateKey = "blank" | "clock" | "crypto" | "welcome" | "led_toggle";

/** Starter layouts — the "old pages" a designer can load and tweak. */
export const TEMPLATES: Record<TemplateKey, { name: string; widgets: WidgetNode[] }> = {
  blank: { name: "Blank", widgets: [] },

  clock: {
    name: "Clock",
    widgets: [
      {
        type: "label", id: "time", x: 40, y: 90, w: 400, h: 110,
        props: { text: "12:34" },
        style: { text_color: "#00D1FF", align: "center", font: "montserrat_48" },
        bindings: [{ prop: "text", source: "clock", path: "hhmm" }],
      },
      {
        type: "label", id: "date", x: 40, y: 210, w: 400, h: 28,
        props: { text: "Tue 10 Jun 2026" },
        style: { text_color: "#848E9C", align: "center" },
        bindings: [{ prop: "text", source: "clock", path: "date" }],
      },
    ],
  },

  crypto: {
    name: "Crypto",
    widgets: [
      {
        type: "label", id: "pair", x: 18, y: 12, w: 200, h: 28,
        props: { text: "BTC/USDT" },
        style: { text_color: "#EAECEF" },
      },
      {
        type: "label", id: "price", x: 18, y: 50, w: 300, h: 56,
        props: { text: "64,231" },
        style: { text_color: "#0ECB81", font: "montserrat_48" },
        bindings: [{ prop: "text", source: "crypto", path: "BTCUSDT.price", format: "$%s" }],
      },
      {
        type: "chart", id: "candles", x: 18, y: 170, w: 444, h: 130,
        props: {}, style: { bg_color: "#161B22", radius: 12 },
        bindings: [{ prop: "series", source: "crypto", path: "BTCUSDT.klines" }],
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

/** Resolve a widget's text binding to a mock display string (simulate mode). */
export function resolveText(w: WidgetNode): string | null {
  const b = w.bindings?.find((x) => x.prop === "text");
  if (!b) return null;
  const raw = MOCK[b.source]?.[b.path ?? ""];
  if (raw === undefined) return `{${b.source}.${b.path ?? ""}}`;
  return b.format ? b.format.replace("%s", String(raw)) : String(raw);
}
