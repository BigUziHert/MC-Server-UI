import fs from "node:fs/promises";
import path from "node:path";

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

/** Copy selected trees without removing source data or overwriting destinations. */
export async function copyServerFiles({
  sourceDir,
  serverDir,
  destinationPath = "",
  paths,
  safePath,
  fileSystem = fs,
  onProgress,
  assertAccess = async () => {},
}) {
  const io = fileSystem;
  const result = { copiedFiles: 0, copiedDirectories: 0, paths: [] };
  try {
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
  const suppliedPaths = arrayField(fields.paths, "file paths", 20);
  const suppliedDirectories =
    arrayField(fields.directories, "directories", 1000) ?? [];
  const modified = arrayField(fields.modified, "modification times", 20);
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
  for (const relative of names)
    if (await statOrNull(io, await resolve(join(relative))))
      throw failure(
        409,
        `“${relative}” already exists. Rename it before uploading.`,
      );
  for (const relative of directories) {
    const existing = await statOrNull(io, await resolve(join(relative)));
    if (existing && !existing.isDirectory())
      throw failure(409, `“${relative}” already exists as a file.`);
  }
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
  for (let i = 0; i < files.length; i++) {
    const relative = join(names[i]);
    await io.copyFile(files[i].path, await resolve(relative), 1);
    onUploaded?.(relative);
    if (modified)
      await io.utimes(
        await resolve(relative),
        new Date(modified[i]),
        new Date(modified[i]),
      );
  }
  return { uploaded: files.length, directories: createdDirectories };
}
