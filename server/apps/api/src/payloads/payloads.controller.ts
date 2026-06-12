import { Body, Controller, Get, Header, Param, Post, StreamableFile, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { CurrentUser, UserGuard } from "../auth/auth.guards";
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

  /** Compile page-specific Rust source to wasm32-unknown-unknown. */
  @Post("payloads/compile-wasm")
  compileWasm(@Body() body: { source: string; moduleId?: string }) {
    return this.payloads.compileRustWasm({
      source: body.source,
      moduleId: body.moduleId || "logic",
    });
  }

  /** Admin/user Builder library: pages that can be opened again for editing. */
  @Get("payloads/builder-pages")
  @UseGuards(UserGuard)
  builderPages(@CurrentUser() user: User) {
    return this.payloads.listBuilderPages(user);
  }

  /** Open the latest published/saved layout back into Builder. */
  @Get("payloads/builder-pages/:packageId/latest")
  @UseGuards(UserGuard)
  latestBuilderPage(@Param("packageId") packageId: string, @CurrentUser() user: User) {
    return this.payloads.getLatestBuilderPage(packageId, user);
  }

  /**
   * Builder path: validate layout, zip layout.json + compiled wasm files, store
   * bundle locally, and register an immediately assignable PayloadVersion.
   */
  @Post("payloads/publish-compiled")
  @UseGuards(UserGuard)
  publishCompiled(
    @CurrentUser() user: User,
    @Body()
    body: {
      ownerId: string;
      title?: string;
      version?: string;
      layout: unknown;
      wasmFiles?: { path: string; wasmBase64: string }[];
      assetFiles?: { path: string; base64: string }[];
    },
  ) {
    const layout = this.payloads.validateLayout(body.layout);
    return this.payloads.publishCompiled({
      ownerId: user.id,
      title: body.title,
      version: body.version,
      layout,
      wasmFiles: body.wasmFiles ?? [],
      assetFiles: body.assetFiles ?? [],
    });
  }

  /**
   * Publish a new version. Scaffold accepts the bundle metadata directly;
   * M5 swaps this for multipart upload -> MinIO -> server-side manifest.
   */
  @Post("payloads/publish")
  @UseGuards(UserGuard)
  publish(
    @CurrentUser() user: User,
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
      ownerId: user.id,
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

  /** Device-facing: actual zero-flash bundle download used by cmd:sync. */
  @Get("packages/:packageId/:version/bundle.zip")
  @Header("Content-Type", "application/zip")
  @Header("Content-Disposition", 'attachment; filename="bundle.zip"')
  async bundle(@Param("packageId") packageId: string, @Param("version") version: string) {
    return new StreamableFile(await this.payloads.getBundle(packageId, version));
  }
}
