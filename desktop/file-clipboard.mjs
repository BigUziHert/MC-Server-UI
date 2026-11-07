import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const CLIPBOARD_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SELECTION_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const SNAPSHOT_LIFETIME_MS = 10 * 60 * 1000;

export async function clipboardFilePaths(clipboard) {
  const paths = new Set();
  for (const item of await clipboard.read()) {
    if (!item.types.includes("text/uri-list")) continue;
    const payload = await item.getType("text/uri-list");
    if (payload.size > 1024 * 1024)
      throw new Error("The clipboard file selection is too large.");
    for (const line of (await payload.text()).split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const url = new URL(line);
      if (url.protocol !== "file:") continue;
      const file = fileURLToPath(url);
      if (!path.isAbsolute(file)) continue;
      paths.add(file);
    }
  }
  return [...paths];
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    right.isFile()
  );
}

// Capabilities contain only clipboard-selected files. Neither an absolute path
// nor an arbitrary filesystem request ever crosses from renderer to main.
export function createFileClipboard({
  clipboard,
  markInternalCopy,
  now = Date.now,
}) {
  let snapshot;
  let generation = 0;
  let pendingCopy = Promise.resolve();
  const active = (id) => {
    if (snapshot && now() > snapshot.expires) snapshot = undefined;
    if (!snapshot || snapshot.id !== id) {
      throw new Error(
        "The clipboard selection expired. Copy the files and paste again.",
      );
    }
    snapshot.expires = now() + SNAPSHOT_LIFETIME_MS;
    return snapshot;
  };
  return {
    async readFiles() {
      const current = ++generation;
      snapshot = undefined;
      await pendingCopy;
      const roots = await clipboardFilePaths(clipboard);
      if (!roots.length) return null;
      const record = {
        id: randomUUID(),
        files: new Map(),
        directories: [],
        expires: now() + SNAPSHOT_LIFETIME_MS,
      };
      const names = new Set();
      const pending = roots.map((absolute) => ({
        absolute,
        relative: path.basename(absolute),
      }));
      let bytes = 0;
      let entries = 0;
      while (pending.length) {
        const { absolute, relative } = pending.pop();
        if (!relative || names.has(relative.toLowerCase()))
          throw new Error(
            "The clipboard contains files with the same destination name. Paste them separately.",
          );
        names.add(relative.toLowerCase());
        if (++entries > MAX_ENTRIES)
          throw new Error(
            "The clipboard contains too many items. Use Upload folder for this selection.",
          );
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink())
          throw new Error(
            `${relative} is a link. Copy its original file or folder instead.`,
          );
        if (stat.isDirectory()) {
          record.directories.push(relative);
          for (const name of await fs.readdir(absolute))
            pending.push({
              absolute: path.join(absolute, name),
              relative: `${relative}/${name}`,
            });
        } else if (stat.isFile()) {
          if (stat.size > MAX_FILE_BYTES)
            throw new Error(
              `${relative} exceeds the 256 MiB limit for one file.`,
            );
          bytes += stat.size;
          if (bytes > MAX_SELECTION_BYTES)
            throw new Error(
              "This clipboard selection exceeds 512 MiB. Use Upload files or Upload folder for larger selections.",
            );
          const id = randomUUID();
          record.files.set(id, {
            id,
            absolute,
            real: await fs.realpath(absolute),
            stat,
            path: relative,
            name: path.basename(absolute),
            size: stat.size,
            lastModified: stat.mtimeMs,
          });
        } else throw new Error(`${relative} is not a regular file or folder.`);
      }
      if (current !== generation)
        throw new Error("The clipboard selection changed. Paste again.");
      snapshot = record;
      return {
        id: record.id,
        files: [...record.files.values()].map(
          ({ id, path, name, size, lastModified }) => ({
            id,
            path,
            name,
            size,
            lastModified,
          }),
        ),
        directories: record.directories,
      };
    },
    async readFile(id, fileId, offset = 0) {
      const file = active(id).files.get(fileId);
      if (
        !file ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > file.size
      )
        throw new Error("Provide a valid clipboard file and read position.");
      if ((await fs.realpath(file.absolute)) !== file.real)
        throw new Error(
          `${file.path} changed after it was copied. Copy it again.`,
        );
      const handle = await fs.open(file.absolute, "r");
      try {
        if (!sameFile(file.stat, await handle.stat()))
          throw new Error(
            `${file.path} changed after it was copied. Copy it again.`,
          );
        const buffer = Buffer.alloc(
          Math.min(CLIPBOARD_CHUNK_BYTES, file.size - offset),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (
          bytesRead !== buffer.length ||
          !sameFile(file.stat, await handle.stat())
        )
          throw new Error(
            `${file.path} changed while it was being read. Copy it again.`,
          );
        return new Uint8Array(buffer);
      } finally {
        await handle.close();
      }
    },
    releaseFiles(id) {
      if (snapshot?.id === id) snapshot = undefined;
    },
    async markInternalCopy() {
      generation++;
      snapshot = undefined;
      const writing = Promise.resolve().then(markInternalCopy);
      pendingCopy = writing.catch(() => {});
      await writing;
    },
    dispose() {
      generation++;
      snapshot = undefined;
    },
  };
}

export function installFileClipboardIpc(ipcMain, controller, service) {
  const actions = ["readFiles", "readFile", "releaseFiles", "markInternalCopy"];
  for (const action of actions)
    ipcMain.handle(`mc-panel-clipboard:${action}`, (event, ...args) => {
      if (!controller.isManagedSender(event))
        throw new Error(
          "Only this computer's panel workspace can paste local files.",
        );
      return service[action](...args);
    });
  return () => {
    for (const action of actions)
      ipcMain.removeHandler(`mc-panel-clipboard:${action}`);
    service.dispose();
  };
}
