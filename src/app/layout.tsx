import type { Metadata, Viewport } from "next";
import { CUSTOMER_BRAND } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spotless Ops",
  description:
    `${CUSTOMER_BRAND} operations — booking, scheduling, dispatch, billing and communications.`,
  applicationName: "Spotless Ops",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Spotless Ops" },
};

export const viewport: Viewport = {
  themeColor: "#173c58",
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
    <html lang="en">
      <body className="min-h-screen">
        {children}
      </body>
    </html>
  );
}
