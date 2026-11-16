import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createLaunchpad } from "./launchpad.mjs";
import { createLaunchpadRecovery } from "./launchpad-transaction.mjs";
import { containedSourcePath } from "./import.mjs";
const safePath = (root, name = "") =>
  name ? containedSourcePath(root, name) : fs.realpath(root);
const hash = (value) => createHash("sha512").update(value).digest("hex");
async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "launchpad-crash-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverDir = path.join(root, "server"),
    dataDir = path.join(root, "panel");
  await fs.mkdir(path.join(serverDir, "plugins"), { recursive: true });
  await fs.mkdir(dataDir);
  await fs.writeFile(
    path.join(serverDir, "plugins/audit.jar"),
    "old plugin contents",
  );
  await fs.writeFile(
    path.join(serverDir, "plugins/second.jar"),
    "old second plugin",
  );
  const boot = () =>
    createLaunchpad({
      serverDir,
      dataDir,
      safePath,
      getServer: async () => ({
        status: "offline",
        gameVersion: "1.21.1",
        loader: "paper",
      }),
      withMinecraftMutation: async (work) => work(),
      fetch: async () => Response.json([]),
    });
  return { root, serverDir, dataDir, boot };
}
for (const cut of [
  "before-recycle",
  "after-recycle",
  "after-output",
  "after-receipts",
  "partial-output",
  "committed",
])
  test(`restart reconciles content installation after ${cut}`, async (t) => {
    const f = await fixture(t);
    const worker = fileURLToPath(
      new URL("./fixtures/launchpad-crash.mjs", import.meta.url),
    );
    const child = spawnSync(process.execPath, [worker, f.root, cut], {
      encoding: "utf8",
      timeout: 12000,
      windowsHide: true,
    });
    assert.equal(child.status, 86, child.stdout + child.stderr);
    let service = await f.boot();
    const config = await service.config();
    if (cut === "partial-output") {
      assert.equal(service.isRecoveryRequired(), true);
      assert.equal(config.job.recoveryRequired, true);
      assert.equal(
        await fs.readFile(path.join(f.serverDir, "plugins/audit.jar"), "utf8"),
        "new ",
      );
      await assert.rejects(
        service.dismissJob(config.job.id),
        /Resolve installation recovery/,
      );
      // User repairs the conflicting destination; recovery verifies all bytes.
      await fs.writeFile(
        path.join(f.serverDir, "plugins/audit.jar"),
        "old plugin contents",
      );
      assert.equal((await service.resolveRecovery()).ok, true);
    } else {
      assert.equal(service.isRecoveryRequired(), false);
      assert.equal(
        config.job.status,
        cut === "committed" ? "completed" : "failed",
      );
    }
    assert.equal(
      await fs.readFile(path.join(f.serverDir, "plugins/audit.jar"), "utf8"),
      cut === "committed" ? "new plugin contents" : "old plugin contents",
    );
    assert.equal(
      await fs.readFile(path.join(f.serverDir, "plugins/second.jar"), "utf8"),
      cut === "committed" ? "new plugin contents" : "old second plugin",
    );
    await service.close();
    service = await f.boot();
    assert.equal(
      service.isRecoveryRequired(),
      false,
      "repeated recovery is idempotent",
    );
    await service.close();
  });

test("whole-root recovery restores settings, receipts and empty directories while preserving unknown files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dataDir, "launchpad"));
  await fs.mkdir(path.join(f.serverDir, "empty-world"));
  let configuration = { jar: "old.jar" };
  const options = {
    privatePath: (name) => safePath(path.join(f.dataDir, "launchpad"), name),
    serverDir: f.serverDir,
    safePath,
    getConfiguration: () => configuration,
    applyConfiguration: async (value) => {
      configuration = value;
    },
  };
  const journal = await createLaunchpadRecovery(options);
  await journal.begin({
    job: { id: "fixture" },
    planId: "fixture",
    wholeRoot: true,
    files: [{ path: "runtime.jar", sha512: hash("new runtime") }],
    receipts: [{ pack: true }],
    configuration,
  });
  await assert.rejects(
    createLaunchpadRecovery(options),
    /Another panel process/,
  );
  await fs.rm(path.join(f.serverDir, "plugins"), { recursive: true });
  await fs.rmdir(path.join(f.serverDir, "empty-world"));
  await fs.writeFile(path.join(f.serverDir, "runtime.jar"), "new runtime");
  await fs.writeFile(path.join(f.serverDir, "external.txt"), "keep this");
  configuration = { jar: "new.jar" };
  await assert.rejects(journal.reconcile(), /externally added file/);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "external.txt"), "utf8"),
    "keep this",
  );
  await fs.unlink(path.join(f.serverDir, "external.txt"));
  const result = await journal.reconcile();
  assert.deepEqual(result.record.receipts, [{ pack: true }]);
  assert.deepEqual(configuration, { jar: "old.jar" });
  assert.ok(
    (await fs.stat(path.join(f.serverDir, "empty-world"))).isDirectory(),
  );
  await journal.clear();
});
