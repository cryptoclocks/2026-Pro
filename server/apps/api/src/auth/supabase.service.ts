import { Injectable, Logger } from "@nestjs/common";
import type { User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Verifies a Supabase user access token by calling Supabase's /auth/v1/user
 * (no JWT secret needed — the anon key + the user's bearer is enough), then
 * mirrors the user into our DB. Email in ADMIN_EMAILS => ADMIN role.
 */
@Injectable()
export class SupabaseService {
  private readonly log = new Logger(SupabaseService.name);
  private readonly url = process.env.SUPABASE_URL ?? "";
  private readonly anon = process.env.SUPABASE_ANON_KEY ?? "";
  private readonly admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  constructor(private readonly prisma: PrismaService) {}

  isAdminEmail(email: string): boolean {
    return this.admins.includes(email.toLowerCase());
  }

  async userFromToken(token: string): Promise<User | null> {
    if (!this.url || !this.anon) {
      this.log.warn("SUPABASE_URL / SUPABASE_ANON_KEY not set");
      return null;
    }
    let su: { email?: string; user_metadata?: { name?: string } };
    try {
      const res = await fetch(`${this.url}/auth/v1/user`, {
        headers: { apikey: this.anon, Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      su = await res.json();
    } catch (e) {
      this.log.warn(`supabase verify failed: ${e}`);
      return null;
    }
    if (!su.email) return null;
    const role = this.isAdminEmail(su.email) ? "ADMIN" : "USER";
    return this.prisma.user.upsert({
      where: { email: su.email },
      update: { role },
      create: {
        email: su.email,
        passwordHash: "",
        role,
        name: su.user_metadata?.name ?? null,
      },
    });
  }
}
