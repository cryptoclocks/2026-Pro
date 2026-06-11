import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { hash, compare } from "bcryptjs";
import { nanoid } from "nanoid";
import { PrismaService } from "../prisma/prisma.service";
import { MqttBridgeService } from "../mqtt/mqtt-bridge.service";
import type { SyncCommandParams } from "@ccp/shared";
import type { User } from "@prisma/client";

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

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

  async listForUser(user: Pick<User, "id" | "role">) {
    const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
    this.logger.debug(`listForUser role=${user.role} admin=${isAdmin}`);
    const devices = await this.prisma.device.findMany({
      where: isAdmin ? undefined : { ownerId: user.id },
      include: {
        activePayloadVersion: { include: { payload: true } },
        owner: { select: { email: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    // attach each device's per-device entitlement slugs
    const out = [];
    for (const d of devices) {
      const ents = await this.prisma.entitlement.findMany({
        where: { deviceId: d.deviceId },
        include: { item: true },
      });
      out.push(
        jsonSafe({
          ...d,
          entitlements: ents.map((e) => ({
            slug: e.item.slug,
            title: e.item.title,
            kind: e.item.kind,
            source: e.source,
          })),
        }),
      );
    }
    this.logger.debug(`listForUser returned ${out.length} devices`);
    return out;
  }

  /** Admin: every device, enriched (used by the CryptoClock mgmt page). */
  async adminListAll() {
    return this.listForUser({ id: "", role: "ADMIN" });
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
    return jsonSafe({ device, cmdId });
  }

  sendCommand(hwDeviceId: string, type: Parameters<MqttBridgeService["sendCommand"]>[1], params?: Record<string, unknown>) {
    return this.mqtt.sendCommand(hwDeviceId, type, params);
  }

  /**
   * Home-UI settings (device.json shape). The device GETs this at boot and
   * compares versions; saving also pushes the new config over MQTT so online
   * devices apply it instantly.
   */
  async getSettings(hwDeviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) {
      throw new NotFoundException("device not found");
    }
    return { version: device.settingsVersion, config: device.settings };
  }

  async putSettings(hwDeviceId: string, config: Record<string, unknown>) {
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) {
      throw new NotFoundException("device not found");
    }
    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: { settings: config as object, settingsVersion: device.settingsVersion + 1 },
    });
    this.mqtt.sendCommand(hwDeviceId, "settings", {
      version: updated.settingsVersion,
      config,
    });
    return { version: updated.settingsVersion, config: updated.settings };
  }

  /** Admin grants/revokes a catalog item on ONE device (per-CryptoClock). */
  async grantItem(hwDeviceId: string, slug: string, actorUserId: string) {
    const [device, item] = await Promise.all([
      this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } }),
      this.prisma.marketplaceItem.findUnique({
        where: { slug },
        include: {
          payloadRef: {
            include: {
              versions: { where: { status: "PUBLISHED" }, orderBy: { createdAt: "desc" }, take: 1 },
            },
          },
        },
      }),
    ]);
    if (!device) throw new NotFoundException("device not found");
    if (!item) throw new NotFoundException("item not found");
    const userId = device.ownerId ?? actorUserId;
    this.logger.debug(`grantItem device=${hwDeviceId} slug=${slug} user=${userId}`);
    await this.prisma.entitlement.upsert({
      where: { deviceId_itemId: { deviceId: hwDeviceId, itemId: item.id } },
      update: { userId, source: "GIFT" },
      create: { deviceId: hwDeviceId, itemId: item.id, userId, source: "GIFT" },
    });
    const synced = await this.syncEntitlements(hwDeviceId);
    const latest = item.payloadRef?.versions[0];
    if (latest) {
      const assigned = await this.assignPayload(device.id, latest.id);
      return { ok: true, entitlementSynced: synced, assigned };
    }
    return { ok: true, entitlementSynced: synced };
  }

  async revokeItem(hwDeviceId: string, slug: string) {
    const item = await this.prisma.marketplaceItem.findUnique({ where: { slug } });
    if (!item) throw new NotFoundException("item not found");
    this.logger.debug(`revokeItem device=${hwDeviceId} slug=${slug}`);
    await this.prisma.entitlement
      .delete({ where: { deviceId_itemId: { deviceId: hwDeviceId, itemId: item.id } } })
      .catch(() => undefined);
    return this.syncEntitlements(hwDeviceId);
  }

  /** Entitled item slugs for a device (what it's allowed to use). */
  async entitlementSlugs(hwDeviceId: string): Promise<string[]> {
    const ents = await this.prisma.entitlement.findMany({
      where: { deviceId: hwDeviceId },
      include: { item: true },
    });
    return ents.map((e) => e.item.slug);
  }

  /**
   * Mirror the device's per-device entitlements into settings.entitlements and
   * push over MQTT, so the firmware can self-gate the features/pages it owns.
   */
  async syncEntitlements(hwDeviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) return;
    const ents = await this.prisma.entitlement.findMany({
      where: { deviceId: hwDeviceId },
      include: { item: true },
    });
    const cfg = ((device.settings as Record<string, unknown>) ?? {});
    cfg.entitlements = ents.map((e) => e.item.slug);

    // PAGE rights also enter/leave the swipe rotation (settings.pages).
    // Native ids stay untouched; entitled package pages are appended, revoked ones removed.
    const NATIVE = new Set(["clock", "crypto", "slideshow"]);
    const entitledPages = ents.filter((e) => e.item.kind === "PAGE").map((e) => e.item.slug);
    const pages = Array.isArray(cfg.pages) ? (cfg.pages as string[]) : ["clock", "crypto", "slideshow"];
    const kept = pages.filter((p) => NATIVE.has(p) || entitledPages.includes(p));
    for (const slug of entitledPages) if (!kept.includes(slug)) kept.push(slug);
    cfg.pages = kept;

    return this.putSettings(hwDeviceId, cfg);
  }
}

function jsonSafe<T>(value: T): T {
  if (typeof value === "bigint") {
    return value.toString() as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]),
    ) as T;
  }
  return value;
}
