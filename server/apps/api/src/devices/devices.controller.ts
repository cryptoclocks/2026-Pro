import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { DevicesService } from "./devices.service";
import type { DeviceCommandType } from "@ccp/shared";

/**
 * NOTE: auth guards land in M5 (JWT for users, device-token guard for
 * device-originated calls). Boilerplate keeps the surface explicit.
 */
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** User claims a device by hardware id + claim code shown on screen. */
  @Post("claim")
  claim(
    @Body() body: { userId: string; deviceId: string; code: string; name?: string },
  ) {
    return this.devices.claimByUser(body.userId, body.deviceId, body.code, body.name);
  }

  @Get()
  list(@Query("userId") userId: string) {
    return this.devices.listForUser(userId);
  }

  /** Assign payload version + immediate MQTT sync push. */
  @Post(":id/assign")
  assign(@Param("id") id: string, @Body() body: { payloadVersionId: string }) {
    return this.devices.assignPayload(id, body.payloadVersionId);
  }

  /** Generic command center endpoint (reboot, brightness, lock, ...). */
  @Post(":hwId/cmd")
  cmd(
    @Param("hwId") hwId: string,
    @Body() body: { type: DeviceCommandType; params?: Record<string, unknown> },
  ) {
    const cmdId = this.devices.sendCommand(hwId, body.type, body.params);
    return { cmdId };
  }
}
