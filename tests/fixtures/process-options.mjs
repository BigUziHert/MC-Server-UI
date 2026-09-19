import { fileURLToPath } from "node:url";

// Test-only executable launched by the same process path used for real servers.
export const processStartup = {
  mode: "live",
  launchType: "executable",
  launchExecutable: process.execPath,
  launchArgs: [
    fileURLToPath(new URL("./minecraft-process.mjs", import.meta.url)),
  ],
};
