import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  installationFileTransaction,
  inspectInstallationDirectory,
  prepareInstallationDirectory,
} from "./installation-directory.mjs";

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(
    path.join(temporary, "mc-install-folder-test-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-install-folder-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("installation inspection is read-only and creation preserves an empty chosen folder", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, "new-parent", "Minecraft");
  assert.deepEqual(await inspectInstallationDirectory(directory), {
    directory,
    exists: false,
  });
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(await prepareInstallationDirectory(directory), {
    directory,
    exists: true,
  });
  assert.deepEqual(await fs.readdir(directory), []);
  await fs.writeFile(path.join(directory, "world.dat"), "must survive");
  await assert.rejects(
    prepareInstallationDirectory(directory),
    /empty installation folder/,
  );
  assert.equal(
    await fs.readFile(path.join(directory, "world.dat"), "utf8"),
    "must survive",
  );
});

test("installation folders cannot overlap protected storage, use files, drive roots, or relative paths", async (t) => {
  const root = await fixture(t);
  const storage = path.join(root, "panel");
  await fs.mkdir(storage);
  for (const directory of [root, storage, path.join(storage, "server")])
    await assert.rejects(
      inspectInstallationDirectory(directory, {
        forbiddenDirectories: [storage],
      }),
      /overlaps/,
    );
  for (const directory of ["relative/server", "", path.parse(root).root])
    await assert.rejects(inspectInstallationDirectory(directory));
  const file = path.join(root, "file");
  await fs.writeFile(file, "preserved");
  await assert.rejects(prepareInstallationDirectory(file));
  await assert.rejects(prepareInstallationDirectory(path.join(file, "child")));
  assert.equal(await fs.readFile(file, "utf8"), "preserved");
});

test("installation folders reject junctions both directly and in their ancestors", async (t) => {
  const root = await fixture(t);
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  await fs.mkdir(real);
  try {
    await fs.symlink(real, link, "junction");
  } catch (cause) {
    if (["EPERM", "EACCES"].includes(cause.code))
      return t.skip("Symlink creation is unavailable");
    throw cause;
  }
  for (const directory of [link, path.join(link, "child")])
    await assert.rejects(
      prepareInstallationDirectory(directory),
      /actual|symbolic/,
    );
  assert.deepEqual(await fs.readdir(real), []);
});

test("initial setup rollback removes only unchanged files owned by that request", async (t) => {
  const root = await fixture(t);
  const transaction = await installationFileTransaction(root);
  await transaction.write("eula.txt", "eula=true\n");
  await transaction.write("server.properties", "server-port=25565\n");
  await fs.writeFile(path.join(root, "eula.txt"), "user's new content");
  await fs.writeFile(path.join(root, "unrelated.txt"), "preserved");
  await transaction.rollback();
  assert.deepEqual((await fs.readdir(root)).sort(), [
    "eula.txt",
    "unrelated.txt",
  ]);
  assert.equal(
    await fs.readFile(path.join(root, "eula.txt"), "utf8"),
    "user's new content",
  );
});
