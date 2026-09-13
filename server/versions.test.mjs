import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createVersionsService,
  runVersionInstaller,
  versionProviders,
} from "./versions.mjs";

const jar = Buffer.from("PK\x03\x04fixture JAR; never executed");
const digest = (algorithm, value = jar) =>
  createHash(algorithm).update(value).digest("hex");
const NEO = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const FORGE = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const PAPER = "https://fill.papermc.io/v3/projects";
const XML = (versions) =>
  `<metadata><versioning><versions>${versions.map((version) => `<version>${version}</version>`).join("")}</versions></versioning></metadata>`;

async function fixture(t, records = {}, installer) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-versions-test-"));
  const requests = [];
  const runs = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    const value = records[url];
    if (value === undefined) throw new Error(`Unexpected URL ${url}`);
    if (typeof value === "function") return value(url, options);
    return new Response(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    );
  };
  const service = createVersionsService({
    fetch,
    runInstaller: async (request) => {
      runs.push(request);
      await installer?.(request);
    },
  });
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-versions-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, requests, runs, service, records };
}
function neoRecords(extra = {}) {
  return {
    [`${NEO}/maven-metadata.xml`]: XML([
      "21.1.249",
      "21.1.250",
      "21.1.251-beta",
      "26.1.0.1-beta",
      "26.1.2.108",
      "26.2.0.88",
    ]),
    [`${NEO}/21.1.250/neoforge-21.1.250-installer.jar.sha256`]:
      digest("sha256"),
    [`${NEO}/21.1.250/neoforge-21.1.250-installer.jar`]: jar,
    ...extra,
  };
}
async function generatedForge(
  { cwd },
  family = "net/neoforged/neoforge",
  build = "21.1.250",
) {
  const base = path.join(cwd, "libraries", family, build);
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(
    path.join(base, "win_args.txt"),
    "-Dfixture=true\nnet.fixture.Main\n",
  );
  await fs.writeFile(
    path.join(base, "unix_args.txt"),
    "-Dfixture=true\nnet.fixture.Main\n",
  );
  await fs.writeFile(path.join(base, "server.jar"), jar);
  await fs.writeFile(
    path.join(cwd, "user_jvm_args.txt"),
    "# User chooses heap\n",
  );
  await fs.writeFile(
    path.join(cwd, "run.bat"),
    `java @user_jvm_args.txt @libraries/${family}/${build}/win_args.txt %*\n`,
  );
  await fs.writeFile(
    path.join(cwd, "server.properties"),
    "must-not-be-promoted=true\n",
  );
  await fs.mkdir(path.join(cwd, "world"));
  await fs.writeFile(
    path.join(cwd, "world", "level.dat"),
    "must-not-be-promoted",
  );
  await fs.writeFile(path.join(cwd, "installer.log"), "must-not-be-promoted");
}

test("provider catalog includes all requested software and distinguishes nine verified installers from official-download links", () => {
  assert.equal(versionProviders.length, 18);
  assert.equal(versionProviders.filter((entry) => entry.installable).length, 9);
  assert.equal(
    versionProviders.find((entry) => entry.id === "waterfall").badge,
    "Deprecated",
  );
  assert.equal(
    versionProviders.find((entry) => entry.id === "spigot").installable,
    false,
  );
  assert.ok(
    versionProviders.every((entry) => entry.website.startsWith("https://")),
  );
});

test("NeoForge catalogs map both Minecraft numbering schemes and coalesce cached official requests", async (t) => {
  const f = await fixture(t, neoRecords());
  const [first, second] = await Promise.all([
    f.service.versions("neoforge"),
    f.service.versions("neoforge"),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.versions.map((entry) => entry.id),
    ["26.2", "26.1.2", "26.1", "1.21.1"],
  );
  assert.deepEqual(
    (await f.service.builds("neoforge", "1.21.1")).builds.map((entry) => [
      entry.id,
      entry.stable,
    ]),
    [
      ["21.1.251-beta", false],
      ["21.1.250", true],
      ["21.1.249", true],
    ],
  );
  assert.equal(f.requests.length, 1);
  assert.match(
    f.requests[0].options.headers["User-Agent"],
    /MC-Server-UI.*github/,
  );
});

test("NeoForge verifies its installer before running only in private staging and exports no world or user properties", async (t) => {
  const f = await fixture(t, neoRecords(), generatedForge);
  const progress = [];
  const result = await f.service.stage(
    { provider: "neoforge", version: "1.21.1", build: "21.1.250" },
    {
      stageDir: f.root,
      javaPath: "fixture-java",
      onProgress: (event) => progress.push(event.phase),
    },
  );
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].cwd, path.join(f.root, "server"));
  assert.equal(f.runs[0].javaPath, "fixture-java");
  assert.deepEqual(f.runs[0].args, [
    "-jar",
    path.join(f.root, "installer.jar"),
    "--installServer",
  ]);
  assert.equal(result.stageDir, path.join(f.root, "server"));
  assert.equal(result.configuration.launchType, "java-args");
  assert.equal(result.configuration.software, "NeoForge");
  assert.equal(result.configuration.version, "21.1.250");
  assert.ok(
    result.configuration.launchArgs[1].includes(
      `/21.1.250/${process.platform === "win32" ? "win" : "unix"}_args.txt`,
    ),
  );
  assert.equal(
    result.files.find((entry) => entry.path === "user_jvm_args.txt")
      .preserveExisting,
    true,
  );
  assert.equal(
    result.files.find((entry) => entry.path === "run.bat").preserveExisting,
    true,
  );
  assert.ok(
    !result.files.some((entry) =>
      /world|server.properties|installer/.test(entry.path),
    ),
  );
  assert.deepEqual(progress, ["download", "install", "ready"]);
});

test("unlisted providers, versions, builds and URL-shaped input cannot reach a downloader or installer", async (t) => {
  const f = await fixture(t, neoRecords());
  for (const selection of [
    {
      provider: "https://evil.example/a.jar",
      version: "1.21.1",
      build: "21.1.250",
    },
    { provider: "neoforge", version: "../private", build: "21.1.250" },
    {
      provider: "neoforge",
      version: "1.21.1",
      build: "https://evil.example/a.jar",
    },
    { provider: "neoforge", version: "1.21.1", build: "21.1.999" },
    { provider: "spigot", version: "1.21.1", build: "1" },
  ])
    await assert.rejects(f.service.stage(selection, { stageDir: f.root }), {
      status: 400,
    });
  assert.equal(f.runs.length, 0);
  assert.ok(
    f.requests.every((request) => request.url.endsWith("maven-metadata.xml")),
  );
  assert.deepEqual(await fs.readdir(f.root), []);
});

test("checksum mismatch never executes an installer or publishes server outputs", async (t) => {
  const f = await fixture(
    t,
    neoRecords({
      [`${NEO}/21.1.250/neoforge-21.1.250-installer.jar`]:
        Buffer.from("PKbroken"),
    }),
    generatedForge,
  );
  await assert.rejects(
    f.service.stage(
      { provider: "neoforge", version: "1.21.1", build: "21.1.250" },
      { stageDir: f.root },
    ),
    /checksum verification failed/,
  );
  assert.equal(f.runs.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, "server")), []);
});

test("official-host redirects, oversized metadata and service failures fail closed and failures are not cached", async (t) => {
  const f = await fixture(t, {
    [`${NEO}/maven-metadata.xml`]: () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
  });
  await assert.rejects(
    f.service.versions("neoforge"),
    /approved official hosts/,
  );
  f.records[`${NEO}/maven-metadata.xml`] = () =>
    new Response("small", {
      headers: { "content-length": String(9 * 1024 ** 2) },
    });
  await assert.rejects(
    f.service.versions("neoforge"),
    /exceeds the supported size/,
  );
  f.records[`${NEO}/maven-metadata.xml`] = () =>
    new Response("Unavailable", { status: 503 });
  await assert.rejects(f.service.versions("neoforge"), /HTTP 503/);
  f.records[`${NEO}/maven-metadata.xml`] = XML(["21.1.250"]);
  assert.equal((await f.service.versions("neoforge")).versions.length, 1);
  assert.equal(f.requests.length, 4);
});

test("Paper uses the chosen build's SHA256 artifact and never executes the server while staging", async (t) => {
  const url = "https://fill-data.papermc.io/v1/objects/fixture/paper.jar";
  const f = await fixture(t, {
    [`${PAPER}/paper`]: { versions: { 1.21: ["1.21.1"] } },
    [`${PAPER}/paper/versions/1.21.1/builds`]: [
      {
        id: 12,
        channel: "STABLE",
        time: "2026-01-01T00:00:00Z",
        downloads: {
          "server:default": { url, checksums: { sha256: digest("sha256") } },
        },
      },
    ],
    [url]: jar,
  });
  const result = await f.service.stage(
    { provider: "paper", version: "1.21.1", build: "12" },
    { stageDir: f.root },
  );
  assert.deepEqual(result.files, [{ path: "paper-1.21.1-12.jar" }]);
  assert.equal(result.configuration.jar, "paper-1.21.1-12.jar");
  assert.equal(result.summary.checksumAlgorithm, "sha256");
  assert.equal(f.runs.length, 0);
});

test("Vanilla verifies version metadata and server SHA1 from the official manifest", async (t) => {
  const metadataUrl =
    "https://piston-meta.mojang.com/v1/packages/fixture/1.21.1.json";
  const jarUrl = "https://piston-data.mojang.com/v1/objects/fixture/server.jar";
  const metadata = Buffer.from(
    JSON.stringify({
      javaVersion: { majorVersion: 21 },
      downloads: { server: { url: jarUrl, sha1: digest("sha1") } },
    }),
  );
  const f = await fixture(t, {
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json": {
      versions: [
        {
          id: "1.21.1",
          type: "release",
          url: metadataUrl,
          sha1: digest("sha1", metadata),
        },
      ],
    },
    [metadataUrl]: metadata,
    [jarUrl]: jar,
  });
  assert.equal(
    (await f.service.builds("vanilla", "1.21.1")).builds[0].javaVersion,
    21,
  );
  const result = await f.service.stage(
    { provider: "vanilla", version: "1.21.1", build: "1.21.1" },
    { stageDir: f.root },
  );
  assert.equal(result.summary.checksumAlgorithm, "sha1");
  assert.equal(f.runs.length, 0);
});

test("Forge uses the exact Maven build and checksum and validates generated Java argument files", async (t) => {
  const build = "1.21.1-52.1.0";
  const f = await fixture(
    t,
    {
      [`${FORGE}/maven-metadata.xml`]: XML([build]),
      [`${FORGE}/${build}/forge-${build}-installer.jar.sha1`]: digest("sha1"),
      [`${FORGE}/${build}/forge-${build}-installer.jar`]: jar,
    },
    (request) => generatedForge(request, "net/minecraftforge/forge", build),
  );
  const result = await f.service.stage(
    { provider: "forge", version: "1.21.1", build },
    { stageDir: f.root },
  );
  assert.equal(result.configuration.software, "Forge");
  assert.equal(result.configuration.launchType, "java-args");
  assert.equal(result.summary.checksumAlgorithm, "sha1");
});

for (const provider of ["fabric", "quilt"])
  test(`${provider} pins the selected loader, verifies its installer and promotes software pointers with rollback eligibility`, async (t) => {
    const meta =
      provider === "fabric"
        ? "https://meta.fabricmc.net/v2/versions"
        : "https://meta.quiltmc.org/v3/versions";
    const url =
      provider === "fabric"
        ? "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar"
        : "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar";
    const f = await fixture(
      t,
      {
        [`${meta}/game`]: [{ version: "1.21.1", stable: true }],
        [`${meta}/loader/1.21.1`]: [
          { loader: { version: "0.18.0", stable: true } },
        ],
        [`${meta}/installer`]: [
          {
            version: "1.1.2",
            stable: true,
            url,
            hashes: { sha256: digest("sha256") },
          },
        ],
        [url]: jar,
      },
      async ({ cwd }) => {
        const output = provider === "quilt" ? path.join(cwd, "server") : cwd;
        await fs.writeFile(
          path.join(output, `${provider}-server-launch.jar`),
          jar,
        );
        await fs.writeFile(path.join(output, "server.jar"), jar);
        await fs.writeFile(
          path.join(output, `${provider}-server-launcher.properties`),
          "serverJar=server.jar\n",
        );
      },
    );
    const result = await f.service.stage(
      { provider, version: "1.21.1", build: "0.18.0" },
      { stageDir: f.root },
    );
    assert.ok(f.runs[0].args.includes("0.18.0"));
    assert.equal(result.configuration.jar, `${provider}-server-launch.jar`);
    assert.equal(
      result.files.find((entry) => entry.path.endsWith(".properties"))
        .preserveExisting,
      undefined,
    );
  });

test("installer failure, nonempty staging and symlink output never return a promotion manifest", async (t) => {
  const f = await fixture(t, neoRecords(), async () => {
    throw new Error("fixture installer failure");
  });
  await fs.writeFile(path.join(f.root, "existing.txt"), "preserve");
  await assert.rejects(
    f.service.stage(
      { provider: "neoforge", version: "1.21.1", build: "21.1.250" },
      { stageDir: f.root },
    ),
    /empty private/,
  );
  await fs.unlink(path.join(f.root, "existing.txt"));
  await assert.rejects(
    f.service.stage(
      { provider: "neoforge", version: "1.21.1", build: "21.1.250" },
      { stageDir: f.root },
    ),
    /fixture installer failure/,
  );
  const other = await fixture(t, neoRecords(), async (request) => {
    await generatedForge(request);
    await fs.symlink(
      request.cwd,
      path.join(request.cwd, "unexpected-link"),
      "junction",
    );
  });
  await assert.rejects(
    other.service.stage(
      { provider: "neoforge", version: "1.21.1", build: "21.1.250" },
      { stageDir: other.root },
    ),
    /symbolic link/,
  );
});

test("installer process reports actual success and failure without hiding its exit code", async (t) => {
  const f = await fixture(t);
  const progress = [];
  await runVersionInstaller({
    javaPath: process.execPath,
    args: ["-e", "console.log('fixture completed')"],
    cwd: f.root,
    onProgress: (value) => progress.push(value.message),
  });
  assert.ok(progress.includes("fixture completed"));
  await assert.rejects(
    runVersionInstaller({
      javaPath: process.execPath,
      args: ["-e", "console.error('fixture failure');process.exit(7)"],
      cwd: f.root,
    }),
    /code 7\. fixture failure/,
  );
});

test("cancelling the real benign installer process waits for owned process exit", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let pid;
  await assert.rejects(
    runVersionInstaller({
      javaPath: process.execPath,
      args: ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
      cwd: f.root,
      signal: controller.signal,
      onProgress: ({ message }) => {
        pid = Number(message);
        controller.abort();
      },
    }),
    /cancelled/,
  );
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(
    runVersionInstaller({
      javaPath: "this executable must never start",
      args: [],
      cwd: f.root,
      signal: controller.signal,
    }),
    /cancelled/,
  );
});
