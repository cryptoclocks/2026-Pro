import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { AdminGuard, UserGuard, CurrentUser } from "../auth/auth.guards";
import { FeaturesService } from "./features.service";

@Controller()
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  /** User requests an optional feature (e.g. crypto alerts) for their device. */
  @Post("me/feature-requests")
  @UseGuards(UserGuard)
  create(
    @CurrentUser() user: User,
    @Body() body: { deviceId: string; page: string; feature: string; detail?: Record<string, unknown> },
  ) {
    return this.features.create(user.id, body);
  }

  @Get("me/feature-requests")
  @UseGuards(UserGuard)
  mine(@CurrentUser() user: User) {
    return this.features.listForUser(user.id);
  }

  /** Admin approval queue. */
  @Get("admin/feature-requests")
  @UseGuards(AdminGuard)
  list(@Query("status") status?: "PENDING" | "APPROVED" | "REJECTED") {
    return this.features.list(status);
  }

  @Post("admin/feature-requests/:id/approve")
  @UseGuards(AdminGuard)
  approve(@Param("id") id: string, @CurrentUser() admin: User) {
    return this.features.decide(id, true, admin.email);
  }

  @Post("admin/feature-requests/:id/reject")
  @UseGuards(AdminGuard)
  reject(@Param("id") id: string, @CurrentUser() admin: User) {
    return this.features.decide(id, false, admin.email);
  }
}
