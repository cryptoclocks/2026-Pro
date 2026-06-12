/**
 * TypeScript mirror of schema/layout.schema.json (v1) + zod validators.
 * The builder composes these types; the API validates exports with them.
 */
import { z } from "zod";

export const WIDGET_TYPES = [
  "label", "button", "image", "gif", "arc", "bar", "slider", "switch",
  "checkbox", "dropdown", "roller", "chart", "canvas", "table", "list",
  "tabs", "panel", "qrcode", "textarea", "keyboard", "spinner", "led",
  "scale", "analog_clock", "spinbox",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const SCREEN = { portrait: { w: 320, h: 480 }, landscape: { w: 480, h: 320 } };

const ident = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

export const StyleSchema = z
  .object({
    bg_color: color,
    bg_opa: z.number().int().min(0).max(255),
    text_color: color,
    border_color: color,
    border_width: z.number().int().min(0).max(16),
    radius: z.number().int().min(0).max(100),
    pad: z.number().int().min(0).max(64),
    font: z.string(),
    align: z.enum(["left", "center", "right"]),
    opa: z.number().int().min(0).max(255),
    shadow_width: z.number().int().min(0).max(64),
    shadow_color: color,
    scale: z.number().min(0.1).max(8), // transform multiplier on top of the font
  })
  .partial();

export const BindingSchema = z.object({
  prop: z.string(),
  source: ident,
  path: z.string().optional(),
  format: z.string().optional(),
  map: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  scale: z.number().optional(),
});

export const ActionSchema = z.object({
  on: z.enum([
    "clicked", "pressed", "released", "long_pressed", "value_changed",
    "gesture_left", "gesture_right",
  ]),
  do: z.enum([
    "page.show", "wasm.event", "audio.play", "audio.stop", "mqtt.publish",
    "brightness.set", "device.reboot", "device.sync", "var.set", "widget.set",
  ]),
  target: z.string().optional(),
  asset: z.string().optional(),
  event_id: z.number().int().optional(),
  topic_suffix: z.string().optional(),
  payload: z.unknown().optional(),
  value: z.unknown().optional(),
  key: z.string().optional(),
});

export type WidgetNode = {
  type: WidgetType;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hidden?: boolean;
  style?: z.infer<typeof StyleSchema>;
  props?: Record<string, unknown>;
  bindings?: z.infer<typeof BindingSchema>[];
  actions?: z.infer<typeof ActionSchema>[];
  children?: WidgetNode[];
};

export const WidgetSchema: z.ZodType<WidgetNode> = z.lazy(() =>
  z.object({
    type: z.enum(WIDGET_TYPES),
    id: ident,
    x: z.number().int(),
    y: z.number().int(),
    w: z.number().int().min(1),
    h: z.number().int().min(1),
    hidden: z.boolean().optional(),
    style: StyleSchema.optional(),
    props: z.record(z.unknown()).optional(),
    bindings: z.array(BindingSchema).optional(),
    actions: z.array(ActionSchema).optional(),
    children: z.array(WidgetSchema).optional(),
  }),
);

export const LayoutSchema = z.object({
  schema_version: z.literal("1.0"),
  meta: z.object({
    id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/),
    name: z.string().max(64),
    version: semver,
    min_fw: semver.optional(),
    author: z.string().optional(),
    description: z.string().optional(),
  }),
  display: z
    .object({
      orientation: z.enum(["portrait", "landscape"]).default("landscape"),
      theme: z
        .object({ bg: color, fg: color, accent: color, font_scale: z.number() })
        .partial()
        .optional(),
      brightness: z.number().int().min(0).max(100).optional(),
      timeout_page: z.string().optional(),
      timeout_s: z.number().int().min(0).optional(),
    })
    .optional(),
  assets: z
    .array(
      z.object({
        id: ident,
        type: z.enum(["image", "gif", "font", "audio", "lottie", "bin"]),
        path: z.string(),
      }),
    )
    .optional(),
  data_sources: z
    .array(
      z.object({
        id: ident,
        stream: z.string().max(96),
        format: z.enum(["json", "raw"]).default("json"),
        sample_hint_ms: z.number().int().min(100).optional(),
      }),
    )
    .optional(),
  wasm: z
    .array(
      z.object({
        id: ident,
        path: z.string(),
        tick_ms: z.number().int().min(16).optional(),
        canvas_ids: z.array(ident).optional(),
        memory_kb: z.number().int().min(64).max(1024).optional(),
      }),
    )
    .optional(),
  builder: z
    .object({
      logic_source: z.string().max(128 * 1024).optional(),
    })
    .optional(),
  pages: z
    .array(
      z.object({
        id: ident,
        bg: color.optional(),
        bg_image: ident.optional(),
        scrollable: z.boolean().optional(),
        on_load: z.array(ActionSchema.omit({ on: true })).optional(),
        widgets: z.array(WidgetSchema),
      }),
    )
    .min(1),
});

export type Layout = z.infer<typeof LayoutSchema>;

export const ManifestSchema = z.object({
  manifest_version: z.literal(1),
  package_id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/),
  version: semver,
  min_fw_version: semver.optional(),
  layout: z.string().default("layout.json"),
  wasm_entry: z.string().optional(),
  total_size: z.number().int().optional(),
  signature: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string().regex(/^[^/\\]/),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().min(0),
      }),
    )
    .min(1),
});
export type Manifest = z.infer<typeof ManifestSchema>;
