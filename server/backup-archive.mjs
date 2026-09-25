import fs, { createWriteStream } from "node:fs";
import io from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { constants, createGzip } from "node:zlib";
import { Header, Pax } from "tar";

const chunkSize = 256 * 1024;
const call = (method, ...args) =>
  new Promise((resolve, reject) =>
    fs[method](...args, (cause, result) =>
      cause ? reject(cause) : resolve(result),
    ),
  );
const cancelled = () =>
  Object.assign(new Error("Backup canceled. No backup was created."), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
const checkSignal = (signal) => {
  if (signal?.aborted) throw signal.reason ?? cancelled();
};
const sameFile = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const changed = (filename) =>
  Object.assign(
    new Error(`The server file changed during backup: ${filename}. Try again.`),
    { status: 409, path: filename },
  );
const canonical = (filename) =>
  process.platform === "win32" ? filename.toLowerCase() : filename;

function* headers(relative, stat) {
  const directory = stat.isDirectory();
  const name = `./${relative.split(path.sep).join("/")}${directory && relative ? "/" : ""}`;
  let mode = ((stat.mode & 0o7777) | 0o600) & ~0o22;
  if (directory) mode |= (mode & 0o444) >> 2;
  const values = {
    path: name,
    type: directory ? "Directory" : "File",
    mode,
    size: directory ? 0 : stat.size,
    mtime: directory ? undefined : stat.mtime,
  };
  const header = new Header(values);
  if (header.encode()) yield new Pax(values).encode();
  yield header.block;
}

export async function createBackupArchive(
  serverDir,
  destination,
  { signal, onProgress } = {},
) {
  const progress = {
    phase: "scanning",
    totalBytes: 0,
    processedBytes: 0,
    totalFiles: 0,
    processedFiles: 0,
    currentFile: null,
    compressedBytes: 0,
  };
  let root = serverDir;
  let output;
  let lastProgress = 0;
  const report = (force = false) => {
    progress.compressedBytes = output?.bytesWritten ?? 0;
    if (force || Date.now() - lastProgress >= 100) {
      lastProgress = Date.now();
      onProgress?.({ ...progress });
    }
  };
  let timer;
  try {
    checkSignal(signal);
    report(true);
    root = await io.realpath(serverDir);
    const rootStat = await io.lstat(serverDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw changed(serverDir);
    const entries = [];
    const checked = async (relative, previous) => {
      const filename = path.join(root, relative);
      const stat = await io.lstat(filename);
      if (
        stat.isSymbolicLink() ||
        (previous && !sameFile(previous, stat)) ||
        canonical(await io.realpath(filename)) !== canonical(filename)
      )
        throw changed(filename);
      return stat;
    };
    const scan = async (relative, stat) => {
      checkSignal(signal);
      const filename = path.join(root, relative);
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() &&
          path.basename(filename).toLowerCase() === "session.lock")
      )
        return;
      await checked(relative, stat);
      entries.push({ relative, stat });
      progress.currentFile = relative || null;
      if (stat.isFile()) {
        progress.totalBytes += stat.size;
        progress.totalFiles++;
      }
      report();
      if (stat.isDirectory())
        for (const name of await io.readdir(filename)) {
          checkSignal(signal);
          const child = path.join(relative, name);
          await scan(child, await io.lstat(path.join(root, child)));
        }
    };
    await scan("", rootStat);
    checkSignal(signal);
    progress.phase = "archiving";
    progress.currentFile = null;
    report(true);

    let sourceStarted = false;
    const sourceFinished = Promise.withResolvers();
    async function* source({ signal: pipelineSignal }) {
      sourceStarted = true;
      try {
        for (const { relative, stat: scanned } of entries) {
          checkSignal(pipelineSignal);
          checkSignal(signal);
          await checked("", rootStat);
          const stat = await checked(relative, scanned);
          const filename = path.join(root, relative);
          if (stat.isDirectory()) {
            yield* headers(relative, stat);
            continue;
          }
          let fd;
          try {
            fd = await call(
              "open",
              filename,
              fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
            );
            const opened = await call("fstat", fd);
            await checked(relative, opened);
            if (!opened.isFile() || !sameFile(stat, opened))
              throw changed(filename);
            progress.totalBytes += opened.size - scanned.size;
            progress.currentFile = relative.split(path.sep).join("/");
            report();
            yield* headers(relative, opened);
            let position = 0;
            while (position < opened.size) {
              checkSignal(pipelineSignal);
              checkSignal(signal);
              const buffer = Buffer.allocUnsafe(
                Math.min(chunkSize, opened.size - position),
              );
              const bytes = await call(
                "read",
                fd,
                buffer,
                0,
                buffer.length,
                position,
              );
              if (!bytes) throw changed(filename);
              position += bytes;
              progress.processedBytes += bytes;
              report();
              checkSignal(pipelineSignal);
              checkSignal(signal);
              yield buffer.subarray(0, bytes);
            }
            if ((await call("fstat", fd)).size !== opened.size)
              throw changed(filename);
            if (opened.size % 512)
              yield Buffer.alloc(512 - (opened.size % 512));
          } catch (cause) {
            if (cause && typeof cause === "object") cause.path ??= filename;
            throw cause;
          } finally {
            if (fd !== undefined) await call("close", fd);
          }
          progress.processedFiles++;
          report();
        }
        progress.phase = "finalizing";
        progress.currentFile = null;
        report(true);
        yield Buffer.alloc(1024);
      } finally {
        sourceFinished.resolve();
      }
    }
    output = createWriteStream(destination, { flags: "wx" });
    timer = setInterval(report, 100);
    timer.unref();
    try {
      // All readers use bounded chunks and close in finally. Node's pipeline
      // handles backpressure and aborts without draining the rest of a file.
      await pipeline(
        source,
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        output,
        { signal },
      );
    } finally {
      // Pipeline may reject while an asynchronous read is still completing.
      if (sourceStarted) await sourceFinished.promise;
    }
    checkSignal(signal);
    report(true);
    return {
      compression: "gzip",
      compressionLevel: constants.Z_BEST_COMPRESSION,
      originalSize: progress.processedBytes,
    };
  } catch (cause) {
    if (signal?.aborted) throw signal.reason ?? cancelled();
    if (["EBUSY", "EACCES", "EPERM"].includes(cause.code)) {
      const relative = cause.path && path.relative(root, cause.path);
      const source =
        relative &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
      const file = source
        ? `read "${relative.replaceAll("\\", "/")}"`
        : "write the backup archive";
      throw Object.assign(
        new Error(
          `Could not ${file}: the file is locked or inaccessible (${cause.code}). ${source ? "Stop the server or close the program using this file, check its permissions, then try again." : "Check the backup folder's permissions and available access, then try again."} No backup was created.`,
          { cause },
        ),
        { status: 409, code: cause.code },
      );
    }
    throw cause;
  } finally {
    clearInterval(timer);
  }
}
