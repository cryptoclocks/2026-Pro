import type { WidgetType } from "@ccp/shared";

/**
 * Per-widget property schema, modeled on real LVGL setters (lv_<widget>_set_*),
 * the same idea as SquareLine Studio / lvgl_editor property panels. Keys land in
 * widget.props (target "props", default) or widget.style (target "style") so the
 * exported layout.json maps 1:1 to firmware ui_renderer calls.
 */
export type PropKind = "text" | "textarea" | "number" | "color" | "bool" | "select";

export interface PropDef {
  key: string;
  label: string;
  kind: PropKind;
  target?: "props" | "style"; // default: props
  options?: string[]; // for select
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  default?: unknown;
}

/** Style props every widget shares (LVGL local styles). */
export const COMMON_STYLE: PropDef[] = [
  { key: "bg_color", label: "Background", kind: "color", target: "style" },
  { key: "bg_opa", label: "BG opacity", kind: "number", target: "style", min: 0, max: 255 },
  { key: "text_color", label: "Text color", kind: "color", target: "style" },
  { key: "border_color", label: "Border color", kind: "color", target: "style" },
  { key: "border_width", label: "Border width", kind: "number", target: "style", min: 0, max: 16 },
  { key: "radius", label: "Corner radius", kind: "number", target: "style", min: 0, max: 100 },
  { key: "pad", label: "Padding", kind: "number", target: "style", min: 0, max: 64 },
  { key: "opa", label: "Opacity", kind: "number", target: "style", min: 0, max: 255 },
  { key: "shadow_width", label: "Shadow", kind: "number", target: "style", min: 0, max: 64 },
  { key: "font", label: "Font", kind: "select", target: "style",
    options: [
      "",
      "montserrat_14", "montserrat_20", "montserrat_28", "montserrat_32", "montserrat_48",
      "montserrat_64", "montserrat_80", "montserrat_96", "montserrat_112",
      "montserrat_128", "montserrat_144", "montserrat_160",
      "dseg7_32", "dseg7_48", "dseg7_64", "dseg7_80", "dseg7_96",
      "dseg7_112", "dseg7_128", "dseg7_144", "dseg7_160",
      "dseg14_32", "dseg14_48", "dseg14_64", "dseg14_80", "dseg14_96",
      "dseg14_112", "dseg14_128", "dseg14_144", "dseg14_160",
    ] },
  { key: "align", label: "Text align", kind: "select", target: "style",
    options: ["left", "center", "right"] },
];

const LONG_MODES = ["wrap", "dot", "scroll", "scroll_circular", "clip"];

export const WIDGET_PROPS: Partial<Record<WidgetType, PropDef[]>> = {
  label: [
    { key: "text", label: "Text", kind: "textarea", default: "Text" },
    { key: "long_mode", label: "Long mode", kind: "select", options: LONG_MODES, default: "wrap" },
    { key: "recolor", label: "Recolor (#RRGGBB)", kind: "bool", default: false },
  ],
  button: [
    { key: "text", label: "Label", kind: "text", default: "Button" },
    { key: "checkable", label: "Checkable (toggle)", kind: "bool", default: false },
    { key: "checked", label: "Checked", kind: "bool", default: false },
  ],
  image: [
    { key: "src", label: "Source path", kind: "text", placeholder: "A:/pages/.../img.png" },
    { key: "scale", label: "Scale (256=1x)", kind: "number", min: 0, max: 2048, default: 256 },
    { key: "rotation", label: "Rotation (0.1°)", kind: "number", min: 0, max: 3600, default: 0 },
    { key: "inner_align", label: "Inner align", kind: "select",
      options: ["center", "top_left", "stretch", "contain", "cover", "tile"], default: "center" },
  ],
  gif: [{ key: "src", label: "GIF path", kind: "text", placeholder: "A:/pages/.../anim.gif" }],
  arc: [
    { key: "min", label: "Min", kind: "number", default: 0 },
    { key: "max", label: "Max", kind: "number", default: 100 },
    { key: "value", label: "Value", kind: "number", default: 40 },
    { key: "start_angle", label: "Start angle", kind: "number", min: 0, max: 360, default: 135 },
    { key: "end_angle", label: "End angle", kind: "number", min: 0, max: 360, default: 45 },
    { key: "mode", label: "Mode", kind: "select", options: ["normal", "reverse", "symmetrical"], default: "normal" },
  ],
  bar: [
    { key: "min", label: "Min", kind: "number", default: 0 },
    { key: "max", label: "Max", kind: "number", default: 100 },
    { key: "value", label: "Value", kind: "number", default: 60 },
    { key: "mode", label: "Mode", kind: "select", options: ["normal", "symmetrical", "range"], default: "normal" },
  ],
  slider: [
    { key: "min", label: "Min", kind: "number", default: 0 },
    { key: "max", label: "Max", kind: "number", default: 100 },
    { key: "value", label: "Value", kind: "number", default: 50 },
    { key: "mode", label: "Mode", kind: "select", options: ["normal", "symmetrical", "range"], default: "normal" },
  ],
  switch: [{ key: "checked", label: "On", kind: "bool", default: false }],
  checkbox: [
    { key: "text", label: "Text", kind: "text", default: "Option" },
    { key: "checked", label: "Checked", kind: "bool", default: false },
  ],
  dropdown: [
    { key: "options", label: "Options (one per line)", kind: "textarea", default: "One\nTwo\nThree" },
    { key: "selected", label: "Selected index", kind: "number", min: 0, default: 0 },
    { key: "dir", label: "Open direction", kind: "select", options: ["down", "up", "left", "right"], default: "down" },
  ],
  roller: [
    { key: "options", label: "Options (one per line)", kind: "textarea", default: "Jan\nFeb\nMar" },
    { key: "selected", label: "Selected index", kind: "number", min: 0, default: 0 },
    { key: "visible_rows", label: "Visible rows", kind: "number", min: 1, max: 9, default: 3 },
    { key: "mode", label: "Mode", kind: "select", options: ["normal", "infinite"], default: "normal" },
  ],
  chart: [
    { key: "chart_type", label: "Type", kind: "select", options: ["line", "bar", "candlestick", "scatter"], default: "candlestick" },
    { key: "point_count", label: "Point count", kind: "number", min: 2, max: 200, default: 60 },
    { key: "y_min", label: "Y min (0=auto)", kind: "number", default: 0 },
    { key: "y_max", label: "Y max (0=auto)", kind: "number", default: 0 },
  ],
  canvas: [
    { key: "wasm", label: "WASM module", kind: "text", placeholder: "module.wasm" },
  ],
  table: [
    { key: "rows", label: "Rows", kind: "number", min: 1, max: 50, default: 3 },
    { key: "cols", label: "Columns", kind: "number", min: 1, max: 12, default: 2 },
  ],
  list: [
    { key: "items", label: "Items (one per line)", kind: "textarea", default: "Item A\nItem B\nItem C" },
  ],
  tabs: [
    { key: "tabs", label: "Tab names (one per line)", kind: "textarea", default: "Tab 1\nTab 2" },
    { key: "position", label: "Tab bar", kind: "select", options: ["top", "bottom", "left", "right"], default: "top" },
  ],
  panel: [
    { key: "layout", label: "Layout", kind: "select", options: ["none", "flex_row", "flex_column", "grid"], default: "none" },
    { key: "scrollable", label: "Scrollable", kind: "bool", default: false },
  ],
  qrcode: [
    { key: "data", label: "Data / URL", kind: "text", default: "https://cryptoclock.app" },
    { key: "size", label: "Size (px)", kind: "number", min: 32, max: 320, default: 120 },
  ],
  textarea: [
    { key: "placeholder", label: "Placeholder", kind: "text", default: "Type…" },
    { key: "text", label: "Text", kind: "text", default: "" },
    { key: "one_line", label: "Single line", kind: "bool", default: true },
    { key: "password", label: "Password", kind: "bool", default: false },
    { key: "max_length", label: "Max length", kind: "number", min: 0, max: 256, default: 0 },
  ],
  keyboard: [
    { key: "mode", label: "Mode", kind: "select",
      options: ["text_lower", "text_upper", "special", "number"], default: "text_lower" },
  ],
  spinner: [
    { key: "speed", label: "Spin time (ms)", kind: "number", min: 100, max: 5000, default: 1000 },
    { key: "arc_length", label: "Arc length (°)", kind: "number", min: 10, max: 350, default: 60 },
  ],
  led: [
    { key: "on", label: "On", kind: "bool", default: false },
    { key: "color", label: "Color", kind: "color", default: "#0ECB81" },
    { key: "brightness", label: "Brightness", kind: "number", min: 0, max: 255, default: 255 },
  ],
  scale: [
    { key: "min", label: "Min", kind: "number", default: 0 },
    { key: "max", label: "Max", kind: "number", default: 100 },
    { key: "total_ticks", label: "Total ticks", kind: "number", min: 2, max: 100, default: 11 },
    { key: "major_every", label: "Major every", kind: "number", min: 1, max: 20, default: 5 },
    { key: "mode", label: "Mode", kind: "select",
      options: ["horizontal_top", "horizontal_bottom", "vertical_left", "vertical_right", "round_inner", "round_outer"],
      default: "horizontal_bottom" },
  ],
  spinbox: [
    { key: "min", label: "Min", kind: "number", default: 0 },
    { key: "max", label: "Max", kind: "number", default: 100 },
    { key: "value", label: "Value", kind: "number", default: 0 },
    { key: "digit_count", label: "Digit count", kind: "number", min: 1, max: 10, default: 3 },
    { key: "decimals", label: "Decimal places", kind: "number", min: 0, max: 6, default: 0 },
  ],
  analog_clock: [
    { key: "show_seconds", label: "Second hand", kind: "bool", default: true },
  ],
};

/** Default props for a freshly-added widget (from the schema defaults). */
export function defaultProps(type: WidgetType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of WIDGET_PROPS[type] ?? []) {
    if (p.target !== "style" && p.default !== undefined) out[p.key] = p.default;
  }
  return out;
}
