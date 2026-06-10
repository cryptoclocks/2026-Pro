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
    // We put userId + itemId into checkout session metadata at creation time.
    const userId = session.metadata?.userId;
    const itemId = session.metadata?.marketplaceItemId;
    if (!userId || !itemId) {
      this.log.warn(`checkout ${session.id} missing metadata — skipped`);
      return;
    }

    const item = await this.prisma.marketplaceItem.findUnique({
      where: { id: itemId },
      include: {
        payloadRef: {
          include: { versions: { where: { status: "PUBLISHED" }, orderBy: { createdAt: "desc" }, take: 1 } },
        },
      },
    });
    if (!item) {
      this.log.warn(`marketplace item ${itemId} not found`);
      return;
    }

    // 1) grant the entitlement (idempotent on retries)
    await this.prisma.entitlement.upsert({
      where: { userId_itemId: { userId, itemId } },
      update: {},
      create: { userId, itemId, source: "PURCHASE" },
    });
    this.log.log(`entitlement granted: user=${userId} item=${item.slug}`);

    // 2) push the new content to every device the user owns
    const latest = item.payloadRef.versions[0];
    if (!latest) {
      this.log.warn(`item ${item.slug} has no published version — nothing to push`);
      return;
    }
    const devices = await this.prisma.device.findMany({ where: { ownerId: userId } });
    for (const device of devices) {
      await this.devices.assignPayload(device.id, latest.id);
      this.log.log(`sync pushed to ${device.deviceId} (${item.payloadRef.packageId}@${latest.version})`);
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: "purchase.fulfilled",
        target: item.slug,
        meta: { sessionId: session.id, devices: devices.map((d) => d.deviceId) },
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
