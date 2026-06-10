import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { PayloadsService } from "./payloads.service";

@Controller()
export class PayloadsController {
  constructor(private readonly payloads: PayloadsService) {}

  /** Builder export -> validate only (used live by the web builder). */
  @Post("payloads/validate")
  validate(@Body() body: { layout: unknown }) {
    const layout = this.payloads.validateLayout(body.layout);
    return { ok: true, meta: layout.meta };
  }

  /**
   * Publish a new version. Scaffold accepts the bundle metadata directly;
   * M5 swaps this for multipart upload -> MinIO -> server-side manifest.
   */
  @Post("payloads/publish")
  publish(
    @Body()
    body: {
      ownerId: string;
      title: string;
      version: string;
      layout: unknown;
      bundleKey: string;
      bundleSha256: string;
      sizeBytes: number;
      manifest: unknown;
    },
  ) {
    const layout = this.payloads.validateLayout(body.layout);
    return this.payloads.publishVersion({
      ownerId: body.ownerId,
      packageId: layout.meta.id,
      title: body.title || layout.meta.name,
      version: body.version || layout.meta.version,
      layout,
      bundleKey: body.bundleKey,
      bundleSha256: body.bundleSha256,
      sizeBytes: body.sizeBytes,
      manifest: body.manifest as never,
    });
  }

  /** Device-facing: manifest fetch (bundle.zip is 302 -> presigned URL in M5). */
  @Get("packages/:packageId/:version/manifest")
  manifest(@Param("packageId") packageId: string, @Param("version") version: string) {
    return this.payloads.getManifest(packageId, version);
  }
}
