import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const error = (status, message) =>
  Object.assign(new Error(message), { status });
const ids = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const phases = new Set([
  "prepared",
  "copying",
  "copied",
  "ready",
  "restoring",
  "restored",
]);
const validBackup = (backup) =>
  backup &&
  typeof backup === "object" &&
  ids.test(backup.id) &&
  typeof backup.name === "string" &&
  backup.name.length > 0 &&
  backup.name.length <= 255 &&
  Number.isFinite(backup.size) &&
  backup.size >= 0 &&
  Number.isFinite(Date.parse(backup.createdAt)) &&
  backup.status === "completed" &&
  (backup.trigger === undefined ||
    ["manual", "scheduled"].includes(backup.trigger));

/** Private per-server recovery storage. The public file tree never contains it.
 * Each entry journals its intent before touching source data. A same-volume
 * rename is atomic; cross-volume deletion only follows a complete verified copy.
 * Interrupted copies are retained, and restore always retains the archive until
 * its newly-created destination is verified and a completed record is durable.
 */
export async function createRecycleBin({
  dataDir,
  serverDir,
  backupDir,
  safePath,
  fileSystem = fs,
  now = () => new Date(),
  newId = randomUUID,
} = {}) {
  const io = fileSystem;
  const directory = await safePath(dataDir, "recycle-bin");
  const originalRoot = await io.realpath(serverDir);
  const originalRootStat = await io.lstat(serverDir);
  const assertServerRoot = async () => {
    const current = await io.lstat(serverDir);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.ino !== originalRootStat.ino ||
      current.dev !== originalRootStat.dev ||
      current.birthtimeMs !== originalRootStat.birthtimeMs ||
      (await io.realpath(serverDir)) !== originalRoot
    )
      throw error(
        409,
        "The server folder changed. Recycle Bin files have been retained; restart the panel after restoring the original folder.",
      );
  };
  await assertServerRoot();
  const serverPath = async (relative) => {
    await assertServerRoot();
    const target = await safePath(serverDir, relative);
    await assertServerRoot();
    return target;
  };
  const backupRoot = backupDir ? await io.realpath(backupDir) : null;
  const backupRootStat = backupDir ? await io.lstat(backupDir) : null;
  const backupPath = async (relative) => {
    if (!backupDir || !/^backups\/[a-f0-9-]{36}\.tar\.gz$/i.test(relative))
      throw error(
        409,
        "The backup recovery path is invalid. Its archive has been retained.",
      );
    const assertRoot = async () => {
      const checked = await safePath(dataDir, "backups");
      const stat = await io.lstat(checked);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.ino !== backupRootStat.ino ||
        stat.dev !== backupRootStat.dev ||
        stat.birthtimeMs !== backupRootStat.birthtimeMs ||
        (await io.realpath(checked)) !== backupRoot
      )
        throw error(
          409,
          "The backup folder changed. Recovery archives have been retained; restore the original folder and restart the panel.",
        );
    };
    await assertRoot();
    const target = await safePath(backupDir, relative.slice("backups/".length));
    await assertRoot();
    return target;
  };
  const originalPathFor = (metadata) =>
    metadata.kind === "backup" ? backupPath : serverPath;
  const relative = path.relative(originalRoot, directory);
  if (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
    throw error(
      400,
      "Recycle Bin storage must be outside the Minecraft server folder.",
    );
  await io.mkdir(directory, { recursive: true });
  const storageRoot = await io.realpath(directory);
  const storage = async () => {
    const checked = await safePath(dataDir, "recycle-bin");
    if ((await io.realpath(checked)) !== storageRoot)
      throw error(
        409,
        "The Recycle Bin storage location changed. Its files have been retained.",
      );
    return checked;
  };
  let busy = false;
  const exclusive = async (work) => {
    if (busy)
      throw error(409, "Wait for the current Recycle Bin operation to finish.");
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  };
  const lstat = async (target) => {
    try {
      return await io.lstat(target);
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw cause;
    }
  };
  const entryDirectory = async (id) => {
    if (typeof id !== "string" || !ids.test(id))
      throw error(400, "Choose an item from this server's Recycle Bin.");
    return safePath(await storage(), id);
  };
  const persist = async (entryDir, metadata) => {
    const target = await safePath(entryDir, "entry.json");
    const temporary = await safePath(entryDir, `${newId()}.tmp`);
    const handle = await io.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(metadata));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await io.rename(temporary, target);
    } finally {
      await io.rm(temporary, { force: true });
    }
  };
  const read = async (id) => {
    const entryDir = await entryDirectory(id);
    let metadata;
    try {
      const metadataPath = await safePath(entryDir, "entry.json");
      if ((await io.stat(metadataPath)).size > 64 * 1024)
        throw error(
          409,
          "The recovery record is invalid. Stored files have been retained.",
        );
      metadata = JSON.parse(await io.readFile(metadataPath, "utf8"));
    } catch (cause) {
      if (cause.code === "ENOENT")
        throw error(404, "This Recycle Bin item was not found.");
      throw cause;
    }
    if (
      metadata.id !== id ||
      metadata.version !== 1 ||
      !phases.has(metadata.phase) ||
      !["file", "directory"].includes(metadata.type) ||
      typeof metadata.originalPath !== "string" ||
      !metadata.originalPath ||
      !Number.isFinite(metadata.size) ||
      metadata.size < 0 ||
      !Number.isFinite(Date.parse(metadata.deletedAt)) ||
      (metadata.kind !== undefined && metadata.kind !== "backup") ||
      (metadata.kind === "backup" &&
        (!validBackup(metadata.backup) ||
          metadata.type !== "file" ||
          metadata.originalPath !== `backups/${metadata.backup.id}.tar.gz`))
    )
      throw error(
        409,
        "This recovery record is incomplete. Its stored files have been retained.",
      );
    await originalPathFor(metadata)(metadata.originalPath);
    return { entryDir, metadata, payload: await safePath(entryDir, "content") };
  };
  const walk = async (root, base = "", rows = []) => {
    if ((await io.lstat(root)).isSymbolicLink())
      throw error(400, "Recycle Bin operations do not follow symbolic links.");
    const target = await safePath(root, base);
    const stat = await io.lstat(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw error(
        400,
        "Recycle Bin operations do not follow symbolic links or special files.",
      );
    const type = stat.isDirectory() ? "directory" : "file";
    rows.push({
      path: base,
      type,
      size: type === "file" ? stat.size : 0,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode & 0o777,
      ino: stat.ino,
      dev: stat.dev,
    });
    if (type === "directory") {
      const names = (await io.readdir(target)).sort();
      for (const name of names)
        await walk(root, [base, name].filter(Boolean).join("/"), rows);
    }
    return rows;
  };
  const hashFile = async (target, algorithm = "sha256", signal) => {
    signal?.throwIfAborted();
    const before = await io.lstat(target);
    if (!before.isFile() || before.isSymbolicLink())
      throw error(400, "Only regular files can be recovered.");
    const handle = await io.open(target, "r");
    try {
      const opened = await handle.stat();
      if (
        opened.ino !== before.ino ||
        opened.dev !== before.dev ||
        !opened.isFile()
      )
        throw error(
          409,
          "The file changed during recovery. Try again when it is no longer being edited.",
        );
      const hash = createHash(algorithm);
      const buffer = Buffer.allocUnsafe(128 * 1024);
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        signal?.throwIfAborted();
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  };
  const copyVerified = async (source, resolveDestination) => {
    const initial = await walk(source);
    const hashes = new Map();
    for (const row of initial) {
      const from = await safePath(source, row.path);
      // Resolve from the server/private boundary each time. An external process
      // must not redirect recovery by replacing a parent while journaling waits.
      const target = await resolveDestination(row.path);
      if (row.type === "directory") await io.mkdir(target);
      else {
        await io.copyFile(from, target, 1); // COPYFILE_EXCL: never replace existing files.
        const digest = await hashFile(from);
        if (digest !== (await hashFile(await resolveDestination(row.path))))
          throw error(
            409,
            "The source changed or its copy could not be verified. The original and recovery data have been retained.",
          );
        // Windows FlushFileBuffers requires a writable handle. Only the new
        // copy is made writable temporarily; its original mode is restored below.
        await io.chmod(await resolveDestination(row.path), row.mode | 0o200);
        const copied = await io.open(await resolveDestination(row.path), "r+");
        try {
          await copied.sync();
        } finally {
          await copied.close();
        }
        hashes.set(row.path, digest);
      }
    }
    const after = await walk(source);
    if (JSON.stringify(initial) !== JSON.stringify(after))
      throw error(
        409,
        "The source changed while it was being copied. The original and recovery data have been retained.",
      );
    // Apply directory metadata last, after their children have been created.
    for (const row of [...initial].reverse()) {
      const target = await resolveDestination(row.path);
      await io.chmod(target, row.mode);
      await io.utimes(target, new Date(row.mtimeMs), new Date(row.mtimeMs));
    }
    return { rows: initial, hashes };
  };
  const verifySource = async (source, snapshot) => {
    const rows = await walk(source);
    if (JSON.stringify(rows) !== JSON.stringify(snapshot.rows))
      throw error(
        409,
        "The source changed before removal. The original and recovery data have been retained.",
      );
    for (const row of rows) {
      if (
        row.type === "file" &&
        (await hashFile(await safePath(source, row.path))) !==
          snapshot.hashes.get(row.path)
      )
        throw error(
          409,
          "The source changed before removal. The original and recovery data have been retained.",
        );
    }
    if (JSON.stringify(await walk(source)) !== JSON.stringify(snapshot.rows))
      throw error(
        409,
        "The source changed before removal. The original and recovery data have been retained.",
      );
  };
  const removeVerifiedSource = async (
    originalPath,
    snapshot,
    resolvePath = serverPath,
  ) => {
    const changed = (relative) =>
      error(
        409,
        `The source changed during removal at “${relative}”. Remaining original files and the recovery copy have been retained.`,
      );
    const removalFailure = (cause, relative) => {
      if (["EPERM", "EACCES", "EBUSY"].includes(cause.code))
        return Object.assign(
          error(
            409,
            `Could not remove “${relative}”. It may be in use or its permissions may prevent deletion. Release this file and retry; remaining original files and the recovery copy have been retained.`,
          ),
          { code: cause.code },
        );
      if (cause.code === "ENOTEMPTY" || cause.code === "EEXIST")
        return Object.assign(
          error(
            409,
            `“${relative}” is no longer empty. Newly created files and the recovery copy have been retained.`,
          ),
          { code: cause.code },
        );
      return cause;
    };
    const sameIdentity = (stat, row) =>
      !stat.isSymbolicLink() &&
      stat.ino === row.ino &&
      stat.dev === row.dev &&
      (row.type === "file" ? stat.isFile() : stat.isDirectory());
    const sameFile = (stat, row) =>
      sameIdentity(stat, row) &&
      stat.size === row.size &&
      stat.mtimeMs === row.mtimeMs &&
      (stat.mode & 0o777) === row.mode;
    // walk() records parents before children. Reverse that order so rmdir only
    // sees directories after known descendants have been removed. Never recurse
    // here: a live server may have created new, unarchived files since verification.
    for (const row of [...snapshot.rows].reverse()) {
      const relative = [originalPath, row.path].filter(Boolean).join("/");
      const target = await resolvePath(relative);
      const stat = await io.lstat(target);
      if (!sameIdentity(stat, row)) throw changed(relative);
      if (row.type === "file") {
        if (
          !sameFile(stat, row) ||
          (await hashFile(target)) !== snapshot.hashes.get(row.path)
        )
          throw changed(relative);
        const checked = await resolvePath(relative);
        if (!sameFile(await io.lstat(checked), row)) throw changed(relative);
        try {
          await io.unlink(checked);
        } catch (cause) {
          throw removalFailure(cause, relative);
        }
      } else {
        const checked = await resolvePath(relative);
        if (!sameIdentity(await io.lstat(checked), row))
          throw changed(relative);
        try {
          await io.rmdir(checked);
        } catch (cause) {
          throw removalFailure(cause, relative);
        }
      }
    }
  };
  const view = async (record) => {
    const { entryDir, metadata, payload } = record;
    const stored = await lstat(payload);
    const deleting = await lstat(await safePath(entryDir, ".deleting"));
    const ready =
      stored &&
      !deleting &&
      !stored.isSymbolicLink() &&
      (metadata.type === "file" ? stored.isFile() : stored.isDirectory()) &&
      metadata.phase !== "copying" &&
      metadata.phase !== "restored";
    return {
      id: metadata.id,
      name:
        metadata.kind === "backup"
          ? metadata.backup.name
          : path.posix.basename(metadata.originalPath),
      originalPath: metadata.originalPath,
      type: metadata.type,
      size: metadata.size,
      deletedAt: metadata.deletedAt,
      ...(metadata.kind === "backup"
        ? {
            kind: "backup",
            backup: { ...metadata.backup },
            restoring: metadata.phase === "restoring",
          }
        : {}),
      status: ready ? "ready" : "incomplete",
      ...(metadata.phase === "copied" || metadata.phase === "restoring"
        ? {
            message:
              "The recovery copy is safe. A previous operation was interrupted; an existing destination will not be overwritten.",
          }
        : {}),
      ...(!ready
        ? {
            message:
              "An interrupted operation left incomplete recovery data. Its files are retained; restore is unavailable until the original operation can be resolved.",
          }
        : {}),
      ...(deleting
        ? {
            message:
              "Permanent deletion was interrupted. Remaining recovery data can be permanently deleted, but cannot be restored.",
          }
        : {}),
    };
  };
  return {
    directory,
    inspect(id, { signal, includeHash = true } = {}) {
      return exclusive(async () => {
        signal?.throwIfAborted();
        const record = await read(id);
        const item = await view(record);
        signal?.throwIfAborted();
        if (item.status !== "ready") throw error(409, item.message);
        return {
          ...item,
          ...(includeHash &&
          item.type === "file" &&
          /^mods\/[^/]+\.jar(?:\.disabled)?$/i.test(item.originalPath) &&
          item.size <= 512 * 1024 ** 2
            ? { sha512: await hashFile(record.payload, "sha512", signal) }
            : {}),
        };
      });
    },
    async list() {
      const entries = await io.readdir(await storage(), {
        withFileTypes: true,
      });
      const items = [];
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          !ids.test(entry.name)
        )
          continue;
        try {
          const record = await read(entry.name);
          if (record.metadata.phase !== "restored")
            items.push(await view(record));
        } catch (cause) {
          items.push({
            id: entry.name,
            name: "Incomplete recovery item",
            originalPath: "",
            type: "file",
            size: 0,
            deletedAt: new Date(0).toISOString(),
            status: "incomplete",
            message:
              "The recovery metadata is unavailable. Stored files have been retained.",
          });
        }
      }
      return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    },
    recycle(originalPath, { backup } = {}) {
      return exclusive(async () => {
        if (
          backup &&
          (!validBackup(backup) ||
            originalPath !== `backups/${backup.id}.tar.gz`)
        )
          throw error(400, "Choose a completed backup from this server.");
        const sourcePath = backup ? backupPath : serverPath;
        if (
          typeof originalPath !== "string" ||
          !originalPath ||
          originalPath.split("/").every((part) => !part)
        )
          throw error(
            400,
            "The server root cannot be moved to the Recycle Bin.",
          );
        const source = await sourcePath(originalPath);
        if (path.resolve(source) === originalRoot)
          throw error(
            400,
            "The server root cannot be moved to the Recycle Bin.",
          );
        originalPath = originalPath.split("/").filter(Boolean).join("/");
        const rows = await walk(source);
        const metadata = {
          version: 1,
          id: newId(),
          originalPath,
          type: rows[0].type,
          size: rows.reduce((total, row) => total + row.size, 0),
          deletedAt: now().toISOString(),
          phase: "prepared",
          ...(backup ? { kind: "backup", backup: { ...backup } } : {}),
        };
        if (backup && rows[0].type !== "file")
          throw error(
            400,
            "Only regular backup archives can be moved to the Recycle Bin.",
          );
        const entryDir = await entryDirectory(metadata.id);
        await io.mkdir(entryDir);
        const payload = await safePath(entryDir, "content");
        await persist(entryDir, metadata);
        try {
          await sourcePath(originalPath);
          try {
            await io.rename(source, payload);
          } catch (cause) {
            if (cause.code !== "EXDEV") throw cause;
            metadata.phase = "copying";
            await persist(entryDir, metadata);
            const snapshot = await copyVerified(source, async (relative) =>
              safePath(
                await entryDirectory(metadata.id),
                ["content", relative].filter(Boolean).join("/"),
              ),
            );
            metadata.phase = "copied";
            await persist(entryDir, metadata);
            await sourcePath(originalPath);
            await verifySource(source, snapshot);
            await removeVerifiedSource(originalPath, snapshot, sourcePath);
          }
          metadata.phase = "ready";
          await persist(entryDir, metadata);
          return view({ entryDir, metadata, payload });
        } catch (cause) {
          // Only discard an empty journal; a partial or complete stored copy is
          // retained even when source removal or the final journal write fails.
          if (!(await lstat(payload)))
            await io.rm(entryDir, { recursive: true, force: true });
          else Object.assign(cause, { recoveryId: metadata.id, originalPath });
          throw cause;
        }
      });
    },
    restore(id, { commitBackup } = {}) {
      return exclusive(async () => {
        const record = await read(id);
        const { entryDir, payload, metadata } = record;
        if (metadata.kind === "backup" && typeof commitBackup !== "function")
          throw error(
            409,
            "Restore this backup through the Recycle Bin to return it to backup history.",
          );
        if ((await view(record)).status !== "ready")
          throw error(
            409,
            "This recovery copy is incomplete and cannot be restored automatically.",
          );
        await walk(payload);
        const destinationPath = originalPathFor(metadata);
        const destination = await destinationPath(metadata.originalPath);
        const existing = await lstat(destination);
        // A backup's archive and its history are committed separately. If the
        // panel stopped between them, retry only our verified identical copy.
        const resume =
          metadata.kind === "backup" &&
          metadata.phase === "restoring" &&
          existing?.isFile() &&
          !existing.isSymbolicLink() &&
          existing.size === (await io.lstat(payload)).size &&
          (await hashFile(destination)) === (await hashFile(payload));
        if (existing && !resume)
          throw error(
            409,
            `“${metadata.originalPath}” already exists. Delete or move the existing file first.`,
          );
        const parent = path.posix.dirname(metadata.originalPath);
        if (parent !== "." && metadata.kind !== "backup") {
          const parentPath = await destinationPath(parent);
          await io.mkdir(parentPath, { recursive: true });
          await destinationPath(parent);
        }
        metadata.phase = "restoring";
        await persist(entryDir, metadata);
        if (!resume)
          await copyVerified(payload, (relative) =>
            destinationPath(
              [metadata.originalPath, relative].filter(Boolean).join("/"),
            ),
          );
        if (metadata.kind === "backup")
          await commitBackup({ ...metadata.backup });
        metadata.phase = "restored";
        await persist(entryDir, metadata);
        // Restore cleanup removes its archived payload only after the destination
        // copy is verified. Interrupted cleanup is harmless.
        // A failed cleanup leaves a completed journal, hidden from the list; the
        // verified restored destination is already durable enough for success.
        await io
          .rm(await entryDirectory(id), { recursive: true, force: true })
          .catch(() => {});
        return metadata.originalPath;
      });
    },
    deletePermanently(id, { details = false } = {}) {
      return exclusive(async () => {
        const metadata = details
          ? await read(id)
              .then((record) => record.metadata)
              .catch(() => null)
          : null;
        // Purge uses the validated private ID only. Damaged metadata or an
        // unavailable original server path must not prevent removing an entry.
        const entryDir = await entryDirectory(id);
        const entry = await lstat(entryDir);
        if (!entry) throw error(404, "This Recycle Bin item was not found.");
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw error(
            400,
            "Choose a directory from this server's Recycle Bin.",
          );
        await walk(entryDir); // Reject links/special files before modifying anything.
        const marker = await safePath(await entryDirectory(id), ".deleting");
        try {
          const handle = await io.open(marker, "wx");
          try {
            await handle.writeFile(
              "Permanent deletion requested. Do not restore partial contents.\n",
            );
            await handle.sync();
          } finally {
            await handle.close();
          }
        } catch (cause) {
          if (cause.code !== "EEXIST") throw cause;
        }
        const rows = await walk(await entryDirectory(id));
        const byPath = new Map(rows.map((row) => [row.path, row]));
        // Keep the journal and deletion marker until payload deletion succeeds.
        // A locked file may leave a partial archive, which must never be restored.
        const ordered = rows
          .filter(
            (row) =>
              row.path && !["entry.json", ".deleting"].includes(row.path),
          )
          .reverse();
        for (const special of ["entry.json", ".deleting", ""])
          if (byPath.has(special)) ordered.push(byPath.get(special));
        try {
          for (const row of ordered) {
            const target = await safePath(await entryDirectory(id), row.path);
            const stat = await io.lstat(target);
            if (
              stat.isSymbolicLink() ||
              stat.ino !== row.ino ||
              stat.dev !== row.dev ||
              (row.type === "directory" ? !stat.isDirectory() : !stat.isFile())
            )
              throw error(
                409,
                "This recovery item changed during deletion. Refresh and try again; remaining files have been retained.",
              );
            if (row.type === "directory") await io.rmdir(target);
            else await io.unlink(target);
          }
        } catch (cause) {
          if (
            ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"].includes(
              cause.code,
            )
          )
            throw Object.assign(
              error(
                409,
                "This recovery item could not be fully deleted. Release files that are in use and retry. Remaining recovery data has been retained.",
              ),
              { code: cause.code },
            );
          throw cause;
        }
        return details
          ? {
              id,
              originalPath: metadata?.originalPath ?? null,
              type: metadata?.type ?? null,
              ...(metadata?.kind === "backup"
                ? { kind: "backup", backup: { ...metadata.backup } }
                : {}),
            }
          : id;
      });
    },
  };
}
