import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Every run gets its own server files, database files, schedules, and archives.
// Keeping this in the environment also shares the path with worker processes.
const dataDir = (process.env.PANEL_E2E_DATA_DIR ||= mkdtempSync(
  path.join(tmpdir(), "mc-panel-e2e-"),
));
if (
  path.dirname(path.resolve(dataDir)).toLowerCase() !==
    path.resolve(tmpdir()).toLowerCase() ||
  !path.basename(dataDir).startsWith("mc-panel-e2e-")
) {
  throw new Error(
    "E2E data must be in an isolated mc-panel-e2e-* folder directly inside the OS temporary directory.",
  );
}
const port = 3111;

export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "panel.spec.ts",
    "updates.spec.ts",
    "file-selection.spec.ts",
    "subusers.spec.ts",
    "server-customization.spec.ts",
    "console-controls.spec.ts",
    "players-history.spec.ts",
    "recycle-bin.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  globalTeardown: "./tests/cleanup.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PLAYWRIGHT_CHANNEL,
      },
    },
  ],
  webServer: {
    command: `"${process.execPath}" server/index.mjs`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(port),
      PANEL_DATA_DIR: dataDir,
      MC_SERVER_DIR: path.join(dataDir, "server"),
      MC_SERVER_JAR: "",
      MC_SERVER_NAME: "E2E Overworld",
      MC_SERVER_ADDRESS: "localhost:25565",
      MC_MEMORY_MB: "4096",
    },
  },
});
