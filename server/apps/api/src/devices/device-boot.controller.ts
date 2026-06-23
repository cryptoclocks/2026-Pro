import { Body, Controller, Get, Headers, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { DevicesService } from "./devices.service";

/**
 * Device-only endpoints. Authentication is the minted device token (sent as
 * X-Device-Id + X-Device-Token headers, or did+token query for asset GETs),
 * never a user JWT. Used by firmware to pull config + assets over HTTPS and ack.
 */
@Controller("device")
export class DeviceBootController {
  constructor(private readonly devices: DevicesService) {}

  /** Boot/refresh: 204 if the device's revision is current, else config+manifest. */
  @Get("bootstrap")
  async bootstrap(
    @Headers("x-device-id") deviceId: string,
    @Headers("x-device-token") token: string,
    @Query("revision") revision: string | undefined,
    @Res() res: Response,
  ) {
    const doc = await this.devices.deviceBootstrap(deviceId, token, revision != null ? Number(revision) : undefined);
    if (!doc) {
      res.status(204).send();
      return;
    }
    res.json(doc);
  }

  @Post("config-ack")
  ack(
    @Headers("x-device-id") deviceId: string,
    @Headers("x-device-token") token: string,
    @Body() body: { revision: number; sha256?: string },
  ) {
    return this.devices.deviceAck(deviceId, token, body.revision, body.sha256);
  }

  @Post("config-error")
  err(
    @Headers("x-device-id") deviceId: string,
    @Headers("x-device-token") token: string,
    @Body() body: { error: string },
  ) {
    return this.devices.deviceError(deviceId, token, body.error);
  }

  /** Asset download for the device (token in query — firmware http_download has no headers). */
  @Get("assets/:versionId/file")
  async asset(
    @Param("versionId") versionId: string,
    @Query("did") did: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    const { buffer, contentType } = await this.devices.serveDeviceAsset(did, token, versionId);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "no-store");
    res.send(buffer);
  }
}
