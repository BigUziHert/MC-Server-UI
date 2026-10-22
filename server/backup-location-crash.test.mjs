import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBackupLocation } from "./backup-location.mjs";

const fixtureScript = fileURLToPath(
  new URL("./fixtures/backup-location-crash.mjs", import.meta.url),
);

async function fixture(t) {
  const temporaryParent = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(temporaryParent, "mc-backup-location-crash-")),
  );
  const owned = (...parts) => {
    const target = path.resolve(root, ...parts);
    const relative = path.relative(root, target);
    assert.ok(
      relative &&
        !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`),
    );
    return target;
  };
  const dataDir = owned("panel");
  const defaultDirectory = owned("panel", "backups");
  const destination = owned("other-drive", "archives");
  const children = new Set();
  t.after(async () => {
    for (const running of children) {
      if (running.child.exitCode === null && running.child.signalCode === null)
        running.child.kill("SIGKILL");
      await running.exit;
    }
    // Refuse recursive cleanup unless this is still the exact temporary tree
    // created by the test, rather than a replaced directory or user path.
    assert.equal(path.dirname(root), temporaryParent);
    assert.ok(path.basename(root).startsWith("mc-backup-location-crash-"));
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
  });
  await fs.mkdir(dataDir);
  const manager = () =>
    createBackupLocation({
      dataDir,
      defaultDirectory,
      forbiddenDirectories: async () => [dataDir],
    });
  await manager();
  const archives = [
    {
      name: `${randomUUID()}.tar.gz`,
      bytes: Buffer.from("Saved world before changing backup drives\n"),
    },
    { name: `${randomUUID()}.tar.gz`, bytes: Buffer.alloc(256 * 1024, 0xa7) },
  ];
  for (const archive of archives)
    await fs.writeFile(
      path.join(defaultDirectory, archive.name),
      archive.bytes,
    );

  const readRecord = async () =>
    JSON.parse(
      await fs.readFile(owned("panel", "backup-location.json"), "utf8"),
    );
  const verifyArchives = async (directory) => {
    assert.deepEqual(
      (await fs.readdir(directory)).sort(),
      archives.map((item) => item.name).sort(),
    );
    for (const archive of archives)
      assert.deepEqual(
        await fs.readFile(path.join(directory, archive.name)),
        archive.bytes,
      );
  };
  const crashAfterCommit = async () => {
    const child = fork(fixtureScript, [dataDir, destination], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    const exit = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const running = { child, exit };
    children.add(running);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `Crash fixture did not reach the committed checkpoint. ${stderr}`,
            ),
          ),
        10_000,
      );
      const onError = (cause) => finish(cause);
      const onExit = (code, signal) =>
        finish(
          new Error(
            `Crash fixture exited early (${code}, ${signal}). ${stderr}`,
          ),
        );
      const onMessage = (message) => {
        if (message?.checkpoint === "afterCommit") finish();
      };
      function finish(cause) {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        if (cause) reject(cause);
        else resolve();
      }
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
    });
    const record = await readRecord();
    assert.equal(record.directory, destination);
    assert.equal(record.pending.committed, true);
    assert.equal(record.pending.ownerPid, child.pid);
    await verifyArchives(defaultDirectory);
    await verifyArchives(destination);
    // A second process cannot recover or clean up files while the child owns
    // its journal, even though the new directory is already committed.
    await assert.rejects(manager(), /Another process may still own/);
    assert.equal(child.kill("SIGKILL"), true);
    const result = await exit;
    assert.notEqual(result.code, 0, stderr);
    children.delete(running);
  };
  return {
    dataDir,
    defaultDirectory,
    destination,
    owned,
    manager,
    readRecord,
    verifyArchives,
    crashAfterCommit,
  };
}

test("a killed process after location commit recovers verified destination and removes original archives", async (t) => {
  const {
    defaultDirectory,
    destination,
    manager,
    readRecord,
    verifyArchives,
    crashAfterCommit,
  } = await fixture(t);
  await crashAfterCommit();

  const recovered = await manager();
  const status = await recovered.status();
  assert.equal(status.directory, destination);
  assert.equal(status.available, true);
  assert.equal(status.job.status, "completed");
  await verifyArchives(destination);
  assert.deepEqual(await fs.readdir(defaultDirectory), []);
  assert.equal((await readRecord()).pending, undefined);

  // A later ordinary restart observes the committed setting without needing
  // recovery again or falling back to the original empty directory.
  assert.equal((await (await manager()).status()).directory, destination);
  await verifyArchives(destination);
});

test("a killed committed move keeps its destination when the source drive is missing and finishes cleanup after reconnect", async (t) => {
  const {
    defaultDirectory,
    destination,
    owned,
    manager,
    readRecord,
    verifyArchives,
    crashAfterCommit,
  } = await fixture(t);
  await crashAfterCommit();
  const disconnectedSource = owned("disconnected-source-backups");
  // Both paths are validated descendants of this test's isolated temporary
  // tree. Renaming simulates disconnecting the old backup drive after commit.
  await fs.rename(defaultDirectory, disconnectedSource);

  const offlineRecovery = await manager();
  const status = await offlineRecovery.status();
  assert.equal(status.directory, destination);
  assert.equal(status.available, true);
  assert.match(status.job.error, /recovery copies|retained/i);
  assert.equal((await readRecord()).pending.committed, true);
  await verifyArchives(destination);
  await verifyArchives(disconnectedSource);
  await assert.rejects(fs.stat(defaultDirectory), { code: "ENOENT" });
  await assert.rejects(
    offlineRecovery.preview(owned("next-destination")),
    /recovery copies/i,
  );

  await fs.rename(disconnectedSource, defaultDirectory);
  const reconnected = await manager();
  const recovered = await reconnected.status();
  assert.equal(recovered.directory, destination);
  assert.equal(recovered.available, true);
  assert.equal(recovered.job.status, "completed");
  assert.equal(recovered.job.error, undefined);
  assert.equal((await readRecord()).pending, undefined);
  await verifyArchives(destination);
  assert.deepEqual(await fs.readdir(defaultDirectory), []);
});
