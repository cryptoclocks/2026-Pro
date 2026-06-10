import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../prisma/prisma.service";

export interface StoreItem {
  slug: string;
  title: string;
  description: string;
  priceCents: number;
  currency: string;
  icon: string; // material icon name for the app
}

/**
 * The page catalog. Real published bundles live in the MarketplaceItem table;
 * until authors publish, we expose a built-in catalog of upcoming pages so the
 * app's Store has something to show. The 3 default pages ship free.
 */
const BUILTIN_CATALOG: StoreItem[] = [
  { slug: "weather", title: "Weather", description: "Local forecast, hi/lo, radar icon", priceCents: 199, currency: "usd", icon: "cloud" },
  { slug: "news-ticker", title: "News Ticker", description: "Scrolling headlines from your feeds", priceCents: 199, currency: "usd", icon: "newspaper" },
  { slug: "calendar", title: "Calendar", description: "Today's agenda from Google Calendar", priceCents: 299, currency: "usd", icon: "event" },
  { slug: "stocks", title: "Stocks", description: "Track equities & indices alongside crypto", priceCents: 299, currency: "usd", icon: "trending_up" },
  { slug: "fear-greed", title: "Fear & Greed", description: "Crypto market sentiment gauge", priceCents: 99, currency: "usd", icon: "speed" },
];

@Injectable()
export class MarketplaceService {
  private readonly log = new Logger(MarketplaceService.name);
  private readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder");

  constructor(private readonly prisma: PrismaService) {}

  private get stripeReady(): boolean {
    const k = process.env.STRIPE_SECRET_KEY ?? "";
    return k.startsWith("sk_") && !k.includes("xxx") && !k.includes("placeholder");
  }

  async listItems(): Promise<StoreItem[]> {
    const published = await this.prisma.marketplaceItem
      .findMany({ where: { published: true } })
      .catch(() => []);
    const fromDb: StoreItem[] = published.map((m) => ({
      slug: m.slug,
      title: m.title,
      description: m.description ?? "",
      priceCents: m.priceCents,
      currency: m.currency,
      icon: "extension",
    }));
    // DB items take precedence over builtins with the same slug
    const slugs = new Set(fromDb.map((i) => i.slug));
    return [...fromDb, ...BUILTIN_CATALOG.filter((i) => !slugs.has(i.slug))];
  }

  /**
   * Returns { url } to a Stripe Checkout page, or { configured:false } when
   * Stripe keys aren't set yet (the app shows a "coming soon" notice).
   */
  async checkout(slug: string, deviceId: string, successUrl: string, cancelUrl: string) {
    const item = (await this.listItems()).find((i) => i.slug === slug);
    if (!item) return { error: "unknown item" };
    if (!this.stripeReady) {
      this.log.warn(`checkout for ${slug} but Stripe not configured`);
      return { configured: false };
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: item.currency,
            product_data: { name: `CryptoClock page: ${item.title}` },
            unit_amount: item.priceCents,
          },
          quantity: 1,
        },
      ],
      metadata: { slug, deviceId },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return { configured: true, url: session.url };
  }
}
