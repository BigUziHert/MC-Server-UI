import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import yauzl from "yauzl";

const directory = path.dirname(fileURLToPath(import.meta.url));
export const CADDY_RELEASE = JSON.parse(
  await fs.readFile(path.join(directory, "caddy-release.json"), "utf8"),
);
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateRelease(release) {
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    release.platform !== "windows" ||
    release.architecture !== "amd64" ||
    release.url !==
      `https://github.com/caddyserver/caddy/releases/download/v${release.version}/caddy_${release.version}_windows_amd64.zip` ||
    !/^[a-f0-9]{64}$/.test(release.archiveSha256) ||
    !Number.isSafeInteger(release.archiveSize) ||
    release.archiveSize < 1 ||
    release.archiveSize > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("Invalid pinned Caddy release manifest.");
  }
}

export function verifyArchive(bytes, release = CADDY_RELEASE) {
  validateRelease(release);
  if (
    bytes.length !== release.archiveSize ||
    sha256(bytes) !== release.archiveSha256
  )
    throw new Error(
      "Caddy download does not match the pinned archive size and SHA-256.",
    );
}

export async function downloadCaddy(
  release = CADDY_RELEASE,
  fetchImpl = fetch,
) {
  validateRelease(release);
  const signal = AbortSignal.timeout(120_000);
  let url = new URL(release.url);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["github.com", "release-assets.githubusercontent.com"].includes(
        url.hostname,
      )
    )
      throw new Error(
        "Caddy download redirected outside official release hosts.",
      );
    const response = await fetchImpl(url, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": "MC-Panel-build" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Caddy release redirect has no location.");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body)
      throw new Error(`Caddy download failed (HTTP ${response.status}).`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_ARCHIVE_BYTES) {
      await response.body.cancel();
      throw new Error("Caddy download is too large.");
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ARCHIVE_BYTES)
        throw new Error("Caddy download is too large.");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    verifyArchive(bytes, release);
    return bytes;
  }
  throw new Error("Too many Caddy release redirects.");
}

export async function extractCaddy(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(error);
        const files = new Map();
        let count = 0;
        let total = 0;
        let failed = false;
        const fail = (cause) => {
          failed = true;
          zip.close();
          reject(cause);
        };
        zip.on("error", fail);
        zip.on("entry", (entry) => {
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (
            ++count > 32 ||
            ![
              "caddy.exe",
              "LICENSE",
              "README.md",
              "AUTHORS",
              "NOTICE",
            ].includes(entry.fileName) ||
            files.has(entry.fileName) ||
            (mode !== 0 && mode !== 0x8000) ||
            entry.generalPurposeBitFlag & 1 ||
            (total += entry.uncompressedSize) > MAX_EXPANDED_BYTES
          )
            return fail(new Error("Unsafe or unexpected Caddy archive entry."));
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            const chunks = [];
            let size = 0;
            stream.on("data", (chunk) => {
              size += chunk.length;
              if (size > entry.uncompressedSize || size > MAX_EXPANDED_BYTES)
                stream.destroy(new Error("Caddy archive entry is too large."));
              else chunks.push(chunk);
            });
            stream.on("error", fail);
            stream.on("end", () => {
              if (failed) return;
              files.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => {
          if (failed) return;
          if (
            !["caddy.exe", "LICENSE", "README.md"].every((name) =>
              files.has(name),
            )
          )
            return reject(
              new Error(
                "Caddy archive is missing the executable, license, or README.",
              ),
            );
          const binary = files.get("caddy.exe");
          const pe = binary.length >= 64 ? binary.readUInt32LE(60) : -1;
          if (
            binary.toString("ascii", 0, 2) !== "MZ" ||
            pe < 0 ||
            pe + 6 > binary.length ||
            binary.toString("ascii", pe, pe + 4) !== "PE\0\0" ||
            binary.readUInt16LE(pe + 4) !== 0x8664
          )
            return reject(
              new Error("Caddy executable is not a Windows x64 PE binary."),
            );
          resolve(files);
        });
        zip.readEntry();
      },
    );
  });
}

export async function validateCaddyExecutable(executable, version) {
  if (process.platform !== "win32") return;
  const { stdout } = await promisify(execFile)(executable, ["version"], {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  if (
    !stdout.trim().startsWith(`v${version} `) &&
    stdout.trim() !== `v${version}`
  )
    throw new Error("Caddy executable reported an unexpected version.");
}

export async function prepareCaddy({
  outputDirectory = path.join(directory, "vendor", "caddy"),
  cacheDirectory = path.join(directory, "vendor", "downloads"),
  release = CADDY_RELEASE,
  download = downloadCaddy,
  validateExecutable = validateCaddyExecutable,
} = {}) {
  validateRelease(release);
  outputDirectory = path.resolve(outputDirectory);
  cacheDirectory = path.resolve(cacheDirectory);
  await fs.mkdir(cacheDirectory, { recursive: true });
  const cachePath = path.join(
    cacheDirectory,
    `caddy_${release.version}_windows_amd64.zip`,
  );
  let bytes;
  try {
    bytes = await fs.readFile(cachePath);
    verifyArchive(bytes, release);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    bytes = await download(release);
    verifyArchive(bytes, release);
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx" });
      await fs.rename(temporary, cachePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  const files = await extractCaddy(bytes);
  const temporaryDirectory = `${outputDirectory}.${randomUUID()}.tmp`;
  await fs.mkdir(temporaryDirectory, { recursive: true });
  try {
    for (const [name, contents] of files)
      await fs.writeFile(path.join(temporaryDirectory, name), contents, {
        flag: "wx",
      });
    await validateExecutable(
      path.join(temporaryDirectory, "caddy.exe"),
      release.version,
    );
    const manifest = {
      ...release,
      executableSha256: sha256(files.get("caddy.exe")),
      files: Object.fromEntries(
        [...files].map(([name, content]) => [name, sha256(content)]),
      ),
    };
    await fs.copyFile(
      path.join(directory, "caddy-NOTICE.txt"),
      path.join(temporaryDirectory, "MC-Panel-NOTICE.txt"),
    );
    await fs.writeFile(
      path.join(temporaryDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    // Every build re-extracts from the verified archive: a stale/tampered cached
    // executable or attribution file can never silently enter a new package.
    await fs.mkdir(outputDirectory, { recursive: true });
    for (const name of [
      ...files.keys(),
      "MC-Panel-NOTICE.txt",
      "manifest.json",
    ])
      await fs.rename(
        path.join(temporaryDirectory, name),
        path.join(outputDirectory, name),
      );
    return manifest;
  } finally {
    const cleanupPath = path.resolve(temporaryDirectory);
    if (
      path.dirname(cleanupPath) !== path.dirname(outputDirectory) ||
      !path
        .basename(cleanupPath)
        .startsWith(`${path.basename(outputDirectory)}.`) ||
      !cleanupPath.endsWith(".tmp")
    )
      throw new Error(
        "Refusing to clean up an unexpected Caddy preparation path.",
      );
    await fs.rm(cleanupPath, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await prepareCaddy();
  console.log(
    `Prepared pinned Caddy ${CADDY_RELEASE.version} Windows x64 with original license and notices.`,
  );
}
