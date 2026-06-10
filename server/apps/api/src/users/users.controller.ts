import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../auth/auth.guards";
import { UsersService } from "./users.service";

@Controller("admin/users")
@UseGuards(AdminGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.users.detail(id);
  }

  @Post(":id/grant")
  grant(@Param("id") id: string, @Body() body: { slug: string }) {
    return this.users.grant(id, body.slug);
  }

  @Post(":id/revoke")
  revoke(@Param("id") id: string, @Body() body: { slug: string }) {
    return this.users.revoke(id, body.slug);
  }
}
