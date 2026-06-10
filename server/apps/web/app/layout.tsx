import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CryptoClock Pro Hub",
  description: "Fleet management & UI builder for CryptoClock Pro displays",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-[var(--ccp-border)] px-6 py-3 flex items-center gap-6">
          <span className="font-bold text-[var(--ccp-accent)]">CryptoClock Pro Hub</span>
          <nav className="flex gap-4 text-sm text-[var(--ccp-muted)]">
            <a href="/" className="hover:text-[var(--ccp-fg)]">Fleet</a>
            <a href="/builder" className="hover:text-[var(--ccp-fg)]">Builder</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
