import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@ccp/shared"],
  // Repo root (three up from server/apps/web). On Vercel the Root Directory is
  // server/apps/web but file-trace output paths are resolved against the repo
  // root, so the trace base must match it — otherwise the "server/" segment is
  // dropped and packaging fails (Cannot find next-server/server.runtime.prod.js).
  outputFileTracingRoot: fileURLToPath(new URL("../../..", import.meta.url)),
};

export default nextConfig;
