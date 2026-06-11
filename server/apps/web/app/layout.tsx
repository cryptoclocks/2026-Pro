import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { TopNav } from "@/components/TopNav";

/* LVGL's built-in fonts are Montserrat Medium — load the same face so the
   Builder artboard matches the device pixel-for-pixel. */
const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["500"],
  variable: "--font-montserrat",
});

export const metadata: Metadata = {
  title: "CryptoClock Pro Hub",
  description: "Fleet management & UI builder for CryptoClock Pro displays",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={montserrat.variable}>
      <body className="antialiased">
        <AuthProvider>
          <TopNav />
          <div className="mx-auto max-w-6xl">{children}</div>
        </AuthProvider>
      </body>
    </html>
  );
}
