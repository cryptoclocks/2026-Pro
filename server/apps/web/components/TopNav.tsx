"use client";

import Image from "next/image";
import Link from "next/link";
import { useAuth } from "@/lib/auth";

export function TopNav() {
  const { me, signOut } = useAuth();
  const links: [string, string][] = [
    ["/", "Fleet"],
    ["/builder", "Builder"],
    ["/store", "Store"],
  ];
  if (me?.isAdmin) {
    links.push(["/users", "Users"], ["/approvals", "Approvals"]);
  }
  return (
    <header className="sticky top-0 z-20 backdrop-blur border-b border-[var(--ccp-border)] bg-[var(--ccp-bg)]/80">
      <div className="mx-auto max-w-6xl px-6 py-3 flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Image src="/logo.png" alt="CryptoClock" width={30} height={30} priority />
          <span className="font-bold tracking-tight">
            CryptoClock <span className="text-[var(--ccp-accent)]">Pro</span>
          </span>
        </Link>
        <nav className="flex gap-5 text-sm text-[var(--ccp-muted)] ml-2">
          {links.map(([href, label]) => (
            <Link key={href} href={href} className="hover:text-[var(--ccp-fg)]">
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {me ? (
            <>
              {me.isAdmin && <span className="pill">Admin</span>}
              <span className="text-[var(--ccp-muted)] hidden sm:inline">{me.email}</span>
              <button className="btn" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <Link href="/login" className="btn btn-primary">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
