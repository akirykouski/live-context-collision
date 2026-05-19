import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config. The prod server is started out-of-band (npm start on :3000);
 * Playwright reuses it rather than managing its lifecycle.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: false,
  retries: 0,
  workers: 4,
  reporter: [["list"], ["json", { outputFile: "e2e-results.json" }]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
