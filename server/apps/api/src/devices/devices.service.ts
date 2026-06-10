import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { hash, compare } from "bcryptjs";
import { nanoid } from "nanoid";
import { PrismaService } from "../prisma/prisma.service";
import { MqttBridgeService } from "../mqtt/mqtt-bridge.service";
import type { SyncCommandParams } from "@ccp/shared";

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttBridgeService,
  ) {}

  /**
   * Claim flow:
   * 1. The device boots unclaimed and shows its claim code (QR).
   * 2. The user enters/scans the code in the web app -> POST /devices/claim
   *    (authenticated as the user).
   * 3. We register the device, mint a device token, and hand it back so the
   *    web app can transfer it (the device polls GET /devices/claim/:code).
   */
  async claimByUser(userId: string, hwDeviceId: string, code: string, name?: string) {
    if (!/^ccp-[0-9a-f]{12}$/.test(hwDeviceId)) {
      throw new BadRequestException("invalid device id");
    }
    const token = nanoid(32);
    const tokenHash = await hash(token, 10);

    const device = await this.prisma.device.upsert({
      where: { deviceId: hwDeviceId },
      update: { ownerId: userId, tokenHash, name },
      create: { deviceId: hwDeviceId, ownerId: userId, tokenHash, name },
    });

    await this.prisma.claim.create({
      data: {
        code: code || nanoid(8),
        deviceId: device.id,
        status: "CLAIMED",
        claimedByUserId: userId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    // token returned exactly once; device stores it in NVS, we keep the hash
    return { device, token, mqttUsername: hwDeviceId };
  }

  async verifyDeviceToken(hwDeviceId: string, token: string): Promise<boolean> {
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device?.tokenHash) {
      return false;
    }
    return compare(token, device.tokenHash);
  }

  async listForUser(userId: string) {
    return this.prisma.device.findMany({
      where: { ownerId: userId },
      include: { activePayloadVersion: { include: { payload: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Assign a payload version and push the sync command immediately. */
  async assignPayload(deviceDbId: string, payloadVersionId: string) {
    const version = await this.prisma.payloadVersion.findUnique({
      where: { id: payloadVersionId },
      include: { payload: true },
    });
    if (!version || version.status !== "PUBLISHED") {
      throw new NotFoundException("payload version not found or unpublished");
    }
    const device = await this.prisma.device.update({
      where: { id: deviceDbId },
      data: { activePayloadVersionId: version.id },
    });

    const params: SyncCommandParams = {
      package_id: version.payload.packageId,
      version: version.version,
      bundle_url: `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/packages/${version.payload.packageId}/${version.version}/bundle.zip`,
      bundle_sha256: version.bundleSha256,
      bundle_size: version.sizeBytes,
    };
    const cmdId = this.mqtt.sendCommand(device.deviceId, "sync", params as unknown as Record<string, unknown>);
    return { device, cmdId };
  }

  sendCommand(hwDeviceId: string, type: Parameters<MqttBridgeService["sendCommand"]>[1], params?: Record<string, unknown>) {
    return this.mqtt.sendCommand(hwDeviceId, type, params);
  }
}
