import type { MetadataRoute } from "next";

/**
 * PWA manifest. Installing to the home screen is how this ships on day one —
 * App Store and Play wrappers are phase 10, not a prerequisite.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Spotless Ops",
    short_name: "Spotless",
    description: "Hey Spotless operations — schedule, dispatch, bill, communicate.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f9fb",
    theme_color: "#173c58",
    orientation: "portrait",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
