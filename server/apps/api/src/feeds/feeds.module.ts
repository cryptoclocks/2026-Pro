import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { FeedsService } from "./feeds.service";

@Module({
  imports: [PrismaModule],
  providers: [FeedsService],
})
export class FeedsModule {}
