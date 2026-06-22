import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DevicesService } from "../devices/devices.service";
import { catalogForSlug } from "../marketplace/catalog";

interface CreateDto {
  deviceId: string;
  page: string;
  feature: string;
  detail?: Record<string, unknown>;
}

/**
 * Optional per-page features (e.g. the crypto price alarm) are not applied to a
 * device until an admin manually approves them. On approval the requested
 * config fragment is merged into the device's settings and pushed over MQTT.
 */
@Injectable()
export class FeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
  ) {}

  create(userId: string, dto: CreateDto) {
    return this.prisma.featureRequest.create({
      data: {
        userId,
        deviceId: dto.deviceId,
        page: dto.page,
        feature: dto.feature,
        detail: (dto.detail ?? {}) as object,
        status: "PENDING",
      },
    });
  }

  listForUser(userId: string) {
    return this.prisma.featureRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  list(status?: "PENDING" | "APPROVED" | "REJECTED") {
    return this.prisma.featureRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      include: { user: { select: { email: true, name: true } } },
    });
  }

  async decide(id: string, approve: boolean, adminEmail: string) {
    const req = await this.prisma.featureRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException("request not found");

    const fr = await this.prisma.featureRequest.update({
      where: { id },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        decidedBy: adminEmail,
        decidedAt: new Date(),
      },
    });

    if (approve) {
      // 1) grant the per-device entitlement (slug = "<page>-<feature>", e.g.
      //    crypto-alerts) so the device/app self-gate the feature.
      const slug = `${req.page}-${req.feature}`;
      const item = await this.prisma.marketplaceItem.findUnique({ where: { slug: catalogForSlug(slug)?.slug ?? slug } });
      if (item) {
        await this.prisma.entitlement.upsert({
          where: { deviceId_itemId: { deviceId: req.deviceId, itemId: item.id } },
          update: { userId: req.userId, source: "GIFT" },
          create: { deviceId: req.deviceId, itemId: item.id, userId: req.userId, source: "GIFT" },
        });
      }
      // 2) merge the requested config fragment into settings[page]
      const { config } = await this.devices.getSettings(req.deviceId);
      const cfg = (config as Record<string, unknown>) ?? {};
      const page = (cfg[req.page] as Record<string, unknown>) ?? {};
      cfg[req.page] = { ...page, ...(req.detail as Record<string, unknown>) };
      await this.devices.putSettings(req.deviceId, cfg);
      // 3) reflect entitlement slugs into settings.entitlements + push
      await this.devices.syncEntitlements(req.deviceId);
    }
    return fr;
  }
}
