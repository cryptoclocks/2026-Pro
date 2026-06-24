import { Body, Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { DevicesService } from "./devices.service";
import { CurrentUser, AdminGuard } from "../auth/auth.guards";
import type { User } from "@prisma/client";

/**
 * Firmware upload + OTA distribution. Admin-only, except the file serve which is
 * public (the device fetches it during an OTA and verifies the sha256 itself,
 * exactly like a package bundle.zip — so no per-device token is required).
 */
@Controller("firmware")
export class FirmwareController {
  constructor(private readonly devices: DevicesService) {}

  /** Upload a firmware .bin (base64 in JSON). Returns id + sha256. */
  @Post()
  @UseGuards(AdminGuard)
  upload(
    @CurrentUser() admin: User,
    @Body() body: { version?: string; channel?: string; notes?: string; dataBase64?: string },
  ) {
    return this.devices.uploadFirmware(admin, body);
  }

  /** List uploaded firmware versions (newest first). */
  @Get()
  @UseGuards(AdminGuard)
  list() {
    return this.devices.listFirmware();
  }

  /** Public binary serve — the OTA download target. */
  @Get(":id/file")
  async file(@Param("id") id: string, @Res() res: Response) {
    const { buffer } = await this.devices.getFirmwareFile(id);
    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", "no-store");
    res.send(buffer);
  }
}
