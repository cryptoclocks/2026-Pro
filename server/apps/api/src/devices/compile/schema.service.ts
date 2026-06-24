/* ------------------------------------------------------------- *
 * Schema registry service for the page config system.            *
 *                                                                 *
 * Holds the published PageSettingSchema rows (immutable). Each     *
 * row is a (pageSlug, schemaVersion) pair with a jsonSchema that  *
 * the validator compiles on demand.                              *
 *                                                                 *
 * Use this service from admin tooling to publish a new version;   *
 * never mutate an existing version once published. (schema.md     *
 * §3.4 + §11.2)                                                  *
 * ------------------------------------------------------------- */

import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

export interface PublishSchemaInput {
  pageSlug: string;
  schemaVersion: number;
  packageId?: string | null;
  jsonSchema: unknown;
  uiSchema?: unknown;
  defaultConfig?: unknown;
  assetSlots?: unknown;
}

@Injectable()
export class SchemaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Publish a new immutable version. Throws if the (slug, version)
   *  pair already exists — published schemas are append-only. */
  async publish(input: PublishSchemaInput) {
    return this.prisma.pageSettingSchema.create({
      data: {
        pageSlug: input.pageSlug,
        schemaVersion: input.schemaVersion,
        packageId: input.packageId ?? null,
        jsonSchema: (input.jsonSchema ?? {}) as object,
        uiSchema: (input.uiSchema ?? {}) as object,
        defaultConfig: (input.defaultConfig ?? {}) as object,
        assetSlots: (input.assetSlots ?? []) as object,
      },
    });
  }

  /** Latest published version for a page (used by validators/UI). */
  async latest(pageSlug: string) {
    return this.prisma.pageSettingSchema.findFirst({
      where: { pageSlug },
      orderBy: { schemaVersion: "desc" },
    });
  }

  async get(pageSlug: string, schemaVersion: number) {
    const row = await this.prisma.pageSettingSchema.findUnique({
      where: { pageSlug_schemaVersion: { pageSlug, schemaVersion } },
    });
    if (!row) throw new NotFoundException(`schema ${pageSlug}@${schemaVersion} not found`);
    return row;
  }

  async list() {
    return this.prisma.pageSettingSchema.findMany({
      orderBy: [{ pageSlug: "asc" }, { schemaVersion: "desc" }],
    });
  }
}
