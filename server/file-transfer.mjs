import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const MAX_UPLOAD_FILES_PER_BATCH = 100;
const UPLOAD_IO_CONCURRENCY = 8;

async function eachUploadEntry(entries, visit) {
  let next = 0;
  let failed = false;
  let firstError;
  const worker = async () => {
    while (!failed && next < entries.length) {
      const index = next++;
      try {
        await visit(entries[index], index);
      } catch (cause) {
        if (!failed) firstError = cause;
        failed = true;
      }
    }
  };
  // Drain in-flight work before reporting failure or cleaning temporary files.
  await Promise.all(
    Array.from(
      { length: Math.min(UPLOAD_IO_CONCURRENCY, entries.length) },
      worker,
    ),
  );
  if (failed) throw firstError;
}

// A local upload already exists in the panel's private temporary directory.
// Publishing a second link is atomic and exclusive, with no second full write.
// Cross-volume and link-restricted filesystems retain the exclusive-copy path.
async function publishUpload(io, temporary, destination) {
  try {
    await io.link(temporary, destination);
  } catch (cause) {
    if (
      !["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES"].includes(
        cause.code,
      )
    )
      throw cause;
    await io.copyFile(temporary, destination, constants.COPYFILE_EXCL);
  }
}

const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const identity = (a, b) =>
  a.ino === b.ino && a.dev === b.dev && a.birthtimeMs === b.birthtimeMs;
const unchangedFile = (a, b) =>
  identity(a, b) &&
  a.isFile() &&
  !a.isSymbolicLink() &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs;
const notify = (observer, update) => {
  try {
    observer?.(update);
  } catch {}
};
const normalize = (value, allowRoot = false) => {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    (!allowRoot && !value)
  )
    throw failure(400, "Choose valid paths inside the server folder.");
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    value
      .split("/")
      .some((part) => part === "." || part === ".." || part.includes(":"))
  )
    throw failure(400, "Paths must stay inside the server folder.");
  const result = value.split("/").filter(Boolean).join("/");
  if (!allowRoot && !result)
    throw failure(400, "The server root cannot be copied.");
  return result;
};
const key = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;
const inside = (parent, child) =>
  key(child) === key(parent) || key(child).startsWith(`${key(parent)}/`);
const statOrNull = async (io, target) => {
  try {
    return await io.lstat(target);
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    throw cause;
  }
};

async function boundary(root, safePath, io) {
  const expected = await io.lstat(root);
  const canonical = await io.realpath(root);
  if (!expected.isDirectory() || expected.isSymbolicLink())
    throw failure(409, "The server folder is unavailable or changed.");
  const check = async () => {
    const current = await io.lstat(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !identity(current, expected) ||
      (await io.realpath(root)) !== canonical
    )
      throw failure(409, "The server folder changed during the file transfer.");
  };
  return async (relative = "") => {
    await check();
    const target = await safePath(root, relative);
    await check();
    return target;
  };
}

// Rename the directory entry itself so even a large world moves in one
// operation, preserving its contents, directory identity and permissions.
async function renameFolder(
  io,
  resolve,
  relative,
  renamed,
  original,
  caseOnly,
) {
  let reservation;
  try {
    // Windows refuses to replace another directory. POSIX rename can replace
    // an empty one, so first claim the new name exclusively on those hosts.
    if (!caseOnly && process.platform !== "win32") {
      const to = await resolve(renamed);
      await io.mkdir(to, { mode: 0o700 });
      reservation = await io.lstat(to);
    }
    const from = await resolve(relative);
    const destination = await resolve(renamed);
    const source = await io.lstat(from);
    if (!source.isDirectory() || !identity(source, original))
      throw failure(
        409,
        "The folder changed. Refresh File Manager and try again.",
      );
    const expected = caseOnly ? original : reservation;
    const current = await statOrNull(io, destination);
    if (
      expected
        ? !current?.isDirectory() || !identity(expected, current)
        : current
    )
      throw failure(
        409,
        "The destination changed. Refresh File Manager and try again.",
      );
    await io.rename(from, destination);
    reservation = undefined;
  } catch (cause) {
    if (["EBUSY", "EPERM", "EACCES"].includes(cause.code))
      throw failure(
        409,
        "The folder could not be renamed. Check its permissions and close any program using it.",
      );
    throw cause;
  } finally {
    if (reservation) {
      try {
        const reserved = await resolve(renamed);
        const current = await statOrNull(io, reserved);
        if (current?.isDirectory() && identity(reservation, current))
          await io.rmdir(reserved);
      } catch {
        // Keep any externally changed entry and report the original error.
      }
    }
  }
}

/** Copy or move selected trees, or rename one entry in its current directory. */
export async function copyServerFiles({
  sourceDir,
  serverDir,
  destinationPath = "",
  paths,
  mode = "copy",
  renameTo,
  renameType = "file",
  safePath,
  fileSystem = fs,
  onProgress,
  assertAccess = async () => {},
  canReadDestination = () => true,
}) {
  const io = fileSystem;
  const result = { copiedFiles: 0, copiedDirectories: 0, paths: [] };
  try {
    if (!["copy", "move"].includes(mode))
      throw failure(400, "Choose copy or move for this file transfer.");
    if (mode === "move") result.mode = "move";
    if (!Array.isArray(paths) || !paths.length || paths.length > 5000)
      throw failure(
        400,
        "Select between 1 and 5,000 files or folders to copy.",
      );
    const selected = [...new Set(paths.map((item) => normalize(item)))];
    const renaming = renameTo !== undefined;
    if (renaming) {
      if (
        mode !== "move" ||
        selected.length !== 1 ||
        !["file", "directory"].includes(renameType) ||
        normalize(renameTo) !== renameTo ||
        renameTo.includes("/")
      )
        throw failure(400, "Choose one file or folder and a new name.");
      destinationPath = selected[0].split("/").slice(0, -1).join("/");
    }
    const roots = selected.filter(
      (item) =>
        !selected.some(
          (other) => key(other) !== key(item) && inside(other, item),
        ),
    );
    if (
      new Set(roots.map((item) => key(path.posix.basename(item)))).size !==
      roots.length
    )
      throw failure(
        409,
        "Selected items have the same destination name. Copy them separately.",
      );
    destinationPath = normalize(destinationPath, true);
    await assertAccess();
    const source = await boundary(sourceDir, safePath, io);
    const target = await boundary(serverDir, safePath, io);
    const destination = await target(destinationPath);
    if (!(await io.lstat(destination)).isDirectory())
      throw failure(400, "Choose a destination folder.");
    const sameServer =
      key(await io.realpath(sourceDir)) === key(await io.realpath(serverDir));
    if (mode === "move" && !sameServer)
      throw failure(
        400,
        "Cut and paste is available within the same server. Use Copy to transfer files to another server.",
      );
    const rows = [];
    let totalFiles = 0,
      totalBytes = 0;
    notify(onProgress, {
      phase: "scanning",
      filesProcessed: 0,
      totalFiles: null,
      bytesProcessed: 0,
      totalBytes: null,
    });
    const verifyExistingCopy = async (row, existing) => {
      const conflict = () =>
        Object.assign(
          failure(
            409,
            `“${row.destinationRelative}” already exists. Choose another folder or rename the existing item.`,
          ),
          { code: "EEXIST" },
        );
      if (!canReadDestination() || existing.isSymbolicLink()) throw conflict();
      if (row.stat.isDirectory() && existing.isDirectory()) return;
      if (
        !row.stat.isFile() ||
        !existing.isFile() ||
        row.stat.size !== existing.size
      )
        throw conflict();
      const from = await source(row.relative);
      if (!unchangedContent(await io.lstat(from), row.stat)) throw conflict();
      const to = await target(row.destinationRelative);
      if (from === to) return;
      // Reuse the preflight comparison only while both files are unchanged.
      if (row.verified && unchangedContent(existing, row.verified)) return;
      const assertRead = async () => {
        await assertAccess();
        if (!canReadDestination()) throw conflict();
      };
      const incoming = await fileDigest(io, from, row.stat, assertRead);
      const present = await fileDigest(io, to, existing, assertRead);
      await assertRead();
      const current = await statOrNull(
        io,
        await target(row.destinationRelative),
      );
      if (
        !incoming ||
        incoming !== present ||
        !current ||
        !unchangedContent(current, existing) ||
        !unchangedContent(await io.lstat(await source(row.relative)), row.stat)
      )
        throw conflict();
      row.verified = existing;
    };
    const walk = async (relative, destinationRelative, existing) => {
      if (rows.length >= 100_000)
        throw failure(
          400,
          "Copy fewer items at a time; this selection contains more than 100,000 entries.",
        );
      await assertAccess();
      const stat = await io.lstat(await source(relative));
      if (renaming && !stat.isFile())
        throw failure(
          409,
          "The file changed. Refresh File Manager and try again.",
        );
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw failure(
          400,
          "File copies do not follow symbolic links or special files.",
        );
      const row = { relative, destinationRelative, stat };
      if (existing) await verifyExistingCopy(row, existing);
      rows.push(row);
      if (stat.isFile()) {
        totalFiles++;
        totalBytes += stat.size;
      }
      notify(onProgress, {
        filesProcessed: totalFiles,
        bytesProcessed: totalBytes,
      });
      if (stat.isDirectory()) {
        for (const name of (await io.readdir(await source(relative))).sort()) {
          const child = `${destinationRelative}/${name}`;
          await walk(
            `${relative}/${name}`,
            child,
            existing && (await statOrNull(io, await target(child))),
          );
        }
      }
    };
    const destinationFor = (relative) =>
      [destinationPath, renameTo ?? path.posix.basename(relative)]
        .filter(Boolean)
        .join("/");
    for (const relative of roots) {
      const destinationRelative = destinationFor(relative);
      const existing = await statOrNull(io, await target(destinationRelative));
      const sameFile =
        mode === "copy" &&
        key(relative) === key(destinationRelative) &&
        existing?.isFile();
      if (
        !renaming &&
        sameServer &&
        inside(relative, destinationRelative) &&
        !sameFile
      )
        throw failure(
          409,
          "A file or folder cannot be copied into itself or one of its subfolders.",
        );
      if (renaming) {
        const item = await io.lstat(await source(relative));
        const folder = renameType === "directory";
        if (folder ? !item.isDirectory() : !item.isFile())
          throw failure(
            409,
            "The item type changed. Refresh File Manager and try again.",
          );
        if (relative === destinationRelative) return result;
        let caseOnly = false;
        if (
          existing &&
          identity(item, existing) &&
          relative.toLowerCase() === destinationRelative.toLowerCase()
        ) {
          // A second hard link with the requested spelling is a conflict.
          const names = await io.readdir(destination);
          caseOnly =
            names.includes(path.posix.basename(relative)) &&
            !names.includes(renameTo);
        }
        if (existing && !caseOnly)
          throw failure(
            409,
            `“${renameTo}” already exists. Choose another name.`,
          );
        if (folder || caseOnly) {
          if (folder) {
            await renameFolder(
              io,
              target,
              relative,
              destinationRelative,
              item,
              caseOnly,
            );
            result.copiedDirectories++;
          } else {
            await io.rename(
              await source(relative),
              await target(destinationRelative),
            );
            result.copiedFiles++;
          }
          result.paths.push(destinationRelative);
          return result;
        }
      } else if (mode === "move" && existing)
        throw failure(
          409,
          `“${destinationRelative}” already exists. Choose another folder or rename the existing item.`,
        );
      await walk(relative, destinationRelative, mode === "copy" && existing);
    }
    let bytesProcessed = 0;
    const report = () =>
      notify(onProgress, {
        phase: "copying",
        filesProcessed: result.copiedFiles + (result.skippedFiles ?? 0),
        totalFiles,
        bytesProcessed,
        totalBytes,
      });
    report();
    if (mode === "move") {
      // Publish exclusive hard links before removing anything. Unlike rename,
      // link cannot overwrite a destination that appears after preflight. All
      // data stays on the same inode, so this never deletes an unverified copy.
      const destinationStat = await io.lstat(destination);
      if (rows.some((row) => row.stat.dev !== destinationStat.dev))
        throw failure(
          400,
          "Cut and paste cannot move across drives. Use Copy instead.",
        );
      const created = [];
      let removing = false;
      const verifySource = async (row) => {
        const current = await io.lstat(await source(row.relative));
        if (
          !identity(current, row.stat) ||
          current.isSymbolicLink() ||
          (row.stat.isDirectory()
            ? !current.isDirectory()
            : !unchangedFile(current, row.stat))
        )
          throw failure(
            409,
            "A source item changed during the move. Check both folders before retrying.",
          );
      };
      const verifyTarget = async (row) => {
        const current = await io.lstat(await target(row.destinationRelative));
        if (current.isSymbolicLink() || !identity(current, row.createdStat))
          throw failure(
            409,
            "A destination item changed during the move. Check both folders before retrying.",
          );
      };
      const removeClaimedFile = async (
        from,
        verifyClaim,
        verifyRemaining,
        kind,
      ) => {
        // Claim the current directory entry before deleting it. A server or
        // external editor may replace `from` after the preceding stat checks;
        // unlinking that path directly could delete bytes we never published.
        const staging = await io.mkdtemp(
          path.join(path.dirname(from), ".mc-panel-move-"),
        );
        const held = path.join(staging, "source");
        let claimed = false;
        try {
          await io.rename(from, held);
          claimed = true;
          if (!verifyClaim(await io.lstat(held)))
            throw failure(
              409,
              `A ${kind} item changed during the move. Check both folders before retrying.`,
            );
          await verifyRemaining();
          await io.unlink(held);
          claimed = false;
        } catch (cause) {
          if (claimed) {
            try {
              const current = await io.lstat(held);
              if (!current.isFile() || current.isSymbolicLink()) throw cause;
              // Restore only to a free source path. Never overwrite a second
              // replacement; retain the claimed data for recovery if needed.
              await io.link(held, from);
              await io.unlink(held);
              claimed = false;
            } catch {
              const retained = path
                .relative(sourceDir, held)
                .split(path.sep)
                .join("/");
              throw Object.assign(
                failure(
                  409,
                  `The move stopped. ${kind === "source" ? "Source" : "Destination"} data was retained at “${retained}”. Check both folders before retrying.`,
                ),
                { retainedPath: retained },
              );
            }
          }
          throw cause;
        } finally {
          if (!claimed) await io.rmdir(staging).catch(() => {});
        }
      };
      try {
        for (const row of rows) {
          await assertAccess();
          await verifySource(row);
          const to = await target(row.destinationRelative);
          if (row.stat.isDirectory()) await io.mkdir(to);
          else await io.link(await source(row.relative), to);
          row.createdStat = await io.lstat(
            await target(row.destinationRelative),
          );
          created.push(row);
          if (row.stat.isFile() && !identity(row.createdStat, row.stat))
            throw failure(
              409,
              "A source item changed before it could be moved.",
            );
        }
        // Validate the entire published selection before unlinking the first
        // source. A failed preflight/publication leaves every source in place.
        for (const row of rows) {
          await assertAccess();
          await verifySource(row);
          await verifyTarget(row);
        }
        removing = true;
        for (const row of [...rows].reverse()) {
          await assertAccess();
          await verifySource(row);
          await verifyTarget(row);
          const from = await source(row.relative);
          if (row.stat.isDirectory()) {
            // Never recursively remove: an externally added file stays safe.
            await io.rmdir(from);
            result.copiedDirectories++;
            const to = await target(row.destinationRelative);
            await io.chmod(to, row.stat.mode & 0o777);
            await io.utimes(to, row.stat.atime, row.stat.mtime);
          } else {
            await removeClaimedFile(
              from,
              (stat) => unchangedFile(stat, row.stat),
              async () => {
                await assertAccess();
                await verifyTarget(row);
              },
              "source",
            );
            result.copiedFiles++;
            bytesProcessed += row.stat.size;
          }
          const root = roots.find((relative) => inside(relative, row.relative));
          const movedPath = destinationFor(root);
          if (!result.paths.includes(movedPath)) result.paths.push(movedPath);
          report();
        }
        return result;
      } catch (cause) {
        const retainedWarnings = [];
        for (const row of [...created].reverse()) {
          try {
            await verifyTarget(row);
            const currentSource = await io.lstat(await source(row.relative));
            if (
              currentSource.isSymbolicLink() ||
              !identity(currentSource, row.stat)
            )
              continue;
            const to = await target(row.destinationRelative);
            // Remove unfinished links only while the original inode remains
            // at the source. Completed moves or replaced sources keep their
            // destination; a partial failure must never drop its last link.
            if (row.stat.isDirectory()) await io.rmdir(to);
            else
              await removeClaimedFile(
                to,
                (stat) =>
                  stat.isFile() &&
                  !stat.isSymbolicLink() &&
                  identity(stat, row.createdStat),
                async () => {
                  const remaining = await io.lstat(await source(row.relative));
                  if (
                    !remaining.isFile() ||
                    remaining.isSymbolicLink() ||
                    !identity(remaining, row.stat)
                  )
                    throw failure(
                      409,
                      "The source changed during move cleanup.",
                    );
                },
                "destination",
              );
          } catch (cleanupCause) {
            if (cleanupCause.retainedPath)
              retainedWarnings.push(cleanupCause.message);
            /* Retain changed or completed destinations rather than deleting them. */
          }
        }
        if (retainedWarnings.length)
          throw failure(409, [cause.message, ...retainedWarnings].join(" "));
        if (
          renaming &&
          !removing &&
          ["ENOTSUP", "EOPNOTSUPP", "EPERM", "EBUSY"].includes(cause.code)
        )
          throw failure(
            409,
            "The filesystem could not rename this file. Check whether another program is using it and that the folder allows file moves.",
          );
        if (["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(cause.code))
          throw failure(
            409,
            removing
              ? "The move could not finish. Check both folders before retrying; completed moves have been retained."
              : "This filesystem does not support safe Cut and Paste. Use Copy instead. Source files have been retained.",
          );
        throw cause;
      }
    }
    // Each publication is still exclusive. A destination appearing since the
    // scan must pass the same comparison before it can count as a skip.
    const verifyCollision = async (row, cause) => {
      if (cause.code !== "EEXIST") throw cause;
      const current = await statOrNull(
        io,
        await target(row.destinationRelative),
      );
      if (!current) throw cause;
      await verifyExistingCopy(row, current);
    };
    for (const row of rows) {
      await assertAccess();
      const from = await source(row.relative),
        to = await target(row.destinationRelative);
      const current = await io.lstat(from);
      if (
        !identity(current, row.stat) ||
        current.isSymbolicLink() ||
        (row.stat.isDirectory()
          ? !current.isDirectory()
          : !unchangedFile(current, row.stat))
      )
        throw failure(
          409,
          "A source item changed during the copy. Completed copies have been retained.",
        );
      if (row.stat.isDirectory()) {
        try {
          await io.mkdir(to);
        } catch (cause) {
          await verifyCollision(row, cause);
          continue;
        }
        row.createdDirectory = true;
        result.copiedDirectories++;
      } else {
        const input = await io.open(from, "r");
        let output, created;
        try {
          if (!unchangedFile(await input.stat(), row.stat))
            throw failure(
              409,
              "A source file changed before it could be copied.",
            );
          await source(row.relative);
          try {
            output = await io.open(await target(row.destinationRelative), "wx");
          } catch (cause) {
            await verifyCollision(row, cause);
            result.skippedFiles = (result.skippedFiles ?? 0) + 1;
            bytesProcessed += row.stat.size;
            report();
            continue;
          }
          created = await output.stat();
          const checkDestination = async () => {
            const currentTarget = await io.lstat(
              await target(row.destinationRelative),
            );
            if (
              currentTarget.isSymbolicLink() ||
              !identity(currentTarget, created)
            )
              throw failure(
                409,
                "The destination changed during the copy. Completed copies have been retained.",
              );
          };
          await checkDestination();
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          let remaining = row.stat.size;
          while (remaining) {
            await assertAccess();
            const { bytesRead } = await input.read(
              buffer,
              0,
              Math.min(buffer.length, remaining),
              null,
            );
            if (!bytesRead)
              throw failure(409, "A source file changed during the copy.");
            await checkDestination();
            let offset = 0;
            while (offset < bytesRead) {
              const { bytesWritten } = await output.write(
                buffer,
                offset,
                bytesRead - offset,
                null,
              );
              if (!bytesWritten)
                throw failure(
                  500,
                  "The destination could not accept the copied data.",
                );
              offset += bytesWritten;
            }
            remaining -= bytesRead;
            bytesProcessed += bytesRead;
            report();
          }
          if (
            !unchangedFile(await input.stat(), row.stat) ||
            !unchangedFile(await io.lstat(await source(row.relative)), row.stat)
          )
            throw failure(
              409,
              "A source file changed during the copy. Completed copies have been retained.",
            );
          await assertAccess();
          await checkDestination();
          await output.chmod(row.stat.mode & 0o777);
          await output.utimes(row.stat.atime, row.stat.mtime);
          await output.sync();
        } catch (cause) {
          await output?.close();
          output = undefined;
          if (created) {
            // Remove only our incomplete file, never a substituted destination.
            const checked = await target(row.destinationRelative).catch(
              () => null,
            );
            const currentTarget = checked && (await statOrNull(io, checked));
            if (
              currentTarget &&
              identity(currentTarget, created) &&
              !currentTarget.isSymbolicLink()
            )
              await io.unlink(checked).catch(() => {});
          }
          throw cause;
        } finally {
          await input.close();
          await output?.close();
        }
        result.copiedFiles++;
      }
      const topLevel = [
        destinationPath,
        row.destinationRelative
          .slice(destinationPath ? destinationPath.length + 1 : 0)
          .split("/")[0],
      ]
        .filter(Boolean)
        .join("/");
      if (!result.paths.includes(topLevel)) result.paths.push(topLevel);
      report();
    }
    // Directory times/modes are restored after writing their descendants.
    for (const row of [...rows].reverse()) {
      if (!row.createdDirectory) continue;
      await assertAccess();
      const to = await target(row.destinationRelative);
      await io.chmod(to, row.stat.mode & 0o777);
      await io.utimes(to, row.stat.atime, row.stat.mtime);
    }
    return result;
  } catch (cause) {
    Object.assign(cause, { transferResult: result });
    throw cause;
  }
}

function arrayField(value, label, limit) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : null;
  } catch {}
  if (!Array.isArray(parsed) || parsed.length > limit)
    throw failure(400, `Provide a valid ${label} list.`);
  return parsed;
}

const unchangedContent = (current, expected) =>
  unchangedFile(current, expected) && current.ctimeMs === expected.ctimeMs;

async function fileDigest(io, target, expected, assertRead) {
  const handle = await io.open(
    target,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!unchangedContent(await handle.stat(), expected)) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(expected.size, 1024 * 1024));
    let offset = 0;
    while (offset < expected.size) {
      if (assertRead) await assertRead();
      const length = Math.min(buffer.length, expected.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (!bytesRead) return null;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return unchangedContent(await handle.stat(), expected)
      ? hash.digest("hex")
      : null;
  } finally {
    await handle.close();
  }
}

/** A bounded upload batch. Relative paths preserve folder and empty-folder drops. */
export async function uploadServerFiles({
  serverDir,
  directory = "",
  files,
  fields = {},
  safePath,
  fileSystem = fs,
  onUploaded,
  onSkipped,
  onDirectory,
}) {
  const io = fileSystem;
  directory = normalize(directory, true);
  const resolve = await boundary(serverDir, safePath, io);
  if (!(await io.lstat(await resolve(directory))).isDirectory())
    throw failure(400, "Choose a directory to upload into.");
  const suppliedPaths = arrayField(
    fields.paths,
    "file paths",
    MAX_UPLOAD_FILES_PER_BATCH,
  );
  const suppliedDirectories =
    arrayField(fields.directories, "directories", 1000) ?? [];
  const modified = arrayField(
    fields.modified,
    "modification times",
    MAX_UPLOAD_FILES_PER_BATCH,
  );
  if (files.length > MAX_UPLOAD_FILES_PER_BATCH)
    throw failure(400, "Upload fewer files in one batch.");
  if (
    (suppliedPaths && suppliedPaths.length !== files.length) ||
    (modified && modified.length !== files.length)
  )
    throw failure(
      400,
      "Upload paths and modification times must match the files in this batch.",
    );
  if (
    modified?.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 8.64e15,
    )
  )
    throw failure(400, "Provide valid file modification times.");
  if (!files.length && !suppliedDirectories.length)
    throw failure(400, "Choose files or folders to upload.");
  const names = (suppliedPaths ?? files.map((file) => file.originalname)).map(
    (value) => normalize(value),
  );
  if (new Set(names.map(key)).size !== names.length)
    throw failure(409, "Two uploaded files have the same destination path.");
  const directories = new Set(
    suppliedDirectories.map((value) => normalize(value)),
  );
  for (const relative of [...names, ...directories]) {
    let parent = path.posix.dirname(relative);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  if (directories.size > 10_000)
    throw failure(400, "Upload fewer nested folders in one batch.");
  if (
    [...directories].some((item) =>
      names.some((name) => key(name) === key(item)),
    )
  )
    throw failure(409, "An uploaded file and folder have the same path.");
  const join = (relative) => [directory, relative].filter(Boolean).join("/");
  const skipIdentical = fields.skipIdentical === "true";
  const verified = new Map();
  const existingUpload = async (i) => {
    const relative = join(names[i]);
    const target = await resolve(relative);
    const existing = await statOrNull(io, target);
    if (!existing) return false;
    const conflict = () =>
      failure(409, `“${names[i]}” already exists. Rename it before uploading.`);
    if (!skipIdentical || !existing.isFile() || existing.isSymbolicLink())
      throw conflict();
    const temporary = files[i].path;
    const source = await io.lstat(temporary);
    if (
      !source.isFile() ||
      source.isSymbolicLink() ||
      source.size !== existing.size
    )
      throw conflict();
    const previous = verified.get(i);
    if (
      previous &&
      unchangedContent(existing, previous.existing) &&
      unchangedContent(source, previous.source)
    )
      return true;
    const incoming = await fileDigest(io, temporary, source);
    let destination;
    try {
      destination = await fileDigest(io, target, existing);
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    const current = await statOrNull(io, await resolve(relative));
    if (!current) return false;
    if (
      !incoming ||
      incoming !== destination ||
      !unchangedContent(current, existing) ||
      !unchangedContent(await io.lstat(temporary), source)
    )
      throw conflict();
    verified.set(i, { source, existing });
    return true;
  };
  // Check the full batch before creating anything; writes still use exclusive opens.
  await eachUploadEntry(names, (_, i) => existingUpload(i));
  await eachUploadEntry([...directories], async (relative) => {
    const existing = await statOrNull(io, await resolve(join(relative)));
    if (existing && !existing.isDirectory())
      throw failure(409, `“${relative}” already exists as a file.`);
  });
  let createdDirectories = 0;
  for (const relative of [...directories].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  )) {
    const target = await resolve(join(relative));
    try {
      await io.mkdir(target);
      createdDirectories++;
      onDirectory?.(join(relative));
    } catch (cause) {
      if (
        cause.code !== "EEXIST" ||
        !(await io.lstat(await resolve(join(relative)))).isDirectory()
      )
        throw cause;
    }
  }
  const skipped = new Set();
  const skip = (relative) => {
    skipped.add(relative);
    onSkipped?.(relative);
  };
  // Confirm preflight matches before publication; a disappeared file belongs
  // in the exclusive upload path along with the other missing files.
  await eachUploadEntry([...verified.keys()], async (i) => {
    if (await existingUpload(i)) skip(join(names[i]));
  });
  await eachUploadEntry(files, async (file, i) => {
    const relative = join(names[i]);
    if (skipped.has(relative)) return;
    try {
      await publishUpload(io, file.path, await resolve(relative));
    } catch (cause) {
      if (!skipIdentical || cause.code !== "EEXIST") throw cause;
      if (await existingUpload(i)) return skip(relative);
      // The competing destination disappeared. Publish only if the path is still free.
      await publishUpload(io, file.path, await resolve(relative));
    }
    onUploaded?.(relative);
    if (modified)
      await io.utimes(
        await resolve(relative),
        new Date(modified[i]),
        new Date(modified[i]),
      );
  });
  return {
    uploaded: files.length - skipped.size,
    directories: createdDirectories,
    ...(skipped.size
      ? {
          skippedPaths: names
            .map(join)
            .filter((relative) => skipped.has(relative)),
        }
      : {}),
  };
}
