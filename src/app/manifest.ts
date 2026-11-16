import type { MetadataRoute } from "next";
import { CUSTOMER_BRAND } from "@/lib/brand";

/**
 * PWA manifest. Installing to the home screen is how this ships on day one —
 * App Store and Play wrappers are phase 10, not a prerequisite.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: CUSTOMER_BRAND,
    short_name: CUSTOMER_BRAND,
    description: `Book and manage cleans, follow visits, and coordinate your team with ${CUSTOMER_BRAND}.`,
    start_url: "/",
    display: "standalone",
    background_color: "#fbfcfd",
    theme_color: "#055c80",
    orientation: "portrait",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
