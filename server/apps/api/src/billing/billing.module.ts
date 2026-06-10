import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { DevicesModule } from "../devices/devices.module";

@Module({
  imports: [DevicesModule],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
