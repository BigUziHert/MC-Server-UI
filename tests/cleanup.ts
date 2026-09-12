import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export default async function cleanup() {
  const directory = process.env.PANEL_E2E_DATA_DIR;
  if (!directory) return;
  const target = path.resolve(directory);
  const parent = path.resolve(tmpdir());
  // Refuse recursive cleanup outside a direct, explicitly prefixed temp folder.
  if (
    path.dirname(target).toLowerCase() !== parent.toLowerCase() ||
    !path.basename(target).startsWith("mc-panel-e2e-")
  ) {
    throw new Error(
      `Refusing to remove unexpected test data directory: ${target}`,
    );
  }
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 300,
  });
}
