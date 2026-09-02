import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phase 1 ships as a PWA served from app.heyspotless.com. The service worker and
  // manifest live in src/app/, so nothing here needs to change to make it installable.
  reactStrictMode: true,
};

export default nextConfig;
