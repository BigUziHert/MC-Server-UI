import { realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFleet } from "../server/index.mjs";

// Demonstration data belongs to this test launcher, never normal app startup.
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

const panel = await createFleet({
  createDefaultServer: true,
  useEnvironment: false,
  dataDir,
  serverDir: path.join(dataDir, "server"),
  name: "E2E Overworld",
  mode: "demo",
  memoryLimit: 4096,
  address: "localhost:25565",
});
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
