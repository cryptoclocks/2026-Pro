import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { MqttModule } from "./mqtt/mqtt.module";
import { DevicesModule } from "./devices/devices.module";
import { PayloadsModule } from "./payloads/payloads.module";
import { BillingModule } from "./billing/billing.module";
import { MarketplaceModule } from "./marketplace/marketplace.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { FeaturesModule } from "./features/features.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MqttModule,
    AuthModule,
    DevicesModule,
    PayloadsModule,
    BillingModule,
    MarketplaceModule,
    UsersModule,
    FeaturesModule,
  ],
})
export class AppModule {}
