import { Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../prisma/prisma.service";
import { CATALOG, CATALOG_SLUGS, catalogForSlug, catalogLookupSlugs } from "./catalog";

/**
 * The catalog of things a device can have: PAGE = a swipeable page, FEATURE =
 * an add-on to a built-in page (e.g. crypto price alerts). Seeded into the DB so
 * entitlements (per-device) can reference real rows. Built-in pages (clock /
 * crypto / slideshow) ship free and are always available — not listed here.
 */
@Injectable()
export class MarketplaceService implements OnModuleInit {
  private readonly log = new Logger(MarketplaceService.name);
  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder");

  constructor(private readonly prisma: PrismaService) {}

  /** Seed the catalog so every gateable thing is a real DB row. */
  async onModuleInit() {
    for (const c of CATALOG) {
      const payloadId = c.kind === "PAGE" ? await this.resolvePayloadId(c) : null;
      const data = {
        title: c.title,
        description: c.description,
        kind: c.kind,
        icon: c.icon,
        priceCents: c.priceCents,
        currency: c.currency,
        published: true,
        ...(payloadId ? { payloadId } : {}),
      };
      await this.prisma.marketplaceItem
        .upsert({
          where: { slug: c.slug },
          update: data,
          create: {
            slug: c.slug, title: c.title, description: c.description,
            kind: c.kind, icon: c.icon, priceCents: c.priceCents, currency: c.currency,
            ...(payloadId ? { payloadId } : {}),
            published: true,
          },
        })
        .catch((e) => this.log.warn(`seed ${c.slug}: ${e}`));
    }
    // Prune: hide built-in pages we no longer offer (e.g. removed from CATALOG).
    // Only touches seed rows (authorId == null) so custom/published pages — which
    // always have an author — are never unpublished.
    await this.prisma.marketplaceItem
      .updateMany({
        where: { slug: { notIn: CATALOG_SLUGS }, authorId: null, published: true },
        data: { published: false },
      })
      .then((r) => r.count && this.log.log(`pruned ${r.count} retired catalog page(s)`))
      .catch((e) => this.log.warn(`prune: ${e}`));
  }

  private get stripeReady(): boolean {
    const k = process.env.STRIPE_SECRET_KEY ?? "";
    return k.startsWith("sk_") && !k.includes("xxx") && !k.includes("placeholder");
  }

  listItems() {
    return this.prisma.marketplaceItem.findMany({
      where: { slug: { in: CATALOG_SLUGS }, published: true },
    }).then((items) => sortCatalogItems(items).map(withRuntimeSlug));
  }

  adminListItems() {
    return this.prisma.marketplaceItem.findMany({
      where: { slug: { in: CATALOG_SLUGS } },
    }).then((items) => sortCatalogItems(items).map(withRuntimeSlug));
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
    const item = await this.findItemBySlugOrAlias(slug);
    if (!item) throw new NotFoundException(`item ${slug} not found`);
    return this.prisma.entitlement.upsert({
      where: { deviceId_itemId: { deviceId, itemId: item.id } },
      update: { userId, source },
      create: { deviceId, itemId: item.id, userId, source },
    });
  }

  async revokeFromDevice(deviceId: string, slug: string) {
    const items = await this.findItemsBySlugOrAlias(slug);
    if (items.length === 0) throw new NotFoundException(`item ${slug} not found`);
    await this.prisma.entitlement
      .deleteMany({ where: { deviceId, itemId: { in: items.map((item) => item.id) } } })
      .catch(() => undefined);
    return { ok: true };
  }

  /** Stripe Checkout for a device-scoped purchase, or {configured:false}. */
  async checkout(slug: string, deviceId: string, userId: string, successUrl: string, cancelUrl: string) {
    const item = await this.findItemBySlugOrAlias(slug);
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

  private findItemBySlugOrAlias(slug: string) {
    return this.prisma.marketplaceItem.findUnique({
      where: { slug: catalogForSlug(slug)?.slug ?? slug },
    });
  }

  private findItemsBySlugOrAlias(slug: string) {
    return this.prisma.marketplaceItem.findMany({
      where: { slug: { in: catalogLookupSlugs(slug) } },
    });
  }

  private async resolvePayloadId(seed: { runtimeSlug: string; aliases?: string[] }) {
    const aliasSlugs = [...new Set([seed.runtimeSlug, ...(seed.aliases ?? [])])];
    const existing = await this.prisma.marketplaceItem.findFirst({
      where: { slug: { in: aliasSlugs }, payloadId: { not: null } },
      select: { payloadId: true },
    });
    if (existing?.payloadId) return existing.payloadId;

    const packageIds = [
      `com.ccp.${seed.runtimeSlug}`,
      `com.ccp.${seed.runtimeSlug.replace(/-/g, ".")}`,
    ];
    const payload = await this.prisma.payload.findFirst({
      where: { packageId: { in: packageIds } },
      select: { id: true },
    });
    return payload?.id ?? null;
  }
}

function withRuntimeSlug<T extends { slug: string }>(item: T) {
  return {
    ...item,
    runtimeSlug: catalogForSlug(item.slug)?.runtimeSlug ?? item.slug,
  };
}

function sortCatalogItems<T extends { slug: string }>(items: T[]) {
  const order = new Map(CATALOG_SLUGS.map((slug, index) => [slug, index]));
  return [...items].sort((a, b) => (order.get(a.slug) ?? 999) - (order.get(b.slug) ?? 999));
}
