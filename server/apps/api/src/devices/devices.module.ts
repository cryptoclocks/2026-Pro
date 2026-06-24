import { Module } from "@nestjs/common";
import { DevicesController } from "./devices.controller";
import { DeviceBootController } from "./device-boot.controller";
import { FirmwareController } from "./firmware.controller";
import { DevicesService } from "./devices.service";
import { CompileService } from "./compile/compile.service";
import { SchemaService } from "./compile/schema.service";
import { SchemasController } from "./compile/schemas.controller";

@Module({
  controllers: [DevicesController, DeviceBootController, FirmwareController, SchemasController],
  providers: [DevicesService, CompileService, SchemaService],
  exports: [DevicesService, CompileService, SchemaService],
})
export class DevicesModule {}
