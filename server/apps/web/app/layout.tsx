import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { TopNav } from "@/components/TopNav";

export const metadata: Metadata = {
  title: "CryptoClock Pro Hub",
  description: "Fleet management & UI builder for CryptoClock Pro displays",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthProvider>
          <TopNav />
          <div className="mx-auto max-w-6xl">{children}</div>
        </AuthProvider>
      </body>
    </html>
  );
}
