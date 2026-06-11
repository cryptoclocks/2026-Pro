import { Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../prisma/prisma.service";

type Kind = "PAGE" | "FEATURE";
interface CatalogSeed {
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  icon: string;
  priceCents: number;
  currency?: string;
}

/**
 * The catalog of things a device can have: PAGE = a swipeable page, FEATURE =
 * an add-on to a built-in page (e.g. crypto price alerts). Seeded into the DB so
 * entitlements (per-device) can reference real rows. Built-in pages (clock /
 * crypto / slideshow) ship free and are always available — not listed here.
 */
const CATALOG: CatalogSeed[] = [
  { slug: "clock-alarm", title: "Clock Alarm", kind: "FEATURE", icon: "alarm",
    description: "Alarm add-on for the Clock page with sound and device-side controls.", priceCents: 9900, currency: "thb" },
  /* Policy: default pages are Free; nothing is priced in USD (THB only, paid = ฿49). */
  { slug: "crypto-alerts", title: "Crypto Price Alerts", kind: "FEATURE", icon: "speed",
    description: "Full-screen + sound alerts when a coin crosses your high/low price (needs admin approval).", priceCents: 4900, currency: "thb" },
  { slug: "weather", title: "Weather", kind: "PAGE", icon: "cloud",
    description: "Local forecast, hi/lo, conditions.", priceCents: 0, currency: "thb" },
  { slug: "news-ticker", title: "News Ticker", kind: "PAGE", icon: "newspaper",
    description: "Scrolling headlines from your feeds.", priceCents: 0, currency: "thb" },
  { slug: "calendar", title: "Calendar", kind: "PAGE", icon: "event",
    description: "Today's agenda from Google Calendar.", priceCents: 0, currency: "thb" },
  { slug: "stocks", title: "Stocks", kind: "PAGE", icon: "trending_up",
    description: "Track equities & indices alongside crypto.", priceCents: 0, currency: "thb" },
  { slug: "fear-greed", title: "Fear & Greed", kind: "PAGE", icon: "speed",
    description: "Crypto market sentiment gauge.", priceCents: 0, currency: "thb" },
];

@Injectable()
export class MarketplaceService implements OnModuleInit {
  private readonly log = new Logger(MarketplaceService.name);
  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder");

  constructor(private readonly prisma: PrismaService) {}

  /** Seed the catalog so every gateable thing is a real DB row. */
  async onModuleInit() {
    for (const c of CATALOG) {
      await this.prisma.marketplaceItem
        .upsert({
          where: { slug: c.slug },
          update: { title: c.title, description: c.description, kind: c.kind, icon: c.icon, priceCents: c.priceCents, currency: c.currency ?? "thb" },
          create: {
            slug: c.slug, title: c.title, description: c.description,
            kind: c.kind, icon: c.icon, priceCents: c.priceCents, currency: c.currency ?? "usd", published: true,
          },
        })
        .catch((e) => this.log.warn(`seed ${c.slug}: ${e}`));
    }
  }

  private get stripeReady(): boolean {
    const k = process.env.STRIPE_SECRET_KEY ?? "";
    return k.startsWith("sk_") && !k.includes("xxx") && !k.includes("placeholder");
  }

  listItems() {
    return this.prisma.marketplaceItem.findMany({
      where: { published: true },
      orderBy: [{ kind: "asc" }, { priceCents: "asc" }],
    });
  }

  adminListItems() {
    return this.prisma.marketplaceItem.findMany({ orderBy: { createdAt: "asc" } });
  }

  updateItem(id: string, patch: { priceCents?: number; published?: boolean; title?: string; description?: string }) {
    return this.prisma.marketplaceItem.update({ where: { id }, data: patch });
  }

  /** Slugs (and item meta) a specific device is entitled to. */
  async entitlementsForDevice(deviceId: string) {
    const ents = await this.prisma.entitlement.findMany({
      where: { deviceId },
      include: { item: true },
    });
    return ents.map((e) => ({ slug: e.item.slug, title: e.item.title, kind: e.item.kind, source: e.source }));
  }

  /** Grant a catalog item to ONE device (admin gift / approval / purchase). */
  async grantToDevice(deviceId: string, slug: string, userId: string, source: "PURCHASE" | "GIFT" = "GIFT") {
    const item = await this.prisma.marketplaceItem.findUnique({ where: { slug } });
    if (!item) throw new NotFoundException(`item ${slug} not found`);
    return this.prisma.entitlement.upsert({
      where: { deviceId_itemId: { deviceId, itemId: item.id } },
      update: { userId, source },
      create: { deviceId, itemId: item.id, userId, source },
    });
  }

  async revokeFromDevice(deviceId: string, slug: string) {
    const item = await this.prisma.marketplaceItem.findUnique({ where: { slug } });
    if (!item) throw new NotFoundException(`item ${slug} not found`);
    await this.prisma.entitlement
      .delete({ where: { deviceId_itemId: { deviceId, itemId: item.id } } })
      .catch(() => undefined);
    return { ok: true };
  }

  /** Stripe Checkout for a device-scoped purchase, or {configured:false}. */
  async checkout(slug: string, deviceId: string, userId: string, successUrl: string, cancelUrl: string) {
    const item = await this.prisma.marketplaceItem.findUnique({ where: { slug } });
    if (!item) return { error: "unknown item" };
    if (!deviceId) return { error: "deviceId required (which CryptoClock?)" };
    if (!this.stripeReady) {
      this.log.warn(`checkout ${slug} for ${deviceId} but Stripe not configured`);
      return { configured: false };
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: item.currency,
            product_data: { name: `CryptoClock: ${item.title}` },
            unit_amount: item.priceCents,
          },
          quantity: 1,
        },
      ],
      metadata: { slug, deviceId, userId },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return { configured: true, url: session.url };
  }
}
