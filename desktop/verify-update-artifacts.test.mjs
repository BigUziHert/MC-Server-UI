import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { verifyUpdateArtifacts } from "./verify-update-artifacts.mjs";

async function fixture(t) {
  const projectDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-update-check-"),
  );
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const releaseDir = path.join(projectDir, "release");
  await fs.mkdir(releaseDir);
  const version = "0.1.3-dev.42.2";
  const filename = `MC-Panel-${version}-Setup-x64.exe`;
  const contents = Buffer.alloc(256 * 1024 + 37, 0x5a);
  const sha512 = createHash("sha512").update(contents).digest("base64");
  const manifest = {
    version,
    files: [{ url: filename, sha512, size: contents.length }],
    path: filename,
    sha512,
  };
  await fs.writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({ version }),
  );
  await fs.writeFile(path.join(releaseDir, filename), contents);
  const writeManifest = () =>
    fs.writeFile(path.join(releaseDir, "dev.yml"), stringify(manifest));
  await writeManifest();
  const updateConfig = {
    provider: "github",
    owner: "BigUziHert",
    repo: "MC-Server-UI",
    channel: "dev",
    updaterCacheDirName: "mc-server-ui-updater",
  };
  const configPath = path.join(
    releaseDir,
    "win-unpacked",
    "resources",
    "app-update.yml",
  );
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const writeUpdateConfig = () =>
    fs.writeFile(configPath, stringify(updateConfig));
  await writeUpdateConfig();
  return {
    projectDir,
    releaseDir,
    version,
    filename,
    contents,
    manifest,
    writeManifest,
    updateConfig,
    configPath,
    writeUpdateConfig,
  };
}

test("update verification matches the stamped version and streamed installer bytes", async (t) => {
  const fixtureData = await fixture(t);
  await fs.writeFile(
    path.join(
      fixtureData.releaseDir,
      `MC-Panel-${fixtureData.version}-Portable-x64.exe`,
    ),
    "portable",
  );
  assert.deepEqual(await verifyUpdateArtifacts(fixtureData), {
    version: fixtureData.version,
    filename: fixtureData.filename,
    size: fixtureData.contents.length,
    sha512: fixtureData.manifest.sha512,
  });
});

test("update verification rejects a stale manifest version", async (t) => {
  const data = await fixture(t);
  data.manifest.version = "0.1.3-dev.41.1";
  await data.writeManifest();
  await assert.rejects(verifyUpdateArtifacts(data), /version does not match/);
});

test("update verification rejects missing and duplicate Setup installers", async (t) => {
  const data = await fixture(t);
  await fs.unlink(path.join(data.releaseDir, data.filename));
  await assert.rejects(
    verifyUpdateArtifacts(data),
    /exactly one Setup installer/,
  );
  await fs.writeFile(path.join(data.releaseDir, data.filename), data.contents);
  await fs.writeFile(
    path.join(data.releaseDir, "MC-Panel-0.1.3-dev.1.1-Setup-x64.exe"),
    "old",
  );
  await assert.rejects(
    verifyUpdateArtifacts(data),
    /exactly one Setup installer/,
  );
});

test("update verification rejects missing, duplicate, portable, and escaping manifest entries", async (t) => {
  const data = await fixture(t);
  const entry = { ...data.manifest.files[0] };
  for (const files of [
    [],
    [entry, entry],
    [{ ...entry, url: "portable.exe" }],
    [{ ...entry, url: `../${data.filename}` }],
  ]) {
    data.manifest.files = files;
    await data.writeManifest();
    await assert.rejects(verifyUpdateArtifacts(data), /reference only/);
  }
  data.manifest.files = [entry];
  data.manifest.path = `https://example.com/${data.filename}`;
  await data.writeManifest();
  await assert.rejects(verifyUpdateArtifacts(data), /reference only/);
});

test("update verification rejects incorrect sizes and hashes, including same-sized tampering", async (t) => {
  const data = await fixture(t);
  data.manifest.files[0].size--;
  await data.writeManifest();
  await assert.rejects(verifyUpdateArtifacts(data), /size does not match/);
  data.manifest.files[0].size = data.contents.length;
  data.manifest.sha512 = "invalid";
  await data.writeManifest();
  await assert.rejects(verifyUpdateArtifacts(data), /SHA-512 values/);
  data.manifest.sha512 = data.manifest.files[0].sha512;
  await data.writeManifest();
  data.contents[0] ^= 0xff;
  await fs.writeFile(path.join(data.releaseDir, data.filename), data.contents);
  await assert.rejects(verifyUpdateArtifacts(data), /SHA-512 does not match/);
});

test("update verification rejects a missing manifest", async (t) => {
  const data = await fixture(t);
  await fs.unlink(path.join(data.releaseDir, "dev.yml"));
  await assert.rejects(verifyUpdateArtifacts(data), { code: "ENOENT" });
});

test("update verification rejects missing and incorrect packaged GitHub update settings", async (t) => {
  const data = await fixture(t);
  for (const key of ["provider", "owner", "repo", "channel"]) {
    const expected = data.updateConfig[key];
    for (const value of [undefined, "unexpected"]) {
      data.updateConfig[key] = value;
      await data.writeUpdateConfig();
      await assert.rejects(
        verifyUpdateArtifacts(data),
        new RegExp(
          `app-update\\.yml must set ${key} to ${expected.replaceAll(".", "\\.")}`,
        ),
      );
    }
    data.updateConfig[key] = expected;
  }
  await fs.unlink(data.configPath);
  await assert.rejects(verifyUpdateArtifacts(data), { code: "ENOENT" });
});
