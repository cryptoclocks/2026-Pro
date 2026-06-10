import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  RawBodyRequest,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { BillingService } from "./billing.service";

@Controller("billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Stripe webhook endpoint — raw body required for signature verification. */
  @Post("webhook")
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("stripe-signature") signature: string,
  ) {
    if (!req.rawBody || !signature) {
      throw new BadRequestException("missing raw body or signature");
    }
    let event;
    try {
      event = this.billing.constructEvent(req.rawBody, signature);
    } catch (err) {
      throw new BadRequestException(`webhook signature verification failed: ${err}`);
    }
    await this.billing.handleEvent(event);
    return { received: true };
  }
}
