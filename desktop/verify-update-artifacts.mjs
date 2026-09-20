import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const defaultProjectDir = fileURLToPath(new URL("../", import.meta.url));

export async function verifyUpdateArtifacts({
  projectDir = defaultProjectDir,
  releaseDir = path.join(projectDir, "release"),
} = {}) {
  const fail = (message) => {
    throw new Error(`Invalid update artifacts: ${message}`);
  };
  const pkg = JSON.parse(
    await fs.readFile(path.join(projectDir, "package.json"), "utf8"),
  );
  if (
    typeof pkg.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)
  )
    fail("package.json has no valid release version.");
  const manifest = parse(
    await fs.readFile(path.join(releaseDir, "dev.yml"), "utf8"),
  );
  if (manifest?.version !== pkg.version)
    fail("dev.yml version does not match package.json.");
  const updateConfig = parse(
    await fs.readFile(
      path.join(releaseDir, "win-unpacked", "resources", "app-update.yml"),
      "utf8",
    ),
  );
  for (const [key, expected] of Object.entries({
    provider: "github",
    owner: "BigUziHert",
    repo: "MC-Server-UI",
    channel: "dev",
  })) {
    if (updateConfig?.[key] !== expected)
      fail(`packaged app-update.yml must set ${key} to ${expected}.`);
  }

  const filename = `MC-Panel-${pkg.version}-Setup-x64.exe`;
  const installers = (await fs.readdir(releaseDir)).filter((name) =>
    /^MC-Panel-.+-Setup-x64\.exe$/i.test(name),
  );
  if (installers.length !== 1 || installers[0] !== filename)
    fail(`release must contain exactly one Setup installer: ${filename}.`);
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 1 ||
    manifest.files[0]?.url !== filename ||
    manifest.path !== filename
  )
    fail("dev.yml must reference only the expected Setup installer.");
  const entry = manifest.files[0];
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0)
    fail("the installer size must be a positive byte count.");
  if (
    typeof entry.sha512 !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512) ||
    manifest.sha512 !== entry.sha512
  )
    fail("the manifest SHA-512 values are missing, invalid, or inconsistent.");

  const installerPath = path.join(releaseDir, filename);
  const before = await fs.lstat(installerPath);
  if (!before.isFile() || before.isSymbolicLink())
    fail("the Setup installer must be a regular file.");
  if (before.size !== entry.size)
    fail("the Setup installer size does not match dev.yml.");
  const hash = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(installerPath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  const sha512 = hash.digest("base64");
  const after = await fs.lstat(installerPath);
  if (
    size !== entry.size ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino
  )
    fail("the Setup installer changed during verification.");
  if (sha512 !== entry.sha512)
    fail("the Setup installer SHA-512 does not match dev.yml.");
  return { version: pkg.version, filename, size, sha512 };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await verifyUpdateArtifacts();
    console.log(
      `Verified update ${result.version}: ${result.filename} (${result.size} bytes, SHA-512 matches).`,
    );
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}
