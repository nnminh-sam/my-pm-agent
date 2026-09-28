import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve the `@/*` alias from tsconfig.json, so tests can import route handlers and src/proxy.ts.
  resolve: { tsconfigPaths: true },
});
