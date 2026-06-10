import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { AdminGuard, UserGuard, CurrentUser } from "../auth/auth.guards";
import { MarketplaceService } from "./marketplace.service";

@Controller("store")
export class MarketplaceController {
  constructor(private readonly market: MarketplaceService) {}

  /** Public catalog (pages + features) with prices. */
  @Get("items")
  items() {
    return this.market.listItems();
  }

  /** Buy a catalog item for ONE specific device (per-CryptoClock rights). */
  @Post("checkout")
  @UseGuards(UserGuard)
  checkout(
    @CurrentUser() user: User,
    @Body() body: { slug: string; deviceId: string; successUrl?: string; cancelUrl?: string },
  ) {
    const base = process.env.PUBLIC_WEB_URL ?? "https://cryptoclock.app";
    return this.market.checkout(
      body.slug,
      body.deviceId,
      user.id,
      body.successUrl ?? `${base}/store/success`,
      body.cancelUrl ?? `${base}/store/cancel`,
    );
  }

  @Get("admin/items")
  @UseGuards(AdminGuard)
  adminItems() {
    return this.market.adminListItems();
  }

  @Patch("admin/items/:id")
  @UseGuards(AdminGuard)
  updateItem(
    @Param("id") id: string,
    @Body() patch: { priceCents?: number; published?: boolean; title?: string; description?: string },
  ) {
    return this.market.updateItem(id, patch);
  }
}
