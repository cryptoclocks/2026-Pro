import { Body, Controller, Delete, Get, Param, Post, Put, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { DevicesService, type ProvisionInput } from "./devices.service";
import type { DeviceCommandType } from "@ccp/shared";
import { CurrentUser, UserGuard, AdminGuard } from "../auth/auth.guards";
import type { User } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Read the MAC address of an ESP32 device connected over USB by running
 *  esptool on the host. Used during the "Provision new device" flow so the
 *  admin doesn't have to copy/paste the MAC manually. */
async function readMacFromUsb(): Promise<string> {
  // esptool prints "MAC: 98:3D:AE:E9:14:78" on stdout and exits 0.
  // Try the user's venv path first (common dev setup), then fall back to PATH.
  const candidates = [
    ["/Users/natthapongsuwanjit/.espressif/python_env/idf5.5_py3.9_env/bin/python3",
      "-m", "esptool", "--chip", "esp32s3", "--port", "/dev/cu.usbmodem1301", "read_mac"],
  ];
  let lastErr: unknown = null;
  for (const cmd of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd[0], cmd.slice(1), { timeout: 8000 });
      const m = stdout.match(/([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/);
      if (m) return m[1].toUpperCase();
      lastErr = new Error(`esptool output did not contain a MAC: ${stdout.trim()}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error("esptool not available");
}

/** Device fleet, settings, assignment, and command endpoints. */
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** Admin helper for the Provision modal: reads the MAC of the device
   *  currently connected over USB so the operator doesn't have to type it.
   *  Returns { mac } on success or throws so the modal can show the error. */
  @Post("read-mac")
  @UseGuards(AdminGuard)
  async readMac() {
    const mac = await readMacFromUsb();
    return { mac };
  }

  /** User claims a device by hardware id + claim code shown on screen. */
  @Post("claim")
  @UseGuards(UserGuard)
  claim(
    @CurrentUser() user: User,
    @Body() body: { deviceId: string; code: string; name?: string },
  ) {
    return this.devices.claimByUser(user.id, body.deviceId, body.code, body.name);
  }

  /** Admin provisions a new device by cable at sale: assigns CCP serial + buyer. */
  @Post("provision")
  @UseGuards(AdminGuard)
  provision(@CurrentUser() admin: User, @Body() body: ProvisionInput) {
    return this.devices.provision(admin.id, body);
  }

  /** Admin sets/transfers a device's owner (by user email or id). */
  @Post(":hwId/assign-owner")
  @UseGuards(AdminGuard)
  assignOwner(@Param("hwId") hwId: string, @Body() body: { email?: string; userId?: string }) {
    return this.devices.assignOwner(hwId, body.email ?? body.userId ?? "");
  }

  /** Admin one-time backfill: compiled Device.settings → normalized config tables. */
  @Post("backfill-config")
  @UseGuards(AdminGuard)
  backfillConfig() {
    return this.devices.backfillConfig();
  }

  @Get()
  @UseGuards(UserGuard)
  list(@CurrentUser() user: User) {
    return this.devices.listForUser(user);
  }

  /** Entitled item slugs for a device (device/app self-gating). */
  @Get(":hwId/entitlements")
  @UseGuards(UserGuard)
  entitlements(@Param("hwId") hwId: string, @CurrentUser() user: User) {
    return this.devices.entitlementSlugsForUser(user, hwId);
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
  @UseGuards(AdminGuard)
  assign(@Param("id") id: string, @Body() body: { payloadVersionId: string }) {
    return this.devices.assignPayload(id, body.payloadVersionId);
  }

  /* ----- normalized config REST (Supabase source of truth, phase 2) ----- */

  /** Full normalized config: revision + system + per-page rows + sync state. */
  @Get(":hwId/config")
  @UseGuards(UserGuard)
  getConfig(@Param("hwId") hwId: string, @CurrentUser() user: User) {
    return this.devices.getConfigDoc(user, hwId);
  }

  /** One page's settings + the baseRevision to echo on write. */
  @Get(":hwId/pages/:slug")
  @UseGuards(UserGuard)
  getPage(@Param("hwId") hwId: string, @Param("slug") slug: string, @CurrentUser() user: User) {
    return this.devices.getPage(user, hwId, slug);
  }

  /** Write one page (optimistic concurrency via baseRevision) → recompile + push. */
  @Put(":hwId/pages/:slug")
  @UseGuards(UserGuard)
  putPage(
    @Param("hwId") hwId: string,
    @Param("slug") slug: string,
    @CurrentUser() user: User,
    @Body() body: { baseRevision?: number; config?: Record<string, unknown> },
  ) {
    return this.devices.putPage(user, hwId, slug, body);
  }

  /* ----- per-page assets (files on the OCI volume, phase 3) ----- */

  @Get(":hwId/pages/:slug/assets")
  @UseGuards(UserGuard)
  listAssets(@Param("hwId") hwId: string, @Param("slug") slug: string, @CurrentUser() user: User) {
    return this.devices.listAssets(user, hwId, slug);
  }

  /** Upload a page asset (base64 in JSON). Re-encode the avatar client-side to a
      132×132 PNG before sending; the API validates magic bytes + size. */
  @Post(":hwId/pages/:slug/assets/:assetKey")
  @UseGuards(UserGuard)
  uploadAsset(
    @Param("hwId") hwId: string,
    @Param("slug") slug: string,
    @Param("assetKey") assetKey: string,
    @CurrentUser() user: User,
    @Body() body: { dataBase64?: string; sortOrder?: number },
  ) {
    return this.devices.uploadAsset(user, hwId, slug, assetKey, body);
  }

  @Get(":hwId/pages/:slug/assets/:assetKey/file")
  @UseGuards(UserGuard)
  async serveAsset(
    @Param("hwId") hwId: string,
    @Param("slug") slug: string,
    @Param("assetKey") assetKey: string,
    @CurrentUser() user: User,
    @Res() res: Response,
  ) {
    const { buffer, contentType } = await this.devices.serveAsset(user, hwId, slug, assetKey);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "no-store");
    res.send(buffer);
  }

  @Delete(":hwId/pages/:slug/assets/:assetKey")
  @UseGuards(UserGuard)
  deleteAsset(@Param("hwId") hwId: string, @Param("slug") slug: string, @Param("assetKey") assetKey: string, @CurrentUser() user: User) {
    return this.devices.deleteAsset(user, hwId, slug, assetKey);
  }

  /** Device boot-time settings check (and admin read). */
  @Get(":hwId/settings")
  getSettings(@Param("hwId") hwId: string) {
    return this.devices.getSettings(hwId);
  }

  /** Save settings: bumps version + pushes to the device over MQTT. */
  @Put(":hwId/settings")
  @UseGuards(UserGuard)
  putSettings(
    @Param("hwId") hwId: string,
    @CurrentUser() user: User,
    @Body() body: { config: Record<string, unknown> },
  ) {
    return this.devices.putSettingsForUser(user, hwId, body.config ?? (body as Record<string, unknown>));
  }

  /** Generic command center endpoint (reboot, brightness, lock, ...). */
  @Post(":hwId/cmd")
  @UseGuards(AdminGuard)
  cmd(
    @Param("hwId") hwId: string,
    @Body() body: { type: DeviceCommandType; params?: Record<string, unknown> },
  ) {
    const cmdId = this.devices.sendCommand(hwId, body.type, body.params);
    return { cmdId };
  }

  /** Push an OTA firmware update to this device (admin). */
  @Post(":hwId/ota")
  @UseGuards(AdminGuard)
  ota(@Param("hwId") hwId: string, @Body() body: { firmwareId: string }) {
    return this.devices.pushOta(hwId, body.firmwareId);
  }
}
