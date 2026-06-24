/* REST API for the PageSettingSchema registry.
 * Public reads (so the web-user settings form can render with the right
 * labels/groups), admin-only writes. */

import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { SchemaService, type PublishSchemaInput } from "./schema.service";
import { AdminGuard } from "../../auth/auth.guards";

@Controller("schemas")
export class SchemasController {
  constructor(private readonly svc: SchemaService) {}

  /** List all published schema versions (latest per page first). */
  @Get()
  list() { return this.svc.list(); }

  /** Latest published version for a page. Used by the web-user to build
   *  the settings form (and by the API validator when accepting writes). */
  @Get(":pageSlug/latest")
  latest(@Param("pageSlug") pageSlug: string) { return this.svc.latest(pageSlug); }

  /** One exact version. Used by the audit log + restore. */
  @Get(":pageSlug/:version")
  get(@Param("pageSlug") pageSlug: string, @Param("version", ParseIntPipe) v: number) {
    return this.svc.get(pageSlug, v);
  }

  /** Publish a new immutable version. Admin-only — published schemas
   *  drive how user data is validated and rendered; getting one wrong
   *  can lock every device out. */
  @Post()
  @UseGuards(AdminGuard)
  publish(@Body() body: PublishSchemaInput) { return this.svc.publish(body); }
}
