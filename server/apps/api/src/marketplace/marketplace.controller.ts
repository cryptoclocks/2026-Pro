import { Body, Controller, Get, Post } from "@nestjs/common";
import { MarketplaceService } from "./marketplace.service";

@Controller("store")
export class MarketplaceController {
  constructor(private readonly market: MarketplaceService) {}

  @Get("items")
  items() {
    return this.market.listItems();
  }

  @Post("checkout")
  checkout(
    @Body()
    body: {
      slug: string;
      deviceId?: string;
      successUrl?: string;
      cancelUrl?: string;
    },
  ) {
    const base = process.env.PUBLIC_WEB_URL ?? "https://cryptoclock.app";
    return this.market.checkout(
      body.slug,
      body.deviceId ?? "",
      body.successUrl ?? `${base}/store/success`,
      body.cancelUrl ?? `${base}/store/cancel`,
    );
  }
}
