import { createWriteStream } from "node:fs";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { constants, createGzip } from "node:zlib";
import * as tar from "tar";

export async function createBackupArchive(serverDir, destination) {
  let originalSize = 0;
  let stopping = false;
  const archive = tar.c(
    {
      cwd: serverDir,
      portable: true,
      follow: false,
      // Keep just one source file open, including when a read fails.
      jobs: 1,
      filter: (name, stat) => {
        if (stopping) return false;
        if (stat.isSymbolicLink()) return false;
        // Minecraft recreates this runtime lock. Reading it on Windows can
        // fail even after save-off and a successful save-all flush.
        return !(
          stat.isFile() &&
          path.posix.basename(name.replaceAll("\\", "/")).toLowerCase() ===
            "session.lock"
        );
      },
      onWriteEntry: (entry) => {
        if (entry.type === "File") originalSize += entry.stat.size;
        // Errors from fs.read(fd) have no filename. Capture it before tar
        // forwards the error so failures identify the file that needs attention.
        entry.on("error", (cause) => {
          cause.path ??= entry.absolute;
        });
      },
    },
    ["."],
  );
  const gzip = createGzip({ level: constants.Z_BEST_COMPRESSION });
  const archiveFinished = finished(archive, { cleanup: true });
  archiveFinished.catch(() => {});
  archive.on("error", (cause) => gzip.destroy(cause));
  archive.pipe(gzip);
  try {
    // Async compression keeps the panel responsive for large worlds. Pipeline
    // closes the output on failure before the caller removes the partial file.
    await pipeline(gzip, createWriteStream(destination, { flags: "wx" }));
  } catch (cause) {
    // Destroying tar does not close its active input file. Drain that entry
    // while filtering out remaining entries, then let the caller resume saves.
    stopping = true;
    archive.unpipe(gzip);
    archive.resume();
    await archiveFinished.catch(() => {});
    if (["EBUSY", "EACCES", "EPERM"].includes(cause.code)) {
      const relative = cause.path && path.relative(serverDir, cause.path);
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
  }
  return {
    compression: "gzip",
    compressionLevel: constants.Z_BEST_COMPRESSION,
    originalSize,
  };
}
