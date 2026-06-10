import { Controller, Get, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { UserGuard, CurrentUser } from "./auth.guards";

@Controller("auth")
export class AuthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Who am I + my devices + per-device entitlements + role. */
  @Get("me")
  @UseGuards(UserGuard)
  async me(@CurrentUser() user: User) {
    const devices = await this.prisma.device.findMany({
      where: { ownerId: user.id },
      select: { deviceId: true, name: true },
    });
    const entitlements = await this.prisma.entitlement.findMany({
      where: { userId: user.id },
      include: { item: true },
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isAdmin: user.role === "ADMIN" || user.role === "SUPER_ADMIN",
      devices: devices.map((d) => ({ deviceId: d.deviceId, name: d.name })),
      // entitlements are per-device: { deviceId, slug, title }
      entitlements: entitlements.map((e) => ({
        deviceId: e.deviceId,
        slug: e.item.slug,
        title: e.item.title,
        source: e.source,
        since: e.createdAt,
      })),
    };
  }
}
