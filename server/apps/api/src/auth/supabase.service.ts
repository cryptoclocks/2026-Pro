import { createHmac, timingSafeEqual } from "node:crypto";
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
  private readonly devAuth =
    process.env.CCP_DEV_AUTH === "1" ||
    process.env.CCP_DEV_AUTH?.toLowerCase() === "true";
  private readonly jwtSecret = process.env.JWT_SECRET ?? "";
  private readonly admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  constructor(private readonly prisma: PrismaService) {}

  isAdminEmail(email: string): boolean {
    return this.admins.includes(email.toLowerCase());
  }

  async userFromToken(token: string): Promise<User | null> {
    const dev = this.userFromDevToken(token);
    if (dev) {
      this.log.debug(`dev auth accepted email=${dev.email} role=${dev.role}`);
      return this.mirrorUser(dev);
    }

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
    return this.mirrorUser({
      email: su.email,
      name: su.user_metadata?.name ?? null,
      role,
    });
  }

  private mirrorUser(input: {
    email: string;
    name: string | null;
    role: "USER" | "ADMIN" | "SUPER_ADMIN";
  }) {
    return this.prisma.user.upsert({
      where: { email: input.email },
      update: { role: input.role, name: input.name },
      create: {
        email: input.email,
        passwordHash: "",
        role: input.role,
        name: input.name,
      },
    });
  }

  private userFromDevToken(token: string): {
    email: string;
    name: string | null;
    role: "USER" | "ADMIN" | "SUPER_ADMIN";
  } | null {
    if (!this.devAuth || !token.startsWith("ccpdev.")) return null;
    if (!this.jwtSecret) {
      this.log.warn("CCP_DEV_AUTH enabled but JWT_SECRET is not set");
      return null;
    }

    const [prefix, payloadB64, sigB64] = token.split(".");
    if (prefix !== "ccpdev" || !payloadB64 || !sigB64) return null;

    const signed = `${prefix}.${payloadB64}`;
    const expected = createHmac("sha256", this.jwtSecret)
      .update(signed)
      .digest("base64url");
    if (!safeEqual(sigB64, expected)) return null;

    let payload: {
      email?: unknown;
      name?: unknown;
      role?: unknown;
      exp?: unknown;
    };
    try {
      payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      );
    } catch {
      return null;
    }

    if (typeof payload.email !== "string") return null;
    if (
      typeof payload.exp === "number" &&
      Math.floor(Date.now() / 1000) > payload.exp
    ) {
      this.log.debug(`dev auth expired email=${payload.email}`);
      return null;
    }

    const role =
      payload.role === "SUPER_ADMIN" || payload.role === "ADMIN"
        ? payload.role
        : this.isAdminEmail(payload.email)
          ? "ADMIN"
          : "USER";
    return {
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : null,
      role,
    };
  }
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
