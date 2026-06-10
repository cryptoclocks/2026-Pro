import type { Metadata } from "next";
import Image from "next/image";
import "./globals.css";

export const metadata: Metadata = {
  title: "CryptoClock Pro Hub",
  description: "Fleet management & UI builder for CryptoClock Pro displays",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <header className="sticky top-0 z-20 backdrop-blur border-b border-[var(--ccp-border)] bg-[var(--ccp-bg)]/80">
          <div className="mx-auto max-w-6xl px-6 py-3 flex items-center gap-6">
            <a href="/" className="flex items-center gap-2.5">
              <Image src="/logo.png" alt="CryptoClock" width={30} height={30} priority />
              <span className="font-bold tracking-tight">
                CryptoClock <span className="text-[var(--ccp-accent)]">Pro</span>
              </span>
            </a>
            <nav className="flex gap-5 text-sm text-[var(--ccp-muted)] ml-2">
              <a href="/" className="hover:text-[var(--ccp-fg)]">Fleet</a>
              <a href="/builder" className="hover:text-[var(--ccp-fg)]">Builder</a>
              <a href="/store" className="hover:text-[var(--ccp-fg)]">Store</a>
            </nav>
            <span className="ml-auto pill">Admin</span>
          </div>
        </header>
        <div className="mx-auto max-w-6xl">{children}</div>
      </body>
    </html>
  );
}
