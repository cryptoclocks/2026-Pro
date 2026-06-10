import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { DevicesService } from "./devices.service";
import type { DeviceCommandType } from "@ccp/shared";
import { CurrentUser, UserGuard, AdminGuard } from "../auth/auth.guards";
import type { User } from "@prisma/client";

/** Device fleet, settings, assignment, and command endpoints. */
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** User claims a device by hardware id + claim code shown on screen. */
  @Post("claim")
  @UseGuards(UserGuard)
  claim(
    @CurrentUser() user: User,
    @Body() body: { deviceId: string; code: string; name?: string },
  ) {
    return this.devices.claimByUser(user.id, body.deviceId, body.code, body.name);
  }

  @Get()
  @UseGuards(UserGuard)
  list(@CurrentUser() user: User) {
    return this.devices.listForUser(user);
  }

  /** Entitled item slugs for a device (device/app self-gating). */
  @Get(":hwId/entitlements")
  entitlements(@Param("hwId") hwId: string) {
    return this.devices.entitlementSlugs(hwId);
  }

  /** Admin: re-push a device's entitlements into its settings. */
  @Post(":hwId/entitlements/sync")
  @UseGuards(AdminGuard)
  syncEntitlements(@Param("hwId") hwId: string) {
    return this.devices.syncEntitlements(hwId);
  }

  /** Admin: grant/revoke a catalog item on this specific device. */
  @Post(":hwId/grant")
  @UseGuards(AdminGuard)
  grant(@Param("hwId") hwId: string, @CurrentUser() admin: User, @Body() body: { slug: string }) {
    return this.devices.grantItem(hwId, body.slug, admin.id);
  }

  @Post(":hwId/revoke")
  @UseGuards(AdminGuard)
  revoke(@Param("hwId") hwId: string, @Body() body: { slug: string }) {
    return this.devices.revokeItem(hwId, body.slug);
  }

  /** Assign payload version + immediate MQTT sync push. */
  @Post(":id/assign")
  assign(@Param("id") id: string, @Body() body: { payloadVersionId: string }) {
    return this.devices.assignPayload(id, body.payloadVersionId);
  }

  /** Device boot-time settings check (and admin read). */
  @Get(":hwId/settings")
  getSettings(@Param("hwId") hwId: string) {
    return this.devices.getSettings(hwId);
  }

  /** Save settings: bumps version + pushes to the device over MQTT. */
  @Put(":hwId/settings")
  putSettings(@Param("hwId") hwId: string, @Body() body: { config: Record<string, unknown> }) {
    return this.devices.putSettings(hwId, body.config ?? (body as Record<string, unknown>));
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
