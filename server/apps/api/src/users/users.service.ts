import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DevicesService } from "../devices/devices.service";

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
  ) {}

  async list() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { entitlements: true, devices: true } } },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      devices: u._count.devices,
      purchases: u._count.entitlements,
      since: u.createdAt,
    }));
  }

  async detail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        entitlements: { include: { item: true } },
        devices: true,
        featureRequests: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!user) throw new NotFoundException("user not found");
    return user;
  }

  /** Admin grants a catalog item to ONE of the user's devices (per-device). */
  async grant(userId: string, deviceId: string, slug: string) {
    const item = await this.prisma.marketplaceItem.findUnique({ where: { slug } });
    if (!item) throw new NotFoundException("item not found");
    await this.prisma.entitlement.upsert({
      where: { deviceId_itemId: { deviceId, itemId: item.id } },
      update: { userId, source: "GIFT" },
      create: { deviceId, itemId: item.id, userId, source: "GIFT" },
    });
    await this.devices.syncEntitlements(deviceId);
    return { ok: true };
  }

  async revoke(deviceId: string, slug: string) {
    const item = await this.prisma.marketplaceItem.findUnique({ where: { slug } });
    if (!item) throw new NotFoundException("item not found");
    await this.prisma.entitlement
      .delete({ where: { deviceId_itemId: { deviceId, itemId: item.id } } })
      .catch(() => undefined);
    await this.devices.syncEntitlements(deviceId);
    return { ok: true };
  }
}
