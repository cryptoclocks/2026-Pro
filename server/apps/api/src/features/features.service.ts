import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DevicesService } from "../devices/devices.service";

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
      // merge the requested fragment into settings[page] and push to the device
      const { config } = await this.devices.getSettings(req.deviceId);
      const cfg = (config as Record<string, unknown>) ?? {};
      const page = (cfg[req.page] as Record<string, unknown>) ?? {};
      cfg[req.page] = { ...page, ...(req.detail as Record<string, unknown>) };
      await this.devices.putSettings(req.deviceId, cfg);
    }
    return fr;
  }
}
