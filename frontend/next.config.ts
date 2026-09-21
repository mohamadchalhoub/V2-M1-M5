import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained dist/standalone/ with only the traced
  // dependencies a production Docker image needs — no full node_modules
  // copy required (Phase 11 — DEPLOYMENT.md).
  output: "standalone",
};

export default nextConfig;
