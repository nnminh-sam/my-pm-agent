import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// One throwaway file workspace per run. Workers re-evaluate this file, but inherit E2E_DATA_DIR from the main process.
process.env.E2E_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "my-pm-e2e-"));
const PORT = 3100;

const env = {
  PM_STORAGE: "fs",
  PM_DATA_DIR: process.env.E2E_DATA_DIR,
  JWT_SECRET: "e2e-jwt-secret-0123456789abcdef0123456789abcdef",
  PM_TIMEZONE: "UTC",
  NEXT_DIST_DIR: ".next-e2e",
  // Never reach the real GitHub API from a test run.
  // A token is configured but the API is a dead port: every pull fails, so sync badges offer Retry now.
  GITHUB_TOKEN: "e2e-fake-token",
  GITHUB_API_URL: "http://127.0.0.1:9",
};

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  // Actions are held for 1.5–3 s on purpose; leave room on a loaded machine.
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node --import tsx tests/e2e/seed.ts && npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    env,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
