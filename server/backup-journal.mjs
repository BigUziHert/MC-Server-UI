import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const active = new Set();
export function claimBackupJournal(location) {
  active.add(location);
  return () => active.delete(location);
}

export const fileIdentity = ({ dev, ino, birthtimeMs }) => ({
  dev,
  ino,
  birthtimeMs,
});
export const sameIdentity = (stat, expected) =>
  !!stat &&
  !!expected &&
  !stat.isSymbolicLink() &&
  stat.dev === expected.dev &&
  stat.ino === expected.ino &&
  stat.birthtimeMs === expected.birthtimeMs;
export const optionalStat = (target) =>
  fs.lstat(target).catch((cause) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });

// Flush files before publishing journals. Directory fsync is unavailable on
// Windows, but is required to make renamed directory entries durable on Unix.
export async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function persistJournal(target, record) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function assertInactiveOwner(record, location) {
  if (!Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0)
    throw Object.assign(
      new Error(
        `Recovery ownership is invalid at ${location}. Files were preserved.`,
      ),
      { status: 409 },
    );
  if (record.ownerPid === process.pid && !active.has(location)) return;
  try {
    process.kill(record.ownerPid, 0);
  } catch (cause) {
    if (cause.code === "ESRCH") return;
  }
  throw Object.assign(
    new Error(
      `Another process may still own the interrupted backup operation at ${location}. Close that process before retrying. Files were preserved.`,
    ),
    { status: 409 },
  );
}
