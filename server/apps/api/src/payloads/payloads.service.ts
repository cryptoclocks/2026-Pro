import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { LayoutSchema, type Layout, type Manifest } from "@ccp/shared";
import type { User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MqttBridgeService } from "../mqtt/mqtt-bridge.service";

const execFileAsync = promisify(execFile);
const MAX_LOGIC_SOURCE_BYTES = 128 * 1024;
const MAX_WASM_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024; // per-file cap for gif/png/wav assets

type CompileRustWasmInput = {
  source: string;
  moduleId?: string;
};

type PublishedWasmFile = {
  path: string;
  wasmBase64: string;
};

type PublishedAssetFile = {
  path: string; // bundle-relative, e.g. assets/clear.gif
  base64: string;
};

type BundleFile = {
  path: string;
  data: Buffer;
};

/**
 * Payload registry: builder output (layout.json + assets + wasm) becomes an
 * immutable PayloadVersion with a manifest of per-file sha256 hashes.
 *
 * Bundle zips live in object storage in production. The local builder path
 * stores deterministic zip bundles on disk so ESP32 sync works during M5 dev.
 */
@Injectable()
export class PayloadsService {
  private readonly logger = new Logger(PayloadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttBridgeService,
  ) {}

  validateLayout(layout: unknown): Layout {
    const parsed = LayoutSchema.safeParse(layout);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "layout.json failed validation",
        issues: parsed.error.issues.slice(0, 20),
      });
    }
    return parsed.data;
  }

  buildManifest(packageId: string, version: string, files: { path: string; data: Buffer }[]): Manifest {
    return {
      manifest_version: 1,
      package_id: packageId,
      version,
      layout: "layout.json",
      total_size: files.reduce((sum, f) => sum + f.data.length, 0),
      files: files.map((f) => ({
        path: f.path,
        sha256: createHash("sha256").update(f.data).digest("hex"),
        size: f.data.length,
      })),
    };
  }

  async compileRustWasm(input: CompileRustWasmInput) {
    if (typeof input.source !== "string" || input.source.trim().length === 0) {
      throw new BadRequestException("Rust source is required");
    }
    if (Buffer.byteLength(input.source, "utf8") > MAX_LOGIC_SOURCE_BYTES) {
      throw new BadRequestException(`Rust source is too large; max ${MAX_LOGIC_SOURCE_BYTES} bytes`);
    }

    const moduleId = assertIdent(input.moduleId || "logic", "moduleId");
    const root = await mkdtemp(join(tmpdir(), "ccp-page-logic-"));
    this.logger.debug(`compileRustWasm:start module=${moduleId} bytes=${Buffer.byteLength(input.source, "utf8")}`);

    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "Cargo.toml"), rustCargoToml(), "utf8");
      await writeFile(join(root, "src", "lib.rs"), input.source, "utf8");

      const cargo = this.resolveCargo();
      const rustc = this.resolveRustc(cargo);
      const env = {
        ...process.env,
        CARGO_TARGET_DIR: join(root, "target"),
        ...(rustc ? { RUSTC: rustc } : {}),
      };

      const result = await execFileAsync(cargo, ["build", "--release", "--target", "wasm32-unknown-unknown"], {
        cwd: root,
        env,
        timeout: 60_000,
        maxBuffer: 3 * 1024 * 1024,
      });

      const wasm = await readFile(join(root, "target", "wasm32-unknown-unknown", "release", "ccp_page_logic.wasm"));
      if (wasm.length === 0 || wasm.length > MAX_WASM_BYTES) {
        throw new BadRequestException(`Compiled WASM size must be 1..${MAX_WASM_BYTES} bytes`);
      }

      this.logger.debug(`compileRustWasm:done module=${moduleId} size=${wasm.length} sha256=${sha256(wasm)}`);
      return {
        ok: true,
        moduleId,
        path: `wasm/${moduleId}.wasm`,
        sizeBytes: wasm.length,
        sha256: sha256(wasm),
        wasmBase64: wasm.toString("base64"),
        diagnostics: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const e = err as { message?: string; stdout?: string; stderr?: string };
      this.logger.warn(`compileRustWasm:fail module=${moduleId}: ${[e.stderr, e.stdout, e.message].filter(Boolean).join(" ").slice(0, 500)}`);
      throw new BadRequestException({
        message: "Rust WASM compile failed",
        diagnostics: [e.stderr, e.stdout, e.message].filter(Boolean).join("\n").trim(),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async publishCompiled(opts: {
    ownerId: string;
    title?: string;
    version?: string;
    layout: Layout;
    wasmFiles?: PublishedWasmFile[];
    assetFiles?: PublishedAssetFile[];
  }) {
    if (!opts.ownerId) {
      throw new BadRequestException("ownerId is required to publish");
    }

    const packageId = opts.layout.meta.id;
    const version = opts.version || opts.layout.meta.version;
    this.logger.debug(`publishCompiled:start package=${packageId} version=${version} wasm=${opts.wasmFiles?.length ?? 0}`);
    const files: BundleFile[] = [
      {
        path: "layout.json",
        data: Buffer.from(JSON.stringify(opts.layout, null, 2), "utf8"),
      },
    ];

    for (const wasm of opts.wasmFiles ?? []) {
      const path = assertBundlePath(wasm.path);
      const data = Buffer.from(wasm.wasmBase64, "base64");
      if (data.length === 0 || data.length > MAX_WASM_BYTES) {
        throw new BadRequestException(`${path} size must be 1..${MAX_WASM_BYTES} bytes`);
      }
      files.push({ path, data });
    }

    const seenAsset = new Set(files.map((f) => f.path));
    for (const asset of opts.assetFiles ?? []) {
      const path = assertBundlePath(asset.path);
      if (seenAsset.has(path)) continue; // sent twice → keep first
      const data = Buffer.from(asset.base64, "base64");
      if (data.length === 0 || data.length > MAX_ASSET_BYTES) {
        throw new BadRequestException(`${path} size must be 1..${MAX_ASSET_BYTES} bytes`);
      }
      files.push({ path, data });
      seenAsset.add(path);
    }

    const bundled = new Set(files.map((file) => file.path));
    for (const module of opts.layout.wasm ?? []) {
      const path = assertBundlePath(module.path);
      if (bundled.has(path)) continue;
      const previous = await this.readLatestPayloadFile(packageId, path);
      if (!previous) {
        throw new BadRequestException(
          `${path} is referenced by the layout but no compiled file was provided. Compile Rust before the first publish.`,
        );
      }
      files.push({ path, data: previous });
      bundled.add(path);
      this.logger.debug(`publishCompiled:carried-forward ${path} package=${packageId}`);
    }

    // Carry assets referenced by the layout forward from the previous version so
    // re-publishing a page (e.g. moving a widget) doesn't require re-uploading them.
    for (const asset of opts.layout.assets ?? []) {
      const path = assertBundlePath(asset.path);
      if (bundled.has(path)) continue;
      const previous = await this.readLatestPayloadFile(packageId, path);
      if (!previous) {
        throw new BadRequestException(
          `asset "${asset.id}" (${path}) is referenced by the layout but was not uploaded. Add the file in the Builder Assets panel before publishing.`,
        );
      }
      files.push({ path, data: previous });
      bundled.add(path);
      this.logger.debug(`publishCompiled:carried-forward-asset ${path} package=${packageId}`);
    }

    const manifest = this.buildManifest(packageId, version, files);
    // firmware sync_manager verifies <dir>/manifest.json after unzip — ship it inside the bundle
    const bundle = buildZip([
      ...files,
      { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
    ]);
    const bundleSha256 = sha256(bundle);
    const bundleKey = `payloads/${packageId}/${version}/bundle.zip`;
    const storageRoot = this.storageRoot();
    const bundlePath = join(storageRoot, bundleKey);
    const manifestPath = join(storageRoot, "payloads", packageId, version, "manifest.json");

    await mkdir(dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, bundle);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    for (const file of files) {
      const out = join(storageRoot, "payloads", packageId, version, file.path);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, file.data);
    }

    const payloadVersion = await this.publishVersion({
      ownerId: opts.ownerId,
      packageId,
      title: opts.title || opts.layout.meta.name,
      version,
      layout: opts.layout,
      bundleKey,
      bundleSha256,
      sizeBytes: bundle.length,
      manifest,
    });
    const marketplaceItem = await this.ensureMarketplaceItem({
      ownerId: opts.ownerId,
      payloadId: payloadVersion.payloadId,
      packageId,
      title: opts.title || opts.layout.meta.name,
      description: opts.layout.meta.description,
    });
    // Auto-update every CryptoClock that already owns this page: point it at the
    // new version and push MQTT sync so admins don't re-grant after each edit.
    const pushedTo = await this.propagateToEntitledDevices(
      payloadVersion.payloadId,
      payloadVersion.id,
      packageId,
      version,
      bundleSha256,
      bundle.length,
    );
    this.logger.debug(`publishCompiled:done package=${packageId} version=${version} pv=${payloadVersion.id} item=${marketplaceItem.slug} bundle=${bundle.length} pushedTo=${pushedTo}`);

    return {
      ok: true,
      pushedToDevices: pushedTo,
      payloadVersionId: payloadVersion.id,
      packageId,
      version,
      bundleKey,
      bundleUrl: `/api/v1/packages/${packageId}/${version}/bundle.zip`,
      bundleSha256,
      sizeBytes: bundle.length,
      manifest,
      marketplaceItem: {
        id: marketplaceItem.id,
        slug: marketplaceItem.slug,
        title: marketplaceItem.title,
        published: marketplaceItem.published,
        priceCents: marketplaceItem.priceCents,
        currency: marketplaceItem.currency,
      },
    };
  }

  /**
   * Push a freshly published version to every device already entitled to this
   * page (Entitlement → MarketplaceItem.payloadId == this payload). Each device's
   * activePayloadVersion is bumped and an MQTT cmd:sync is sent so the ESP32
   * downloads the new bundle without a re-grant. Returns the device count.
   */
  private async propagateToEntitledDevices(
    payloadId: string,
    versionId: string,
    packageId: string,
    version: string,
    bundleSha256: string,
    sizeBytes: number,
  ): Promise<number> {
    const ents = await this.prisma.entitlement.findMany({
      where: { item: { payloadId } },
      select: { deviceId: true },
    });
    const hwIds = [...new Set(ents.map((e) => e.deviceId))];
    const bundleUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/packages/${packageId}/${version}/bundle.zip`;
    let count = 0;
    for (const hwId of hwIds) {
      const device = await this.prisma.device.findUnique({ where: { deviceId: hwId } });
      if (!device) continue;
      await this.prisma.device.update({
        where: { id: device.id },
        data: { activePayloadVersionId: versionId },
      });
      this.mqtt.sendCommand(hwId, "sync", {
        package_id: packageId,
        version,
        bundle_url: bundleUrl,
        bundle_sha256: bundleSha256,
        bundle_size: sizeBytes,
      });
      count += 1;
    }
    return count;
  }

  /** Create or bump a payload version from a validated layout + bundle hash. */
  async publishVersion(opts: {
    ownerId: string;
    packageId: string;
    title: string;
    version: string;
    layout: Layout;
    bundleKey: string;
    bundleSha256: string;
    sizeBytes: number;
    manifest: Manifest;
  }) {
    const payloadType = (opts.layout.wasm?.length ?? 0) > 0 ? "LAYOUT_WASM" : "LAYOUT";
    const payload = await this.prisma.payload.upsert({
      where: { packageId: opts.packageId },
      update: { title: opts.title, type: payloadType },
      create: {
        packageId: opts.packageId,
        title: opts.title,
        ownerId: opts.ownerId,
        type: payloadType,
      },
    });

    const data = {
      payloadId: payload.id,
      version: opts.version,
      minFwVersion: opts.layout.meta.min_fw,
      bundleKey: opts.bundleKey,
      bundleSha256: opts.bundleSha256,
      sizeBytes: opts.sizeBytes,
      manifest: opts.manifest as object,
      layout: opts.layout as object,
      status: "PUBLISHED" as const,
    };

    const existing = await this.prisma.payloadVersion.findUnique({
      where: { payloadId_version: { payloadId: payload.id, version: opts.version } },
    });
    if (existing) {
      return this.prisma.payloadVersion.update({
        where: { id: existing.id },
        data,
      });
    }

    return this.prisma.payloadVersion.create({ data });
  }

  async getManifest(packageId: string, version: string): Promise<Manifest> {
    const pv = await this.prisma.payloadVersion.findFirst({
      where: { payload: { packageId }, version },
    });
    if (!pv) {
      throw new NotFoundException("package version not found");
    }
    return pv.manifest as unknown as Manifest;
  }

  async getBundle(packageId: string, version: string): Promise<Buffer> {
    const pv = await this.prisma.payloadVersion.findFirst({
      where: { payload: { packageId }, version },
    });
    if (!pv) {
      throw new NotFoundException("package version not found");
    }
    const path = join(this.storageRoot(), pv.bundleKey);
    if (!existsSync(path)) {
      throw new NotFoundException("bundle.zip not found on local storage");
    }
    return readFile(path);
  }

  async listBuilderPages(user: User) {
    const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
    const payloads = await this.prisma.payload.findMany({
      where: isAdmin ? undefined : { ownerId: user.id },
      orderBy: { createdAt: "desc" },
      include: {
        owner: { select: { email: true, name: true } },
        marketItems: true,
        versions: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    return payloads
      .filter((payload) => payload.versions.length > 0)
      .map((payload) => {
        const latest = payload.versions[0];
        const item = payload.marketItems[0] ?? null;
        return {
          id: payload.id,
          packageId: payload.packageId,
          title: payload.title,
          type: payload.type,
          owner: payload.owner,
          latest: {
            id: latest.id,
            version: latest.version,
            status: latest.status,
            createdAt: latest.createdAt,
            sizeBytes: latest.sizeBytes,
            bundleSha256: latest.bundleSha256,
          },
          marketplaceItem: item
            ? {
                id: item.id,
                slug: item.slug,
                title: item.title,
                kind: item.kind,
                published: item.published,
                priceCents: item.priceCents,
                currency: item.currency,
              }
            : null,
        };
      });
  }

  async getLatestBuilderPage(packageId: string, user: User) {
    const payload = await this.prisma.payload.findUnique({
      where: { packageId },
      include: {
        owner: { select: { email: true, name: true } },
        marketItems: true,
        versions: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    if (!payload || payload.versions.length === 0) {
      throw new NotFoundException("builder page not found");
    }
    const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";
    if (!isAdmin && payload.ownerId !== user.id) {
      throw new NotFoundException("builder page not found");
    }
    const latest = payload.versions[0];
    const item = payload.marketItems[0] ?? null;
    return {
      id: payload.id,
      packageId: payload.packageId,
      title: payload.title,
      type: payload.type,
      owner: payload.owner,
      latest: {
        id: latest.id,
        version: latest.version,
        status: latest.status,
        createdAt: latest.createdAt,
        sizeBytes: latest.sizeBytes,
        bundleSha256: latest.bundleSha256,
        manifest: latest.manifest,
        layout: latest.layout,
      },
      marketplaceItem: item
        ? {
            id: item.id,
            slug: item.slug,
            title: item.title,
            kind: item.kind,
            published: item.published,
            priceCents: item.priceCents,
            currency: item.currency,
          }
        : null,
    };
  }

  private storageRoot() {
    return process.env.PAYLOAD_STORAGE_DIR || join(process.cwd(), "storage");
  }

  private async readLatestPayloadFile(packageId: string, path: string): Promise<Buffer | null> {
    const version = await this.prisma.payloadVersion.findFirst({
      where: { payload: { packageId } },
      orderBy: { createdAt: "desc" },
    });
    if (!version) return null;
    const fullPath = join(this.storageRoot(), "payloads", packageId, version.version, assertBundlePath(path));
    if (!existsSync(fullPath)) return null;
    return readFile(fullPath);
  }

  private resolveCargo() {
    if (process.env.CCP_RUST_CARGO) return process.env.CCP_RUST_CARGO;
    const pinned = join(homedir(), ".rustup", "toolchains", "1.79.0-aarch64-apple-darwin", "bin", "cargo");
    if (existsSync(pinned)) return pinned;
    const cargoHome = join(homedir(), ".cargo", "bin", "cargo");
    if (existsSync(cargoHome)) return cargoHome;
    return "cargo";
  }

  private resolveRustc(cargo: string) {
    if (process.env.CCP_RUSTC) return process.env.CCP_RUSTC;
    if (cargo.endsWith("/cargo")) {
      const sibling = `${cargo.slice(0, -"cargo".length)}rustc`;
      if (existsSync(sibling)) return sibling;
    }
    return undefined;
  }

  private async ensureMarketplaceItem(opts: {
    ownerId: string;
    payloadId: string;
    packageId: string;
    title: string;
    description?: string;
  }) {
    const slug = slugFromPackageId(opts.packageId);
    return this.prisma.marketplaceItem.upsert({
      where: { slug },
      update: {
        title: opts.title,
        description: opts.description,
        payloadId: opts.payloadId,
        authorId: opts.ownerId,
        kind: "PAGE",
      },
      create: {
        slug,
        title: opts.title,
        description: opts.description,
        kind: "PAGE",
        icon: "widgets",
        payloadId: opts.payloadId,
        authorId: opts.ownerId,
        priceCents: 0,
        currency: "thb",
        published: false,
      },
    });
  }
}

function rustCargoToml() {
  return `[package]
name = "ccp-page-logic"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
lto = true
panic = "abort"
strip = true
codegen-units = 1
`;
}

function assertIdent(value: string, label: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(value)) {
    throw new BadRequestException(`${label} must match /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/`);
  }
  return value;
}

function assertBundlePath(path: string) {
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new BadRequestException(`Invalid bundle path: ${path}`);
  }
  return path;
}

function sha256(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

function slugFromPackageId(packageId: string) {
  return packageId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildZip(files: BundleFile[]) {
  let offset = 0;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const dosDate = (1 << 5) | 1;

  for (const file of files) {
    const name = Buffer.from(assertBundlePath(file.path), "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + file.data.length;
  }

  const centralOffset = offset;
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDir, end]);
}

function crc32(buf: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
