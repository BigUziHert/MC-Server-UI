import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import {
  createLaunchpad,
  curseFingerprint,
  providerJson,
} from "./launchpad.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { containedSourcePath } from "./import.mjs";
import { unpackProviderZip, safeInstallPath } from "./launchpad-archives.mjs";
import { downloadVerified } from "./launchpad-network.mjs";

const bytes = (value) => Buffer.from(value);
const safePath = (root, relative = "") =>
  relative ? containedSourcePath(root, relative) : fs.realpath(root);
const hashes = (value) => ({
  sha512: createHash("sha512").update(value).digest("hex"),
  sha1: createHash("sha1").update(value).digest("hex"),
});
const selection = {
  platform: "modrinth",
  type: "mod",
  projectId: "project",
  versionId: "new",
  gameVersion: "1.21.1",
  loader: "neoforge",
};
function zip(entries) {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const [filename, value, mode = 0o100644] of entries) {
    const name = Buffer.from(filename),
      data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const row = Buffer.alloc(46);
    row.writeUInt32LE(0x02014b50);
    row.writeUInt16LE(0x314, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt32LE(crc32(data), 16);
    row.writeUInt32LE(data.length, 20);
    row.writeUInt32LE(data.length, 24);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt32LE((mode << 16) >>> 0, 38);
    row.writeUInt32LE(offset, 42);
    chunks.push(local, name, data);
    central.push(row, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
async function fixture(t, options = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-launchpad-test-")),
  );
  const serverDir = path.join(root, "minecraft"),
    dataDir = path.join(root, "panel");
  await fs.mkdir(serverDir);
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(serverDir, "mods"));
  const old = bytes("existing server mod"),
    newer = bytes("verified compatible new server mod"),
    dependency = bytes("required dependency");
  await fs.writeFile(path.join(serverDir, "mods", "old.jar"), old);
  const bin = await createRecycleBin({ dataDir, serverDir, safePath });
  const downloads = new Map([
    ["https://cdn.modrinth.com/new.jar", newer],
    ["https://cdn.modrinth.com/dep.jar", dependency],
  ]);
  const versions = {
    old: {
      id: "old",
      project_id: "project",
      name: "Existing version",
      version_number: "1.0",
      game_versions: ["1.21.1"],
      loaders: ["neoforge"],
      date_published: "2026-01-01",
      environment: "server_only",
      files: [
        {
          filename: "old.jar",
          url: "https://cdn.modrinth.com/old.jar",
          size: old.length,
          hashes: hashes(old),
          primary: true,
        },
      ],
    },
    new: {
      id: "new",
      project_id: "project",
      name: "New version",
      version_number: "2.0",
      game_versions: ["1.21.1"],
      loaders: ["neoforge"],
      date_published: "2026-02-01",
      environment: "server_only",
      files: [
        {
          filename: "new.jar",
          url: "https://cdn.modrinth.com/new.jar",
          size: newer.length,
          hashes: hashes(newer),
          primary: true,
        },
      ],
    },
    dep: {
      id: "dep",
      project_id: "dependency",
      name: "Dependency",
      version_number: "1.0",
      game_versions: ["1.21.1"],
      loaders: ["neoforge"],
      date_published: "2026-02-01",
      environment: "server_only",
      files: [
        {
          filename: "dep.jar",
          url: "https://cdn.modrinth.com/dep.jar",
          size: dependency.length,
          hashes: hashes(dependency),
          primary: true,
        },
      ],
    },
  };
  let server = {
      status: "offline",
      mode: "live",
      gameVersion: "1.21.1",
      loader: "neoforge",
      world: "Survival",
    },
    settings = {},
    mutations = 0;
  const requests = [];
  const request = async (url, init = {}) => {
    requests.push({ url: String(url), ...init });
    const address = new URL(url);
    if (downloads.has(String(url)))
      return new Response(downloads.get(String(url)));
    if (options.request) {
      const custom = await options.request(url, init);
      if (custom) return custom;
    }
    if (address.pathname === "/v2/tag/game_version")
      return Response.json([{ version: "1.21.1", version_type: "release" }]);
    if (address.pathname === "/v2/version_files")
      return Response.json({ [hashes(old).sha512]: versions.old });
    if (address.pathname.startsWith("/v2/version/"))
      return Response.json(versions[address.pathname.split("/").at(-1)]);
    if (address.pathname.endsWith("/version"))
      return Response.json(
        address.pathname.includes("dependency")
          ? [versions.dep]
          : [versions.new, versions.old],
      );
    if (address.pathname.startsWith("/v2/project/"))
      return Response.json({
        id: address.pathname.split("/").at(-1),
        title: "Fixture Project",
        project_type: options.type ?? "mod",
        server_side: "required",
      });
    if (address.pathname === "/v2/search")
      return Response.json({
        hits: [
          {
            project_id: "project",
            title: "Fixture Project",
            description: "From a provider fixture",
            downloads: 17,
          },
        ],
        total_hits: 1,
        offset: 0,
        limit: 20,
      });
    throw new Error(`Unexpected provider request ${url}`);
  };
  const services = [];
  const boot = async (overrides = {}) => {
    const service = await createLaunchpad({
      serverDir,
      dataDir,
      safePath,
      getServer: async () => server,
      fetch: request,
      recycle: (value) => bin.recycle(value),
      restore: (id) => bin.restore(id),
      withMinecraftMutation: async (work) => {
        mutations++;
        return work();
      },
      platformConfig: {
        get: async () => settings,
        set: async (value) => {
          settings = value;
        },
      },
      ...overrides,
    });
    services.push(service);
    return service;
  };
  const service = await boot();
  t.after(async () => {
    for (const instance of services) await instance.close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-launchpad-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    serverDir,
    dataDir,
    bin,
    service,
    boot,
    old,
    newer,
    dependency,
    downloads,
    versions,
    requests,
    setServer: (value) => {
      server = { ...server, ...value };
    },
    get mutations() {
      return mutations;
    },
  };
}
async function finish(service, input) {
  const result = await service.install(input);
  return waitForJob(service, result.job.id);
}
async function waitForJob(service, id) {
  for (let at = 0; at < 200; at++) {
    const job = service.job(id).job;
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Fixture install did not complete");
}

for (const fails of [false, true]) {
  test(
    `Launchpad publishes ${fails ? "failed" : "completed"} only after private cleanup releases the active slot`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t);
      const first = await f.service.preview(selection);
      const second = await f.service.preview({
        ...selection,
        projectId: "dependency",
        versionId: "dep",
      });
      if (fails)
        f.downloads.set(
          "https://cdn.modrinth.com/new.jar",
          bytes("corrupt download"),
        );
      let began, release;
      const started = new Promise((resolve) => {
        began = resolve;
      });
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const remove = fs.rm;
      t.mock.method(fs, "rm", async (target, ...options) => {
        if (target === path.join(f.dataDir, "launchpad", first.planId)) {
          began();
          await pending;
        }
        return remove(target, ...options);
      });
      const { job } = await f.service.install({
        planId: first.planId,
        confirmed: true,
      });
      await started;
      try {
        const pendingJob = f.service.job(job.id).job;
        assert.equal(pendingJob.status, "running");
        assert.equal(pendingJob.finishedAt, undefined);
        assert.equal(pendingJob.error, undefined);
        await assert.rejects(
          f.service.install({ planId: second.planId, confirmed: true }),
          /already running/,
        );
      } finally {
        release();
      }
      const completed = await waitForJob(f.service, job.id);
      assert.equal(completed.status, fails ? "failed" : "completed");
      assert.ok(completed.finishedAt);
      if (fails) assert.match(completed.error, /checksum|size/);
      assert.equal(
        (await finish(f.service, { planId: second.planId, confirmed: true }))
          .status,
        "completed",
      );
    },
  );
}

test("Launchpad hash-identifies installed mods, filters compatibility, confirms exact replacements and preserves originals", async (t) => {
  const f = await fixture(t);
  const catalog = await f.service.search(selection);
  assert.equal(catalog.projects[0].title, "Fixture Project");
  const search = new URL(
    f.requests.find((row) => row.url.includes("/search?")).url,
  );
  assert.match(search.searchParams.get("facets"), /neoforge/);
  assert.match(search.searchParams.get("facets"), /1.21.1/);
  const installed = await f.service.installed(selection);
  assert.equal(installed.items[0].projectId, "project");
  assert.equal(installed.items[0].update.id, "new");
  const plan = await f.service.preview({
    ...selection,
    replacePath: "mods/old.jar",
  });
  assert.deepEqual(
    plan.files.map(({ path, previousPath, action }) => ({
      path,
      previousPath,
      action,
    })),
    [{ path: "mods/new.jar", previousPath: "mods/old.jar", action: "replace" }],
  );
  assert.equal(f.mutations, 0);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
  await assert.rejects(f.service.install({ planId: plan.planId }), {
    status: 400,
  });
  f.setServer({ status: "running" });
  await assert.rejects(
    f.service.install({ planId: plan.planId, confirmed: true }),
    { status: 409 },
  );
  f.setServer({ status: "offline" });
  assert.equal(
    (await finish(f.service, { planId: plan.planId, confirmed: true })).status,
    "completed",
  );
  assert.equal(f.mutations, 1);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "new.jar")),
    f.newer,
  );
  await assert.rejects(fs.stat(path.join(f.serverDir, "mods", "old.jar")), {
    code: "ENOENT",
  });
  const recovered = (await f.bin.list())[0];
  assert.equal(recovered.originalPath, "mods/old.jar");
  assert.deepEqual(
    await fs.readFile(path.join(f.bin.directory, recovered.id, "content")),
    f.old,
  );
  const restarted = await f.boot();
  assert.equal(
    (await restarted.installed(selection)).items[0].versionId,
    "new",
  );
});

test("checksum failures and changed reviewed files never mutate existing server data", async (t) => {
  const f = await fixture(t);
  const plan = await f.service.preview(selection);
  f.downloads.set(
    "https://cdn.modrinth.com/new.jar",
    bytes("corrupt provider content"),
  );
  let job = await finish(f.service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "failed");
  assert.match(job.error, /checksum|size/);
  assert.equal(f.mutations, 0);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
  assert.deepEqual(await f.bin.list(), []);
  f.downloads.set("https://cdn.modrinth.com/new.jar", f.newer);
  const next = await f.service.preview(selection);
  await fs.writeFile(
    path.join(f.serverDir, "mods", "old.jar"),
    "changed since review",
  );
  job = await finish(f.service, { planId: next.planId, confirmed: true });
  assert.equal(job.status, "failed");
  assert.match(job.error, /changed since review/);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar"), "utf8"),
    "changed since review",
  );
});

test("partial promotion failure rolls back only newly installed files and restores replaced originals", async (t) => {
  const f = await fixture(t);
  f.versions.new.dependencies = [
    {
      project_id: "dependency",
      version_id: "dep",
      dependency_type: "required",
    },
  ];
  const plan = await f.service.preview(selection);
  assert.equal(plan.files.length, 2);
  const open = fs.open;
  t.mock.method(fs, "open", async (target, flags, ...rest) => {
    if (target === path.join(f.serverDir, "mods", "dep.jar") && flags === "wx")
      throw Object.assign(new Error("fixture locked destination"), {
        code: "EPERM",
      });
    return open(target, flags, ...rest);
  });
  const job = await finish(f.service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "failed");
  assert.match(job.error, /Previous server files were restored/);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
  await assert.rejects(fs.stat(path.join(f.serverDir, "mods", "new.jar")), {
    code: "ENOENT",
  });
  assert.ok(
    (await f.bin.list()).some((item) => item.originalPath === "mods/new.jar"),
  );
});

test("Modrinth packs install server dependencies and overrides without client files or protected server/world data", async (t) => {
  const f = await fixture(t, { type: "modpack" });
  await fs.mkdir(path.join(f.serverDir, "Survival"));
  await fs.writeFile(
    path.join(f.serverDir, "Survival", "level.dat"),
    "existing world",
  );
  await fs.writeFile(path.join(f.serverDir, "eula.txt"), "eula=false");
  const manifest = {
    formatVersion: 1,
    game: "minecraft",
    name: "Fixture Pack",
    versionId: "2",
    dependencies: { minecraft: "1.21.1", neoforge: "21.1.200" },
    files: [
      {
        path: "mods/server.jar",
        hashes: hashes(f.newer),
        downloads: ["https://cdn.modrinth.com/new.jar"],
        fileSize: f.newer.length,
        env: { server: "required", client: "optional" },
      },
      {
        path: "mods/client.jar",
        hashes: hashes(f.dependency),
        downloads: ["https://cdn.modrinth.com/dep.jar"],
        fileSize: f.dependency.length,
        env: { server: "unsupported", client: "required" },
      },
    ],
  };
  const archive = zip([
    ["modrinth.index.json", JSON.stringify(manifest)],
    ["overrides/config/common.cfg", "common"],
    ["server-overrides/config/common.cfg", "server override"],
    ["client-overrides/mods/client-extra.jar", "client only"],
    ["overrides/Survival/level.dat", "wrong world"],
    ["overrides/eula.txt", "eula=true"],
  ]);
  f.downloads.set("https://cdn.modrinth.com/pack.mrpack", archive);
  f.versions.new.files = [
    {
      filename: "pack.mrpack",
      url: "https://cdn.modrinth.com/pack.mrpack",
      hashes: hashes(archive),
      size: archive.length,
      primary: true,
    },
  ];
  const plan = await f.service.preview({ ...selection, type: "modpack" });
  assert.deepEqual(plan.files.map((file) => file.path).sort(), [
    "config/common.cfg",
    "mods/server.jar",
  ]);
  assert.match(plan.warnings.join(" "), /client-only/);
  assert.equal(
    (await finish(f.service, { planId: plan.planId, confirmed: true })).status,
    "completed",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "config", "common.cfg"), "utf8"),
    "server override",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "Survival", "level.dat"), "utf8"),
    "existing world",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "eula.txt"), "utf8"),
    "eula=false",
  );
  assert.equal(
    (await f.service.installed({ ...selection, type: "modpack" })).items[0]
      .versionId,
    "new",
  );
});

test("ZIP traversal, Windows aliases, links and duplicate entries are rejected inside private staging", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "../escape",
    "/absolute",
    "C:/file",
    "folder\\file",
    "safe/../../escape",
    "AUX.txt",
    "folder/file:stream",
    "folder/end.",
  ])
    assert.throws(() => safeInstallPath(name), { status: 400 });
  for (const entries of [
    [["../escape", "bad"]],
    [["link", "destination", 0o120777]],
    [
      ["same.txt", "one"],
      ["SAME.txt", "two"],
    ],
  ]) {
    const archive = path.join(f.root, `archive-${Math.random()}.zip`),
      stage = path.join(f.root, `stage-${Math.random()}`);
    await fs.writeFile(archive, zip(entries));
    await fs.mkdir(stage);
    await assert.rejects(unpackProviderZip(archive, stage));
  }
  await assert.rejects(fs.stat(path.join(f.root, "escape")), {
    code: "ENOENT",
  });
});

test("provider redirects cannot escape download hosts or leak API keys and keys never appear in safe configuration", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    downloadVerified(
      { url: "https://evil.example/file.jar", hashes: hashes(f.newer) },
      path.join(f.root, "unsafe"),
      ["cdn.modrinth.com"],
      () => assert.fail("Must not contact an arbitrary host"),
    ),
    { status: 400 },
  );
  let calls = 0;
  await assert.rejects(
    providerJson("https://api.curseforge.com/v1/mods", {
      headers: { "x-api-key": "private-fixture-key" },
      fetch: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.modrinth.com/v2/project/test" },
        });
      },
    }),
    /authenticated request/,
  );
  assert.equal(calls, 1);
  const config = await f.service.settings({
    curseforgeApiKey: "private-fixture-key",
  });
  assert.equal(
    config.platforms.find((row) => row.id === "curseforge").keyConfigured,
    true,
  );
  assert.ok(!JSON.stringify(config).includes("private-fixture-key"));
});

test("plans and jobs are server-scoped and the configured runtime must match install selections", async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  const plan = await first.service.preview(selection);
  await assert.rejects(
    second.service.install({ planId: plan.planId, confirmed: true }),
    { status: 409 },
  );
  assert.throws(() => second.service.job("other-job"), { status: 404 });
  await assert.rejects(
    first.service.preview({ ...selection, loader: "fabric" }),
    /uses neoforge/,
  );
  await assert.rejects(
    first.service.preview({ ...selection, gameVersion: "1.20.1" }),
    /uses Minecraft/,
  );
  assert.equal(
    curseFingerprint(bytes("a b\r\nc\td")),
    curseFingerprint(bytes("abcd")),
  );
});

test("CurseForge packs require author server packs and honor restricted downloads", async (t) => {
  let file = {
    id: 22,
    modId: 11,
    displayName: "Client pack",
    gameVersions: ["1.21.1", "NeoForge"],
    isAvailable: true,
    downloadUrl: "https://edge.forgecdn.net/client.zip",
    hashes: [{ algo: 1, value: "a".repeat(40) }],
  };
  const f = await fixture(t, {
    request: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/v1/categories")
        return Response.json({
          data: [{ id: 4471, slug: "modpacks", name: "Modpacks" }],
        });
      if (pathname === "/v1/mods/11")
        return Response.json({
          data: { id: 11, gameId: 432, classId: 4471, name: "Author pack" },
        });
      if (pathname === "/v1/mods/11/files/22")
        return Response.json({ data: file });
    },
  });
  await f.service.settings({ curseforgeApiKey: "fixture-key" });
  const input = {
    ...selection,
    platform: "curseforge",
    type: "modpack",
    projectId: "11",
    versionId: "22",
  };
  await assert.rejects(
    f.service.preview(input),
    /no author-provided server pack/,
  );
  file = { ...file, isServerPack: true, downloadUrl: null };
  await assert.rejects(
    f.service.preview(input),
    /restricts automated downloads/,
  );
});

test("existing CurseForge-only mods require matching fingerprints and SHA-1 before offering compatible updates", async (t) => {
  let fingerprint,
    sha1,
    wrongHash = false;
  const f = await fixture(t, {
    request: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/v2/version_files") return Response.json({});
      if (pathname === "/v1/fingerprints/432") {
        assert.deepEqual(JSON.parse(init.body).fingerprints, [fingerprint]);
        return Response.json({
          data: {
            exactMatches: [
              {
                id: 11,
                file: {
                  modId: 11,
                  id: 21,
                  displayName: "Installed CurseForge mod",
                  fileFingerprint: fingerprint,
                  hashes: [
                    { algo: 1, value: wrongHash ? "0".repeat(40) : sha1 },
                  ],
                },
              },
            ],
          },
        });
      }
      if (pathname === "/v1/mods/11/files")
        return Response.json({
          data: [
            {
              id: 22,
              displayName: "Compatible update",
              gameVersions: ["1.21.1", "NeoForge"],
              fileDate: "2026-02-01",
              downloadUrl: "https://edge.forgecdn.net/new.jar",
            },
            {
              id: 23,
              displayName: "Wrong loader",
              gameVersions: ["1.21.1", "Fabric"],
              fileDate: "2026-03-01",
              downloadUrl: "https://edge.forgecdn.net/fabric.jar",
            },
            {
              id: 21,
              displayName: "Installed CurseForge mod",
              gameVersions: ["1.21.1", "NeoForge"],
              fileDate: "2026-01-01",
              downloadUrl: "https://edge.forgecdn.net/old.jar",
            },
          ],
        });
    },
  });
  fingerprint = curseFingerprint(f.old);
  sha1 = hashes(f.old).sha1;
  await f.service.settings({ curseforgeApiKey: "fixture-key" });
  let result = await f.service.installed(selection);
  assert.equal(result.items[0].platform, "curseforge");
  assert.equal(result.items[0].projectId, "11");
  assert.equal(result.items[0].versionId, "21");
  assert.equal(result.items[0].update.id, "22");
  wrongHash = true;
  result = await f.service.installed(selection);
  assert.equal(result.items[0].platform, null);
  assert.equal(result.items[0].update, undefined);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
});

test("CurseForge pagination supports 100 rows without skipping its 50-row API pages", async (t) => {
  const pages = [];
  const f = await fixture(t, {
    request: async (url) => {
      const address = new URL(url);
      if (address.pathname === "/v1/categories")
        return Response.json({
          data: [{ id: 6, slug: "mc-mods", name: "Mods" }],
        });
      if (address.pathname === "/v1/mods/search") {
        const start = Number(address.searchParams.get("index")),
          count = Number(address.searchParams.get("pageSize"));
        assert.ok(count <= 50);
        pages.push(start);
        return Response.json({
          data: Array.from({ length: count }, (_, index) => ({
            id: start + index,
            name: `Mod ${start + index}`,
          })),
          pagination: { totalCount: 250 },
        });
      }
    },
  });
  await f.service.settings({ curseforgeApiKey: "fixture-key" });
  const result = await f.service.search({
    ...selection,
    platform: "curseforge",
    offset: 100,
    limit: 100,
  });
  assert.deepEqual(pages, [100, 150]);
  assert.equal(result.projects.length, 100);
  assert.equal(result.projects[0].id, "100");
  assert.equal(result.projects.at(-1).id, "199");
  assert.equal(result.limit, 100);
});

test("direct pack files merge with server ZIP overrides and preserve worlds, EULA, RAM and existing startup files", async (t) => {
  const f = await fixture(t);
  const archive = zip([
    ["config/pack.cfg", "pack configuration"],
    ["Survival/level.dat", "must not replace world"],
    ["user_jvm_args.txt", "-Xmx12G"],
    ["custom-start.cmd", "replacement launcher"],
    ["run.bat", "replacement run script"],
    ["start.sh", "new pack start script"],
  ]);
  f.downloads.set("https://cdn.modrinth.com/configs.zip", archive);
  const extra = {
    id: "fixturepack",
    name: "Fixture Pack Provider",
    types: ["modpack"],
    available: true,
    downloadHosts: ["cdn.modrinth.com"],
    resolve: async () => ({
      title: "Combined pack",
      versionName: "1.0",
      files: [
        {
          path: "mods/server.jar",
          url: "https://cdn.modrinth.com/new.jar",
          size: f.newer.length,
          hashes: hashes(f.newer),
        },
        {
          path: "eula.txt",
          url: "https://cdn.modrinth.com/dep.jar",
          size: f.dependency.length,
          hashes: hashes(f.dependency),
        },
      ],
      archive: {
        format: "server-zip",
        url: "https://cdn.modrinth.com/configs.zip",
        size: archive.length,
        hashes: hashes(archive),
      },
    }),
  };
  const service = await f.boot({ extraProviders: [extra] });
  await fs.mkdir(path.join(f.serverDir, "Survival"));
  await fs.writeFile(
    path.join(f.serverDir, "Survival", "level.dat"),
    "original world",
  );
  await fs.writeFile(path.join(f.serverDir, "eula.txt"), "eula=false");
  f.setServer({ launchScript: "custom-start.cmd" });
  const preserved = {
    "user_jvm_args.txt": "# My RAM settings\n-Xms2G\n-Xmx6G\n",
    "custom-start.cmd":
      "@echo off\r\njava @user_jvm_args.txt @custom_args.txt\r\n",
    "run.bat": "original run script",
  };
  for (const [name, content] of Object.entries(preserved))
    await fs.writeFile(path.join(f.serverDir, name), content);
  const plan = await service.preview({
    ...selection,
    platform: "fixturepack",
    type: "modpack",
  });
  assert.deepEqual(plan.files.map((file) => file.path).sort(), [
    "config/pack.cfg",
    "mods/server.jar",
    "start.sh",
  ]);
  for (const name of Object.keys(preserved))
    assert.ok(plan.warnings.some((warning) => warning.includes(name)));
  assert.equal(
    (await finish(service, { planId: plan.planId, confirmed: true })).status,
    "completed",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "Survival", "level.dat"), "utf8"),
    "original world",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "eula.txt"), "utf8"),
    "eula=false",
  );
  for (const [name, content] of Object.entries(preserved))
    assert.equal(
      await fs.readFile(path.join(f.serverDir, name), "utf8"),
      content,
    );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "start.sh"), "utf8"),
    "new pack start script",
  );
});

test("pack review rejects a known different loader build and client-only required dependencies", async (t) => {
  const f = await fixture(t);
  const service = await f.boot({
    extraProviders: [
      {
        id: "fixturepack",
        name: "Fixture",
        types: ["modpack"],
        available: true,
        downloadHosts: ["cdn.modrinth.com"],
        resolve: async () => ({
          title: "Pinned pack",
          versionName: "1",
          loaderInstall: {
            loader: "neoforge",
            gameVersion: "1.21.1",
            loaderVersion: "21.1.200",
          },
          files: [
            {
              path: "mods/server.jar",
              url: "https://cdn.modrinth.com/new.jar",
              size: f.newer.length,
              hashes: hashes(f.newer),
            },
          ],
        }),
      },
    ],
  });
  f.setServer({ loaderVersion: "21.1.199" });
  await assert.rejects(
    service.preview({ ...selection, platform: "fixturepack", type: "modpack" }),
    /requires neoforge 21.1.200/,
  );
  f.versions.new.dependencies = [
    {
      project_id: "dependency",
      version_id: "dep",
      dependency_type: "required",
    },
  ];
  f.versions.dep.environment = "client_only";
  await assert.rejects(f.service.preview(selection), /intended for clients/);
  assert.equal(f.mutations, 0);
});

test("mod and plugin catalogs cannot cross-install into the wrong server folders", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.search({ ...selection, loader: "paper" }),
    /Use the Plugins tab/,
  );
  await assert.rejects(
    f.service.preview({ ...selection, loader: "paper" }),
    /Use the Plugins tab/,
  );
  await assert.rejects(
    f.service.preview({ ...selection, type: "plugin", loader: "neoforge" }),
    /Use the Mods tab/,
  );
  assert.equal(f.mutations, 0);
});

test("pack archives accept bounded large downloads while individual files keep the smaller cap", async () => {
  const file = {
    url: "https://cdn.modrinth.com/pack.zip",
    hashes: hashes(bytes("fixture")),
    size: 729602057,
  };
  let requests = 0;
  const request = async () => {
    requests++;
    throw new Error("Accepted bounded archive request");
  };
  await assert.rejects(
    downloadVerified(file, "unused", ["cdn.modrinth.com"], request),
    /512 MB per-file/,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    downloadVerified(
      { ...file, archive: true },
      "unused",
      ["cdn.modrinth.com"],
      request,
    ),
    /Accepted bounded archive/,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    downloadVerified(
      { ...file, archive: true, size: 2 * 1024 ** 3 + 1 },
      "unused",
      ["cdn.modrinth.com"],
      request,
    ),
    /2 GB archive/,
  );
  assert.equal(requests, 1);
});

test(
  "closing cancels an active download promptly without promoting or losing existing files",
  { timeout: 5000 },
  async (t) => {
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const f = await fixture(t, {
      request: async (url, init) => {
        if (String(url) !== "https://cdn.modrinth.com/new.jar") return;
        return new Promise((resolve, reject) => {
          began();
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        });
      },
    });
    const plan = await f.service.preview(selection);
    f.downloads.delete("https://cdn.modrinth.com/new.jar");
    const { job } = await f.service.install({
      planId: plan.planId,
      confirmed: true,
    });
    await started;
    await f.service.close();
    assert.equal(f.service.job(job.id).job.status, "failed");
    assert.match(f.service.job(job.id).job.error, /Launchpad closed/);
    assert.equal(f.mutations, 0);
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods/old.jar")),
      f.old,
    );
    await assert.rejects(fs.stat(path.join(f.serverDir, "mods/new.jar")), {
      code: "ENOENT",
    });
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, "launchpad")), []);
  },
);

test(
  "closing aborts and drains an archive preview before cleaning its private staging folder",
  { timeout: 5000 },
  async (t) => {
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const f = await fixture(t, {
      request: async (url, init) => {
        if (String(url) !== "https://cdn.modrinth.com/pending.zip") return;
        return new Promise((resolve, reject) => {
          began();
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        });
      },
    });
    const service = await f.boot({
      extraProviders: [
        {
          id: "fixturepack",
          name: "Fixture",
          types: ["modpack"],
          available: true,
          downloadHosts: ["cdn.modrinth.com"],
          resolve: async () => ({
            title: "Pending pack",
            versionName: "1",
            files: [],
            archive: {
              format: "server-zip",
              url: "https://cdn.modrinth.com/pending.zip",
              size: 1,
              hashes: hashes(bytes("x")),
            },
          }),
        },
      ],
    });
    const result = service
      .preview({ ...selection, type: "modpack", platform: "fixturepack" })
      .then(
        () => null,
        (cause) => cause,
      );
    await started;
    await service.close();
    assert.match((await result).message, /Launchpad closed/);
    assert.equal(f.mutations, 0);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, "launchpad")), []);
  },
);

test(
  "closing drains a transaction that has already begun promotion without interrupting it",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    let began, release;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const service = await f.boot({
      recycle: async (relative) => {
        if (relative === "mods/old.jar") {
          began();
          await pending;
        }
        return f.bin.recycle(relative);
      },
    });
    const plan = await service.preview(selection);
    const { job } = await service.install({
      planId: plan.planId,
      confirmed: true,
    });
    await started;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await new Promise(setImmediate);
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(service.job(job.id).job.status, "completed");
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods/new.jar")),
      f.newer,
    );
    await assert.rejects(fs.stat(path.join(f.serverDir, "mods/old.jar")), {
      code: "ENOENT",
    });
    assert.equal((await f.bin.list()).length, 1);
  },
);
