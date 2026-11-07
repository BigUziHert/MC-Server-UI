import fs from "node:fs/promises";
import { constants } from "node:fs";
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

/** Copy or move selected trees without overwriting existing destinations. */
export async function copyServerFiles({
  sourceDir,
  serverDir,
  destinationPath = "",
  paths,
  mode = "copy",
  safePath,
  fileSystem = fs,
  onProgress,
  assertAccess = async () => {},
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
    const walk = async (relative, destinationRelative) => {
      if (rows.length >= 100_000)
        throw failure(
          400,
          "Copy fewer items at a time; this selection contains more than 100,000 entries.",
        );
      await assertAccess();
      const stat = await io.lstat(await source(relative));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw failure(
          400,
          "File copies do not follow symbolic links or special files.",
        );
      rows.push({ relative, destinationRelative, stat });
      if (stat.isFile()) {
        totalFiles++;
        totalBytes += stat.size;
      }
      notify(onProgress, {
        filesProcessed: totalFiles,
        bytesProcessed: totalBytes,
      });
      if (stat.isDirectory()) {
        for (const name of (await io.readdir(await source(relative))).sort())
          await walk(`${relative}/${name}`, `${destinationRelative}/${name}`);
      }
    };
    for (const relative of roots) {
      const destinationRelative = [
        destinationPath,
        path.posix.basename(relative),
      ]
        .filter(Boolean)
        .join("/");
      if (sameServer && inside(relative, destinationRelative))
        throw failure(
          409,
          "A file or folder cannot be copied into itself or one of its subfolders.",
        );
      if (await statOrNull(io, await target(destinationRelative)))
        throw failure(
          409,
          `“${destinationRelative}” already exists. Choose another folder or rename the existing item.`,
        );
      await walk(relative, destinationRelative);
    }
    let bytesProcessed = 0;
    const report = () =>
      notify(onProgress, {
        phase: "copying",
        filesProcessed: result.copiedFiles,
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
          const movedPath = [destinationPath, path.posix.basename(root)]
            .filter(Boolean)
            .join("/");
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
        await io.mkdir(to); // Exclusive: existing folders are never merged by Paste.
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
          output = await io.open(await target(row.destinationRelative), "wx");
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
      if (!row.stat.isDirectory()) continue;
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

/** A bounded upload batch. Relative paths preserve folder and empty-folder drops. */
export async function uploadServerFiles({
  serverDir,
  directory = "",
  files,
  fields = {},
  safePath,
  fileSystem = fs,
  onUploaded,
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
  // Check the full batch before creating anything; writes still use exclusive opens.
  await eachUploadEntry(names, async (relative) => {
    if (await statOrNull(io, await resolve(join(relative))))
      throw failure(
        409,
        `“${relative}” already exists. Rename it before uploading.`,
      );
  });
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
  await eachUploadEntry(files, async (file, i) => {
    const relative = join(names[i]);
    await publishUpload(io, file.path, await resolve(relative));
    onUploaded?.(relative);
    if (modified)
      await io.utimes(
        await resolve(relative),
        new Date(modified[i]),
        new Date(modified[i]),
      );
  });
  return { uploaded: files.length, directories: createdDirectories };
}
