import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve the `@/*` alias from tsconfig.json, so tests can import route handlers and src/proxy.ts.
  resolve: { tsconfigPaths: true },
  // pglite startup and scrypt logins are slow under CPU load.
  // Playwright's e2e specs (tests/e2e, `npm run e2e`) aren't vitest tests.
  test: { testTimeout: 20_000, hookTimeout: 30_000, exclude: [...configDefaults.exclude, "tests/e2e/**"] },
});
