import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  createParamDecorator,
} from "@nestjs/common";
import type { User } from "@prisma/client";
import { SupabaseService } from "./supabase.service";

function bearer(req: { headers: Record<string, string | undefined> }): string | null {
  const h = req.headers["authorization"] ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Requires any logged-in Supabase user; attaches req.user. */
@Injectable()
export class UserGuard implements CanActivate {
  constructor(protected readonly sb: SupabaseService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = bearer(req);
    if (!token) throw new UnauthorizedException("missing bearer token");
    const user = await this.sb.userFromToken(token);
    if (!user) throw new UnauthorizedException("invalid session");
    req.user = user;
    return true;
  }
}

/** Requires an admin user (email in ADMIN_EMAILS). */
@Injectable()
export class AdminGuard extends UserGuard {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await super.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as User;
    if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") {
      throw new ForbiddenException("admin only");
    }
    return true;
  }
}

/** @CurrentUser() — injects the authenticated user into a handler. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User => {
    return ctx.switchToHttp().getRequest().user;
  },
);
