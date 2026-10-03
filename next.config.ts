import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `npm run e2e` builds into its own directory so it never overwrites the dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // ...and type-checks through its own tsconfig, so the build's generated includes never rewrite tsconfig.json.
  typescript: { tsconfigPath: process.env.NEXT_DIST_DIR ? "tsconfig.e2e.json" : "tsconfig.json" },
};

export default nextConfig;
