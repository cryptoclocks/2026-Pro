import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { hash, compare } from "bcryptjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { PrismaService } from "../prisma/prisma.service";
import { MqttBridgeService } from "../mqtt/mqtt-bridge.service";
import type { SyncCommandParams } from "@ccp/shared";
import type { User } from "@prisma/client";
import { expandedEntitlementSlugs, runtimeSlugForCatalogSlug, catalogForSlug, catalogLookupSlugs, isRetiredStoreSlug } from "../marketplace/catalog";

/** Accepts both the legacy MAC-derived id and the provisioned CCP serial. */
const DEVICE_ID_RE = /^(ccp-[0-9a-f]{12}|CCP\d{6})$/;

/** Page slugs that get their own DevicePageSettings row. */
const CONFIG_PAGE_SLUGS = ["clock", "crypto", "slideshow", "weather", "profile", "calendar"];
/** Device-wide system keys kept in DeviceConfigHead.systemConfig. */
const SYSTEM_KEYS = ["display_mode", "page_delay_s", "brightness"];

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
   * Read the next serial WITHOUT consuming it. The Provision modal uses this
   * to show the operator the upcoming CCP number so they can verify it before
   * committing. If two admins open the modal at the same time they may both
   * see the same peek — that's fine; the actual increment happens on POST
   * provision, which is atomic.
   */
  async peekNextDeviceId(): Promise<string> {
    const c = await this.prisma.counter.upsert({
      where: { id: "device_ccp" },
      create: { id: "device_ccp", value: 0 },
      update: {},
    });
    return `CCP${String(c.value + 1).padStart(6, "0")}`;
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
    // dual-write: mirror into the normalized config tables (source of truth +
    // audit + sync state). Best-effort so it never breaks the legacy save path.
    await this.mirrorConfig(device.id, merged, "api").catch((e) =>
      this.logger.warn(`mirrorConfig ${hwDeviceId} failed: ${e}`),
    );
    this.mqtt.sendCommand(hwDeviceId, "settings", {
      version: updated.settingsVersion,
      config: merged,
    });
    return { version: updated.settingsVersion, config: updated.settings };
  }

  /**
   * Mirror a compiled `Device.settings` document into the normalized config
   * tables: bump the global revision, write one DevicePageSettings row per page,
   * record an audit revision, and mark the device's sync state pending. The
   * compiled doc stays the firmware cache; these tables become the source of
   * truth for the new per-page REST API (Phase 2+).
   */
  async mirrorConfig(deviceDbId: string, fullConfig: Record<string, unknown>, source: string, actorUserId?: string) {
    const sys: Record<string, unknown> = {};
    for (const k of SYSTEM_KEYS) if (k in fullConfig) sys[k] = fullConfig[k];
    const order = Array.isArray(fullConfig.pages) ? (fullConfig.pages as string[]) : [];
    const sha = createHash("sha256").update(JSON.stringify(fullConfig)).digest("hex");

    await this.prisma.$transaction(async (tx) => {
      const head = await tx.deviceConfigHead.upsert({
        where: { deviceDbId },
        create: { deviceDbId, revision: 1n, systemConfig: sys as object, compiledConfig: fullConfig as object, compiledSha256: sha, updatedSource: source, updatedByUserId: actorUserId ?? null },
        update: { revision: { increment: 1n }, systemConfig: sys as object, compiledConfig: fullConfig as object, compiledSha256: sha, updatedSource: source, updatedByUserId: actorUserId ?? null },
      });
      for (const slug of CONFIG_PAGE_SLUGS) {
        const pcfg = fullConfig[slug];
        if (!isPlainObject(pcfg)) continue;
        const pos = order.indexOf(slug);
        await tx.devicePageSettings.upsert({
          where: { deviceDbId_pageSlug: { deviceDbId, pageSlug: slug } },
          create: { deviceDbId, pageSlug: slug, config: pcfg as object, enabled: pos >= 0, position: pos >= 0 ? pos : 0, updatedSource: source, updatedByUserId: actorUserId ?? null },
          update: { config: pcfg as object, enabled: pos >= 0, position: pos >= 0 ? pos : 0, pageRevision: { increment: 1n }, updatedSource: source, updatedByUserId: actorUserId ?? null },
        });
      }
      await tx.deviceConfigRevision.create({
        data: { deviceDbId, globalRevision: head.revision, changeType: "settings", source, actorUserId: actorUserId ?? null, afterConfig: fullConfig as object },
      });
      await tx.deviceSyncState.upsert({
        where: { deviceDbId },
        create: { deviceDbId, desiredRevision: head.revision, status: "pending" },
        update: { desiredRevision: head.revision, status: "pending" },
      });
    });
  }

  /** One-time backfill (admin): populate the normalized config tables from each
   *  device's existing compiled `Device.settings`, for devices that have no
   *  DeviceConfigHead yet. Idempotent — already-migrated devices are skipped. */
  async backfillConfig() {
    const devices = await this.prisma.device.findMany({ select: { id: true, deviceId: true, settings: true } });
    let backfilled = 0;
    let skipped = 0;
    for (const d of devices) {
      const head = await this.prisma.deviceConfigHead.findUnique({ where: { deviceDbId: d.id } });
      if (head) { skipped++; continue; }
      const cfg = isPlainObject(d.settings) ? d.settings : {};
      try {
        await this.mirrorConfig(d.id, cfg, "device_import");
        backfilled++;
      } catch (e) {
        this.logger.warn(`backfill ${d.deviceId} failed: ${e}`);
      }
    }
    return { ok: true, backfilled, skipped, total: devices.length };
  }

  /* ---------------------------------------------- normalized config REST (P2) */

  /** Whole config doc for a device: revision + system + per-page rows. */
  async getConfigDoc(user: Pick<User, "id" | "role">, hwDeviceId: string) {
    await this.assertCanManageDevice(user, hwDeviceId);
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    const [head, pages, sync] = await Promise.all([
      this.prisma.deviceConfigHead.findUnique({ where: { deviceDbId: device.id } }),
      this.prisma.devicePageSettings.findMany({ where: { deviceDbId: device.id }, orderBy: { position: "asc" } }),
      this.prisma.deviceSyncState.findUnique({ where: { deviceDbId: device.id } }),
    ]);
    return jsonSafe({
      deviceId: hwDeviceId,
      revision: head?.revision ?? 0n,
      system: head?.systemConfig ?? {},
      pages: pages.map((p) => ({ slug: p.pageSlug, enabled: p.enabled, position: p.position, schemaVersion: p.schemaVersion, pageRevision: p.pageRevision, config: p.config })),
      sync: sync ? { desiredRevision: sync.desiredRevision, reportedRevision: sync.reportedRevision, status: sync.status } : null,
    });
  }

  /** One page's settings + the current baseRevision the client must echo back. */
  async getPage(user: Pick<User, "id" | "role">, hwDeviceId: string, slug: string) {
    await this.assertCanManageDevice(user, hwDeviceId);
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    const [head, page] = await Promise.all([
      this.prisma.deviceConfigHead.findUnique({ where: { deviceDbId: device.id } }),
      this.prisma.devicePageSettings.findUnique({ where: { deviceDbId_pageSlug: { deviceDbId: device.id, pageSlug: slug } } }),
    ]);
    return jsonSafe({ slug, baseRevision: head?.revision ?? 0n, schemaVersion: page?.schemaVersion ?? 1, pageRevision: page?.pageRevision ?? 0n, enabled: page?.enabled ?? false, position: page?.position ?? 0, config: page?.config ?? {} });
  }

  /** Write one page with optimistic concurrency, then recompile + push. */
  async putPage(user: Pick<User, "id" | "role">, hwDeviceId: string, slug: string, body: { baseRevision?: number; config?: Record<string, unknown> }) {
    await this.assertCanManageDevice(user, hwDeviceId);
    if (!CONFIG_PAGE_SLUGS.includes(slug)) throw new BadRequestException("unknown page");
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    const cfg = isPlainObject(body.config) ? body.config : {};
    await this.prisma.$transaction(async (tx) => {
      const head = await tx.deviceConfigHead.findUnique({ where: { deviceDbId: device.id } });
      const current = head?.revision ?? 0n;
      if (body.baseRevision != null && BigInt(body.baseRevision) !== current) {
        throw new ConflictException({ error: "CONFIG_REVISION_CONFLICT", currentRevision: Number(current) });
      }
      const existing = await tx.devicePageSettings.findUnique({ where: { deviceDbId_pageSlug: { deviceDbId: device.id, pageSlug: slug } } });
      const h = await tx.deviceConfigHead.upsert({ where: { deviceDbId: device.id }, create: { deviceDbId: device.id, revision: 1n, updatedSource: "api", updatedByUserId: user.id }, update: { revision: { increment: 1n }, updatedSource: "api", updatedByUserId: user.id } });
      await tx.devicePageSettings.upsert({
        where: { deviceDbId_pageSlug: { deviceDbId: device.id, pageSlug: slug } },
        create: { deviceDbId: device.id, pageSlug: slug, config: cfg as object, enabled: true, position: existing?.position ?? 99, updatedSource: "api", updatedByUserId: user.id },
        update: { config: cfg as object, pageRevision: { increment: 1n }, updatedSource: "api", updatedByUserId: user.id },
      });
      await tx.deviceConfigRevision.create({ data: { deviceDbId: device.id, globalRevision: h.revision, pageSlug: slug, changeType: "settings", source: "api", actorUserId: user.id, beforeConfig: (existing?.config as object) ?? undefined, afterConfig: cfg as object } });
      await tx.deviceSyncState.upsert({ where: { deviceDbId: device.id }, create: { deviceDbId: device.id, desiredRevision: h.revision, status: "pending" }, update: { desiredRevision: h.revision, status: "pending" } });
    });
    const compiled = await this.compileAndPush(device.id, hwDeviceId);
    return jsonSafe({ ok: true, config: compiled });
  }

  /** Compile the normalized tables to the firmware document, cache it on Device
   *  + DeviceConfigHead, and push over MQTT. Returns the compiled doc. */
  private async compileAndPush(deviceDbId: string, hwDeviceId: string): Promise<Record<string, unknown>> {
    const [head, pages] = await Promise.all([
      this.prisma.deviceConfigHead.findUnique({ where: { deviceDbId } }),
      this.prisma.devicePageSettings.findMany({ where: { deviceDbId }, orderBy: { position: "asc" } }),
    ]);
    const sys = isPlainObject(head?.systemConfig) ? (head!.systemConfig as Record<string, unknown>) : {};
    const cfg: Record<string, unknown> = { ...sys, pages: pages.filter((p) => p.enabled).map((p) => p.pageSlug) };
    for (const p of pages) cfg[p.pageSlug] = p.config;
    // inject asset references the firmware reads as local SD paths
    const assets = await this.prisma.deviceAsset.findMany({ where: { deviceDbId, enabled: true } });
    for (const a of assets) {
      if (!a.currentVersionId) continue;
      if (a.pageSlug === "profile" && a.assetKey === "avatar") {
        const pr = isPlainObject(cfg.profile) ? (cfg.profile as Record<string, unknown>) : {};
        pr.avatar = "pages/profile/assets/avatar.png";
        cfg.profile = pr;
      }
    }
    const sha = createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
    const updated = await this.prisma.device.update({ where: { id: deviceDbId }, data: { settings: cfg as object, settingsVersion: { increment: 1 } } });
    await this.prisma.deviceConfigHead.update({ where: { deviceDbId }, data: { compiledConfig: cfg as object, compiledSha256: sha } });
    this.mqtt.sendCommand(hwDeviceId, "settings", { version: updated.settingsVersion, config: cfg });
    return cfg;
  }

  /* ------------------------------------------------ device assets (P3) */

  private assetBaseDir(): string {
    return join(process.env.PAYLOAD_STORAGE_DIR ?? join(process.cwd(), "storage"), "device-assets");
  }

  /** Upload a page asset (base64). Stores an immutable version on the volume,
   *  bumps revision, then recompiles + pushes so the path is in the config. */
  async uploadAsset(user: Pick<User, "id" | "role">, hwDeviceId: string, slug: string, assetKey: string, body: { dataBase64?: string; sortOrder?: number }) {
    await this.assertCanManageDevice(user, hwDeviceId);
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    if (!body.dataBase64) throw new BadRequestException("dataBase64 required");
    const buf = Buffer.from(body.dataBase64, "base64");
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024) throw new BadRequestException("invalid file size");
    const det = detectAsset(buf);
    if (!det) throw new BadRequestException("unsupported file type");
    if (slug === "profile" && assetKey === "avatar") {
      if (det.kind !== "image") throw new BadRequestException("avatar must be PNG/JPEG");
      if (buf.length > 300 * 1024) throw new BadRequestException("avatar too large (max 300 KB)");
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    const asset = await this.prisma.deviceAsset.upsert({
      where: { deviceDbId_pageSlug_assetKey: { deviceDbId: device.id, pageSlug: slug, assetKey } },
      create: { deviceDbId: device.id, pageSlug: slug, assetKey, kind: det.kind, sortOrder: body.sortOrder ?? null },
      update: { kind: det.kind, enabled: true },
    });
    const version = (await this.prisma.deviceAssetVersion.count({ where: { assetId: asset.id } })) + 1;
    const dir = join(this.assetBaseDir(), hwDeviceId, slug, assetKey);
    await mkdir(dir, { recursive: true });
    const objectPath = join(dir, `v${version}.${det.ext}`);
    await writeFile(objectPath, buf);
    const ver = await this.prisma.deviceAssetVersion.create({
      data: { assetId: asset.id, version, objectPath, contentType: det.contentType, sizeBytes: BigInt(buf.length), sha256: sha, createdByUserId: user.id },
    });
    await this.prisma.deviceAsset.update({ where: { id: asset.id }, data: { currentVersionId: ver.id } });
    await this.prisma.$transaction(async (tx) => {
      const h = await tx.deviceConfigHead.upsert({ where: { deviceDbId: device.id }, create: { deviceDbId: device.id, revision: 1n }, update: { revision: { increment: 1n } } });
      await tx.deviceConfigRevision.create({ data: { deviceDbId: device.id, globalRevision: h.revision, pageSlug: slug, changeType: "asset", source: "api", actorUserId: user.id, metadata: { assetKey, version } } });
      await tx.deviceSyncState.upsert({ where: { deviceDbId: device.id }, create: { deviceDbId: device.id, desiredRevision: h.revision, status: "pending" }, update: { desiredRevision: h.revision, status: "pending" } });
    });
    await this.compileAndPush(device.id, hwDeviceId);
    return { assetId: asset.id, version, kind: det.kind, contentType: det.contentType, sizeBytes: buf.length, url: `/api/v1/devices/${hwDeviceId}/pages/${slug}/assets/${assetKey}/file` };
  }

  async listAssets(user: Pick<User, "id" | "role">, hwDeviceId: string, slug: string) {
    await this.assertCanManageDevice(user, hwDeviceId);
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    const assets = await this.prisma.deviceAsset.findMany({
      where: { deviceDbId: device.id, pageSlug: slug },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return jsonSafe(assets.map((a) => ({
      id: a.id, assetKey: a.assetKey, kind: a.kind, enabled: a.enabled, sortOrder: a.sortOrder,
      version: a.versions[0]?.version ?? 0, sizeBytes: a.versions[0]?.sizeBytes ?? 0n, contentType: a.versions[0]?.contentType ?? null,
      url: `/api/v1/devices/${hwDeviceId}/pages/${slug}/assets/${a.assetKey}/file`,
    })));
  }

  async serveAsset(user: Pick<User, "id" | "role">, hwDeviceId: string, slug: string, assetKey: string): Promise<{ buffer: Buffer; contentType: string }> {
    await this.assertCanManageDevice(user, hwDeviceId);
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    const asset = await this.prisma.deviceAsset.findUnique({ where: { deviceDbId_pageSlug_assetKey: { deviceDbId: device.id, pageSlug: slug, assetKey } } });
    if (!asset?.currentVersionId) throw new NotFoundException("asset not found");
    const ver = await this.prisma.deviceAssetVersion.findUnique({ where: { id: asset.currentVersionId } });
    if (!ver) throw new NotFoundException("asset version not found");
    return { buffer: await readFile(ver.objectPath), contentType: ver.contentType };
  }

  async deleteAsset(user: Pick<User, "id" | "role">, hwDeviceId: string, slug: string, assetKey: string) {
    await this.assertCanManageDevice(user, hwDeviceId);
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    const asset = await this.prisma.deviceAsset.findUnique({
      where: { deviceDbId_pageSlug_assetKey: { deviceDbId: device.id, pageSlug: slug, assetKey } },
      include: { versions: true },
    });
    if (!asset) return { ok: true };
    for (const v of asset.versions) await rm(v.objectPath, { force: true }).catch(() => undefined);
    await this.prisma.deviceAsset.delete({ where: { id: asset.id } });
    await this.compileAndPush(device.id, hwDeviceId);
    return { ok: true };
  }

  /* ------------------------------------------------ firmware OTA */

  private firmwareBaseDir(): string {
    return join(process.env.PAYLOAD_STORAGE_DIR ?? join(process.cwd(), "storage"), "firmware");
  }

  /** Admin uploads a firmware .bin (base64). Stored content-addressed on the
   *  volume; metadata + sha256 recorded for OTA. */
  async uploadFirmware(
    user: Pick<User, "id">,
    body: { version?: string; channel?: string; notes?: string; dataBase64?: string },
  ) {
    if (!body.version?.trim()) throw new BadRequestException("version required");
    if (!body.dataBase64) throw new BadRequestException("dataBase64 required");
    const buf = Buffer.from(body.dataBase64, "base64");
    if (buf.length < 1024 || buf.length > 16 * 1024 * 1024) {
      throw new BadRequestException("invalid firmware size (1KB–16MB)");
    }
    // ESP-IDF app images begin with the 0xE9 magic byte — reject obvious mistakes.
    if (buf[0] !== 0xe9) throw new BadRequestException("not an ESP32 firmware image (bad 0xE9 magic)");
    const sha = createHash("sha256").update(buf).digest("hex");
    const dir = this.firmwareBaseDir();
    await mkdir(dir, { recursive: true });
    const objectPath = join(dir, `${sha}.bin`);
    await writeFile(objectPath, buf);
    const fw = await this.prisma.firmware.create({
      data: {
        version: body.version.trim(),
        channel: body.channel?.trim() || "stable",
        notes: body.notes?.trim() || null,
        sha256: sha,
        sizeBytes: buf.length,
        objectPath,
        createdById: user.id,
      },
    });
    this.logger.log(`firmware uploaded ${fw.version} (${fw.channel}) sha=${sha.slice(0, 12)} ${buf.length}B`);
    return { id: fw.id, version: fw.version, channel: fw.channel, sha256: sha, sizeBytes: buf.length };
  }

  async listFirmware() {
    const rows = await this.prisma.firmware.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map((f) => ({
      id: f.id, version: f.version, channel: f.channel, notes: f.notes,
      sha256: f.sha256, sizeBytes: f.sizeBytes, createdAt: f.createdAt,
    }));
  }

  /** Public serve (like the package bundle.zip): the device GETs this URL during
   *  OTA and verifies the sha256 itself, so no per-device token is needed. */
  async getFirmwareFile(id: string): Promise<{ buffer: Buffer }> {
    const fw = await this.prisma.firmware.findUnique({ where: { id } });
    if (!fw) throw new NotFoundException("firmware not found");
    return { buffer: await readFile(fw.objectPath) };
  }

  /** Admin pushes an OTA: sends the device an `ota` command with the firmware's
   *  public file URL + sha256. The device downloads, verifies, flashes, reboots. */
  async pushOta(hwDeviceId: string, firmwareId: string) {
    const device = await this.prisma.device.findUnique({ where: { deviceId: hwDeviceId } });
    if (!device) throw new NotFoundException("device not found");
    const fw = await this.prisma.firmware.findUnique({ where: { id: firmwareId } });
    if (!fw) throw new NotFoundException("firmware not found");
    const base = process.env.PUBLIC_API_URL ?? "https://api.cashlessthailand.com";
    const fwUrl = `${base}/api/v1/firmware/${fw.id}/file`;
    const cmdId = this.mqtt.sendCommand(hwDeviceId, "ota", { fw_url: fwUrl, fw_sha256: fw.sha256 });
    this.logger.log(`OTA push ${hwDeviceId} -> ${fw.version} (${fw.sha256.slice(0, 12)})`);
    return { cmdId, version: fw.version, fwUrl };
  }

  /* ------------------------------------------------ device bootstrap (P4) */

  private async deviceByToken(deviceId: string, token: string) {
    if (!deviceId || !token || !(await this.verifyDeviceToken(deviceId, token))) {
      throw new UnauthorizedException("invalid device credentials");
    }
    const device = await this.prisma.device.findUnique({ where: { deviceId } });
    if (!device) throw new NotFoundException("device not found");
    return device;
  }

  /** Device boot: returns compiled config + asset manifest if newer than the
   *  device's local revision, else null (caller sends 204). */
  async deviceBootstrap(deviceId: string, token: string, sinceRevision?: number) {
    const device = await this.deviceByToken(deviceId, token);
    const head = await this.prisma.deviceConfigHead.findUnique({ where: { deviceDbId: device.id } });
    const rev = head?.revision ?? 0n;
    if (sinceRevision != null && BigInt(sinceRevision) >= rev) return null;
    const rows = await this.prisma.deviceAsset.findMany({ where: { deviceDbId: device.id, enabled: true } });
    const base = process.env.PUBLIC_API_URL ?? "https://api.cashlessthailand.com";
    const assets: Array<Record<string, unknown>> = [];
    for (const a of rows) {
      if (!a.currentVersionId) continue;
      const v = await this.prisma.deviceAssetVersion.findUnique({ where: { id: a.currentVersionId } });
      if (!v) continue;
      const ext = v.contentType === "image/gif" ? "gif" : v.contentType === "audio/wav" ? "wav" : v.contentType === "image/jpeg" ? "jpg" : "png";
      const localPath = a.assetKey === "avatar" ? "pages/profile/assets/avatar.png"
        : a.assetKey === "background" ? `pages/${a.pageSlug}/assets/background.${ext}`
        : `pages/${a.pageSlug}/assets/${a.assetKey}.${ext}`;
      assets.push({
        id: v.id, page: a.pageSlug, key: a.assetKey, local_path: localPath,
        download_url: `${base}/api/v1/device/assets/${v.id}/file?did=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(token)}`,
        sha256: v.sha256, size_bytes: Number(v.sizeBytes), content_type: v.contentType,
      });
    }
    await this.prisma.deviceSyncState.upsert({
      where: { deviceDbId: device.id },
      create: { deviceDbId: device.id, desiredRevision: rev, status: "syncing", lastNotifiedAt: new Date() },
      update: { status: "syncing", lastNotifiedAt: new Date() },
    });
    return { revision: Number(rev), sha256: head?.compiledSha256 ?? null, config: head?.compiledConfig ?? {}, assets };
  }

  /** Device acknowledges it applied a revision (updates sync state). */
  async deviceAck(deviceId: string, token: string, revision: number, sha256?: string) {
    const device = await this.deviceByToken(deviceId, token);
    await this.prisma.deviceSyncState.upsert({
      where: { deviceDbId: device.id },
      create: { deviceDbId: device.id, desiredRevision: BigInt(revision || 0), reportedRevision: BigInt(revision || 0), reportedSha256: sha256 ?? null, status: "applied", lastAppliedAt: new Date() },
      update: { reportedRevision: BigInt(revision || 0), reportedSha256: sha256 ?? null, status: "applied", lastAppliedAt: new Date(), lastError: null },
    });
    return { ok: true };
  }

  async deviceError(deviceId: string, token: string, error: string) {
    const device = await this.deviceByToken(deviceId, token);
    await this.prisma.deviceSyncState.updateMany({ where: { deviceDbId: device.id }, data: { status: "failed", lastError: String(error || "").slice(0, 500) } });
    return { ok: true };
  }

  /** Stream an asset file to the device (device-token auth via query). */
  async serveDeviceAsset(deviceId: string, token: string, versionId: string): Promise<{ buffer: Buffer; contentType: string }> {
    const device = await this.deviceByToken(deviceId, token);
    const v = await this.prisma.deviceAssetVersion.findUnique({ where: { id: versionId }, include: { asset: true } });
    if (!v || v.asset.deviceDbId !== device.id) throw new NotFoundException("asset not found");
    return { buffer: await readFile(v.objectPath), contentType: v.contentType };
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

/** Sniff a supported asset type from its magic bytes (never trust the filename). */
function detectAsset(buf: Buffer): { ext: string; contentType: string; kind: string } | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return { ext: "png", contentType: "image/png", kind: "image" };
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    return { ext: "gif", contentType: "image/gif", kind: "gif" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { ext: "jpg", contentType: "image/jpeg", kind: "image" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE")
    return { ext: "wav", contentType: "audio/wav", kind: "audio" };
  return null;
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
