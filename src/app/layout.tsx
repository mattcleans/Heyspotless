import type { Metadata, Viewport } from "next";
import { Baloo_2, Poppins } from "next/font/google";
import { CUSTOMER_BRAND } from "@/lib/brand";
import "./globals.css";

/*
 * Brand fonts per the Hey Spotless design system: Baloo 2 for the chunky
 * rounded display voice (wordmark, headlines), Poppins for UI and body.
 * next/font self-hosts them at build time — no runtime Google request,
 * no layout shift, and the CSS variables feed --font-sans/--font-display
 * in globals.css with system fallbacks if a weight ever fails to load.
 */
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});
const baloo = Baloo_2({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-baloo",
  display: "swap",
});

export const metadata: Metadata = {
  title: CUSTOMER_BRAND,
  description:
    `Book and manage cleans, follow visits, and coordinate your team with ${CUSTOMER_BRAND}.`,
  applicationName: CUSTOMER_BRAND,
  appleWebApp: { capable: true, statusBarStyle: "default", title: CUSTOMER_BRAND },
};

export const viewport: Viewport = {
  themeColor: "#055c80",
  width: "device-width",
  initialScale: 1,
  // Cleaners use this one-handed on a phone in someone's driveway.
  viewportFit: "cover",
};

/**
 * The document, and nothing else.
 *
 * Chrome is per area: staff pages ask for `OpsChrome`, the client app has its
 * own shell, and the public pages — /book, /apply, /rate — deliberately wear
 * none. See components/ops-chrome.tsx for what that fixed.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${poppins.variable} ${baloo.variable}`}>
      <body className="min-h-screen">
        {children}
      </body>
    </html>
  );
}
