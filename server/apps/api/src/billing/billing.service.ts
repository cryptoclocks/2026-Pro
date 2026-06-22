import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../prisma/prisma.service";
import { DevicesService } from "../devices/devices.service";
import { catalogForSlug } from "../marketplace/catalog";

/**
 * The money flow the platform is built around:
 *
 *   Stripe checkout.session.completed
 *     -> record a paid purchase awaiting admin review
 *     -> admin grants the entitlement to the target device from Fleet/Rights
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger(BillingService.name);
  readonly stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder");

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
  ) {}

  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET ?? "",
    );
  }

  async handleEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case "checkout.session.completed":
        await this.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await this.onSubscriptionChanged(event.data.object as Stripe.Subscription);
        break;
      default:
        this.log.debug(`unhandled stripe event: ${event.type}`);
    }
  }

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    // metadata set by marketplace.checkout: { slug, deviceId, userId }
    const userId = session.metadata?.userId;
    const deviceId = session.metadata?.deviceId; // hardware id (ccp-xxxx)
    const slug = session.metadata?.slug;
    if (!userId || !deviceId || !slug) {
      this.log.warn(`checkout ${session.id} missing metadata — skipped`);
      return;
    }

    const item = await this.prisma.marketplaceItem.findUnique({
      where: { slug: catalogForSlug(slug)?.slug ?? slug },
      include: {
        payloadRef: {
          include: { versions: { where: { status: "PUBLISHED" }, orderBy: { createdAt: "desc" }, take: 1 } },
        },
      },
    });
    if (!item) {
      this.log.warn(`marketplace item ${slug} not found`);
      return;
    }

    this.log.log(`purchase pending admin grant: device=${deviceId} item=${item.slug}`);

    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        deviceId,
        action: "purchase.pending_grant",
        target: item.slug,
        meta: { sessionId: session.id, runtimeSlug: catalogForSlug(item.slug)?.runtimeSlug ?? item.slug },
      },
    });
  }

  private async onSubscriptionChanged(sub: Stripe.Subscription): Promise<void> {
    // current_period_end lives on the subscription in classic API versions and
    // on subscription items from the 2025 "basil" versions — accept either.
    const periodEnd =
      (sub as unknown as { current_period_end?: number }).current_period_end ??
      (sub.items.data[0] as unknown as { current_period_end?: number } | undefined)
        ?.current_period_end ??
      0;
    await this.prisma.subscription.updateMany({
      where: { stripeSubscriptionId: sub.id },
      data: {
        status:
          sub.status === "active" ? "ACTIVE"
          : sub.status === "past_due" ? "PAST_DUE"
          : sub.status === "trialing" ? "TRIALING"
          : "CANCELED",
        currentPeriodEnd: new Date(periodEnd * 1000),
      },
    });
  }
}
