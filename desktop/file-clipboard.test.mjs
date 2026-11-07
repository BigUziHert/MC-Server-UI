import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLIPBOARD_CHUNK_BYTES,
  clipboardFilePaths,
  createFileClipboard,
  installFileClipboardIpc,
} from "./file-clipboard.mjs";

function clipboardFor(paths) {
  return {
    read: async () => [
      {
        types: ["text/uri-list"],
        getType: async () =>
          new Blob([
            paths.map((file) => pathToFileURL(file).href).join("\r\n"),
          ]),
      },
    ],
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-clipboard-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("native clipboard parsing accepts multiple copied files and ignores ordinary text", async () => {
  const paths = [path.resolve("first.txt"), path.resolve("second file.txt")];
  assert.deepEqual(
    await clipboardFilePaths(clipboardFor([...paths, paths[0]])),
    paths,
  );
  assert.deepEqual(
    await clipboardFilePaths({
      read: async () => [{ types: ["text/plain"], getType: assert.fail }],
    }),
    [],
  );
});

test("clipboard capabilities include nested/empty folders and bound chunk reads", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "folder", "empty"), { recursive: true });
  await fs.writeFile(path.join(root, "folder", "config.txt"), "configured");
  await fs.writeFile(
    path.join(root, "large.bin"),
    Buffer.alloc(CLIPBOARD_CHUNK_BYTES + 3, 71),
  );
  const service = createFileClipboard({
    clipboard: clipboardFor([
      path.join(root, "folder"),
      path.join(root, "large.bin"),
    ]),
    markInternalCopy: async () => {},
  });
  const selection = await service.readFiles();
  assert.deepEqual(selection.directories.sort(), ["folder", "folder/empty"]);
  assert.equal(
    JSON.stringify(selection).includes(root.replaceAll("\\", "\\\\")),
    false,
  );
  const small = selection.files.find(
    (file) => file.path === "folder/config.txt",
  );
  assert.equal(
    Buffer.from(await service.readFile(selection.id, small.id)).toString(),
    "configured",
  );
  const large = selection.files.find((file) => file.name === "large.bin");
  assert.equal(
    (await service.readFile(selection.id, large.id)).byteLength,
    CLIPBOARD_CHUNK_BYTES,
  );
  assert.deepEqual(
    await service.readFile(selection.id, large.id, CLIPBOARD_CHUNK_BYTES),
    new Uint8Array([71, 71, 71]),
  );
  await assert.rejects(
    service.readFile(selection.id, path.join(root, "large.bin")),
    /valid clipboard file/,
  );
  await assert.rejects(
    service.readFile(selection.id, large.id, -1),
    /valid clipboard file/,
  );
  service.releaseFiles(selection.id);
  await assert.rejects(service.readFile(selection.id, small.id), /expired/);
});

test("clipboard reads reject files that changed and expired snapshots", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "notes.txt");
  await fs.writeFile(file, "initial");
  let now = 0;
  const service = createFileClipboard({
    clipboard: clipboardFor([file]),
    now: () => now,
    markInternalCopy: async () => {},
  });
  const first = await service.readFiles();
  await fs.writeFile(file, "changed contents");
  await assert.rejects(
    service.readFile(first.id, first.files[0].id),
    /changed/,
  );
  const second = await service.readFiles();
  await assert.rejects(
    service.readFile(first.id, first.files[0].id),
    /expired/,
  );
  assert.equal(
    Buffer.from(
      await service.readFile(second.id, second.files[0].id),
    ).toString(),
    "changed contents",
  );
  now = 11 * 60 * 1000;
  await assert.rejects(
    service.readFile(second.id, second.files[0].id),
    /expired/,
  );
});

test("new internal copies invalidate native selections and clear stale OS file references", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "notes.txt");
  await fs.writeFile(file, "initial");
  const clipboard = clipboardFor([file]);
  const service = createFileClipboard({
    clipboard,
    markInternalCopy: async () => {
      clipboard.read = async () => [];
    },
  });
  const selection = await service.readFiles();
  await service.markInternalCopy();
  assert.equal(await service.readFiles(), null);
  await assert.rejects(
    service.readFile(selection.id, selection.files[0].id),
    /expired/,
  );
});

test("an immediate paste waits for the preceding internal copy to replace OS files", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "previous.txt");
  await fs.writeFile(file, "previous clipboard");
  const clipboard = clipboardFor([file]);
  let finishCopy;
  const service = createFileClipboard({
    clipboard,
    markInternalCopy: () =>
      new Promise((resolve) => {
        finishCopy = () => {
          clipboard.read = async () => [];
          resolve();
        };
      }),
  });
  const copying = service.markInternalCopy();
  const pasting = service.readFiles();
  await Promise.resolve();
  finishCopy();
  await copying;
  assert.equal(await pasting, null);
});

test("clipboard folder enumeration rejects links and colliding destination names", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "source"));
  await fs.mkdir(path.join(root, "other"));
  await fs.writeFile(path.join(root, "source", "file.txt"), "one");
  await fs.writeFile(path.join(root, "other", "file.txt"), "two");
  const service = createFileClipboard({
    clipboard: clipboardFor([
      path.join(root, "source", "file.txt"),
      path.join(root, "other", "file.txt"),
    ]),
    markInternalCopy: async () => {},
  });
  await assert.rejects(service.readFiles(), /same destination name/);
  await fs.symlink(
    path.join(root, "other"),
    path.join(root, "source", "link"),
    "junction",
  );
  const folders = createFileClipboard({
    clipboard: clipboardFor([path.join(root, "source")]),
    markInternalCopy: async () => {},
  });
  await assert.rejects(folders.readFiles(), /is a link/);
});

test("clipboard IPC rejects remote documents, subframes and unknown capability holders", async () => {
  const handlers = new Map();
  const ipc = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const trusted = {};
  let reads = 0;
  let disposed = false;
  const remove = installFileClipboardIpc(
    ipc,
    { isManagedSender: (event) => event === trusted },
    {
      readFiles: () => ++reads,
      dispose: () => {
        disposed = true;
      },
    },
  );
  const handler = handlers.get("mc-panel-clipboard:readFiles");
  assert.throws(() => handler({}), /Only this computer/);
  assert.equal(handler(trusted), 1);
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, true);
});
