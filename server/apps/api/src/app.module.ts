import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { MqttModule } from "./mqtt/mqtt.module";
import { DevicesModule } from "./devices/devices.module";
import { PayloadsModule } from "./payloads/payloads.module";
import { BillingModule } from "./billing/billing.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MqttModule,
    DevicesModule,
    PayloadsModule,
    BillingModule,
  ],
})
export class AppModule {}
