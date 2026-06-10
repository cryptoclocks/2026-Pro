import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DevicesModule } from "../devices/devices.module";
import { FeaturesController } from "./features.controller";
import { FeaturesService } from "./features.service";

@Module({
  imports: [PrismaModule, DevicesModule],
  controllers: [FeaturesController],
  providers: [FeaturesService],
})
export class FeaturesModule {}
