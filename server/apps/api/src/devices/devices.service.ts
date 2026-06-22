import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { hash, compare } from "bcryptjs";
import { nanoid } from "nanoid";
import { PrismaService } from "../prisma/prisma.service";
import { MqttBridgeService } from "../mqtt/mqtt-bridge.service";
import type { SyncCommandParams } from "@ccp/shared";
import type { User } from "@prisma/client";
import { expandedEntitlementSlugs, runtimeSlugForCatalogSlug, catalogForSlug, catalogLookupSlugs, isRetiredStoreSlug } from "../marketplace/catalog";

/** Accepts both the legacy MAC-derived id and the provisioned CCP serial. */
const DEVICE_ID_RE = /^(ccp-[0-9a-f]{12}|CCP\d{6})$/;

export type ProvisionInput = {
  mac: string;
  buyerEmail?: string;
  firstname?: string;
  lastname?: string;
  position?: string;
  company?: string;
  ssid?: string;
  pass?: string;
  oldssid?: string;
  permission?: number;
  active?: number;
  coin1?: string;
  coin2?: string;
  customerName?: string;
  ads?: string;
};

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttBridgeService,
  ) {}

  /**
   * Claim flow (Option B): the device is already provisioned by an admin and
   * carries a deviceId + claimCode. The buyer signs in, then types or scans the
   * claim code (QR). We verify the code and set ownership. One device → one
   * owner; a second account is rejected (transfer is admin-only).
   */
  async claimByUser(userId: string, hwDeviceId: string, code: string, name?: string) {
    if (!DEVICE_ID_RE.test(hwDeviceId)) {
      throw new BadRequestException("invalid device id");
    }
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) {
      throw new NotFoundException("device not found — it must be provisioned first");
    }
    if (device.claimCode && code !== device.claimCode) {
      throw new BadRequestException("invalid claim code");
    }
    if (device.ownerId && device.ownerId !== userId) {
      throw new ConflictException("device is already owned by another account");
    }
    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: { ownerId: userId, name: name ?? device.name },
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
    return jsonSafe({ device: updated, mqttUsername: hwDeviceId });
  }

  /** Next sequential CCP serial, e.g. CCP000007 (atomic increment). */
  async nextDeviceId(): Promise<string> {
    const c = await this.prisma.counter.upsert({
      where: { id: "device_ccp" },
      create: { id: "device_ccp", value: 1 },
      update: { value: { increment: 1 } },
    });
    return `CCP${String(c.value).padStart(6, "0")}`;
  }

  /**
   * Admin provisions a new device by cable at sale time: assign the next CCP
   * serial, store buyer details + MAC, mint a device token + claim code, and
   * grant the default page entitlements. Returns token + claimCode for the admin
   * to push to the device (local /provision) and hand to the buyer.
   */
  async provision(adminId: string, input: ProvisionInput) {
    if (!input.mac) throw new BadRequestException("mac is required");
    const deviceId = await this.nextDeviceId();
    const claimCode = nanoid(8);
    const token = nanoid(32);
    const tokenHash = await hash(token, 10);

    let ownerId: string | null = null;
    if (input.buyerEmail) {
      const u = await this.prisma.user.upsert({
        where: { email: input.buyerEmail.toLowerCase() },
        update: {},
        create: { email: input.buyerEmail.toLowerCase(), passwordHash: "", role: "USER" },
      });
      ownerId = u.id;
    }

    const fullName = [input.firstname, input.lastname].filter(Boolean).join(" ").trim();
    const settings: Record<string, unknown> = {
      profile: {
        name: fullName || undefined,
        role: input.position || undefined,
        company: input.company || undefined,
      },
      coins: [input.coin1, input.coin2].filter(Boolean),
      ads: input.ads,
      permission: input.permission,
      provision: {
        firstname: input.firstname, lastname: input.lastname, position: input.position,
        company: input.company, ssid: input.ssid, oldssid: input.oldssid,
        customerName: input.customerName, active: input.active,
      },
    };

    const device = await this.prisma.device.create({
      data: {
        deviceId, mac: input.mac, claimCode, tokenHash, ownerId,
        name: input.customerName ?? null, settings: settings as object,
      },
    });

    // default swipe pages so a fresh device is usable out of the box
    for (const slug of ["clock", "crypto", "slideshow", "weather", "profile", "calendar"]) {
      await this.grantItem(deviceId, slug, adminId).catch((e) =>
        this.logger.warn(`provision grant ${slug} failed: ${e}`),
      );
    }
    this.logger.log(`provisioned ${deviceId} mac=${input.mac} owner=${ownerId ?? "(unclaimed)"}`);
    return jsonSafe({ deviceId, token, claimCode, mac: input.mac, device });
  }

  /** Admin sets/transfers a device's owner (by user email or user id). */
  async assignOwner(hwDeviceId: string, emailOrId: string) {
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    let userId = emailOrId;
    if (emailOrId.includes("@")) {
      const u = await this.prisma.user.upsert({
        where: { email: emailOrId.toLowerCase() },
        update: {},
        create: { email: emailOrId.toLowerCase(), passwordHash: "", role: "USER" },
      });
      userId = u.id;
    }
    const updated = await this.prisma.device.update({ where: { id: device.id }, data: { ownerId: userId } });
    return jsonSafe(updated);
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
            slug: catalogForSlug(e.item.slug)?.slug ?? e.item.slug,
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

  async putSettingsForUser(user: Pick<User, "id" | "role">, hwDeviceId: string, config: Record<string, unknown>) {
    await this.assertCanManageDevice(user, hwDeviceId);
    return this.putSettings(hwDeviceId, config);
  }

  async entitlementSlugsForUser(user: Pick<User, "id" | "role">, hwDeviceId: string) {
    await this.assertCanManageDevice(user, hwDeviceId);
    return this.entitlementSlugs(hwDeviceId);
  }

  async putSettings(hwDeviceId: string, config: Record<string, unknown>) {
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) {
      throw new NotFoundException("device not found");
    }
    const merged = mergeSettings(
      isPlainObject(device.settings) ? device.settings : {},
      isPlainObject(config) ? config : {},
    );
    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: { settings: merged as object, settingsVersion: device.settingsVersion + 1 },
    });
    this.mqtt.sendCommand(hwDeviceId, "settings", {
      version: updated.settingsVersion,
      config: merged,
    });
    return { version: updated.settingsVersion, config: updated.settings };
  }

  /** Admin grants/revokes a catalog item on ONE device (per-CryptoClock). */
  async grantItem(hwDeviceId: string, slug: string, actorUserId: string) {
    const [device, item] = await Promise.all([
      this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } }),
      this.prisma.marketplaceItem.findUnique({
        where: { slug: catalogForSlug(slug)?.slug ?? slug },
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
    const items = await this.prisma.marketplaceItem.findMany({ where: { slug: { in: catalogLookupSlugs(slug) } } });
    if (items.length === 0) throw new NotFoundException("item not found");
    this.logger.debug(`revokeItem device=${hwDeviceId} slug=${slug}`);
    await this.prisma.entitlement
      .deleteMany({ where: { deviceId: hwDeviceId, itemId: { in: items.map((item) => item.id) } } })
      .catch(() => undefined);
    return this.syncEntitlements(hwDeviceId);
  }

  /** Entitled item slugs for a device (what it's allowed to use). */
  async entitlementSlugs(hwDeviceId: string): Promise<string[]> {
    const ents = await this.prisma.entitlement.findMany({
      where: { deviceId: hwDeviceId },
      include: { item: true },
    });
    return expandedEntitlementSlugs(ents.map((e) => e.item.slug).filter((slug) => !isRetiredStoreSlug(slug)));
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
    const cfg = { ...((device.settings as Record<string, unknown>) ?? {}) };
    const activeEntitlementSlugs = ents.map((e) => e.item.slug).filter((slug) => !isRetiredStoreSlug(slug));
    cfg.entitlements = expandedEntitlementSlugs(activeEntitlementSlugs);

    // PAGE rights also enter/leave the swipe rotation (settings.pages).
    // Native ids stay untouched; entitled package pages are appended, revoked ones removed.
    const NATIVE = new Set(["clock", "crypto", "slideshow"]);
    const entitledPages = ents
      .filter((e) => e.item.kind === "PAGE" && !isRetiredStoreSlug(e.item.slug))
      .map((e) => runtimeSlugForCatalogSlug(e.item.slug));
    const pages = Array.isArray(cfg.pages) ? (cfg.pages as string[]) : ["clock", "crypto", "slideshow"];
    const kept = pages.filter((p) => NATIVE.has(p) || entitledPages.includes(p));
    for (const slug of entitledPages) if (!kept.includes(slug)) kept.push(slug);
    cfg.pages = kept;

    return this.putSettings(hwDeviceId, cfg);
  }

  private async assertCanManageDevice(user: Pick<User, "id" | "role">, hwDeviceId: string) {
    const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
    const device = await this.prisma.device.findUnique({
      where: { deviceId: hwDeviceId },
      select: { ownerId: true },
    });
    if (!device) {
      throw new NotFoundException("device not found");
    }
    if (!isAdmin && device.ownerId !== user.id) {
      throw new BadRequestException("device is not owned by this user");
    }
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeSettings(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value)
      ? mergeSettings(current, value)
      : value;
  }
  return out;
}
