import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { FeedsService } from "./feeds.service";
import { MarketController } from "./market.controller";

@Module({
  imports: [PrismaModule],
  controllers: [MarketController],
  providers: [FeedsService],
})
export class FeedsModule {}
