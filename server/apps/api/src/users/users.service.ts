import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { entitlements: true, devices: true } },
      },
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

  /** Admin grants a page to a user (no payment) — source GIFT. */
  async grant(userId: string, slug: string) {
    const item = await this.prisma.marketplaceItem.findUnique({ where: { slug } });
    if (!item) throw new NotFoundException("item not found");
    return this.prisma.entitlement.upsert({
      where: { userId_itemId: { userId, itemId: item.id } },
      update: {},
      create: { userId, itemId: item.id, source: "GIFT" },
    });
  }

  async revoke(userId: string, slug: string) {
    const item = await this.prisma.marketplaceItem.findUnique({ where: { slug } });
    if (!item) throw new NotFoundException("item not found");
    await this.prisma.entitlement
      .delete({ where: { userId_itemId: { userId, itemId: item.id } } })
      .catch(() => undefined);
    return { ok: true };
  }
}
