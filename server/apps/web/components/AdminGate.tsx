"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";

/** Wrap admin-only page content. Shows a sign-in / forbidden notice otherwise. */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) {
    return <div className="p-8 text-sm text-[var(--ccp-muted)]">Loading…</div>;
  }
  if (!me) {
    return (
      <div className="p-8">
        <div className="card p-6 max-w-md">
          <p className="mb-4">You need to sign in to view this page.</p>
          <Link href="/login" className="btn btn-primary">
            Sign in
          </Link>
        </div>
      </div>
    );
  }
  if (!me.isAdmin) {
    return (
      <div className="p-8 text-sm text-[var(--ccp-red)]">
        Admin access required ({me.email} is not an admin).
      </div>
    );
  }
  return <>{children}</>;
}
