export type CatalogKind = "PAGE" | "FEATURE";

export interface CatalogSeed {
  slug: string;
  runtimeSlug: string;
  aliases?: string[];
  title: string;
  description: string;
  kind: CatalogKind;
  icon: string;
  priceCents: number;
  currency: string;
}

/**
 * Store product IDs are stable customer-facing IDs. runtimeSlug is the page /
 * feature slug already understood by the device firmware and mobile app.
 */
export const CATALOG: CatalogSeed[] = [
  {
    slug: "p001",
    runtimeSlug: "profile",
    aliases: ["profile"],
    title: "Profile",
    kind: "PAGE",
    icon: "person",
    description: "Social profile page with avatar, name, role, motto, and links.",
    priceCents: 0,
    currency: "thb",
  },
  {
    slug: "p002",
    runtimeSlug: "weather",
    aliases: ["weather"],
    title: "Weather",
    kind: "PAGE",
    icon: "cloud",
    description: "Local forecast, hi/lo, conditions.",
    priceCents: 0,
    currency: "thb",
  },
  {
    slug: "p003",
    runtimeSlug: "calendar",
    aliases: ["calendar"],
    title: "Calendar",
    kind: "PAGE",
    icon: "event",
    description: "Today's agenda from Google Calendar.",
    priceCents: 0,
    currency: "thb",
  },
  {
    slug: "p004",
    runtimeSlug: "clock",
    aliases: ["clock"],
    title: "Clock",
    kind: "PAGE",
    icon: "schedule",
    description: "Built-in clock page with configurable style, colors, date, and timezone.",
    priceCents: 0,
    currency: "thb",
  },
  {
    slug: "p005",
    runtimeSlug: "crypto",
    aliases: ["crypto"],
    title: "Crypto",
    kind: "PAGE",
    icon: "candlestick_chart",
    description: "Built-in crypto market page. Users can switch between chart and big-number modes in the app.",
    priceCents: 0,
    currency: "thb",
  },
  {
    slug: "p006",
    runtimeSlug: "slideshow",
    aliases: ["slideshow"],
    title: "Photo Slideshow",
    kind: "PAGE",
    icon: "photo_library",
    description: "Built-in photo slideshow page for local display images.",
    priceCents: 0,
    currency: "thb",
  },
  {
    slug: "f001",
    runtimeSlug: "clock-alarm",
    aliases: ["clock-alarm"],
    title: "Clock Alarm",
    kind: "FEATURE",
    icon: "alarm",
    description: "Alarm add-on for the Clock page with sound and device-side controls.",
    priceCents: 4900,
    currency: "thb",
  },
  {
    slug: "f002",
    runtimeSlug: "crypto-alerts",
    aliases: ["crypto-alerts"],
    title: "Crypto Alarm",
    kind: "FEATURE",
    icon: "speed",
    description: "Full-screen + sound alerts when a coin crosses your high/low price (needs admin approval).",
    priceCents: 4900,
    currency: "thb",
  },
];

const CATALOG_BY_SLUG = new Map(CATALOG.map((c) => [c.slug, c]));
const CATALOG_BY_ALIAS = new Map(
  CATALOG.flatMap((c) => [c.runtimeSlug, ...(c.aliases ?? [])].map((slug) => [slug, c] as const)),
);

export const CATALOG_SLUGS = CATALOG.map((c) => c.slug);
export const RETIRED_STORE_SLUGS = ["crypto-big", "crypto_big", "crypto-big-number"];

export function catalogForSlug(slug: string) {
  return CATALOG_BY_SLUG.get(slug) ?? CATALOG_BY_ALIAS.get(slug);
}

export function runtimeSlugForCatalogSlug(slug: string) {
  return catalogForSlug(slug)?.runtimeSlug ?? slug;
}

export function catalogLookupSlugs(slug: string) {
  const catalog = catalogForSlug(slug);
  if (!catalog) return [slug];
  return [...new Set([catalog.slug, catalog.runtimeSlug, ...(catalog.aliases ?? [])])];
}

export function isRetiredStoreSlug(slug: string) {
  return RETIRED_STORE_SLUGS.includes(slug);
}

export function expandedEntitlementSlugs(slugs: string[]) {
  return [...new Set(slugs.flatMap((slug) => {
    const catalog = catalogForSlug(slug);
    if (!catalog) return [slug];
    return catalog.slug === catalog.runtimeSlug ? [catalog.slug] : [catalog.slug, catalog.runtimeSlug];
  }))];
}
