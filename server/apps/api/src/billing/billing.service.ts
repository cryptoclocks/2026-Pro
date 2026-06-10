import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";
import { PrismaService } from "../prisma/prisma.service";
import { DevicesService } from "../devices/devices.service";

/**
 * The money flow the platform is built around:
 *
 *   Stripe checkout.session.completed
 *     -> grant Entitlement (user x marketplace item)
 *     -> find the user's devices
 *     -> push MQTT cmd:sync so every device downloads the purchased
 *        package within seconds of payment.
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
      where: { slug },
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

    // 1) grant the entitlement to THIS device (per-CryptoClock), idempotent
    await this.prisma.entitlement.upsert({
      where: { deviceId_itemId: { deviceId, itemId: item.id } },
      update: { userId, source: "PURCHASE" },
      create: { deviceId, itemId: item.id, userId, source: "PURCHASE" },
    });
    this.log.log(`entitlement granted: device=${deviceId} item=${item.slug}`);

    // 2) reflect entitlements into the device's settings so it self-gates,
    //    and push the purchased page bundle if one exists.
    await this.devices.syncEntitlements(deviceId);
    const latest = item.payloadRef?.versions[0];
    if (latest) {
      const device = await this.prisma.device.findUnique({ where: { deviceId } });
      if (device) await this.devices.assignPayload(device.id, latest.id);
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        deviceId,
        action: "purchase.fulfilled",
        target: item.slug,
        meta: { sessionId: session.id },
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
