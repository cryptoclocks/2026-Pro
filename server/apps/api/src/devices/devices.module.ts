import { Module } from "@nestjs/common";
import { DevicesController } from "./devices.controller";
import { DeviceBootController } from "./device-boot.controller";
import { DevicesService } from "./devices.service";

@Module({
  controllers: [DevicesController, DeviceBootController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
