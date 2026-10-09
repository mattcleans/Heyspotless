import type { Metadata, Viewport } from "next";
import { CUSTOMER_BRAND } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: CUSTOMER_BRAND,
  description:
    `Book and manage cleans, follow visits, and coordinate your team with ${CUSTOMER_BRAND}.`,
  applicationName: CUSTOMER_BRAND,
  appleWebApp: { capable: true, statusBarStyle: "default", title: CUSTOMER_BRAND },
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
