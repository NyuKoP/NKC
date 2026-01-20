import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "tests/ui",
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    baseURL: "http://localhost:5173",
    animations: "disabled",
    timezoneId: "UTC",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "cross-env NKC_E2E=1 VITE_E2E=1 E2E=1 npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
