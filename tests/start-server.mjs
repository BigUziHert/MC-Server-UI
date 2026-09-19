import { realpath, lstat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFleet } from "../server/index.mjs";
import { processStartup } from "./fixtures/process-options.mjs";

// Fixture files and a real subprocess belong only to this isolated test launcher.
const configured = process.env.PANEL_E2E_DATA_DIR;
if (!configured)
  throw new Error("PANEL_E2E_DATA_DIR is required by the E2E launcher.");
const dataDir = await realpath(configured);
const temporary = await realpath(tmpdir());
if (
  (await lstat(configured)).isSymbolicLink() ||
  path.dirname(dataDir).toLowerCase() !== temporary.toLowerCase() ||
  !path.basename(dataDir).startsWith("mc-panel-e2e-")
)
  throw new Error(
    "The E2E launcher requires an isolated mc-panel-e2e-* directory directly inside OS temporary storage.",
  );

const serverDir = path.join(dataDir, "server");
await mkdir(serverDir, { recursive: true });
await writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
const panel = await createFleet({
  createDefaultServer: true,
  useEnvironment: false,
  dataDir,
  serverDir,
  name: "E2E Overworld",
  ...processStartup,
  memoryLimit: 4096,
  address: "localhost:25565",
  publicAddress: { resolve: async () => "8.8.8.8" },
});
// Start against a temporary listener, then expose the Playwright readiness URL.
const bootstrap = await new Promise((resolve) => {
  const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
});
const bootstrapUrl = `http://127.0.0.1:${bootstrap.address().port}`;
try {
  const fleet = await (await fetch(`${bootstrapUrl}/api/servers`)).json();
  const configured = await fetch(
    `${bootstrapUrl}/api/servers/${fleet.defaultServerId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(processStartup),
    },
  );
  if (!configured.ok) throw new Error(await configured.text());
  const response = await fetch(`${bootstrapUrl}/api/server/power`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start" }),
  });
  if (!response.ok) throw new Error(await response.text());
  const deadline = Date.now() + 10_000;
  while (
    (await (await fetch(`${bootstrapUrl}/api/server`)).json()).status !==
    "running"
  ) {
    if (Date.now() > deadline) throw new Error("E2E subprocess did not start.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
} finally {
  bootstrap.closeAllConnections();
  await new Promise((resolve) => bootstrap.close(resolve));
}
const listener = panel.app.listen(3111, "127.0.0.1", () => {
  console.log("Isolated Minecraft panel E2E runtime: http://127.0.0.1:3111");
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  listener.close();
  await panel.close();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
