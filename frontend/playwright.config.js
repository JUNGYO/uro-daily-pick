import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../tests/e2e",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:3101/uro-daily-pick/",
    headless: true,
    launchOptions: { args: ["--disable-gpu"] },
    reducedMotion: "reduce",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `"${process.execPath}" ../tests/browser_harness.mjs`,
    url: "http://127.0.0.1:3101",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
