import { Module } from "@nestjs/common";
import { DevicesController } from "./devices.controller";
import { DeviceBootController } from "./device-boot.controller";
import { FirmwareController } from "./firmware.controller";
import { DevicesService } from "./devices.service";

@Module({
  controllers: [DevicesController, DeviceBootController, FirmwareController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
