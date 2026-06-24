/* ------------------------------------------------------------- *
 * Initial PageSettingSchema seed for the 5 native pages.          *
 *                                                                 *
 * Each page gets v1 of its schema. These are intentionally        *
 * permissive (passthrough of the legacy fields) so the migration  *
 * can keep the existing flat shape while we build out the        *
 * canonical structured forms (schema.md §4).                     *
 *                                                                 *
 * Idempotent: re-running is a no-op (unique by pageSlug+version). *
 * ------------------------------------------------------------- */

import type { PrismaClient } from "@prisma/client";

/* v1 schemas — pass-through for now, valid JSON objects with the
 * existing flat fields the firmware already accepts. */

const systemV1 = {
  type: "object",
  properties: {
    display_mode: { enum: ["static", "dynamic"] },
    page_delay_s: { type: "integer", minimum: 3, maximum: 3600 },
    brightness: { type: "integer", minimum: 5, maximum: 100 },
  },
  additionalProperties: true,
} as const;

const systemUiV1 = {
  groups: [
    { id: "system", title: "System", fields: ["display_mode", "page_delay_s", "brightness"] },
  ],
  fields: {
    display_mode: { widget: "select", options: ["static", "dynamic"], label: "Display mode" },
    page_delay_s: { widget: "number", min: 3, max: 3600, label: "Auto-rotate seconds" },
    brightness: { widget: "slider", min: 5, max: 100, label: "Brightness" },
  },
} as const;

const systemDefaults = { display_mode: "static", page_delay_s: 10, brightness: 80 } as const;

const clockV1 = {
  type: "object",
  properties: {
    format_24h: { type: "boolean" },
    show_seconds: { type: "boolean" },
    show_date: { type: "boolean" },
    show_logo: { type: "boolean" },
    date_format: { type: "string" },
    tz_offset_min: { type: "integer" },
    colors: { type: "object" },
    alarms: { type: "array" },
  },
  additionalProperties: true,
} as const;

const cryptoV1 = {
  type: "object",
  properties: {
    symbols: { type: "array" },
    symbol: { type: "string" },
    style: { enum: ["chart", "big"] },
    currency: { type: "string" },
    fetch_interval_s: { type: "integer" },
    timeframe: { type: "string" },
    alerts: { type: "object" },
  },
  additionalProperties: true,
} as const;

const profileV1 = {
  type: "object",
  properties: {
    show: { type: "boolean" },
    name: { type: "string", maxLength: 80 },
    nickname: { type: "string", maxLength: 80 },
    role: { type: "string", maxLength: 80 },
    motto: { type: "string", maxLength: 120 },
    company: { type: "string", maxLength: 80 },
    name_color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
    role_color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
    company_color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
    verify_color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
    bg_color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
  },
  additionalProperties: true,
} as const;

const profileSlots = [
  { key: "avatar", kind: "image", maxBytes: 300 * 1024, transform: "png-132-square" },
] as const;

const slideshowV1 = {
  type: "object",
  properties: {
    interval_s: { type: "integer", minimum: 3 },
    fade: { type: "boolean" },
    assets: { type: "array" },
  },
  additionalProperties: true,
} as const;

const weatherV1 = {
  type: "object",
  properties: {
    location: { type: "string" },
    units: { enum: ["metric", "imperial"] },
    refresh_min: { type: "integer", minimum: 5 },
  },
  additionalProperties: true,
} as const;

interface PageSpec {
  pageSlug: string;
  packageId: string | null;
  jsonSchema: unknown;
  uiSchema?: unknown;
  defaultConfig?: unknown;
  assetSlots?: unknown;
}

const PAGES: PageSpec[] = [
  { pageSlug: "system", packageId: null,
    jsonSchema: systemV1, uiSchema: systemUiV1, defaultConfig: systemDefaults },
  { pageSlug: "clock", packageId: "com.ccp.clock",
    jsonSchema: clockV1, defaultConfig: { format_24h: true, show_seconds: true, show_date: true } },
  { pageSlug: "crypto", packageId: null,
    jsonSchema: cryptoV1, defaultConfig: { symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT"], style: "chart" } },
  { pageSlug: "profile", packageId: "com.ccp.profile",
    jsonSchema: profileV1, defaultConfig: { show: true, name: "", motto: "" }, assetSlots: profileSlots },
  { pageSlug: "slideshow", packageId: null,
    jsonSchema: slideshowV1, defaultConfig: { interval_s: 10, fade: true } },
  { pageSlug: "weather", packageId: "com.ccp.weather",
    jsonSchema: weatherV1, defaultConfig: { units: "metric", refresh_min: 15 } },
];

/** Idempotent: skips (pageSlug, version) pairs that already exist. */
export async function seedPageSchemas(prisma: PrismaClient): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0, skipped = 0;
  for (const p of PAGES) {
    const exists = await prisma.pageSettingSchema.findUnique({
      where: { pageSlug_schemaVersion: { pageSlug: p.pageSlug, schemaVersion: 1 } },
    });
    if (exists) { skipped++; continue; }
    await prisma.pageSettingSchema.create({
      data: {
        pageSlug: p.pageSlug,
        schemaVersion: 1,
        packageId: p.packageId,
        jsonSchema: p.jsonSchema as object,
        uiSchema: (p.uiSchema ?? {}) as object,
        defaultConfig: (p.defaultConfig ?? {}) as object,
        assetSlots: (p.assetSlots ?? []) as object,
      },
    });
    inserted++;
  }
  return { inserted, skipped };
}
