import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { DevicesModule } from "../devices/devices.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [PrismaModule, DevicesModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
