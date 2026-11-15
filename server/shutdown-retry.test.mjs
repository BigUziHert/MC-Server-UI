import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel } from "./index.mjs";

test("a transient server shutdown persistence failure can be retried", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-shutdown-retry-"));
  const panel = await createPanel({
    dataDir: root,
    useEnvironment: false,
    scheduler: false,
    publicAddress: { resolve: async () => null },
  });
  let failuresRemaining = 2;
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (source, destination) => {
    if (
      failuresRemaining > 0 &&
      destination === path.join(root, "panel.json")
    ) {
      failuresRemaining--;
      throw new Error("Temporary state disk failure");
    }
    return rename(source, destination);
  });
  t.after(async () => {
    t.mock.restoreAll();
    await panel.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-shutdown-retry-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    panel.audit("server", "Fixture", "pending state"),
    /Temporary state disk failure/,
  );
  await assert.rejects(panel.close(), /Temporary state disk failure/);
  await panel.close();
  assert.ok(
    JSON.parse(await fs.readFile(path.join(root, "panel.json"), "utf8")),
  );
});
