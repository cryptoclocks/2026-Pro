import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { LayoutSchema, type Layout, type Manifest } from "@ccp/shared";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Payload registry: builder output (layout.json + assets + wasm) becomes an
 * immutable PayloadVersion with a manifest of per-file sha256 hashes.
 *
 * Bundle zips live in MinIO/S3 (bundleKey). For the scaffold we accept
 * pre-built bundles via base64; the M5 milestone replaces this with multipart
 * upload + server-side zipping + presigned download URLs.
 */
@Injectable()
export class PayloadsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const payload = await this.prisma.payload.upsert({
      where: { packageId: opts.packageId },
      update: { title: opts.title },
      create: {
        packageId: opts.packageId,
        title: opts.title,
        ownerId: opts.ownerId,
        type: (opts.layout.wasm?.length ?? 0) > 0 ? "LAYOUT_WASM" : "LAYOUT",
      },
    });

    return this.prisma.payloadVersion.create({
      data: {
        payloadId: payload.id,
        version: opts.version,
        minFwVersion: opts.layout.meta.min_fw,
        bundleKey: opts.bundleKey,
        bundleSha256: opts.bundleSha256,
        sizeBytes: opts.sizeBytes,
        manifest: opts.manifest as object,
        layout: opts.layout as object,
        status: "PUBLISHED",
      },
    });
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
}
