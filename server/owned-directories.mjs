import fs from "node:fs/promises";
import path from "node:path";

export async function createOwnedDirectories(directory) {
  const missing = [];
  let current = path.resolve(directory);
  for (;;) {
    try {
      await fs.lstat(current);
      break;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error("The selected drive is unavailable.");
    current = parent;
  }
  const created = [];
  try {
    for (const target of missing) {
      try {
        await fs.mkdir(target);
        created.push({ path: target, stat: await fs.lstat(target) });
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
      }
    }
    return created;
  } catch (cause) {
    await removeOwnedEmptyDirectories(created);
    throw cause;
  }
}

export async function removeOwnedEmptyDirectories(created, keep = []) {
  for (const entry of [...created].reverse()) {
    if (keep.includes(entry.path)) continue;
    try {
      const current = await fs.lstat(entry.path);
      if (
        !current.isSymbolicLink() &&
        current.isDirectory() &&
        current.dev === entry.stat.dev &&
        current.ino === entry.stat.ino &&
        current.birthtimeMs === entry.stat.birthtimeMs
      )
        await fs.rmdir(entry.path);
    } catch (cause) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(cause.code)) throw cause;
    }
  }
}
