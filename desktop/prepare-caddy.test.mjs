import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yazl from "yazl";
import {
  CADDY_RELEASE,
  downloadCaddy,
  extractCaddy,
  prepareCaddy,
  validateRelease,
  verifyArchive,
} from "./prepare-caddy.mjs";

function executable() {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(80, 60);
  bytes.write("PE\0\0", 80);
  bytes.writeUInt16LE(0x8664, 84);
  return bytes;
}
async function archive(
  entries = [
    ["caddy.exe", executable()],
    ["LICENSE", Buffer.from("Original license")],
    ["README.md", Buffer.from("Original README")],
  ],
) {
  const zip = new yazl.ZipFile();
  for (const [name, bytes, options] of entries)
    zip.addBuffer(bytes, name, options);
  const chunks = [];
  zip.outputStream.on("data", (chunk) => chunks.push(chunk));
  const result = new Promise((resolve, reject) => {
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.once("error", reject);
  });
  zip.end();
  return result;
}
const releaseFor = (bytes) => ({
  ...CADDY_RELEASE,
  archiveSize: bytes.length,
  archiveSha256: createHash("sha256").update(bytes).digest("hex"),
});

test("Caddy release is pinned to the official Windows x64 archive", () => {
  validateRelease(CADDY_RELEASE);
  assert.equal(
    CADDY_RELEASE.archiveSha256,
    "1708333f79e274c7697285afe6d592ab39314e0b131e9ec6bea08ad27df62ebf",
  );
  for (const change of [
    { url: "http://github.com/untrusted.zip" },
    { architecture: "arm64" },
    { version: "../../bad" },
    { archiveSha256: "bad" },
    { archiveSize: 100_000_000 },
  ])
    assert.throws(
      () => validateRelease({ ...CADDY_RELEASE, ...change }),
      /Invalid pinned/,
    );
});

test("Caddy archive must match both its pinned size and digest", async () => {
  const bytes = await archive();
  const release = releaseFor(bytes);
  verifyArchive(bytes, release);
  assert.throws(
    () => verifyArchive(Buffer.concat([bytes, Buffer.from("x")]), release),
    /pinned archive/,
  );
  const changed = Buffer.from(bytes);
  changed[0] ^= 1;
  assert.throws(() => verifyArchive(changed, release), /pinned archive/);
});

test("Caddy extraction preserves upstream license and rejects missing or unsafe files", async () => {
  const files = await extractCaddy(await archive());
  assert.equal(files.get("LICENSE").toString(), "Original license");
  for (const entries of [
    [["caddy.exe", executable()]],
    [
      ["nested/caddy.exe", executable()],
      ["LICENSE", Buffer.from("license")],
      ["README.md", Buffer.from("readme")],
    ],
    [
      ["caddy.exe", Buffer.from("Not an executable")],
      ["LICENSE", Buffer.from("license")],
      ["README.md", Buffer.from("readme")],
    ],
    [
      ["caddy.exe", executable(), { mode: 0o120777 }],
      ["LICENSE", Buffer.from("license")],
      ["README.md", Buffer.from("readme")],
    ],
    [
      ["caddy.exe", executable()],
      ["caddy.exe", executable()],
      ["LICENSE", Buffer.from("license")],
      ["README.md", Buffer.from("readme")],
    ],
  ])
    await assert.rejects(
      extractCaddy(await archive(entries)),
      /Unsafe|missing|Windows x64/,
    );
});

test("Caddy download rejects unsafe redirects, oversized bodies, wrong digest, and endless redirects", async () => {
  const bytes = await archive();
  const release = releaseFor(bytes);
  await assert.rejects(
    downloadCaddy(
      release,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://github.com/insecure" },
        }),
    ),
    /outside official/,
  );
  await assert.rejects(
    downloadCaddy(
      release,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/payload" },
        }),
    ),
    /outside official/,
  );
  await assert.rejects(
    downloadCaddy(
      release,
      async () =>
        new Response("small", { headers: { "content-length": "999999999" } }),
    ),
    /too large/,
  );
  await assert.rejects(
    downloadCaddy(release, async () => new Response("bad bytes")),
    /pinned archive/,
  );
  await assert.rejects(
    downloadCaddy(
      release,
      async () =>
        new Response(null, { status: 302, headers: { location: release.url } }),
    ),
    /Too many/,
  );
  const downloaded = await downloadCaddy(release, async (_url, options) => {
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    return new Response(bytes);
  });
  assert.deepEqual(downloaded, bytes);
});

test("Caddy preparation reuses verified archive and replaces tampered executable and notices", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-caddy-prepare-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = await archive();
  const release = releaseFor(bytes);
  let downloads = 0;
  let versions = 0;
  const options = {
    outputDirectory: path.join(root, "caddy"),
    cacheDirectory: path.join(root, "cache"),
    release,
    download: async () => {
      downloads += 1;
      return bytes;
    },
    validateExecutable: async (file, version) => {
      assert.deepEqual(await fs.readFile(file), executable());
      assert.equal(version, release.version);
      versions += 1;
    },
  };
  const manifest = await prepareCaddy(options);
  assert.equal(
    manifest.executableSha256,
    createHash("sha256").update(executable()).digest("hex"),
  );
  await fs.writeFile(
    path.join(options.outputDirectory, "caddy.exe"),
    "old or tampered binary",
  );
  await fs.writeFile(
    path.join(options.outputDirectory, "LICENSE"),
    "missing attribution",
  );
  await prepareCaddy(options);
  assert.equal(downloads, 1);
  assert.equal(versions, 2);
  assert.deepEqual(
    await fs.readFile(path.join(options.outputDirectory, "caddy.exe")),
    executable(),
  );
  assert.equal(
    await fs.readFile(path.join(options.outputDirectory, "LICENSE"), "utf8"),
    "Original license",
  );
  assert.match(
    await fs.readFile(
      path.join(options.outputDirectory, "MC-Panel-NOTICE.txt"),
      "utf8",
    ),
    /Apache License/,
  );
  await fs.writeFile(
    path.join(
      options.cacheDirectory,
      `caddy_${release.version}_windows_amd64.zip`,
    ),
    "tampered archive",
  );
  await assert.rejects(prepareCaddy(options), /pinned archive/);
  assert.equal(
    downloads,
    1,
    "a corrupt pinned cache fails the build instead of masking tampering",
  );
});

test("Caddy preparation never publishes a failed or wrong-version executable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-caddy-version-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = await archive();
  const outputDirectory = path.join(root, "caddy");
  await assert.rejects(
    prepareCaddy({
      outputDirectory,
      cacheDirectory: path.join(root, "cache"),
      release: releaseFor(bytes),
      download: async () => bytes,
      validateExecutable: async () => {
        throw new Error("unexpected version");
      },
    }),
    /unexpected version/,
  );
  await assert.rejects(fs.access(path.join(outputDirectory, "caddy.exe")), {
    code: "ENOENT",
  });
});
