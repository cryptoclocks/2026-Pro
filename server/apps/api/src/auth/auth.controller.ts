import { Controller, Get, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { UserGuard, CurrentUser } from "./auth.guards";

@Controller("auth")
export class AuthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Who am I + my entitlements (pages I own) + role. */
  @Get("me")
  @UseGuards(UserGuard)
  async me(@CurrentUser() user: User) {
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
      entitlements: entitlements.map((e) => ({
        slug: e.item.slug,
        title: e.item.title,
        source: e.source,
        since: e.createdAt,
      })),
    };
  }
}
