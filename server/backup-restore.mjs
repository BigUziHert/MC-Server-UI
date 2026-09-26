import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { t as list, x as extract } from "tar";

const failure = (status, message, cause) =>
  Object.assign(new Error(message, { cause }), { status });
const canonical = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;
const sharingRetryDelays = [50, 100, 200, 400, 800, 1000, 1000, 1000];

async function renameDirectory(source, destination) {
  const original = await fs.lstat(source);
  for (let attempt = 0; ; attempt++) {
    const current = await fs.lstat(source);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      canonical(await fs.realpath(source)) !== canonical(source)
    )
      throw failure(
        409,
        "The server folder changed during restore. No replacement was attempted.",
      );
    try {
      await fs.lstat(destination);
      throw failure(
        409,
        "Another application created the destination folder during restore. It was not overwritten.",
      );
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    try {
      await fs.rename(source, destination);
      return;
    } catch (cause) {
      // Windows refuses to rename a tree while any child file is open without
      // delete sharing. Scanners can briefly hold newly extracted JARs even
      // after tar has closed all of its own handles. Never force-delete a path.
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(cause.code) ||
        attempt >= sharingRetryDelays.length
      )
        throw cause;
      await delay(sharingRetryDelays[attempt]);
    }
  }
}

// Reject ambiguous Windows names on every platform so an archive cannot change
// its meaning when a panel or backup is moved to another computer.
function archiveManifest() {
  const entries = new Map();
  const ancestors = new Set();
  let bytes = 0;
  let invalid;
  return {
    filter(raw, entry) {
      if (invalid) return false;
      const name = raw.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
      const directory = entry.type === "Directory";
      const parts = name.split("/");
      if (
        !["Directory", "File", "OldFile"].includes(entry.type) ||
        raw.includes("\\") ||
        raw.startsWith("/") ||
        (name !== "." &&
          name !== "" &&
          parts.some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              /[\x00-\x1f<>:"|?*]/.test(part) ||
              /[. ]$/.test(part) ||
              /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
          )) ||
        ((!name || name === ".") && !directory) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      ) {
        invalid = failure(
          400,
          `This backup contains an unsafe archive entry: ${raw}.`,
        );
        return false;
      }
      if (!name || name === ".") return true;
      const key = name.toLowerCase();
      const parents = parts.slice(0, -1).map((_, index) =>
        parts
          .slice(0, index + 1)
          .join("/")
          .toLowerCase(),
      );
      if (
        entries.has(key) ||
        parents.some((parent) => entries.get(parent) === "file") ||
        (!directory && ancestors.has(key))
      ) {
        invalid = failure(
          400,
          `This backup contains conflicting archive paths: ${raw}.`,
        );
        return false;
      }
      entries.set(key, directory ? "directory" : "file");
      parents.forEach((parent) => ancestors.add(parent));
      if (!directory) bytes += entry.size;
      if (!Number.isSafeInteger(bytes) || entries.size > 1_000_000)
        invalid = failure(
          400,
          "This backup contains too many files or an invalid total size.",
        );
      return !invalid;
    },
    get bytes() {
      return bytes;
    },
    check() {
      if (invalid) throw invalid;
    },
  };
}

export async function restoreBackupArchive(serverDir, archive) {
  const root = path.resolve(serverDir);
  const parent = path.dirname(root);
  const rootStat = await fs.lstat(root);
  if (
    parent === root ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    canonical(await fs.realpath(root)) !== canonical(root)
  )
    throw failure(
      409,
      "The server folder must be a regular folder before restoring a backup.",
    );
  const archiveStat = await fs.lstat(archive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink())
    throw failure(400, "The backup archive is not a regular file.");

  // A sibling workspace stays on the server's drive, even for imported servers.
  // Keep the original tree until both the extraction and replacement succeed.
  const workspace = await fs.mkdtemp(
    path.join(parent, `.${path.basename(root)}-restore-`),
  );
  const staged = path.join(workspace, "restored");
  const previous = path.join(workspace, "previous");
  const snapshot = path.join(workspace, "backup.tar.gz");
  let preserveWorkspace = false;
  let restored = false;
  let restoreError;
  try {
    const available = await fs.statfs(parent);
    if (available.bavail * available.bsize < archiveStat.size)
      throw failure(
        409,
        "There is not enough free space on the server's drive to safely restore this backup. Free space and try again.",
      );
    await fs.copyFile(archive, snapshot);
    const manifest = archiveManifest();
    try {
      await list({ file: snapshot, strict: true, filter: manifest.filter });
      manifest.check();
    } catch (cause) {
      throw failure(400, `Cannot restore this backup: ${cause.message}`, cause);
    }
    const storage = await fs.statfs(parent);
    if (storage.bavail * storage.bsize < manifest.bytes)
      throw failure(
        409,
        "There is not enough free space on the server's drive to safely restore this backup. Free space and try again.",
      );
    await fs.mkdir(staged, { mode: rootStat.mode & 0o777 });
    const extraction = archiveManifest();
    let extractionError;
    await extract({
      file: snapshot,
      cwd: staged,
      preservePaths: false,
      preserveOwner: false,
      filter: extraction.filter,
      // Wait for the unpacker's close event, including pending writes, before
      // cleaning up a failed extraction. Strict warnings reject too early.
      onwarn: (_code, message) => {
        extractionError ??= failure(409, message);
      },
    });
    if (extractionError) throw extractionError;
    extraction.check();
    const current = await fs.lstat(root);
    if (
      current.isSymbolicLink() ||
      current.dev !== rootStat.dev ||
      current.ino !== rootStat.ino ||
      canonical(await fs.realpath(root)) !== canonical(root)
    )
      throw failure(
        409,
        "The server folder changed during restore. Try again.",
      );
    try {
      await renameDirectory(root, previous);
    } catch (cause) {
      throw failure(
        409,
        `Restore could not move the current server folder. Your current server files were not changed. Close applications using this folder and try again. ${cause.message}`,
        cause,
      );
    }
    try {
      await renameDirectory(staged, root);
    } catch (cause) {
      try {
        await renameDirectory(previous, root);
      } catch (rollback) {
        preserveWorkspace = true;
        throw failure(
          409,
          `Restore could not finish or move the original files back. Your original server files are preserved at ${previous}. Restore that folder before starting the server. ${rollback.message}`,
          cause,
        );
      }
      throw failure(
        409,
        `Restore could not replace the server folder. Your original files were restored. Close applications using the server files and try again. ${cause.message}`,
        cause,
      );
    }
    restored = true;
  } catch (cause) {
    restoreError =
      cause.code === "ENOSPC"
        ? failure(
            409,
            "There is not enough free space on the server's drive to safely restore this backup. Your current server files were not replaced. Free space and try again.",
            cause,
          )
        : cause;
    throw restoreError;
  } finally {
    if (!preserveWorkspace) {
      // Only this unique, verified sibling workspace is ever removed recursively.
      if (path.dirname(workspace) !== parent || workspace === root)
        throw new Error("Invalid backup restore workspace.");
      try {
        await fs.rm(workspace, {
          recursive: true,
          force: true,
          maxRetries: 6,
          retryDelay: 100,
        });
      } catch (cause) {
        if (restored)
          return {
            warning: `The backup was restored, but temporary restore files could not be removed from ${workspace}. ${cause.message}`,
          };
        if (!restoreError) throw cause;
        restoreError.message += ` Temporary restore files remain at ${workspace} because Windows or another application still has them open.`;
      }
    }
  }
  return { warning: null };
}
