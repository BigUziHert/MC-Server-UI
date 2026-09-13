import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import yauzl from "yauzl";
import { launchpadError } from "./launchpad-network.mjs";

export function safeInstallPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 500 ||
    /[\\\x00-\x1f\x7f:*?"<>|]/.test(value) ||
    value.startsWith("/")
  )
    throw launchpadError(400, "The package contains an unsafe file path.");
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw launchpadError(400, "The package contains an unsafe file path.");
  return value;
}

// ZIP entries are read lazily and written exclusively inside a fresh private stage.
// Reject every unsafe entry, including ones outside the selected override subtree.
export async function unpackProviderZip(
  archive,
  directory,
  select = (name) => name,
  { signal } = {},
) {
  signal?.throwIfAborted();
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (err, value) => (err ? reject(err) : resolve(value)),
    ),
  );
  const files = [];
  const seen = new Set();
  let count = 0,
    total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const entry = await new Promise((resolve, reject) => {
        const cleanup = () => {
          zip.off("entry", onEntry);
          zip.off("end", onEnd);
          zip.off("error", onError);
        };
        const onEntry = (value) => {
          cleanup();
          resolve(value);
        };
        const onEnd = () => {
          cleanup();
          resolve(null);
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        zip.once("entry", onEntry);
        zip.once("end", onEnd);
        zip.once("error", onError);
        zip.readEntry();
      });
      if (!entry) break;
      if (++count > 10000)
        throw launchpadError(
          400,
          "The archive contains more than 10,000 entries.",
        );
      const name = safeInstallPath(entry.fileName.replace(/\/$/, ""));
      const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (kind && kind !== 0x8000 && kind !== 0x4000)
        throw launchpadError(
          400,
          "Archives containing links or special files cannot be installed.",
        );
      if (entry.generalPurposeBitFlag & 1)
        throw launchpadError(400, "Encrypted archives cannot be installed.");
      if (
        entry.uncompressedSize > 512 * 1024 ** 2 ||
        (total += entry.uncompressedSize) > 4 * 1024 ** 3
      )
        throw launchpadError(
          400,
          "The archive exceeds the supported unpacked size.",
        );
      const selected = select(name);
      if (!selected || entry.fileName.endsWith("/")) continue;
      const relative = safeInstallPath(selected);
      const key = relative.toLowerCase();
      if (seen.has(key))
        throw launchpadError(
          400,
          "The archive contains duplicate or conflicting file paths.",
        );
      seen.add(key);
      const target = path.join(directory, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const stream = await new Promise((resolve, reject) =>
        zip.openReadStream(entry, (err, value) =>
          err ? reject(err) : resolve(value),
        ),
      );
      const handle = await fs.open(target, "wx");
      const hash = createHash("sha512");
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          bytes += chunk.length;
          if (bytes > entry.uncompressedSize)
            throw launchpadError(
              400,
              "The archive has an invalid unpacked size.",
            );
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        if (bytes !== entry.uncompressedSize)
          throw launchpadError(400, "The archive is incomplete.");
        await handle.sync();
      } finally {
        await handle.close();
      }
      files.push({
        path: relative,
        stagedPath: target,
        size: bytes,
        hashes: { sha512: hash.digest("hex") },
      });
    }
    return files;
  } finally {
    zip.close();
  }
}
