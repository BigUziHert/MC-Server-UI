import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const canonical = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;
const sameFile = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
const changed = () =>
  failure(409, "A selected file or folder changed during download. Try again.");

// Validate and scan before sending attachment headers. Only entry metadata is
// retained; file contents are opened lazily and streamed with backpressure.
export async function planFileDownload(root, requested, { safePath, signal }) {
  const paths = Array.isArray(requested) ? requested : [requested];
  if (
    !paths.length ||
    paths.length > 1000 ||
    paths.some((value) => typeof value !== "string")
  )
    throw failure(400, "Choose files or folders to download.");
  root = await fs.realpath(root);
  const rootStat = await fs.lstat(root);
  const selected = [];
  for (const relative of paths) {
    signal?.throwIfAborted();
    const target = await safePath(root, relative);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw failure(400, "Choose regular files or folders to download.");
    if (
      !selected.some((entry) => canonical(entry.target) === canonical(target))
    )
      selected.push({ target, stat });
  }
  const roots = selected.filter(
    (entry) =>
      !selected.some(
        (other) =>
          other !== entry &&
          other.stat.isDirectory() &&
          inside(other.target, entry.target),
      ),
  );
  if (roots.length === 1 && roots[0].stat.isFile())
    return { filename: path.basename(roots[0].target), file: roots[0].target };

  let parent = path.dirname(roots[0].target);
  for (const entry of roots)
    while (!inside(parent, entry.target)) parent = path.dirname(parent);
  const checked = async (target, previous) => {
    signal?.throwIfAborted();
    const currentRoot = await fs.lstat(root);
    const stat = await fs.lstat(target);
    if (
      currentRoot.isSymbolicLink() ||
      !sameFile(rootStat, currentRoot) ||
      stat.isSymbolicLink() ||
      !sameFile(previous, stat) ||
      canonical(await fs.realpath(target)) !== canonical(target)
    )
      throw changed();
    return stat;
  };
  const entries = [];
  const scan = async (target, stat) => {
    signal?.throwIfAborted();
    // Links and devices are also hidden from the File Manager listing.
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      return;
    await checked(target, stat);
    const name = path.relative(parent, target).split(path.sep).join("/");
    // A literal backslash on a Unix host would otherwise become a ZIP separator.
    if (name.includes("\\") || Buffer.byteLength(name) > 65534)
      throw failure(
        400,
        "A selected filename cannot be represented safely in a ZIP download.",
      );
    entries.push({ target, stat, name });
    if (stat.isDirectory())
      for (const name of await fs.readdir(target)) {
        const child = path.join(target, name);
        await scan(child, await fs.lstat(child));
      }
  };
  for (const entry of roots) await scan(entry.target, entry.stat);
  return {
    filename:
      roots.length === 1
        ? `${path.basename(roots[0].target)}.zip`
        : "files.zip",
    entries,
    checked,
  };
}

export async function streamFileArchive(plan, destination, { signal } = {}) {
  signal?.throwIfAborted();
  const zip = new ZipFile();
  let active;
  const fail = (cause) => {
    active?.destroy(cause);
    zip.outputStream.destroy(cause);
  };
  zip.on("error", fail);
  const abort = () => zip.emit("error", signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const completion = pipeline(zip.outputStream, destination);
  // Observe failures immediately, including while entries are being registered.
  completion.catch(() => {});
  try {
    for (const entry of plan.entries) {
      const { target, stat, name } = entry;
      if (stat.isDirectory()) {
        zip.addEmptyDirectory(name, { mtime: stat.mtime, mode: stat.mode });
        continue;
      }
      zip.addReadStreamLazy(
        name,
        { mtime: stat.mtime, mode: stat.mode, size: stat.size },
        (callback) => {
          void (async () => {
            let handle;
            try {
              if (zip.outputStream.destroyed) throw changed();
              await plan.checked(target, stat);
              handle = await fs.open(
                target,
                constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
              );
              const opened = await handle.stat();
              await plan.checked(target, opened);
              if (
                !opened.isFile() ||
                !sameFile(stat, opened) ||
                opened.size !== stat.size ||
                zip.outputStream.destroyed
              )
                throw changed();
              const source = handle.createReadStream({
                autoClose: true,
                ...(stat.size ? { end: stat.size - 1 } : {}),
                signal,
              });
              handle = undefined; // The stream now owns the descriptor.
              active = source;
              source.once("error", (cause) => zip.emit("error", cause));
              source.once("close", () => {
                if (active === source) active = undefined;
              });
              callback(null, source);
            } catch (cause) {
              await handle?.close();
              callback(cause);
            }
          })();
        },
      );
    }
    zip.end();
    await completion;
  } catch (cause) {
    zip.emit("error", cause);
    await completion.catch(() => {});
    throw cause;
  } finally {
    signal?.removeEventListener("abort", abort);
    active?.destroy();
  }
}
