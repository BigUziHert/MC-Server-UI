import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel } from "./index.mjs";

test("a transient server shutdown persistence failure can be retried", async (t) => {
  // safePath canonicalizes the destination before rename. Windows runners can
  // expose TEMP through short names or different casing, so match that path.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-shutdown-retry-")),
  );
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
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-shutdown-retry-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    panel.audit("server", "Fixture", "pending state"),
    /Temporary state disk failure/,
  );
  assert.equal(failuresRemaining, 1, "the initial audit write was rejected");
  await assert.rejects(panel.close(), /Temporary state disk failure/);
  assert.equal(failuresRemaining, 0, "shutdown retried the failed state write");
  await panel.close();
  const saved = JSON.parse(
    await fs.readFile(path.join(root, "panel.json"), "utf8"),
  );
  assert.ok(saved.audit.some((entry) => entry.detail === "pending state"));
});
