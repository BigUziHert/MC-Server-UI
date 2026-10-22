import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectInstallationDirectory } from "./installation-directory.mjs";
import {
  fileIdentity,
  sameIdentity,
  persistJournal,
  syncDirectory,
  assertInactiveOwner,
  claimBackupJournal,
} from "./backup-journal.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const archiveName = /^[a-f0-9-]{36}\.tar\.gz$/i;
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
async function digest(target) {
  const handle = await fs.open(target, "r");
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function checkedDirectory(directory, identity) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !samePath(await fs.realpath(directory), directory) ||
    (identity && !sameIdentity(stat, identity))
  )
    throw fail(
      409,
      "The backup folder changed. Restore its original folder or drive before continuing.",
    );
  return stat;
}
const unavailable =
  "The backup location is unavailable. Reconnect its drive or restore the original folder. Backups will not be saved elsewhere.";

export async function backupStorageDirectories(dataDir) {
  try {
    const record = JSON.parse(
      await fs.readFile(path.join(dataDir, "backup-location.json"), "utf8"),
    );
    return [
      record.directory,
      record.pending?.source,
      record.pending?.destination,
    ].filter((value) => typeof value === "string" && path.isAbsolute(value));
  } catch (cause) {
    if (cause.code === "ENOENT") return [path.join(dataDir, "backups")];
    throw cause;
  }
}

// This record is separate from panel history so the location and its migration
// commit in one durable rename. Recovery runs before any archive consumer opens.
export async function createBackupLocation({
  dataDir,
  defaultDirectory,
  defaultAncestors = [],
  forbiddenDirectories = async () => [],
  onDirectory = () => {},
  hooks = {},
}) {
  const recordPath = path.join(dataDir, "backup-location.json");
  let record;
  try {
    record = JSON.parse(await fs.readFile(recordPath, "utf8"));
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  if (
    record &&
    (record.version !== 1 ||
      typeof record.directory !== "string" ||
      !path.isAbsolute(record.directory))
  )
    throw fail(
      409,
      "The backup location record is invalid. Backup files have been preserved.",
    );
  if (
    record?.pending &&
    (!record.job ||
      !Array.isArray(record.pending.files) ||
      ![record.pending.source, record.pending.destination].every(
        (value) => typeof value === "string" && path.isAbsolute(value),
      ) ||
      record.pending.files.some(
        (item) =>
          !archiveName.test(item.name) ||
          !Number.isSafeInteger(item.size) ||
          item.size < 0 ||
          (item.hash && !/^[a-f0-9]{64}$/.test(item.hash)),
      ))
  )
    throw fail(
      409,
      "The backup move recovery record is invalid. Backup files have been preserved.",
    );
  if (!record) {
    await fs.mkdir(defaultDirectory, { recursive: true });
    record = {
      version: 1,
      directory: await fs.realpath(defaultDirectory),
      identity: fileIdentity(await checkedDirectory(defaultDirectory)),
      job: null,
    };
  }
  const persist = () => persistJournal(recordPath, record);
  let commitUncertain = false;
  const assertAvailable = async () => {
    if (commitUncertain)
      throw fail(
        409,
        "The backup location commit could not be confirmed. Restart the panel to recover the saved location; both archive copies have been retained.",
      );
    try {
      await checkedDirectory(record.directory, record.identity);
      await fs.access(record.directory, constants.R_OK | constants.W_OK);
      return record.directory;
    } catch (cause) {
      throw fail(409, cause.status ? cause.message : unavailable);
    }
  };
  const update = (values) =>
    Object.assign(record.job, values, { updatedAt: new Date().toISOString() });
  const assertTransactionRoots = async (pending) => {
    await checkedDirectory(pending.source, pending.sourceIdentity);
    await checkedDirectory(pending.destination, pending.destinationIdentity);
  };
  const cleanupCommitted = async (pending) => {
    // A source drive may be disconnected after commit. Keep the redundant copies
    // and retry on restart; never roll back a committed destination.
    if (pending.files.every((item) => item.cleaned)) return;
    await assertTransactionRoots(pending);
    for (const item of pending.files) {
      if (item.cleaned) continue;
      const target = path.join(pending.destination, item.name);
      const original = path.join(pending.source, item.name);
      const sourceStat = await fs.lstat(original).catch((cause) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (!sourceStat) {
        item.cleaned = true;
        await persist();
        continue;
      }
      const targetStat = await fs.lstat(target);
      if (
        !targetStat.isFile() ||
        !sameIdentity(targetStat, item.output) ||
        (await digest(target)) !== item.hash
      )
        throw fail(
          409,
          "A moved backup changed. The original copies have been retained.",
        );
      if (
        !sourceStat.isFile() ||
        !sameIdentity(sourceStat, item.source) ||
        (await digest(original)) !== item.hash
      )
        throw fail(
          409,
          "An original backup changed. Both copies have been retained.",
        );
      await assertTransactionRoots(pending);
      const latestSource = await fs.lstat(original);
      const latestTarget = await fs.lstat(target);
      if (
        !sameIdentity(latestSource, sourceStat) ||
        latestSource.size !== sourceStat.size ||
        latestSource.mtimeMs !== sourceStat.mtimeMs ||
        !sameIdentity(latestTarget, targetStat) ||
        latestTarget.size !== targetStat.size ||
        latestTarget.mtimeMs !== targetStat.mtimeMs
      )
        throw fail(
          409,
          "A backup changed during cleanup. Both copies have been retained.",
        );
      await fs.unlink(original);
      await syncDirectory(pending.source);
      item.cleaned = true;
      await persist();
    }
    await syncDirectory(pending.source);
  };
  const rollbackCopies = async (pending) => {
    await assertTransactionRoots(pending);
    let ambiguous = false;
    for (const item of pending.files) {
      if (!item.output) continue;
      const target = path.join(pending.destination, item.name);
      const stat = await fs.lstat(target).catch((cause) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (!stat) continue;
      const original = path.join(pending.source, item.name);
      const sourceStat = await fs.lstat(original).catch((cause) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (
        stat.isFile() &&
        sameIdentity(stat, item.output) &&
        item.hash &&
        stat.size === item.size &&
        (await digest(target)) === item.hash &&
        sourceStat?.isFile() &&
        sameIdentity(sourceStat, item.source) &&
        (await digest(original)) === item.hash
      ) {
        await assertTransactionRoots(pending);
        const latest = await fs.lstat(target);
        const latestSource = await fs.lstat(original);
        if (
          !sameIdentity(latest, stat) ||
          latest.size !== stat.size ||
          latest.mtimeMs !== stat.mtimeMs ||
          !sameIdentity(latestSource, sourceStat) ||
          latestSource.size !== sourceStat.size ||
          latestSource.mtimeMs !== sourceStat.mtimeMs
        ) {
          ambiguous = true;
          continue;
        }
        await fs.unlink(target);
      } else ambiguous = true;
    }
    await syncDirectory(pending.destination);
    if (ambiguous)
      throw fail(
        409,
        "Incomplete or changed recovery copies were retained in the selected destination.",
      );
  };
  if (record.pending) {
    assertInactiveOwner(record.pending, recordPath);
    try {
      if (record.pending.committed) {
        await cleanupCommitted(record.pending);
        update({ status: "completed", phase: "completed", error: undefined });
      } else {
        await rollbackCopies(record.pending);
        update({
          status: "failed",
          phase: "failed",
          error:
            "The move was interrupted. Your backups remain in their original location; you can try again.",
        });
      }
      delete record.pending;
    } catch (cause) {
      update({
        status: "failed",
        phase: "failed",
        error: `The interrupted move retained recovery copies at ${record.pending.destination}. Reconnect its drives or inspect the retained copies before restarting the panel. ${cause.message}`,
      });
    }
    await persist();
  }
  onDirectory(record.directory);
  const filesSnapshot = async () => {
    await assertAvailable();
    const files = [];
    for (const name of (await fs.readdir(record.directory)).sort()) {
      // Unexpected files may be recovery data. Do not lose track of them or
      // sweep them into a different server's backup folder.
      if (!archiveName.test(name))
        throw fail(
          409,
          "The backup folder contains unfinished or unrecognized files. Resolve them before changing its location.",
        );
      const stat = await fs.lstat(path.join(record.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw fail(
          409,
          "Backup archives must be ordinary files without links before moving them.",
        );
      files.push({
        name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        source: fileIdentity(stat),
      });
    }
    return files;
  };
  const revision = (files) =>
    createHash("sha256")
      .update(JSON.stringify([record.directory, record.identity, files]))
      .digest("hex");
  async function inspectDestination(directory, totalBytes) {
    let target;
    try {
      const restoringDefault =
        typeof directory === "string" &&
        samePath(path.resolve(directory), defaultDirectory);
      const forbidden = (await forbiddenDirectories()).filter(
        (entry) =>
          !restoringDefault ||
          ![dataDir, ...defaultAncestors].some((ancestor) =>
            samePath(path.resolve(entry), path.resolve(ancestor)),
          ),
      );
      target = await inspectInstallationDirectory(directory, {
        forbiddenDirectories: [...forbidden, record.directory],
      });
    } catch (cause) {
      if (cause.status)
        cause.message = cause.message
          .replaceAll("installation folder", "backup folder")
          .replaceAll("installation", "backup")
          .replace(
            "To use existing server files, choose Import an existing server.",
            "Existing backups will be copied here after you confirm.",
          );
      throw cause;
    }
    if (
      !samePath(target.directory, defaultDirectory) &&
      target.directory
        .split(path.sep)
        .some(
          (part) =>
            part.toLowerCase() === ".mc-panel" ||
            /^\.mc-recycle-bin-[a-f0-9]{16}$/i.test(part),
        )
    )
      throw fail(
        409,
        "Choose a backup folder outside MC Panel's support and Recycle Bin folders.",
      );
    let ancestor = target.directory;
    while (
      !(await fs.lstat(ancestor).catch((cause) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      }))
    )
      ancestor = path.dirname(ancestor);
    const space = await fs.statfs(ancestor);
    if (space.bavail * space.bsize < totalBytes + 1024 * 1024)
      throw fail(
        409,
        "The selected drive does not have enough free space for these backups.",
      );
    return target;
  }
  const preview = async (directory) => {
    if (record.pending)
      throw fail(
        409,
        `An interrupted backup move still has recovery copies at ${record.pending.destination}. Reconnect its drives, or inspect and remove incomplete copies there, then restart the panel before moving again.`,
      );
    const files = await filesSnapshot();
    const totalBytes = files.reduce((sum, item) => sum + item.size, 0);
    const target = await inspectDestination(directory, totalBytes);
    return {
      directory: target.directory,
      currentDirectory: record.directory,
      backupCount: files.length,
      totalBytes,
      revision: revision(files),
    };
  };
  let running = false;
  let requestedDestination;
  const move = async (directory, expectedRevision) => {
    if (running)
      throw fail(409, "A backup location change is already in progress.");
    running = true;
    const release = claimBackupJournal(recordPath);
    let committed = false;
    try {
      const reviewed = await preview(directory);
      if (expectedRevision !== reviewed.revision)
        throw fail(
          409,
          "The backups changed since you reviewed this move. Review the new location again.",
        );
      const files = await filesSnapshot();
      if (revision(files) !== expectedRevision)
        throw fail(409, "The backups changed. Review the move again.");
      update({
        phase: "preparing",
        totalBytes: reviewed.totalBytes,
        totalFiles: files.length,
      });
      await fs.mkdir(reviewed.directory, { recursive: true });
      await inspectDestination(reviewed.directory, reviewed.totalBytes);
      record.pending = {
        ownerPid: process.pid,
        source: record.directory,
        sourceIdentity: record.identity,
        destination: reviewed.directory,
        destinationIdentity: fileIdentity(
          await checkedDirectory(reviewed.directory),
        ),
        files,
      };
      await persist();
      const pending = record.pending;
      for (const item of files) {
        await assertTransactionRoots(pending);
        update({ phase: "copying" });
        const original = path.join(pending.source, item.name),
          target = path.join(pending.destination, item.name);
        const input = await fs.open(original, "r");
        let output;
        try {
          if (!sameIdentity(await input.stat(), item.source))
            throw fail(409, "A backup changed while preparing its move.");
          output = await fs.open(target, "wx", 0o600);
          item.output = fileIdentity(await output.stat());
          await persist();
          const hash = createHash("sha256");
          for await (const chunk of input.createReadStream({
            autoClose: false,
          })) {
            let offset = 0;
            while (offset < chunk.length)
              offset += (await output.write(chunk, offset)).bytesWritten;
            hash.update(chunk);
            update({
              processedBytes: record.job.processedBytes + chunk.length,
            });
          }
          await output.sync();
          item.hash = hash.digest("hex");
        } finally {
          await input.close();
          await output?.close();
        }
        update({ phase: "verifying" });
        const sourceStat = await fs.lstat(original);
        const outputStat = await fs.lstat(target);
        if (
          !sameIdentity(sourceStat, item.source) ||
          sourceStat.size !== item.size ||
          sourceStat.mtimeMs !== item.mtimeMs ||
          !sameIdentity(outputStat, item.output) ||
          outputStat.size !== item.size ||
          (await digest(target)) !== item.hash
        )
          throw fail(
            409,
            "A copied backup could not be verified. Original archives have been retained.",
          );
        update({ processedFiles: record.job.processedFiles + 1 });
        await persist();
      }
      await hooks.beforeCommit?.();
      await assertTransactionRoots(pending);
      if (
        revision(await filesSnapshot()) !== expectedRevision ||
        JSON.stringify((await fs.readdir(pending.destination)).sort()) !==
          JSON.stringify(files.map((item) => item.name))
      )
        throw fail(
          409,
          "The source or destination changed during the move. Original backups have been retained.",
        );
      await syncDirectory(pending.destination);
      update({ phase: "committing" });
      // Atomic location commit precedes any removal of source archives.
      const previous = record;
      record = {
        ...record,
        directory: pending.destination,
        identity: pending.destinationIdentity,
        pending: { ...pending, committed: true },
      };
      try {
        await persist();
      } catch (cause) {
        // rename may have succeeded before directory fsync failed. Read the
        // atomic record before deciding whether rollback is still safe.
        let saved;
        try {
          saved = JSON.parse(await fs.readFile(recordPath, "utf8"));
        } catch {
          /* Ambiguous publication must retain both copies. */
        }
        if (
          saved?.job?.id === record.job.id &&
          saved.pending?.committed &&
          samePath(saved.directory, record.directory)
        ) {
          committed = true;
          onDirectory(record.directory);
        } else {
          record = previous;
          commitUncertain = !(
            saved?.job?.id === record.job.id &&
            !saved.pending?.committed &&
            samePath(saved.directory, record.directory)
          );
        }
        throw cause;
      }
      committed = true;
      onDirectory(record.directory);
      update({ phase: "cleaning" });
      await hooks.afterCommit?.();
      await cleanupCommitted(record.pending);
      delete record.pending;
      update({ status: "completed", phase: "completed" });
      await persist();
    } catch (cause) {
      if (!committed && !commitUncertain && record.pending) {
        try {
          await rollbackCopies(record.pending);
          delete record.pending;
        } catch {
          /* Preserve ambiguous recovery copies. */
        }
      }
      update({
        status: committed ? "completed" : "failed",
        phase: committed ? "completed" : "failed",
        error: `${committed ? "The location was changed, but some original copies were retained. " : ""}${cause.code === "ENOSPC" ? "The destination drive is full. Original backups were retained." : cause.message}`,
      });
      if (!commitUncertain) await persist();
    } finally {
      running = false;
      requestedDestination = undefined;
      release();
    }
  };
  return {
    get directory() {
      return record.directory;
    },
    reservedDirectories: () => [
      record.directory,
      ...(requestedDestination ? [requestedDestination] : []),
      ...(record.pending
        ? [record.pending.source, record.pending.destination]
        : []),
    ],
    assertAvailable,
    preview,
    async status() {
      let availabilityError;
      try {
        await assertAvailable();
      } catch (cause) {
        availabilityError = cause.message;
      }
      return {
        directory: record.directory,
        defaultDirectory,
        available: !availabilityError,
        ...(availabilityError ? { error: availabilityError } : {}),
        canChange: true,
        job:
          running && record.job?.status !== "running"
            ? { ...record.job, status: "running", phase: "committing" }
            : record.job,
        revision: createHash("sha256").update(record.directory).digest("hex"),
      };
    },
    begin(directory, expectedRevision) {
      if (running || record.job?.status === "running")
        throw fail(409, "A backup location change is already in progress.");
      const job = {
        id: randomUUID(),
        status: "running",
        phase: "preparing",
        processedBytes: 0,
        totalBytes: 0,
        processedFiles: 0,
        totalFiles: 0,
        startedAt: new Date().toISOString(),
      };
      record.job = job;
      requestedDestination =
        typeof directory === "string" && path.isAbsolute(directory)
          ? path.resolve(directory)
          : undefined;
      const promise = move(directory, expectedRevision);
      return { job, promise };
    },
  };
}
