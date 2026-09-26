import fs from "node:fs/promises";
import path from "node:path";

const fail = (status, message) => Object.assign(new Error(message), { status });

export function createHostDirectoryBrowser({
  platform = process.platform,
  roots = platform === "win32"
    ? Array.from(
        { length: 26 },
        (_, index) => `${String.fromCharCode(65 + index)}:\\`,
      )
    : ["/"],
  maxFolders = 200,
  maxEntries = 2000,
  rootTimeoutMs = 750,
  timeoutMs = 5000,
  maxActive = 2,
  fileSystem = fs,
} = {}) {
  let active = 0;
  const pendingRoots = new Map();
  const accessibleRoot = async (directory) => {
    // Windows filesystem calls cannot be cancelled. Reuse an outstanding drive
    // check so retries never queue another OS call for a disconnected drive.
    if (!pendingRoots.has(directory)) {
      const check = Promise.resolve()
        .then(() => fileSystem.stat(directory))
        .then(
          (stat) => (stat.isDirectory() ? directory : null),
          () => null,
        )
        .finally(() => pendingRoots.delete(directory));
      pendingRoots.set(directory, check);
    }
    let timer;
    try {
      return await Promise.race([
        pendingRoots.get(directory),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), rootTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  async function read(directory, signal) {
    signal.throwIfAborted();
    if (directory === undefined || directory === "") {
      const available = (await Promise.all(roots.map(accessibleRoot))).filter(
        Boolean,
      );
      return {
        directory: null,
        parent: null,
        separator: path.sep,
        folders: available.map((root) => ({ name: root, path: root })),
        truncated: false,
      };
    }
    if (
      typeof directory !== "string" ||
      directory.length > 4096 ||
      !path.isAbsolute(directory) ||
      /[\0\r\n]/.test(directory)
    )
      throw fail(
        400,
        "Enter an absolute folder path on the computer running MC Panel.",
      );
    const resolved = path.resolve(directory);
    try {
      const stat = await fileSystem.lstat(resolved);
      signal.throwIfAborted();
      const canonical = await fileSystem.realpath(resolved);
      signal.throwIfAborted();
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw fail(
          400,
          "Choose an actual folder, not a file, symbolic link, or directory junction.",
        );
      const same =
        process.platform === "win32"
          ? canonical.toLowerCase() === resolved.toLowerCase()
          : canonical === resolved;
      if (!same)
        throw fail(
          400,
          "Choose the folder's actual path without symbolic links or directory junctions.",
        );
      const folders = [];
      let scanned = 0,
        truncated = false;
      const entries = await fileSystem.opendir(canonical);
      if (signal.aborted) {
        await entries.close();
        signal.throwIfAborted();
      }
      for await (const entry of entries) {
        signal.throwIfAborted();
        if (++scanned > maxEntries) {
          truncated = true;
          break;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (folders.length >= maxFolders) {
          truncated = true;
          break;
        }
        folders.push({
          name: entry.name,
          path: path.join(canonical, entry.name),
        });
      }
      folders.sort((first, second) =>
        first.name.localeCompare(second.name, "en", {
          numeric: true,
          sensitivity: "base",
        }),
      );
      signal.throwIfAborted();
      const parent = path.dirname(canonical);
      return {
        directory: canonical,
        parent: parent === canonical ? null : parent,
        separator: path.sep,
        folders,
        truncated,
      };
    } catch (cause) {
      if (["EACCES", "EPERM"].includes(cause.code))
        throw fail(
          403,
          "MC Panel cannot open this folder. Choose another folder or check its permissions.",
        );
      if (["ENOENT", "ENOTDIR"].includes(cause.code))
        throw fail(
          404,
          "This folder is unavailable. Choose an existing parent folder, then enter a new folder name below.",
        );
      throw cause;
    }
  }
  return async function browse(directory, requestSignal) {
    if (active >= maxActive)
      throw fail(
        503,
        "Previous folder lookups are still waiting for a drive. Reconnect the drive and try again shortly.",
      );
    const controller = new AbortController();
    const disconnected = () =>
      controller.abort(
        requestSignal.reason ?? fail(499, "Folder browsing was cancelled."),
      );
    requestSignal?.addEventListener("abort", disconnected, { once: true });
    if (requestSignal?.aborted) disconnected();
    const timer = setTimeout(
      () =>
        controller.abort(
          fail(
            504,
            "This folder or drive is not responding. Reconnect it or choose another location.",
          ),
        ),
      timeoutMs,
    );
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    active++;
    // Keep the slot occupied until the underlying OS work actually finishes,
    // even if the client disconnects or receives the timeout response first.
    const pending = read(directory, controller.signal).finally(() => active--);
    try {
      return await Promise.race([pending, cancelled]);
    } finally {
      clearTimeout(timer);
      requestSignal?.removeEventListener("abort", disconnected);
      controller.signal.removeEventListener("abort", cancel);
    }
  };
}
