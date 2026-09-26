import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const fail = (status, message) => Object.assign(new Error(message), { status });
const samePath = (first, second) =>
  process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
const contains = (root, target) => {
  const relative = path.relative(root, target);
  return (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};

// Resolve missing children through their nearest existing ancestor. Refuse
// links/junctions so a reviewed path cannot silently target a different drive.
async function location(directory) {
  const missing = [];
  let ancestor = path.resolve(directory);
  while (true) {
    try {
      const stat = await fs.lstat(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw fail(
          400,
          "Choose an actual folder, not a file, symbolic link, or directory junction.",
        );
      const canonical = await fs.realpath(ancestor);
      if (!samePath(canonical, ancestor))
        throw fail(
          400,
          "Choose the folder's actual path without symbolic links or directory junctions.",
        );
      return {
        directory: path.join(canonical, ...missing),
        ancestor,
        exists: !missing.length,
      };
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
      const parent = path.dirname(ancestor);
      if (parent === ancestor)
        throw fail(
          400,
          "The selected drive is unavailable. Connect it before continuing.",
        );
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function inspectInstallationDirectory(
  directory,
  {
    forbiddenDirectories = [],
    requireEmpty = true,
    requireExisting = false,
  } = {},
) {
  if (
    typeof directory !== "string" ||
    !directory.trim() ||
    !path.isAbsolute(directory) ||
    /[\0\r\n]/.test(directory)
  )
    throw fail(
      400,
      "Enter an absolute installation folder path on the computer running MC Panel.",
    );
  const resolved = path.resolve(directory);
  if (samePath(resolved, path.parse(resolved).root))
    throw fail(
      400,
      "Choose a dedicated server folder, not the root of a drive.",
    );
  let target;
  try {
    target = await location(resolved);
    if (requireExisting && !target.exists)
      throw fail(
        409,
        "The installation folder is unavailable. Reconnect its drive or restore the original folder.",
      );
    for (const forbidden of forbiddenDirectories) {
      const actual = await fs.realpath(forbidden).catch((cause) => {
        if (!["ENOENT", "ENOTDIR"].includes(cause.code)) throw cause;
        return path.resolve(forbidden);
      });
      if (
        contains(actual, target.directory) ||
        contains(target.directory, actual)
      )
        throw fail(
          409,
          "This installation folder overlaps panel storage or another server. Choose a separate folder.",
        );
    }
    if (
      requireEmpty &&
      target.exists &&
      (await fs.readdir(target.directory)).length
    )
      throw fail(
        409,
        "Choose an empty installation folder. To use existing server files, choose Import an existing server.",
      );
    await fs.access(target.ancestor, constants.W_OK | constants.R_OK);
  } catch (cause) {
    if (["EACCES", "EPERM"].includes(cause.code))
      throw fail(
        403,
        "MC Panel cannot use this installation folder. Check its read and write permissions.",
      );
    if (cause.code === "ENOTDIR")
      throw fail(
        400,
        "The installation path includes a file. Choose a folder path.",
      );
    throw cause;
  }
  return { directory: target.directory, exists: target.exists };
}

export async function prepareInstallationDirectory(directory, options) {
  const reviewed = await inspectInstallationDirectory(directory, options);
  // Never clear the selected directory, including when creation fails.
  await fs.mkdir(reviewed.directory, { recursive: true });
  return inspectInstallationDirectory(reviewed.directory, {
    ...options,
    requireExisting: true,
  });
}

// Before registry publication, roll back only files this request created and
// whose identity and contents still match. Never delete a user's changed file
// or recursively remove their selected folder.
export async function installationFileTransaction(directory) {
  const original = await fs.stat(directory);
  const written = [];
  return {
    async write(name, content) {
      const target = path.join(directory, name);
      const handle = await fs.open(target, "wx");
      try {
        await handle.writeFile(content);
      } finally {
        try {
          const stat = await handle.stat();
          const bytes = await fs.readFile(target);
          if (bytes.equals(Buffer.from(content).subarray(0, bytes.length)))
            written.push({ target, stat, bytes });
        } finally {
          await handle.close();
        }
      }
    },
    async rollback() {
      await inspectInstallationDirectory(directory, {
        requireEmpty: false,
        requireExisting: true,
      });
      const currentDirectory = await fs.stat(directory);
      if (
        original.dev !== currentDirectory.dev ||
        original.ino !== currentDirectory.ino
      )
        return;
      for (const { target, stat, bytes } of written.reverse()) {
        try {
          const current = await fs.lstat(target);
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.dev !== stat.dev ||
            current.ino !== stat.ino ||
            current.size !== stat.size ||
            current.mtimeMs !== stat.mtimeMs ||
            !(await fs.readFile(target)).equals(bytes)
          )
            continue;
          await fs.unlink(target);
        } catch (cause) {
          if (cause.code !== "ENOENT") throw cause;
        }
      }
    },
  };
}
