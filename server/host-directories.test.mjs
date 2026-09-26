import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHostDirectoryBrowser } from "./host-directories.mjs";

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-folder-browse-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-folder-browse-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("host folder browser lists available roots and only sorted subfolders without creating files", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "World 12"));
  await fs.mkdir(path.join(root, "World 2"));
  await fs.writeFile(
    path.join(root, "private-file.txt"),
    "contents never listed",
  );
  const before = await fs.readdir(root);
  const browse = createHostDirectoryBrowser({
    roots: [root, path.join(root, "missing")],
  });
  assert.deepEqual((await browse()).folders, [{ name: root, path: root }]);
  const listing = await browse(root);
  assert.equal(listing.directory, root);
  assert.equal(listing.parent, path.dirname(root));
  assert.equal(listing.separator, path.sep);
  assert.deepEqual(
    listing.folders.map((folder) => folder.name),
    ["World 2", "World 12"],
  );
  assert.ok(
    listing.folders.every((folder) => path.dirname(folder.path) === root),
  );
  assert.equal(listing.truncated, false);
  assert.deepEqual(await fs.readdir(root), before);
});

test("host folder listing rejects relative paths, files, missing paths, and link traversal", async (t) => {
  const root = await fixture(t);
  const browse = createHostDirectoryBrowser();
  await fs.writeFile(path.join(root, "file"), "preserve");
  for (const input of [
    "relative",
    [root],
    root + "\0",
    path.join(root, "file"),
  ])
    await assert.rejects(browse(input), { status: 400 });
  await assert.rejects(browse(path.join(root, "missing")), { status: 404 });
  const target = path.join(root, "actual");
  const linked = path.join(root, "linked");
  await fs.mkdir(target);
  await fs.mkdir(path.join(target, "child"));
  try {
    await fs.symlink(target, linked, "junction");
  } catch (cause) {
    if (["EPERM", "EACCES"].includes(cause.code))
      return t.skip("Symlink creation unavailable");
    throw cause;
  }
  assert.deepEqual(
    (await browse(root)).folders.map((folder) => folder.name),
    ["actual"],
  );
  await assert.rejects(browse(linked), { status: 400 });
  await assert.rejects(browse(path.join(linked, "child")), { status: 400 });
});

test("host folder listing bounds both returned folders and scanned entries", async (t) => {
  const root = await fixture(t);
  for (let index = 0; index < 7; index++)
    await fs.mkdir(path.join(root, `folder-${index}`));
  const limited = await createHostDirectoryBrowser({ maxFolders: 2 })(root);
  assert.equal(limited.folders.length, 2);
  assert.equal(limited.truncated, true);
  const scan = await createHostDirectoryBrowser({ maxEntries: 3 })(root);
  assert.equal(scan.folders.length, 3);
  assert.equal(scan.truncated, true);
});

test("hung drive probes are shared across retries and directory lookups retain bounded slots until OS calls finish", async (t) => {
  const root = await fixture(t);
  let finishRoot;
  let probes = 0;
  const rootProbe = new Promise((resolve) => {
    finishRoot = resolve;
  });
  const roots = createHostDirectoryBrowser({
    roots: [root],
    rootTimeoutMs: 5,
    fileSystem: {
      ...fs,
      stat: () => {
        probes++;
        return rootProbe;
      },
    },
  });
  assert.deepEqual((await roots()).folders, []);
  assert.deepEqual((await roots()).folders, []);
  assert.equal(probes, 1);
  finishRoot({ isDirectory: () => true });
  await rootProbe;
  const pending = [];
  let reads = 0;
  const browse = createHostDirectoryBrowser({
    timeoutMs: 5,
    maxActive: 2,
    fileSystem: {
      ...fs,
      lstat: () => {
        reads++;
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  });
  await assert.rejects(browse(root), { status: 504 });
  await assert.rejects(browse(root), { status: 504 });
  await assert.rejects(browse(root), { status: 503 });
  assert.equal(reads, 2);
  for (const finish of pending) finish({ isDirectory: () => true });
  await new Promise((resolve) => setImmediate(resolve));
});

test("a directory handle arriving after client cancellation is closed", async (t) => {
  const root = await fixture(t);
  let opened, finishOpen;
  const started = new Promise((resolve) => {
    opened = resolve;
  });
  const opening = new Promise((resolve) => {
    finishOpen = resolve;
  });
  let closes = 0;
  const browse = createHostDirectoryBrowser({
    fileSystem: {
      ...fs,
      opendir: () => {
        opened();
        return opening;
      },
    },
  });
  const controller = new AbortController();
  const request = browse(root, controller.signal);
  const failed = assert.rejects(request, /cancelled fixture/);
  await started;
  controller.abort(new Error("cancelled fixture"));
  await failed;
  finishOpen({
    close: async () => {
      closes++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
});
