import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve the `@/*` alias from tsconfig.json, so tests can import route handlers and src/proxy.ts.
  resolve: { tsconfigPaths: true },
  // pglite startup and scrypt logins are slow under CPU load.
  test: { testTimeout: 20_000, hookTimeout: 30_000 },
});
