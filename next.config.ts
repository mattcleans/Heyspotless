import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phase 1 ships as a PWA served from app.heyspotless.com. The service worker and
  // manifest live in src/app/, so nothing here needs to change to make it installable.
  reactStrictMode: true,

  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into the repo root on every
  // run. Two reasons to decline: they arrive as untracked files in everyone's working
  // tree, and CLAUDE.md is a file this project would want to write for itself — having
  // the dev server regenerate it is a good way to lose what you wrote.
  agentRules: false,
};

export default nextConfig;
