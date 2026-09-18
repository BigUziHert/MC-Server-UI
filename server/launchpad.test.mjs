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
import { createCoreProviders } from "./launchpad-providers.mjs";
import { inferPackRuntime } from "./launchpad-pack-runtime.mjs";

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
    if (address.pathname === "/v2/version_files/update")
      return Response.json(
        Object.fromEntries(
          JSON.parse(init.body).hashes.map((hash) => [
            hash,
            hash === hashes(dependency).sha512 ? versions.dep : versions.new,
          ]),
        ),
      );
    if (address.pathname === "/v2/versions")
      return Response.json(
        JSON.parse(address.searchParams.get("ids"))
          .map((id) => versions[id])
          .filter(Boolean),
      );
    if (address.pathname === "/v2/projects")
      return Response.json(
        JSON.parse(address.searchParams.get("ids")).map((id) => ({
          id,
          title: "Fixture Project",
          icon_url: `https://cdn.modrinth.com/data/${id}/icon.png`,
          team: `team-${id}`,
        })),
      );
    if (address.pathname === "/v2/teams")
      return Response.json(
        JSON.parse(address.searchParams.get("ids")).map((team_id) => [
          {
            team_id,
            accepted: true,
            role: "Owner",
            user: { username: "FixtureAuthor" },
          },
        ]),
      );
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
        icon_url: "https://cdn.modrinth.com/data/project/icon.png",
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
      getConfiguration: () => ({
        ...server,
        javaPath: "java",
        memoryLimitMB: 6144,
        port: 25565,
        mode: "live",
      }),
      applyConfiguration: async (value) => {
        server = { ...server, ...value };
      },
      versionsService: {
        builds: async (provider, version) => ({
          provider: { name: provider },
          builds: [
            { id: provider === "forge" ? `${version}-21.1.200` : "21.1.200" },
          ],
        }),
        stage: async (input, { stageDir }) => {
          const output = path.join(stageDir, "server");
          await fs.mkdir(output);
          await fs.writeFile(
            path.join(output, "runtime.jar"),
            "verified runtime",
          );
          return {
            stageDir: output,
            files: [{ path: "runtime.jar" }],
            configuration: {
              jar: "runtime.jar",
              launchType: "jar",
              software: input.provider,
              version: input.build,
            },
            summary: input,
          };
        },
      },
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

test("local inventory needs no provider, reuses unchanged hashes and notices same-size edits with restored mtime", async (t) => {
  const f = await fixture(t);
  const open = fs.open.bind(fs),
    reads = [];
  t.mock.method(fs, "open", async (target, mode, ...rest) => {
    if (mode === "r" && String(target).includes(`${path.sep}mods${path.sep}`))
      reads.push(String(target));
    return open(target, mode, ...rest);
  });
  const first = await f.service.installed({ ...selection, local: true });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].platform, null);
  assert.equal(f.requests.length, 0);
  assert.equal(reads.length, 1);
  await f.service.installed({ ...selection, local: "true" });
  assert.equal(
    reads.length,
    1,
    "the local refresh does not read unchanged JAR bytes again",
  );
  await f.service.installed(selection);
  const known = await f.service.installed({ ...selection, local: true });
  assert.equal(known.items[0].author, "FixtureAuthor");
  assert.equal(known.items[0].update.id, "new");
  assert.equal(reads.length, 1);
  const target = path.join(f.serverDir, "mods", "old.jar"),
    stat = await fs.stat(target);
  await fs.writeFile(target, Buffer.alloc(f.old.length, 120));
  await fs.utimes(target, stat.atime, stat.mtime);
  const changed = await f.service.installed({ ...selection, local: true });
  assert.equal(reads.length, 2);
  assert.equal(changed.items[0].platform, null);
  assert.equal(changed.items[0].update, undefined);
  assert.notEqual(changed.items[0].sha512, first.items[0].sha512);
});

test("updating one mod keeps unrelated results cached and immediately publishes the new local filename", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.serverDir, "mods", "dep.jar"), f.dependency);
  await fs.writeFile(
    path.join(f.dataDir, "launchpad", "installed.json"),
    JSON.stringify([
      {
        path: "mods/dep.jar",
        sha512: hashes(f.dependency).sha512,
        platform: "modrinth",
        projectId: "dependency",
        versionId: "dep",
        title: "Dependency",
        versionName: "1.0",
        type: "mod",
      },
    ]),
  );
  const service = await f.boot();
  await service.installed(selection);
  const batches = () =>
    f.requests.filter(
      ({ url }) => new URL(url).pathname === "/v2/version_files/update",
    );
  assert.equal(batches().length, 1);
  await service.installed(selection);
  assert.equal(
    batches().length,
    1,
    "unchanged compatible update results have a short cache",
  );
  const plan = await service.preview({
    ...selection,
    replacePath: "mods/old.jar",
  });
  assert.equal(
    batches().length,
    1,
    "reviewing an update does not check every installed project's releases",
  );
  assert.equal(
    (await finish(service, { planId: plan.planId, confirmed: true })).status,
    "completed",
  );
  const beforeLocal = f.requests.length;
  const local = await service.installed({ ...selection, local: true });
  assert.equal(f.requests.length, beforeLocal);
  assert.deepEqual(local.items.map(({ path }) => path).sort(), [
    "mods/dep.jar",
    "mods/new.jar",
  ]);
  assert.equal(
    local.items.find(({ path }) => path === "mods/new.jar").versionId,
    "new",
  );
  await service.installed(selection);
  assert.equal(batches().length, 2);
  assert.deepEqual(JSON.parse(batches().at(-1).body).hashes, [
    hashes(f.newer).sha512,
  ]);
  await service.installed({ ...selection, refresh: "true" });
  assert.equal(
    batches().length,
    3,
    "the user's Refresh explicitly checks again",
  );
  assert.equal(JSON.parse(batches().at(-1).body).hashes.length, 2);
});

test("failed or incomplete Modrinth rechecks retain known updates after cache expiry and recover", async (t) => {
  let now = Date.now(),
    failure;
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t, {
    request: async (url) => {
      if (new URL(url).pathname !== "/v2/version_files/update") return;
      if (failure === "404") return new Response(null, { status: 404 });
      if (failure === "missing") return Response.json({});
    },
  });
  const first = await f.service.installed(selection);
  assert.equal(first.items[0].update.id, "new");
  assert.equal(first.items[0].updateCheck, "checked");
  for (const mode of ["404", "missing"]) {
    failure = mode;
    now += 11 * 60_000;
    const next = await f.service.installed(selection);
    assert.equal(next.items[0].update.id, "new", mode);
    assert.equal(next.items[0].updateCheck, "unavailable", mode);
    assert.ok(next.warnings.length > 0 || next.items[0].updateIssue, mode);
    const local = await f.service.installed({ ...selection, local: true });
    assert.equal(
      local.items[0].update.id,
      "new",
      "reopening retains the update",
    );
    assert.equal(local.items[0].updateCheck, "pending");
  }
  failure = undefined;
  now += 60_000;
  const recovered = await f.service.installed({ ...selection, refresh: true });
  assert.equal(recovered.items[0].update.id, "new");
  assert.equal(recovered.items[0].updateCheck, "checked");
  assert.deepEqual(recovered.warnings, []);
});

test("a forced refresh interrupted before update checks cannot reuse a cached up-to-date status", async (t) => {
  const f = await fixture(t, {
    request: async (url) => {
      if (new URL(url).pathname === "/v2/version_files/update")
        return Response.json({ [hashes(f.old).sha512]: f.versions.old });
    },
  });
  const first = await f.service.installed(selection);
  assert.equal(first.items[0].updateCheck, "checked");
  assert.equal(first.items[0].update, undefined);
  const deadline = new AbortController(),
    timeout = AbortSignal.timeout.bind(AbortSignal);
  deadline.abort(new DOMException("Fixture refresh deadline", "TimeoutError"));
  t.mock.method(AbortSignal, "timeout", (duration) =>
    duration === 30000 ? deadline.signal : timeout(duration),
  );
  const refreshed = await f.service.installed({ ...selection, refresh: true });
  assert.equal(refreshed.items[0].updateCheck, "unavailable");
  assert.match(refreshed.warnings.join(" "), /too long/);
});

test("update issues belong only to the affected mod while unidentified files stay neutral", async (t) => {
  const f = await fixture(t);
  f.versions.dep.environment = "client_only";
  await fs.writeFile(path.join(f.serverDir, "mods", "dep.jar"), f.dependency);
  await fs.writeFile(
    path.join(f.serverDir, "mods", "private.jar"),
    "mod outside configured catalogs",
  );
  await fs.writeFile(
    path.join(f.dataDir, "launchpad", "installed.json"),
    JSON.stringify([
      {
        path: "mods/dep.jar",
        sha512: hashes(f.dependency).sha512,
        platform: "modrinth",
        projectId: "dependency",
        versionId: "dep",
        type: "mod",
      },
    ]),
  );
  const service = await f.boot();
  const first = await service.installed(selection);
  const normal = first.items.find((item) => item.path === "mods/old.jar");
  const client = first.items.find((item) => item.path === "mods/dep.jar");
  const unknown = first.items.find((item) => item.path === "mods/private.jar");
  assert.equal(normal.update.id, "new");
  assert.equal(normal.updateCheck, "checked");
  assert.equal(normal.updateIssue, undefined);
  assert.equal(client.updateCheck, "unavailable");
  assert.match(client.updateIssue, /client.only/i);
  assert.equal(unknown.platform, null);
  assert.equal(unknown.update, undefined);
  assert.equal(unknown.updateIssue, undefined);
  assert.deepEqual(
    first.warnings,
    [],
    "per-mod issues and unmatched catalog files do not generate broad warnings",
  );
  f.versions.dep.environment = "client_only_server_optional";
  const recovered = await service.installed({ ...selection, refresh: true });
  const checked = recovered.items.find((item) => item.path === "mods/dep.jar");
  assert.equal(checked.updateCheck, "checked");
  assert.equal(checked.updateIssue, undefined);
  assert.equal(
    checked.update,
    undefined,
    "verified current optional-server release is up to date",
  );
  assert.deepEqual(recovered.warnings, []);
});

test("an unavailable first update check is never reported as up to date", async (t) => {
  const f = await fixture(t, {
    request: async (url) => {
      if (new URL(url).pathname === "/v2/version_files/update")
        return new Response(null, { status: 404 });
    },
  });
  const result = await f.service.installed(selection);
  assert.equal(result.items[0].update, undefined);
  assert.equal(result.items[0].updateCheck, "unavailable");
  assert.ok(result.warnings.length);
});

test("one unreadable package does not hide the remaining installed mods", async (t) => {
  const f = await fixture(t);
  const blocked = path.join(f.serverDir, "mods", "locked.jar");
  await fs.writeFile(blocked, "unreadable fixture");
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (target, ...args) => {
    if (target === blocked)
      throw Object.assign(new Error("File is locked"), { code: "EACCES" });
    return open(target, ...args);
  });
  const local = await f.service.installed({ ...selection, local: true });
  assert.equal(local.items.length, 2);
  assert.match(local.warnings.join(" "), /locked.jar could not be read/);
  assert.equal(f.requests.length, 0);
  const full = await f.service.installed(selection);
  assert.equal(
    full.items.find((item) => item.path === "mods/old.jar").update.id,
    "new",
  );
  assert.equal(
    full.items.find((item) => item.path === "mods/locked.jar").platform,
    null,
  );
  assert.match(full.warnings.join(" "), /locked.jar could not be read/);
});

test("overlapping installed scans share remote work while another local read remains available", async (t) => {
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    request: async (url) => {
      if (new URL(url).pathname === "/v2/version_files/update") {
        started();
        await held;
      }
    },
  });
  const first = f.service.installed(selection);
  await began;
  const second = f.service.installed(selection);
  const local = await f.service.installed({ ...selection, local: true });
  assert.equal(local.items.length, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.items[0].update.id, "new");
  assert.deepEqual(a, b);
  a.items[0].title = "Modified caller copy";
  assert.notEqual(a.items[0].title, b.items[0].title);
  assert.equal(
    f.requests.filter(
      ({ url }) => new URL(url).pathname === "/v2/version_files/update",
    ).length,
    1,
  );
});

test("an unresponsive provider cannot hold installed rows past the overall remote deadline", async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal),
    deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (duration) =>
    duration === 30000 ? deadline.signal : timeout(duration),
  );
  let started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    request: async (url) => {
      if (new URL(url).pathname === "/v2/version_files/update") {
        started();
        return new Promise(() => {}); // Deliberately ignores AbortSignal.
      }
    },
  });
  const pending = f.service.installed(selection);
  await began;
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  const result = await pending;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "Fixture Project");
  assert.match(result.warnings.join(" "), /too long/);
  assert.equal(
    (await f.service.installed({ ...selection, local: true })).items[0].author,
    "FixtureAuthor",
  );
});

test("fallback update checks share six slots across overlapping filters and cache each project", async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.serverDir, "mods", "old.jar"));
  const receipts = [];
  for (let index = 0; index < 14; index++) {
    const name = `mod-${index}.jar`,
      data = bytes(`fixture-${index}`);
    await fs.writeFile(path.join(f.serverDir, "mods", name), data);
    receipts.push({
      path: `mods/${name}`,
      sha512: hashes(data).sha512,
      platform: "fixture",
      projectId: `project-${index}`,
      versionId: "old",
      title: name,
      type: "mod",
    });
  }
  await fs.writeFile(
    path.join(f.dataDir, "launchpad", "installed.json"),
    JSON.stringify(receipts),
  );
  let active = 0,
    peak = 0,
    calls = 0,
    release,
    started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const began = new Promise((resolve) => {
    started = resolve;
  });
  let scans = 0,
    twoScans;
  const bothScanning = new Promise((resolve) => {
    twoScans = resolve;
  });
  const service = await f.boot({
    extraProviders: [
      {
        id: "fixture",
        name: "Fixture",
        types: ["mod"],
        async projectMetadata() {
          if (++scans === 2) twoScans();
          return { projects: [], warnings: [] };
        },
        async versions(input) {
          assert.ok(input.signal instanceof AbortSignal);
          calls++;
          active++;
          peak = Math.max(peak, active);
          if (active === 6) started();
          await held;
          active--;
          return [
            {
              id: "new",
              name: "New",
              version: "2",
              publishedAt: "2026-02-01",
              downloadable: true,
            },
            {
              id: "old",
              name: "Old",
              version: "1",
              publishedAt: "2026-01-01",
              downloadable: true,
            },
          ];
        },
      },
    ],
  });
  const pending = service.installed(selection);
  await began;
  const overlapping = service.installed({
    ...selection,
    gameVersion: "1.21.2",
  });
  await bothScanning;
  await new Promise(setImmediate);
  assert.equal(
    calls,
    6,
    "requests start together but the whole collection is not fired at once",
  );
  release();
  const [result] = await Promise.all([pending, overlapping]);
  assert.equal(peak, 6);
  assert.equal(calls, 28);
  assert.ok(result.items.every((item) => item.update?.id === "new"));
  await service.installed(selection);
  assert.equal(calls, 28);
  await service.installed({ ...selection, refresh: true });
  assert.equal(calls, 42);
});

for (const sameName of [false, true]) {
  test(`preview rejects a file changed after cached identity lookup (${sameName ? "same" : "different"} filename)`, async (t) => {
    const f = await fixture(t);
    if (sameName) f.versions.new.files[0].filename = "old.jar";
    const changed = bytes("a different project's mod");
    let armed = false,
      matches = 0;
    const service = await f.boot({
      safePath: async (root, relative = "") => {
        const result = await safePath(root, relative);
        if (
          armed &&
          root === f.serverDir &&
          relative === (sameName ? "mods/old.jar" : "mods/new.jar")
        ) {
          if (!sameName || ++matches === 2) {
            armed = false;
            await fs.writeFile(
              path.join(f.serverDir, "mods", "old.jar"),
              changed,
            );
          }
        }
        return result;
      },
    });
    await service.installed(selection);
    armed = true;
    await assert.rejects(
      service.preview({ ...selection, replacePath: "mods/old.jar" }),
      /changed after identification/,
    );
    assert.equal(f.mutations, 0);
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
      changed,
    );
  });
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
  assert.equal(installed.items[0].author, "FixtureAuthor");
  assert.equal(installed.items[0].title, "Fixture Project");
  assert.equal(
    installed.items[0].iconUrl,
    "https://cdn.modrinth.com/data/project/icon.png",
  );
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
  const saved = JSON.parse(
    await fs.readFile(
      path.join(f.dataDir, "launchpad", "installed.json"),
      "utf8",
    ),
  );
  assert.equal(
    saved[0].iconUrl,
    "https://cdn.modrinth.com/data/project/icon.png",
  );
  assert.equal(saved[0].author, "FixtureAuthor");
  assert.equal(
    (await restarted.installed(selection)).items[0].versionId,
    "new",
  );
});

test("Launchpad audits only completed mod changes, separates added dependencies, and keeps installations when audit persistence fails", async (t) => {
  const f = await fixture(t);
  const events = [];
  const service = await f.boot({
    audit: async (...event) => {
      events.push(event);
      throw new Error("Fixture audit storage unavailable");
    },
  });
  f.versions.new.dependencies = [
    {
      project_id: "dependency",
      version_id: "dep",
      dependency_type: "required",
    },
  ];
  const plan = await service.preview({
    ...selection,
    replacePath: "mods/old.jar",
  });
  await assert.rejects(service.install({ planId: plan.planId }), {
    status: 400,
  });
  assert.deepEqual(
    events,
    [],
    "a preview and rejected confirmation are not completed changes",
  );
  const job = await finish(service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "completed", job.error);
  assert.deepEqual(events.map(([action]) => action).sort(), [
    "Mod added",
    "Mod updated",
  ]);
  assert.match(
    events.find(([action]) => action === "Mod updated")[1],
    /mods\/new.jar/,
  );
  assert.match(
    events.find(([action]) => action === "Mod added")[1],
    /mods\/dep.jar/,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods/new.jar")),
    f.newer,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods/dep.jar")),
    f.dependency,
  );
});

for (const algorithm of ["sha512", "sha256", "sha1"]) {
  test(`updates skip identical dependencies without downloading or touching them (${algorithm})`, async (t) => {
    const f = await fixture(t);
    f.versions.new.dependencies = [
      {
        project_id: "dependency",
        version_id: "dep",
        dependency_type: "required",
      },
    ];
    f.versions.dep.files[0].hashes = {
      // A weaker conflicting hash must not override the strongest checksum.
      sha1: "0".repeat(40),
      [algorithm]: createHash(algorithm)
        .update(f.dependency)
        .digest("hex")
        .toUpperCase(),
    };
    const dependencyPath = path.join(f.serverDir, "mods", "dep.jar");
    await fs.writeFile(dependencyPath, f.dependency);
    const before = await fs.stat(dependencyPath);
    const plan = await f.service.preview({
      ...selection,
      replacePath: "mods/old.jar",
    });
    assert.equal(plan.unchangedCount, 1);
    assert.deepEqual(
      plan.files.map((file) => file.path),
      ["mods/new.jar"],
    );
    const job = await finish(f.service, {
      planId: plan.planId,
      confirmed: true,
    });
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.total, 1);
    assert.equal(job.completed, 1);
    assert.equal(
      f.requests.filter(({ url }) => url === "https://cdn.modrinth.com/dep.jar")
        .length,
      0,
    );
    assert.deepEqual(await fs.readFile(dependencyPath), f.dependency);
    const after = await fs.stat(dependencyPath);
    for (const field of ["ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"])
      assert.equal(after[field], before[field], field);
    assert.deepEqual(
      (await f.bin.list()).map((item) => item.originalPath),
      ["mods/old.jar"],
    );
  });
}

test("matching version labels do not skip a dependency with different bytes", async (t) => {
  const f = await fixture(t);
  f.versions.new.dependencies = [
    {
      project_id: "dependency",
      version_id: "dep",
      dependency_type: "required",
    },
  ];
  const changed = bytes("different dependency bytes");
  const dependencyPath = path.join(f.serverDir, "mods", "dep.jar");
  await fs.writeFile(dependencyPath, changed);
  await fs.writeFile(
    path.join(f.dataDir, "launchpad", "installed.json"),
    JSON.stringify([
      {
        path: "mods/dep.jar",
        sha512: hashes(changed).sha512,
        platform: "modrinth",
        projectId: "dependency",
        versionId: "dep",
        type: "mod",
      },
    ]),
  );
  const service = await f.boot();
  const plan = await service.preview(selection);
  assert.equal(plan.unchangedCount, 0);
  assert.equal(
    plan.files.find((file) => file.path === "mods/dep.jar").action,
    "replace",
  );
  const job = await finish(service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "completed", job.error);
  assert.equal(
    f.requests.filter(({ url }) => url === "https://cdn.modrinth.com/dep.jar")
      .length,
    1,
  );
  assert.deepEqual(await fs.readFile(dependencyPath), f.dependency);
  assert.deepEqual(
    (await f.bin.list()).map((item) => item.originalPath).sort(),
    ["mods/dep.jar", "mods/old.jar"],
  );
});

for (const change of ["edited", "removed"]) {
  test(`a skipped dependency ${change} after review aborts before any file promotion`, async (t) => {
    const f = await fixture(t);
    f.versions.new.dependencies = [
      {
        project_id: "dependency",
        version_id: "dep",
        dependency_type: "required",
      },
    ];
    const dependencyPath = path.join(f.serverDir, "mods", "dep.jar");
    await fs.writeFile(dependencyPath, f.dependency);
    const plan = await f.service.preview(selection);
    assert.equal(plan.unchangedCount, 1);
    if (change === "edited") {
      const before = await fs.stat(dependencyPath);
      await fs.writeFile(
        dependencyPath,
        bytes("x".repeat(f.dependency.length)),
      );
      await fs.utimes(dependencyPath, before.atime, before.mtime);
    } else await fs.unlink(dependencyPath);
    const job = await finish(f.service, {
      planId: plan.planId,
      confirmed: true,
    });
    assert.equal(job.status, "failed");
    assert.match(job.error, /mods\/dep.jar changed since review/);
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
      f.old,
    );
    await assert.rejects(fs.stat(path.join(f.serverDir, "mods", "new.jar")), {
      code: "ENOENT",
    });
    assert.deepEqual(await f.bin.list(), []);
    assert.equal(
      f.requests.filter(({ url }) => url === "https://cdn.modrinth.com/dep.jar")
        .length,
      0,
    );
  });
}

test("an identical renamed dependency stays in place and its absent destination remains part of review", async (t) => {
  const f = await fixture(t);
  f.versions.new.dependencies = [
    {
      project_id: "dependency",
      version_id: "dep",
      dependency_type: "required",
    },
  ];
  const renamedPath = path.join(f.serverDir, "mods", "my-dependency.jar");
  await fs.writeFile(renamedPath, f.dependency);
  await fs.writeFile(
    path.join(f.dataDir, "launchpad", "installed.json"),
    JSON.stringify([
      {
        path: "mods/my-dependency.jar",
        sha512: hashes(f.dependency).sha512,
        platform: "modrinth",
        projectId: "dependency",
        versionId: "dep",
        type: "mod",
      },
    ]),
  );
  const service = await f.boot();
  const first = await service.preview(selection);
  assert.equal(first.unchangedCount, 1);
  assert.deepEqual(
    first.files.map((file) => file.path),
    ["mods/new.jar"],
  );
  // An external writer must not introduce a duplicate after the review.
  const destination = path.join(f.serverDir, "mods", "dep.jar");
  await fs.writeFile(destination, f.dependency);
  const failed = await finish(service, {
    planId: first.planId,
    confirmed: true,
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /mods\/dep.jar changed since review/);
  assert.deepEqual(await f.bin.list(), []);
  await fs.unlink(destination);
  const plan = await service.preview(selection);
  const before = await fs.stat(renamedPath);
  const job = await finish(service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "completed", job.error);
  assert.equal(plan.unchangedCount, 1);
  assert.equal((await fs.stat(renamedPath)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readFile(renamedPath), f.dependency);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  assert.equal(
    f.requests.filter(({ url }) => url === "https://cdn.modrinth.com/dep.jar")
      .length,
    0,
  );
});

test("an all-up-to-date review has no changes and cannot start an installation", async (t) => {
  const f = await fixture(t);
  let plan;
  for (let count = 0; count < 8; count++) {
    plan = await f.service.preview({
      ...selection,
      versionId: "old",
      replacePath: "mods/old.jar",
    });
    await assert.rejects(
      fs.stat(path.join(f.dataDir, "launchpad", plan.planId)),
      {
        code: "ENOENT",
      },
    );
  }
  assert.deepEqual(plan.files, []);
  assert.equal(plan.unchangedCount, 1);
  await assert.rejects(
    f.service.install({ planId: plan.planId, confirmed: true }),
    {
      status: 409,
      message:
        "All reviewed files are already up to date. No installation is needed.",
    },
  );
  assert.equal(f.mutations, 0);
  assert.equal(
    f.requests.filter(({ url }) => url.startsWith("https://cdn.modrinth.com/"))
      .length,
    0,
  );
  assert.deepEqual(await f.bin.list(), []);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
  // Repeated empty reviews must leave all four real installation slots available.
  for (let count = 0; count < 4; count++)
    assert.equal((await f.service.preview(selection)).files.length, 1);
});

test("installed project icons and titles are available with All loaders and All versions", async (t) => {
  const f = await fixture(t);
  const result = await f.service.installed({
    ...selection,
    gameVersion: "",
    loader: "",
  });
  assert.equal(result.items[0].title, "Fixture Project");
  assert.equal(result.items[0].versionName, "Existing version");
  assert.equal(result.items[0].author, "FixtureAuthor");
  assert.equal(
    result.items[0].iconUrl,
    "https://cdn.modrinth.com/data/project/icon.png",
  );
  assert.equal(result.items[0].update, undefined);
  assert.equal(result.warnings.length, 0);
  assert.equal(
    f.requests.some(({ url }) => new URL(url).pathname.endsWith("/version")),
    false,
  );
  await f.service.installed({ ...selection, gameVersion: "", loader: "" });
  assert.equal(
    f.requests.filter(({ url }) => new URL(url).pathname === "/v2/projects")
      .length,
    1,
  );
});

test("Modrinth authors use accepted owners or sorted accepted contributors and match teams by ID", async () => {
  const requests = [];
  const projects = [
    { id: "one", team: "owned" },
    { id: "two", team: "owned" },
    { id: "three", team: "shared" },
    { id: "four", team: "unaccepted" },
  ];
  const member = (team_id, username, role, accepted = true) => ({
    team_id,
    role,
    accepted,
    user: { username },
  });
  const modrinth = createCoreProviders({
    fetch: async (url) => {
      const address = new URL(url);
      requests.push(address.pathname);
      if (address.pathname === "/v2/projects")
        return Response.json(
          projects.map((project) => ({
            ...project,
            title: project.id,
            icon_url: `https://cdn.modrinth.com/${project.id}.png`,
          })),
        );
      assert.equal(address.pathname, "/v2/teams");
      assert.deepEqual(JSON.parse(address.searchParams.get("ids")), [
        "owned",
        "shared",
        "unaccepted",
      ]);
      return Response.json([
        [
          member("shared", "zulu", "Maintainer"),
          member("shared", "Alpha", "Contributor"),
          member("shared", "Excluded", "Owner", false),
        ],
        [member("unaccepted", "Invited", "Owner", false)],
        [
          member("owned", "Member", "Member"),
          member("owned", "LegacyOwner", "Owner"),
          member("owned", "BlockedOwner", "Owner", false),
        ],
      ]);
    },
  }).find(({ id }) => id === "modrinth");
  const [first, repeated] = await Promise.all([
    modrinth.projectMetadata(["one", "two", "three", "four"]),
    modrinth.projectMetadata(["one", "two", "three", "four"]),
  ]);
  const second = await modrinth.projectMetadata(["two", "three"]);
  assert.deepEqual(first, repeated);
  assert.deepEqual(
    first.projects.map(({ author }) => author),
    ["LegacyOwner", "LegacyOwner", "Alpha, zulu", undefined],
  );
  assert.deepEqual(
    second.projects.map(({ author }) => author),
    ["LegacyOwner", "Alpha, zulu"],
  );
  assert.deepEqual(requests, ["/v2/projects", "/v2/teams"]);
  assert.equal(first.projects[2].iconUrl, "https://cdn.modrinth.com/three.png");
  await modrinth.projectMetadata(["one", "three"]);
  assert.equal(requests.length, 2);
});

test("Modrinth contributor batching is bounded and coalesced for a large installed collection", async () => {
  const requests = [];
  const modrinth = createCoreProviders({
    fetch: async (url, init) => {
      const address = new URL(url);
      const ids = JSON.parse(address.searchParams.get("ids"));
      assert.ok(ids.length <= 100);
      assert.ok(init.signal instanceof AbortSignal);
      requests.push({ path: address.pathname, ids });
      if (address.pathname === "/v2/projects")
        return Response.json(
          ids.map((id) => ({ id, team: `team-${id}`, title: `Project ${id}` })),
        );
      assert.equal(address.pathname, "/v2/teams");
      return Response.json(
        ids.map((team_id) => [
          {
            team_id,
            is_owner: true,
            accepted: true,
            role: "Project Lead",
            user: { username: team_id },
          },
        ]),
      );
    },
  }).find(({ id }) => id === "modrinth");
  const ids = Array.from({ length: 205 }, (_, index) => `project${index}`);
  const [result, subset] = await Promise.all([
    modrinth.projectMetadata(ids),
    modrinth.projectMetadata(ids.slice(0, 120)),
  ]);
  assert.equal(result.projects.length, 205);
  assert.equal(subset.projects.length, 120);
  assert.equal(result.projects[204].author, "team-project204");
  const teams = requests.filter(({ path }) => path === "/v2/teams");
  assert.equal(teams.length, 3);
  assert.equal(teams.flatMap(({ ids }) => ids).length, 205);
  assert.equal(new Set(teams.flatMap(({ ids }) => ids)).size, 205);
});

test("failed contributor lookups preserve titles, icons, updates and saved authors through an update", async (t) => {
  let fail = true,
    now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t, {
    request: async (url) => {
      if (fail && new URL(url).pathname === "/v2/teams")
        return new Response("Unavailable", { status: 503 });
    },
  });
  const receiptPath = path.join(f.dataDir, "launchpad", "installed.json");
  await fs.writeFile(
    receiptPath,
    JSON.stringify([
      {
        path: "mods/old.jar",
        sha512: hashes(f.old).sha512,
        platform: "modrinth",
        projectId: "project",
        versionId: "old",
        title: "Saved title",
        author: "Saved Author",
        type: "mod",
      },
    ]),
  );
  const restarted = await f.boot();
  const installed = await restarted.installed(selection);
  assert.equal(installed.items[0].title, "Fixture Project");
  assert.equal(
    installed.items[0].iconUrl,
    "https://cdn.modrinth.com/data/project/icon.png",
  );
  assert.equal(installed.items[0].author, "Saved Author");
  assert.equal(installed.items[0].update.id, "new");
  assert.match(installed.warnings.join(" "), /contributors/i);
  const plan = await restarted.preview({
    ...selection,
    replacePath: "mods/old.jar",
  });
  assert.equal(
    (await finish(restarted, { planId: plan.planId, confirmed: true })).status,
    "completed",
  );
  const receipts = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assert.equal(receipts[0].author, "Saved Author");
  assert.equal(
    f.requests.filter(({ url }) => new URL(url).pathname === "/v2/teams")
      .length,
    1,
  );
  const cached = await restarted.installed({
    ...selection,
    gameVersion: "",
    loader: "",
  });
  assert.equal(cached.items[0].author, "Saved Author");
  fail = false;
  now += 30_001;
  const recovered = await restarted.installed({
    ...selection,
    gameVersion: "",
    loader: "",
  });
  assert.equal(recovered.items[0].author, "FixtureAuthor");
  assert.equal(
    f.requests.filter(({ url }) => new URL(url).pathname === "/v2/projects")
      .length,
    1,
    "a team retry does not discard cached project icons",
  );
});

test("old mod and modpack receipts are enriched without compatibility filters or filesystem writes", async (t) => {
  const f = await fixture(t, {
    request: async (url, init) => {
      if (new URL(url).pathname !== "/v1/mods") return;
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { modIds: [11] });
      return Response.json({
        data: [
          {
            id: 11,
            gameId: 432,
            name: "CurseForge Project",
            authors: [
              { name: "Creator" },
              { name: "Contributor" },
              { name: "Creator" },
              null,
              { name: " " },
            ],
            logo: {
              thumbnailUrl: "https://media.forgecdn.net/avatars/fixture.png",
            },
          },
        ],
      });
    },
  });
  const receiptPath = path.join(f.dataDir, "launchpad", "installed.json");
  const legacy = [
    {
      path: "mods/old.jar",
      sha512: hashes(f.old).sha512,
      platform: "curseforge",
      projectId: "11",
      versionId: "21",
      title: "Old version label",
      versionName: "1.0",
      type: "mod",
    },
    {
      path: "",
      pack: true,
      platform: "modrinth",
      projectId: "pack",
      versionId: "pack-version",
      title: "Pack version label",
      type: "modpack",
    },
  ];
  await fs.writeFile(receiptPath, JSON.stringify(legacy));
  const restarted = await f.boot();
  await restarted.settings({ curseforgeApiKey: "fixture-key" });
  const mods = await restarted.installed({
    ...selection,
    loader: "",
    gameVersion: "",
  });
  assert.equal(mods.items[0].title, "CurseForge Project");
  assert.equal(mods.items[0].author, "Creator, Contributor");
  assert.equal(
    mods.items[0].iconUrl,
    "https://media.forgecdn.net/avatars/fixture.png",
  );
  const packs = await restarted.installed({
    ...selection,
    type: "modpack",
    loader: "",
    gameVersion: "",
  });
  assert.equal(packs.items[0].title, "Fixture Project");
  assert.equal(packs.items[0].author, "FixtureAuthor");
  assert.equal(packs.items[0].name, "Fixture Project");
  assert.equal(
    packs.items[0].iconUrl,
    "https://cdn.modrinth.com/data/pack/icon.png",
  );
  assert.deepEqual(JSON.parse(await fs.readFile(receiptPath, "utf8")), legacy);
});

test("metadata failures preserve installed files, receipt icons, and compatible update checks with a short retry cache", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t, {
    request: async (url) => {
      if (new URL(url).pathname === "/v2/projects")
        return new Response("Unavailable", { status: 503 });
    },
  });
  const receiptPath = path.join(f.dataDir, "launchpad", "installed.json");
  await fs.writeFile(
    receiptPath,
    JSON.stringify([
      {
        path: "mods/old.jar",
        sha512: hashes(f.old).sha512,
        platform: "modrinth",
        projectId: "project",
        versionId: "old",
        title: "Saved project title",
        iconUrl: "https://cdn.modrinth.com/saved-icon.png",
        type: "mod",
      },
    ]),
  );
  const restarted = await f.boot();
  for (let count = 0; count < 2; count++) {
    const result = await restarted.installed(selection);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "Saved project title");
    assert.equal(
      result.items[0].iconUrl,
      "https://cdn.modrinth.com/saved-icon.png",
    );
    assert.equal(result.items[0].update.id, "new");
    assert.match(result.warnings.join(" "), /Modrinth project details/);
  }
  assert.equal(
    f.requests.filter(({ url }) => new URL(url).pathname === "/v2/projects")
      .length,
    1,
  );
  now += 30_001;
  await restarted.installed(selection);
  assert.equal(
    f.requests.filter(({ url }) => new URL(url).pathname === "/v2/projects")
      .length,
    2,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
});

test("project metadata batching coalesces concurrent overlapping callers and refreshes after its TTL", async (t) => {
  let now = Date.now(),
    release;
  t.mock.method(Date, "now", () => now);
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requests = [];
  const modrinth = createCoreProviders({
    fetch: async (url) => {
      const address = new URL(url);
      assert.equal(address.origin, "https://api.modrinth.com");
      assert.equal(address.pathname, "/v2/projects");
      assert.deepEqual([...address.searchParams.keys()], ["ids"]);
      const ids = JSON.parse(address.searchParams.get("ids"));
      assert.ok(ids.length <= 100);
      requests.push(ids);
      await held;
      return Response.json(
        ids.map((id) => ({
          id,
          title: `Project ${id}`,
          icon_url: `https://cdn.modrinth.com/${id}.png`,
        })),
      );
    },
  }).find(({ id }) => id === "modrinth");
  const first = modrinth.projectMetadata(
    Array.from({ length: 205 }, (_, index) => `p${index}`),
  );
  const second = modrinth.projectMetadata(
    Array.from({ length: 205 }, (_, index) => `p${index + 50}`),
  );
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].projects.length, 205);
  assert.equal(results[1].projects.length, 205);
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests.flat()).size, 255);
  assert.equal(requests.flat().length, 255, "overlapping IDs are fetched once");
  await modrinth.projectMetadata(["p0", "p254"]);
  assert.equal(requests.length, 4);
  now += 10 * 60_000 + 1;
  await modrinth.projectMetadata(["p0", "p254"]);
  assert.equal(requests.length, 5);
});

test("CurseForge project metadata uses authenticated batches, handles newly configured keys and ignores unsafe icon schemes", async () => {
  let secret = null;
  const requests = [];
  const curseforge = createCoreProviders({
    key: async () => secret,
    fetch: async (url, init) => {
      assert.equal(url, "https://api.curseforge.com/v1/mods");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["x-api-key"], "fixture-key");
      const { modIds } = JSON.parse(init.body);
      requests.push(modIds);
      return Response.json({
        data: modIds.map((id) => ({
          id,
          gameId: id === 13 ? 999 : 432,
          name: `Project ${id}`,
          logo: {
            thumbnailUrl:
              id === 12
                ? "javascript:alert(1)"
                : `https://media.forgecdn.net/${id}.png`,
          },
        })),
      });
    },
  }).find(({ id }) => id === "curseforge");
  assert.deepEqual((await curseforge.projectMetadata(["11"])).projects, []);
  assert.equal(requests.length, 0);
  secret = "fixture-key";
  const [first, second] = await Promise.all([
    curseforge.projectMetadata(["11", "12", "13"]),
    curseforge.projectMetadata(["11", "12"]),
  ]);
  assert.deepEqual(requests, [[11, 12, 13]]);
  assert.deepEqual(
    first.projects.map(({ id }) => id),
    ["11", "12"],
  );
  assert.equal(first.projects[0].iconUrl, "https://media.forgecdn.net/11.png");
  assert.equal(first.projects[1].iconUrl, undefined);
  assert.deepEqual(first.projects, second.projects);
});

test("metadata timeout cools down queued batches without hiding cached icons or extending the retry deadline", async (t) => {
  let now = Date.now(),
    stalled = false;
  t.mock.method(Date, "now", () => now);
  const timeouts = [],
    requests = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    timeouts.push(milliseconds);
    return stalled
      ? AbortSignal.abort(
          new DOMException("Fixture metadata timeout", "TimeoutError"),
        )
      : timeout(milliseconds);
  });
  const modrinth = createCoreProviders({
    fetch: async (url, init) => {
      const ids = JSON.parse(new URL(url).searchParams.get("ids"));
      requests.push(ids);
      init.signal.throwIfAborted();
      return Response.json(
        ids.map((id) => ({
          id,
          title: `Project ${id}`,
          icon_url: `https://cdn.modrinth.com/${id}.png`,
        })),
      );
    },
  }).find(({ id }) => id === "modrinth");
  await modrinth.projectMetadata(["cached"]);
  stalled = true;
  const result = await modrinth.projectMetadata([
    ...Array.from({ length: 205 }, (_, index) => `mod${index}`),
    "cached",
  ]);
  assert.equal(
    requests.length,
    2,
    "only the first missing batch calls the stalled provider",
  );
  assert.deepEqual(
    timeouts,
    [8000, 60000, 8000, 60000],
    "each metadata request keeps its shorter eight-second budget alongside the transport deadline",
  );
  assert.deepEqual(result.projects, [
    {
      id: "cached",
      title: "Project cached",
      iconUrl: "https://cdn.modrinth.com/cached.png",
    },
  ]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /took too long/);
  now += 20_000;
  const duringCooldown = await modrinth.projectMetadata([
    "new-during-cooldown",
    "cached",
  ]);
  assert.equal(requests.length, 2);
  assert.equal(
    duringCooldown.projects[0].iconUrl,
    "https://cdn.modrinth.com/cached.png",
  );
  now += 10_001;
  stalled = false;
  const recovered = await modrinth.projectMetadata([
    "mod0",
    "new-during-cooldown",
    "cached",
  ]);
  assert.equal(
    requests.length,
    3,
    "queued fallbacks keep the original cooldown deadline",
  );
  assert.deepEqual(requests[2], ["mod0", "new-during-cooldown"]);
  assert.equal(recovered.projects.length, 3);
  assert.deepEqual(recovered.warnings, []);
  assert.equal(
    recovered.projects[2].iconUrl,
    "https://cdn.modrinth.com/cached.png",
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

test("bundled libraries satisfy only checksum-identified catalog requirements and reuse the reviewed download", async (t) => {
  for (const mode of [
    "identified",
    "unknown",
    "wrong-hash",
    "pinned-other",
    "tampered-stage",
    "other-loader",
    "catalog-other-loader",
    "catalog-other-minecraft",
    "catalog-client-only",
  ]) {
    await t.test(mode, async (t) => {
      const nested = zip([
        [
          "META-INF/neoforge.mods.toml",
          '[[mods]]\nmodId="bundled_library"\nversion="1.2.3"\ndisplayName="Bundled Library"\n',
        ],
      ]);
      const nestedHash = hashes(nested).sha512;
      const embeddedPath = "META-INF/jarjar/library.jar";
      const parent = zip([
        [
          "META-INF/jarjar/metadata.json",
          JSON.stringify({
            jars: [
              {
                identifier: { group: "example", artifact: "library" },
                version: { range: "[1,2)", artifactVersion: "1.2.3" },
                path: embeddedPath,
              },
            ],
          }),
        ],
        [embeddedPath, nested],
      ]);
      const f = await fixture(t, {
        request: async (url, init) => {
          const pathname = new URL(url).pathname;
          if (pathname.startsWith("/v2/project/bundledProject"))
            return new Response(null, { status: 404 });
          if (
            pathname === "/v2/version_files" &&
            JSON.parse(init.body).hashes.includes(nestedHash)
          ) {
            if (mode === "unknown") return Response.json({});
            return Response.json({
              [nestedHash]: {
                id: "embedded-version",
                project_id: "bundledProject",
                game_versions: [
                  mode === "catalog-other-minecraft" ? "1.20.1" : "1.21.1",
                ],
                loaders: [
                  mode === "catalog-other-loader" ? "fabric" : "neoforge",
                ],
                environment:
                  mode === "catalog-client-only"
                    ? "client_only"
                    : "server_only",
                files: [
                  {
                    hashes: {
                      sha512:
                        mode === "wrong-hash"
                          ? hashes("different").sha512
                          : nestedHash,
                    },
                  },
                ],
              },
            });
          }
        },
      });
      f.downloads.set("https://cdn.modrinth.com/new.jar", parent);
      f.versions.new.files[0].size = parent.length;
      f.versions.new.files[0].hashes = hashes(parent);
      f.versions.new.dependencies = [
        {
          project_id: "bundledProject",
          version_id: mode === "pinned-other" ? "other-version" : null,
          dependency_type: "required",
        },
      ];
      if (mode === "other-loader") {
        f.setServer({ loader: "fabric" });
        f.versions.new.loaders = ["fabric"];
      }
      const plan = await f.service.preview({
        ...selection,
        ...(mode === "other-loader" ? { loader: "fabric" } : {}),
        replacePath: "mods/old.jar",
      });
      assert.deepEqual(
        plan.bundledDependencies,
        mode === "other-loader"
          ? []
          : [
              {
                title: "Bundled Library",
                version: "1.2.3",
                path: embeddedPath,
                bundledWith: "mods/new.jar",
              },
            ],
      );
      const resolved = ["identified", "tampered-stage"].includes(mode);
      assert.equal(plan.unavailableDependencies.length, resolved ? 0 : 1);
      if (!resolved)
        await assert.rejects(
          f.service.install({ planId: plan.planId, confirmed: true }),
          /unavailable required dependencies/,
        );
      if (mode === "tampered-stage") {
        const stage = path.join(
          f.dataDir,
          "launchpad",
          plan.planId,
          "dependency-inspection-0.jar",
        );
        await fs.writeFile(stage, Buffer.alloc(parent.length));
      }
      const job = await finish(f.service, {
        planId: plan.planId,
        confirmed: true,
        ...(!resolved ? { acknowledgedUnavailableDependencies: true } : {}),
      });
      if (mode === "tampered-stage") {
        assert.equal(job.status, "failed");
        assert.match(job.error, /checksum/);
        assert.equal(f.mutations, 0);
        assert.deepEqual(
          await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
          f.old,
        );
        assert.deepEqual(await f.bin.list(), []);
      } else {
        assert.equal(job.status, "completed");
        assert.deepEqual(await fs.readdir(path.join(f.serverDir, "mods")), [
          "new.jar",
        ]);
        assert.deepEqual(
          await fs.readFile(path.join(f.serverDir, "mods", "new.jar")),
          parent,
        );
      }
      assert.equal(
        f.requests.filter(
          (item) => item.url === "https://cdn.modrinth.com/new.jar",
        ).length,
        1,
      );
    });
  }
});
test("unchanged dependencies supply verified bundled libraries without downloads or extra review rows", async (t) => {
  const nested = zip([
    [
      "META-INF/neoforge.mods.toml",
      '[[mods]]\nmodId="bundled_library"\nversion="1.2.3"\ndisplayName="Bundled Library"\n',
    ],
  ]);
  const embeddedPath = "META-INF/jarjar/library.jar";
  const parent = zip([
    [
      "META-INF/jarjar/metadata.json",
      JSON.stringify({
        jars: [
          {
            identifier: { group: "example", artifact: "library" },
            version: { range: "[1,2)", artifactVersion: "1.2.3" },
            path: embeddedPath,
          },
        ],
      }),
    ],
    [embeddedPath, nested],
  ]);
  const nestedHash = hashes(nested).sha512;
  const f = await fixture(t, {
    request: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.startsWith("/v2/project/bundledProject"))
        return new Response(null, { status: 404 });
      if (
        pathname === "/v2/version_files" &&
        JSON.parse(init.body).hashes.includes(nestedHash)
      )
        return Response.json({
          [nestedHash]: {
            id: "embedded-version",
            project_id: "bundledProject",
            game_versions: ["1.21.1"],
            loaders: ["neoforge"],
            environment: "server_only",
            files: [{ hashes: hashes(nested) }],
          },
        });
    },
  });
  f.versions.new.dependencies = [
    {
      project_id: "dependency",
      version_id: "dep",
      dependency_type: "required",
    },
  ];
  f.versions.dep.dependencies = [
    {
      project_id: "bundledProject",
      version_id: null,
      dependency_type: "required",
    },
  ];
  f.versions.dep.files[0].hashes = hashes(parent);
  f.versions.dep.files[0].size = parent.length;
  const installedPath = path.join(f.serverDir, "mods", "dep.jar");
  await fs.writeFile(installedPath, parent);
  const before = await fs.stat(installedPath);
  const plan = await f.service.preview(selection);
  assert.equal(plan.unchangedCount, 1);
  assert.deepEqual(
    plan.files.map((file) => file.path),
    ["mods/new.jar"],
  );
  assert.deepEqual(plan.bundledDependencies, []);
  assert.deepEqual(plan.unavailableDependencies, []);
  assert.equal(
    f.requests.filter(({ url }) => url === "https://cdn.modrinth.com/dep.jar")
      .length,
    0,
  );
  const job = await finish(f.service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "completed", job.error);
  const after = await fs.stat(installedPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.deepEqual(await fs.readFile(installedPath), parent);
  assert.deepEqual(
    (await f.bin.list()).map((item) => item.originalPath),
    ["mods/old.jar"],
  );
  // Local inspection must enforce the provider size used by its total budget.
  for (const size of [parent.length - 1, parent.length + 1]) {
    f.versions.dep.files[0].size = size;
    await assert.rejects(
      f.service.preview(selection),
      /mods\/dep.jar changed since review/,
    );
  }
  f.versions.dep.files[0].size = -1;
  const invalidSize = await f.service.preview(selection);
  assert.equal(invalidSize.unavailableDependencies.length, 1);
  assert.ok(
    invalidSize.warnings.some((warning) =>
      /mods\/dep.jar.*inspection limits/.test(warning),
    ),
  );
  assert.equal(f.mutations, 1);
  assert.equal(
    f.requests.filter(({ url }) => url === "https://cdn.modrinth.com/dep.jar")
      .length,
    0,
  );
});

test("bundled dependency fingerprint matches also require an exact SHA-1 identity", async (t) => {
  const f = await fixture(t);
  f.setServer({ loader: "fabric" });
  const nested = zip([
    [
      "fabric.mod.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "embedded",
        name: "Embedded Library",
        version: "2.0",
      }),
    ],
  ]);
  const parent = zip([
    [
      "fabric.mod.json",
      JSON.stringify({
        schemaVersion: 1,
        id: "parent",
        jars: [{ file: "libs/embedded.jar" }],
      }),
    ],
    ["libs/embedded.jar", nested],
  ]);
  f.downloads.set("https://cdn.modrinth.com/parent.jar", parent);
  let mode = "valid";
  const service = await f.boot({
    extraProviders: [
      {
        id: "fingerprint-fixture",
        name: "Fingerprint catalog",
        types: ["mod"],
        available: true,
        downloadHosts: ["cdn.modrinth.com"],
        versions: async () => {
          throw Object.assign(new Error("Not found"), { status: 404 });
        },
        resolve: async () => ({
          title: "Parent Mod",
          versionName: "1.0",
          files: [
            {
              path: "parent.jar",
              url: "https://cdn.modrinth.com/parent.jar",
              size: parent.length,
              hashes: hashes(parent),
            },
          ],
          dependencies: [
            { platform: "fingerprint-fixture", projectId: "44", type: "mod" },
          ],
        }),
        identifyFingerprints: async (values) => {
          assert.deepEqual(values, [curseFingerprint(nested)]);
          return {
            exactMatches: [
              {
                id: 44,
                file: {
                  modId: 44,
                  id: 55,
                  fileFingerprint:
                    mode === "wrong-fingerprint"
                      ? curseFingerprint(nested) ^ 1
                      : curseFingerprint(nested),
                  hashes: [
                    {
                      algo: 1,
                      value:
                        mode === "wrong-sha1"
                          ? "0".repeat(40)
                          : hashes(nested).sha1,
                    },
                  ],
                },
              },
            ],
          };
        },
        compatibleBundledVersion: () => true,
      },
    ],
  });
  for (mode of ["valid", "wrong-sha1", "wrong-fingerprint"]) {
    const plan = await service.preview({
      ...selection,
      loader: "fabric",
      platform: "fingerprint-fixture",
      projectId: "parent",
      versionId: "new",
    });
    assert.equal(plan.bundledDependencies[0].title, "Embedded Library");
    assert.equal(
      plan.unavailableDependencies.length,
      mode === "valid" ? 0 : 1,
      mode,
    );
  }
});

test("JEI-style missing Modrinth dependencies require explicit acknowledgement of the reviewed omissions", async (t) => {
  const f = await fixture(t, {
    request: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/v2/project/7tEfOcA7/version")
        return new Response(null, { status: 404 });
      if (pathname === "/v2/project/project")
        return Response.json({
          id: "project",
          title: "Just Enough Items (JEI)",
          project_type: "mod",
          server_side: "optional",
        });
    },
  });
  // This is the dependency shape returned for JEI's NeoForge 1.21.1 releases.
  f.versions.new.dependencies = [
    { project_id: "7tEfOcA7", version_id: null, dependency_type: "required" },
  ];
  const plan = await f.service.preview({
    ...selection,
    replacePath: "mods/old.jar",
  });
  assert.deepEqual(plan.unavailableDependencies, [
    {
      platform: "modrinth",
      projectId: "7tEfOcA7",
      versionId: null,
      requiredBy: "Just Enough Items (JEI)",
    },
  ]);
  assert.deepEqual(
    plan.files.map((file) => file.path),
    ["mods/new.jar"],
  );
  for (const acknowledgedUnavailableDependencies of [
    undefined,
    false,
    "true",
  ]) {
    await assert.rejects(
      f.service.install({
        planId: plan.planId,
        confirmed: true,
        acknowledgedUnavailableDependencies,
      }),
      /unavailable required dependencies/,
    );
    assert.equal(f.mutations, 0);
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
      f.old,
    );
  }
  const job = await finish(f.service, {
    planId: plan.planId,
    confirmed: true,
    acknowledgedUnavailableDependencies: true,
  });
  assert.equal(job.status, "completed");
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "new.jar")),
    f.newer,
  );
  assert.deepEqual(
    (await f.bin.list()).map((item) => item.originalPath),
    ["mods/old.jar"],
  );
});

async function pinnedLoaderFixture(t, requestHook) {
  const catalog = [],
    identities = new Map();
  const f = await fixture(t, {
    request: async (url, init) => {
      const custom = await requestHook?.(url, init);
      if (custom) return custom;
      const pathname = new URL(url).pathname;
      if (pathname === "/v2/project/dependency/version")
        return Response.json(catalog);
      if (pathname === "/v2/version_files")
        return Response.json(
          Object.fromEntries(
            JSON.parse(init.body)
              .hashes.filter((hash) => identities.has(hash))
              .map((hash) => [hash, identities.get(hash)]),
          ),
        );
    },
  });
  f.versions.new.dependencies = [
    {
      project_id: "dependency",
      version_id: "dep",
      dependency_type: "required",
    },
  ];
  f.versions.dep.name = "Sable 2.0.3 Fabric";
  f.versions.dep.version_number = "2.0.3";
  f.versions.dep.loaders = ["fabric"];
  const fabricUrl = "https://cdn.modrinth.com/sable-fabric-2.0.3.jar";
  f.versions.dep.files[0].filename = "sable-fabric-2.0.3.jar";
  f.versions.dep.files[0].url = fabricUrl;
  f.downloads.set(fabricUrl, f.dependency);
  const compatibleBytes = bytes("verified Sable NeoForge 2.0.3");
  const compatible = {
    ...structuredClone(f.versions.dep),
    id: "dep-neoforge",
    name: "Sable 2.0.3 NeoForge",
    loaders: ["neoforge"],
    files: [
      {
        filename: "sable-neoforge-2.0.3.jar",
        url: "https://cdn.modrinth.com/sable-neoforge-2.0.3.jar",
        size: compatibleBytes.length,
        hashes: hashes(compatibleBytes),
        primary: true,
      },
    ],
  };
  // Only the incompatible Fabric variant needs Fabric API. Recovery must
  // traverse the selected NeoForge variant's dependency graph instead.
  f.versions.dep.dependencies = [
    {
      project_id: "fabric-api",
      version_id: "fabric-api",
      dependency_type: "required",
    },
  ];
  f.versions[compatible.id] = compatible;
  f.downloads.set(compatible.files[0].url, compatibleBytes);
  catalog.push(compatible);
  identities.set(hashes(f.old).sha512, f.versions.old);
  identities.set(hashes(compatibleBytes).sha512, compatible);
  return { f, catalog, identities, compatible, compatibleBytes, fabricUrl };
}

test("a fresh server installs the exact same-release loader sibling of a wrongly pinned required dependency", async (t) => {
  const { f, compatible, compatibleBytes, fabricUrl } =
    await pinnedLoaderFixture(t);
  await fs.unlink(path.join(f.serverDir, "mods", "old.jar"));
  assert.deepEqual(await fs.readdir(path.join(f.serverDir, "mods")), []);
  const plan = await f.service.preview(selection);
  assert.deepEqual(
    plan.files.map((file) => [file.path, file.action]),
    [
      ["mods/new.jar", "install"],
      ["mods/sable-neoforge-2.0.3.jar", "install"],
    ],
  );
  assert.deepEqual(plan.unavailableDependencies, []);
  const job = await finish(f.service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.total, 2);
  assert.equal(job.completed, 2);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "new.jar")),
    f.newer,
  );
  assert.deepEqual(
    await fs.readFile(
      path.join(f.serverDir, "mods", compatible.files[0].filename),
    ),
    compatibleBytes,
  );
  const receipts = JSON.parse(
    await fs.readFile(
      path.join(f.dataDir, "launchpad", "installed.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    receipts.map(({ projectId, versionId }) => [projectId, versionId]),
    [
      ["project", "new"],
      ["dependency", compatible.id],
    ],
  );
  assert.equal(
    f.requests.filter(({ url }) => url === compatible.files[0].url).length,
    1,
  );
  assert.equal(
    f.requests.some(({ url }) => url === fabricUrl),
    false,
  );
  assert.equal(
    f.requests.some(({ url }) =>
      /^\/v2\/(?:project|version)\/fabric-api(?:\/|$)/.test(
        new URL(url).pathname,
      ),
    ),
    false,
    "the incompatible Fabric variant's dependency graph must not be resolved",
  );
  await assert.rejects(
    fs.stat(path.join(f.serverDir, "mods", "sable-fabric-2.0.3.jar")),
    { code: "ENOENT" },
  );
  assert.deepEqual(await f.bin.list(), []);
});

for (const unavailable of [
  "missing",
  "ambiguous",
  "different-release",
  "wrong-minecraft",
]) {
  test(`a wrongly pinned required dependency stays blocked when its loader sibling is ${unavailable}`, async (t) => {
    const { f, catalog, compatible } = await pinnedLoaderFixture(t);
    if (unavailable === "missing") catalog.length = 0;
    else if (unavailable === "ambiguous")
      catalog.push({
        ...structuredClone(compatible),
        id: "dep-neoforge-other",
      });
    else if (unavailable === "different-release")
      compatible.version_number = "2.0.5";
    else f.versions.dep.game_versions = ["1.20.1"];
    await assert.rejects(
      f.service.preview({
        ...selection,
        acknowledgedUnavailableDependencies: true,
      }),
      { status: 400 },
    );
    assert.equal(f.mutations, 0);
    assert.equal(
      f.requests.some(({ url }) => url.startsWith("https://cdn.modrinth.com/")),
      false,
    );
    assert.deepEqual(await fs.readdir(path.join(f.serverDir, "mods")), [
      "old.jar",
    ]);
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
      f.old,
    );
    assert.deepEqual(await f.bin.list(), []);
  });
}

test("recovering a wrong-loader pin cannot downgrade an unverified installed dependency release", async (t) => {
  const { f, identities, compatible } = await pinnedLoaderFixture(t);
  const existingBytes = bytes("installed Sable NeoForge 2.0.5");
  const existing = {
    ...structuredClone(compatible),
    id: "dep-newer",
    name: "Sable 2.0.5 NeoForge",
    version_number: "2.0.5",
    files: [
      {
        ...compatible.files[0],
        hashes: hashes(existingBytes),
        size: existingBytes.length,
      },
    ],
  };
  f.versions[existing.id] = existing;
  identities.set(hashes(existingBytes).sha512, existing);
  const target = path.join(f.serverDir, "mods", "sable-neoforge-2.0.5.jar");
  await fs.writeFile(target, existingBytes);
  const before = await fs.stat(target);
  await assert.rejects(
    f.service.preview({
      ...selection,
      acknowledgedUnavailableDependencies: true,
    }),
    { status: 409 },
  );
  assert.deepEqual(await fs.readFile(target), existingBytes);
  const after = await fs.stat(target);
  for (const field of ["ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"])
    assert.equal(after[field], before[field], field);
  assert.equal(f.mutations, 0);
  assert.ok(
    f.requests
      .filter(({ url }) => url.startsWith("https://cdn.modrinth.com/"))
      .every(({ url }) => url === f.versions.new.files[0].url),
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
  assert.deepEqual(await f.bin.list(), []);
});

async function installedRangeFixture(t, range = "[1.1.0,)", requestHook) {
  const state = await pinnedLoaderFixture(t, requestHook);
  const { f, compatible, identities } = state;
  const parent = zip([
    [
      "META-INF/neoforge.mods.toml",
      `
modLoader="javafml"
loaderVersion="[1,)"
license="MIT"
[[mods]]
modId="ragdolls"
version="0.7.5"
[[dependencies.ragdolls]]
modId="sable"
type="required"
versionRange="${range}"
side="BOTH"
`,
    ],
  ]);
  const installedBytes = zip([
    [
      "META-INF/neoforge.mods.toml",
      `
modLoader="javafml"
loaderVersion="[1,)"
license="MIT"
[[mods]]
modId="sable"
version="2.0.5"
`,
    ],
  ]);
  f.newer = parent;
  Object.assign(f.versions.new.files[0], {
    size: parent.length,
    hashes: hashes(parent),
  });
  f.downloads.set(f.versions.new.files[0].url, parent);
  const existing = {
    ...structuredClone(compatible),
    id: "dep-newer",
    name: "Sable 2.0.5 NeoForge",
    version_number: "2.0.5",
    files: [
      {
        ...compatible.files[0],
        filename: "sable-neoforge-2.0.5.jar",
        url: "https://cdn.modrinth.com/sable-neoforge-2.0.5.jar",
        hashes: hashes(installedBytes),
        size: installedBytes.length,
      },
    ],
    dependencies: [],
  };
  f.versions[existing.id] = existing;
  f.downloads.set(existing.files[0].url, installedBytes);
  identities.set(hashes(installedBytes).sha512, existing);
  const installedPath = path.join(f.serverDir, "mods", "renamed-sable.jar");
  await fs.writeFile(installedPath, installedBytes);
  // This belongs only to the recovered older release, never the installed one.
  compatible.dependencies = [
    {
      project_id: "old-only",
      version_id: "old-only",
      dependency_type: "required",
    },
  ];
  return { ...state, existing, installedBytes, installedPath };
}

test("a verified installed dependency satisfying the new mod's declared range is retained during wrong-loader recovery", async (t) => {
  const { f, existing, installedBytes, installedPath, compatible, fabricUrl } =
    await installedRangeFixture(t);
  const before = await fs.stat(installedPath);
  const plan = await f.service.preview({
    ...selection,
    replacePath: "mods/old.jar",
  });
  assert.deepEqual(
    plan.files.map(({ path }) => path),
    ["mods/new.jar"],
  );
  assert.equal(plan.unchangedCount, 1);
  assert.deepEqual(plan.unavailableDependencies, []);
  const job = await finish(f.service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.total, 1);
  assert.deepEqual(await fs.readFile(installedPath), installedBytes);
  const after = await fs.stat(installedPath);
  for (const field of ["ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"])
    assert.equal(after[field], before[field], field);
  const installed = await f.service.installed({ ...selection, local: true });
  assert.equal(
    installed.items.find(({ projectId }) => projectId === "dependency")
      .versionId,
    existing.id,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods/new.jar")),
    f.newer,
  );
  assert.equal(
    f.requests.some(
      ({ url }) =>
        [existing.files[0].url, compatible.files[0].url, fabricUrl].includes(
          url,
        ) || new URL(url).pathname.includes("old-only"),
    ),
    false,
  );
  assert.equal(
    f.requests.filter(({ url }) => url === f.versions.new.files[0].url).length,
    1,
    "verified parent inspection is reused for installation",
  );
  assert.deepEqual(
    (await f.bin.list()).map(({ originalPath }) => originalPath),
    ["mods/old.jar"],
  );
});

for (const range of ["[2.0.6,)", "[1.1.0,2.0.5)", "[2.0.3]", "unknown"])
  test(`an installed dependency cannot bypass an incompatible or unknown declaration ${range}`, async (t) => {
    const { f, installedBytes, installedPath } = await installedRangeFixture(
      t,
      range,
    );
    await assert.rejects(
      f.service.preview({
        ...selection,
        acknowledgedUnavailableDependencies: true,
      }),
      { status: 409 },
    );
    assert.equal(f.mutations, 0);
    assert.deepEqual(await fs.readFile(installedPath), installedBytes);
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods/old.jar")),
      f.old,
    );
    assert.deepEqual(await f.bin.list(), []);
  });

test("each dependent must independently permit a preserved installed library even when catalog pins repeat", async (t) => {
  const { f, installedBytes, installedPath } = await installedRangeFixture(t);
  const otherBytes = zip([
    [
      "META-INF/neoforge.mods.toml",
      `
[[mods]]
modId="othermod"
version="1.0"
[[dependencies.othermod]]
modId="sable"
type="required"
versionRange="[1.1.0,2.0.5)"
side="SERVER"
`,
    ],
  ]);
  f.versions.other = {
    ...structuredClone(f.versions.new),
    id: "other",
    project_id: "other",
    name: "Other mod",
    files: [
      {
        ...f.versions.new.files[0],
        filename: "other.jar",
        url: "https://cdn.modrinth.com/other.jar",
        size: otherBytes.length,
        hashes: hashes(otherBytes),
      },
    ],
  };
  f.downloads.set(f.versions.other.files[0].url, otherBytes);
  f.versions.new.dependencies.push({
    project_id: "other",
    version_id: "other",
    dependency_type: "required",
  });
  await assert.rejects(f.service.preview(selection), { status: 409 });
  assert.equal(f.mutations, 0);
  assert.deepEqual(await fs.readFile(installedPath), installedBytes);
});

test("a missing exact-version lookup cannot bypass another parent's preserved-dependency proof", async (t) => {
  let installedVersionLookups = 0;
  const { f, existing, installedBytes, installedPath } =
    await installedRangeFixture(t, "[1.1.0,)", (url) => {
      if (
        new URL(url).pathname === "/v2/version/dep-newer" &&
        ++installedVersionLookups === 2
      )
        return new Response("Removed from the catalog", { status: 404 });
    });
  const otherBytes = zip([
    [
      "META-INF/neoforge.mods.toml",
      `
[[mods]]
modId="othermod"
version="1.0"
[[dependencies.othermod]]
modId="sable"
type="required"
versionRange="[1.1.0,2.0.5)"
side="SERVER"
`,
    ],
  ]);
  f.versions.other = {
    ...structuredClone(f.versions.new),
    id: "other",
    project_id: "other",
    name: "Other mod",
    files: [
      {
        ...f.versions.new.files[0],
        filename: "other.jar",
        url: "https://cdn.modrinth.com/other.jar",
        size: otherBytes.length,
        hashes: hashes(otherBytes),
      },
    ],
    dependencies: [
      {
        project_id: "dependency",
        version_id: existing.id,
        dependency_type: "required",
      },
    ],
  };
  f.downloads.set(f.versions.other.files[0].url, otherBytes);
  f.versions.new.dependencies.push({
    project_id: "other",
    version_id: "other",
    dependency_type: "required",
  });
  await assert.rejects(
    f.service.preview({
      ...selection,
      acknowledgedUnavailableDependencies: true,
    }),
    { status: 400 },
  );
  assert.equal(installedVersionLookups, 2);
  assert.equal(f.mutations, 0);
  assert.deepEqual(await fs.readFile(installedPath), installedBytes);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
  assert.deepEqual(await f.bin.list(), []);
});

test("changing a preserved dependency after review prevents all mod promotion", async (t) => {
  const { f, installedPath } = await installedRangeFixture(t);
  const plan = await f.service.preview(selection);
  await fs.writeFile(installedPath, "externally changed dependency");
  const job = await finish(f.service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "failed");
  assert.match(job.error, /changed since review/);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods/old.jar")),
    f.old,
  );
  assert.deepEqual(await f.bin.list(), []);
});

test("an installed exact recovered loader sibling is omitted without redownloading or replacing it", async (t) => {
  const { f, compatible, compatibleBytes, fabricUrl } =
    await pinnedLoaderFixture(t);
  const target = path.join(f.serverDir, "mods", compatible.files[0].filename);
  await fs.writeFile(target, compatibleBytes);
  const before = await fs.stat(target);
  const plan = await f.service.preview(selection);
  assert.deepEqual(
    plan.files.map(({ path }) => path),
    ["mods/new.jar"],
  );
  assert.deepEqual(plan.unavailableDependencies, []);
  const job = await finish(f.service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.total, 1);
  assert.deepEqual(await fs.readFile(target), compatibleBytes);
  const after = await fs.stat(target);
  for (const field of ["ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"])
    assert.equal(after[field], before[field], field);
  assert.equal(
    f.requests.some(
      ({ url }) => url === compatible.files[0].url || url === fabricUrl,
    ),
    false,
  );
  assert.deepEqual(
    (await f.bin.list()).map(({ originalPath }) => originalPath),
    ["mods/old.jar"],
  );
});

for (const correctFirst of [false, true]) {
  test(`recovered dependency identity deduplicates an explicit correct loader sibling (${correctFirst ? "correct first" : "wrong pin first"})`, async (t) => {
    const { f, compatible, fabricUrl } = await pinnedLoaderFixture(t);
    const direct = {
      project_id: "dependency",
      version_id: compatible.id,
      dependency_type: "required",
    };
    if (correctFirst) f.versions.new.dependencies.unshift(direct);
    else f.versions.new.dependencies.push(direct);
    const plan = await f.service.preview(selection);
    assert.deepEqual(
      plan.files.map(({ path }) => path),
      ["mods/new.jar", "mods/sable-neoforge-2.0.3.jar"],
    );
    assert.deepEqual(plan.unavailableDependencies, []);
    const job = await finish(f.service, {
      planId: plan.planId,
      confirmed: true,
    });
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.total, 2);
    assert.equal(
      f.requests.filter(({ url }) => url === compatible.files[0].url).length,
      1,
    );
    assert.equal(
      f.requests.some(({ url }) => url === fabricUrl),
      false,
    );
    const receipts = JSON.parse(
      await fs.readFile(
        path.join(f.dataDir, "launchpad", "installed.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      receipts
        .filter(({ projectId }) => projectId === "dependency")
        .map(({ versionId }) => versionId),
      [compatible.id],
    );
  });
}

test("a missing conflicting pin cannot bypass a resolved dependency's version conflict", async (t) => {
  const f = await fixture(t, {
    request: async (url) => {
      if (new URL(url).pathname === "/v2/version/missing-dep")
        return new Response(null, { status: 404 });
    },
  });
  f.versions.new.dependencies = ["dep", "missing-dep"].map((version_id) => ({
    project_id: "dependency",
    version_id,
    dependency_type: "required",
  }));
  await assert.rejects(
    f.service.preview({
      ...selection,
      acknowledgedUnavailableDependencies: true,
    }),
    { status: 409 },
  );
  assert.equal(f.mutations, 0);
  assert.equal(
    f.requests.some(({ url }) => url.startsWith("https://cdn.modrinth.com/")),
    false,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
  assert.deepEqual(await f.bin.list(), []);
});

test("a recovered back-reference to the selected root does not block updating that root", async (t) => {
  const f = await fixture(t);
  f.versions.new.dependencies = [
    {
      project_id: "dependency",
      version_id: "dep",
      dependency_type: "required",
    },
  ];
  f.versions.dep.dependencies = [
    {
      project_id: "project",
      version_id: "root-fabric",
      dependency_type: "required",
    },
  ];
  const fabricUrl = "https://cdn.modrinth.com/root-fabric.jar";
  f.versions["root-fabric"] = {
    ...structuredClone(f.versions.new),
    id: "root-fabric",
    name: "New version Fabric",
    loaders: ["fabric"],
    files: [
      {
        ...f.versions.new.files[0],
        filename: "root-fabric.jar",
        url: fabricUrl,
      },
    ],
  };
  f.downloads.set(fabricUrl, f.newer);
  const plan = await f.service.preview({
    ...selection,
    replacePath: "mods/old.jar",
  });
  assert.deepEqual(
    plan.files.map(({ path }) => path),
    ["mods/new.jar", "mods/dep.jar"],
  );
  assert.deepEqual(plan.unavailableDependencies, []);
  const job = await finish(f.service, { planId: plan.planId, confirmed: true });
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.total, 2);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "new.jar")),
    f.newer,
  );
  assert.equal(
    f.requests.some(({ url }) => url === fabricUrl),
    false,
  );
  const receipts = JSON.parse(
    await fs.readFile(
      path.join(f.dataDir, "launchpad", "installed.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    receipts
      .filter(({ projectId }) => projectId === "project")
      .map(({ versionId }) => versionId),
    ["new"],
  );
  assert.deepEqual(
    (await f.bin.list()).map(({ originalPath }) => originalPath),
    ["mods/old.jar"],
  );
});

for (const invalid of [
  "selected-loader",
  "selected-minecraft",
  "dependency-project",
  "dependency-type",
]) {
  test(`unavailable-dependency acknowledgement cannot bypass ${invalid} validation`, async (t) => {
    const f = await fixture(t, {
      request: async (url) => {
        if (
          invalid === "dependency-type" &&
          new URL(url).pathname === "/v2/project/dependency"
        )
          return Response.json({
            id: "dependency",
            title: "Different content type",
            project_type: "modpack",
            server_side: "required",
          });
      },
    });
    if (invalid === "selected-loader") f.versions.new.loaders = ["fabric"];
    else if (invalid === "selected-minecraft")
      f.versions.new.game_versions = ["1.20.1"];
    else {
      f.versions.new.dependencies = [
        {
          project_id: "dependency",
          version_id: "dep",
          dependency_type: "required",
        },
      ];
      // The identity/type failures take precedence even if the loader also differs.
      f.versions.dep.loaders = ["fabric"];
      if (invalid === "dependency-project")
        f.versions.dep.project_id = "unrelated-project";
    }
    await assert.rejects(
      f.service.preview({
        ...selection,
        acknowledgedUnavailableDependencies: true,
      }),
      (cause) => {
        assert.equal(cause.status, 400);
        if (invalid.startsWith("selected-"))
          assert.equal(cause.code, "INCOMPATIBLE_VERSION");
        else assert.notEqual(cause.code, "INCOMPATIBLE_VERSION");
        return true;
      },
    );
    assert.equal(f.mutations, 0);
    assert.equal(
      f.requests.some(({ url }) => url.startsWith("https://cdn.modrinth.com/")),
      false,
    );
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
      f.old,
    );
    assert.deepEqual(await f.bin.list(), []);
  });
}

test("unavailable dependencies are deduplicated and count toward the resolution budget", async (t) => {
  let requests = 0;
  const f = await fixture(t, {
    request: async (url) => {
      if (new URL(url).pathname.startsWith("/v2/project/missing")) {
        requests++;
        return new Response(null, { status: 404 });
      }
    },
  });
  const required = (project_id) => ({
    project_id,
    version_id: null,
    dependency_type: "required",
  });
  f.versions.new.dependencies = Array.from({ length: 500 }, () =>
    required("missing"),
  );
  const plan = await f.service.preview(selection);
  assert.equal(plan.unavailableDependencies.length, 1);
  assert.equal(requests, 1);
  requests = 0;
  f.versions.new.dependencies = Array.from({ length: 101 }, (_, i) =>
    required(`missing${i}`),
  );
  await assert.rejects(
    f.service.preview(selection),
    /dependency graph is too large/,
  );
  assert.equal(
    requests,
    99,
    "root and missing nodes share the 100-node network budget",
  );
  assert.equal(f.mutations, 0);
});

test("missing selected versions and transient dependency errors cannot be bypassed as missing requirements", async (t) => {
  let rootMissing = true;
  const f = await fixture(t, {
    request: async (url) => {
      const pathname = new URL(url).pathname;
      if (rootMissing && pathname === "/v2/version/new")
        return new Response(null, { status: 404 });
      if (pathname === "/v2/project/dependency/version")
        return new Response(null, { status: 503 });
    },
  });
  await assert.rejects(
    f.service.preview(selection),
    /could not find the selected project or version/,
  );
  rootMissing = false;
  f.versions.new.dependencies = [
    { project_id: "dependency", version_id: null, dependency_type: "required" },
  ];
  await assert.rejects(f.service.preview(selection), /503/);
  assert.equal(f.mutations, 0);
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

test("Modrinth packs replace old data with the verified runtime and server pack while retaining EULA acceptance", async (t) => {
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
    "Survival/level.dat",
    "config/common.cfg",
    "mods/server.jar",
  ]);
  assert.match(plan.warnings.join(" "), /client-only/);
  assert.equal(
    f.requests.filter(
      ({ url }) => new URL(url).pathname === "/v2/version_files",
    ).length,
    0,
    "valid mrpack environments need no checksum environment lookups",
  );
  assert.equal(plan.cleanInstall, true);
  assert.equal(plan.runtime.build, "21.1.200");
  assert.equal(plan.summary.fileCount, 3);
  await assert.rejects(
    f.service.install({ planId: plan.planId, confirmed: true }),
    /Confirm the clean installation/,
  );
  assert.equal(
    (
      await finish(f.service, {
        planId: plan.planId,
        confirmed: true,
        cleanInstall: true,
      })
    ).status,
    "completed",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "config", "common.cfg"), "utf8"),
    "server override",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "Survival", "level.dat"), "utf8"),
    "wrong world",
  );
  assert.match(
    await fs.readFile(path.join(f.serverDir, "eula.txt"), "utf8"),
    /eula=false/,
  );
  await assert.rejects(fs.stat(path.join(f.serverDir, "mods", "old.jar")), {
    code: "ENOENT",
  });
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "runtime.jar"), "utf8"),
    "verified runtime",
  );
  assert.equal(
    (await f.service.installed({ ...selection, type: "modpack" })).items[0]
      .versionId,
    "new",
  );
  const saved = JSON.parse(
    await fs.readFile(
      path.join(f.dataDir, "launchpad", "installed.json"),
      "utf8",
    ),
  );
  assert.equal(
    saved.find((item) => item.pack).iconUrl,
    "https://cdn.modrinth.com/data/project/icon.png",
  );
  assert.equal(saved.find((item) => item.pack).author, "FixtureAuthor");
  assert.ok(
    saved
      .filter((item) => !item.pack && item.type === "modpack")
      .every((item) => !item.author),
    "pack authors are not falsely assigned to bundled mods",
  );
});

function configureMrpack(f, files) {
  const manifest = {
    formatVersion: 1,
    game: "minecraft",
    name: "Unknown environments fixture",
    versionId: "2",
    dependencies: { minecraft: "1.21.1", neoforge: "21.1.200" },
    files,
  };
  const archive = zip([["modrinth.index.json", JSON.stringify(manifest)]]);
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
}
const unknownPackFile = (name, data, overrides = {}) => ({
  path: `mods/${name}.jar`,
  hashes: hashes(data),
  downloads: ["https://cdn.modrinth.com/new.jar"],
  fileSize: data.length,
  env: { server: "unknown", client: "unknown" },
  ...overrides,
});
const identifiedPackFile = (file, environment, overrides = {}) => ({
  id: "matched-release",
  project_id: "matched-project",
  game_versions: ["1.21.1"],
  loaders: ["neoforge"],
  environment,
  files: [{ hashes: file.hashes }],
  ...overrides,
});

test("Modrinth packs classify unknown environments by exact checksums while switching loaders", async (t) => {
  const candidates = [
    [unknownPackFile("server", bytes("server")), "server_only"],
    [unknownPackFile("statuseffectbars", bytes("client")), "client_only"],
    [
      unknownPackFile("optional", bytes("optional")),
      "client_only_server_optional",
    ],
    [
      unknownPackFile("singleplayer", bytes("singleplayer")),
      "singleplayer_only",
    ],
    [
      unknownPackFile("legacy-sha1", bytes("legacy"), {
        hashes: { sha1: hashes(bytes("legacy")).sha1 },
      }),
      "client_and_server",
    ],
  ];
  const batches = [];
  const f = await fixture(t, {
    type: "modpack",
    request: async (url, init) => {
      if (new URL(url).pathname !== "/v2/version_files") return;
      const batch = JSON.parse(init.body);
      batches.push(batch);
      return Response.json(
        Object.fromEntries(
          candidates
            .filter(([file]) =>
              batch.hashes.includes(file.hashes[batch.algorithm]),
            )
            .map(([file, environment]) => [
              file.hashes[batch.algorithm],
              identifiedPackFile(file, environment),
            ]),
        ),
      );
    },
  });
  f.setServer({ loader: "fabric" });
  configureMrpack(
    f,
    candidates.map(([file]) => file),
  );
  const plan = await f.service.preview({ ...selection, type: "modpack" });
  assert.deepEqual(
    plan.files.map((file) => file.path),
    ["mods/server.jar", "mods/legacy-sha1.jar"],
  );
  assert.deepEqual(
    batches.map((batch) => [batch.algorithm, batch.hashes.length]),
    [
      ["sha512", 4],
      ["sha1", 1],
    ],
  );
  assert.match(
    plan.warnings.join("\n"),
    /Skipped mods\/statuseffectbars.jar: client-only/,
  );
  assert.match(
    plan.warnings.join("\n"),
    /Skipped mods\/optional.jar: optional server file/,
  );
  assert.equal(plan.runtime.provider, "neoforge");
  assert.equal(f.mutations, 0);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods/old.jar")),
    f.old,
  );
});

for (const failure of [
  "unidentified",
  "mismatched hash",
  "wrong loader",
  "wrong Minecraft version",
  "unknown support",
  "provider missing",
  "provider unavailable",
]) {
  test(`Modrinth packs reject unknown environments with ${failure} without changing the server`, async (t) => {
    const file = unknownPackFile("unverified", bytes("unverified"));
    const f = await fixture(t, {
      type: "modpack",
      request: async (url) => {
        if (new URL(url).pathname !== "/v2/version_files") return;
        if (failure === "provider missing")
          return new Response(null, { status: 404 });
        if (failure === "provider unavailable")
          return new Response(null, { status: 503 });
        if (failure === "unidentified") return Response.json({});
        const match = identifiedPackFile(file, "server_only");
        if (failure === "mismatched hash")
          match.files = [{ hashes: hashes(bytes("different")) }];
        if (failure === "wrong loader") match.loaders = ["fabric"];
        if (failure === "wrong Minecraft version")
          match.game_versions = ["1.20.1"];
        if (failure === "unknown support") match.environment = "unknown";
        return Response.json({ [file.hashes.sha512]: match });
      },
    });
    configureMrpack(f, [file]);
    await assert.rejects(
      f.service.preview({ ...selection, type: "modpack" }),
      (cause) => {
        assert.equal(cause.status, failure.startsWith("provider") ? 502 : 400);
        assert.match(cause.message, /mods\/unverified.jar/);
        assert.match(
          cause.message,
          /check server support|exact release could not be verified/,
        );
        return true;
      },
    );
    assert.equal(f.mutations, 0);
    assert.deepEqual(
      await fs.readFile(path.join(f.serverDir, "mods/old.jar")),
      f.old,
    );
  });
}

test("Modrinth unknown environment recovery retains path, hash and host validation", async (t) => {
  const matches = {};
  const f = await fixture(t, {
    type: "modpack",
    request: async (url) =>
      new URL(url).pathname === "/v2/version_files"
        ? Response.json(matches)
        : undefined,
  });
  for (const [overrides, expected] of [
    [{ path: "../escape.jar" }, /path|relative|folder|traversal/i],
    [{ hashes: { sha512: "not-a-checksum" } }, /valid checksum/],
    [{ downloads: ["https://evil.example/mod.jar"] }, /unsupported host/],
    [
      { env: { server: "maybe" } },
      /invalid server-side dependency metadata for mods\/guarded.jar/,
    ],
  ]) {
    const file = unknownPackFile("guarded", bytes("guarded"), overrides);
    matches[file.hashes.sha512] = identifiedPackFile(file, "server_only");
    configureMrpack(f, [file]);
    await assert.rejects(
      f.service.preview({ ...selection, type: "modpack" }),
      expected,
    );
  }
  assert.equal(f.mutations, 0);
});

test("Modrinth unknown environment checksum lookups use bounded batches", async (t) => {
  const files = Array.from({ length: 101 }, (_, index) =>
    unknownPackFile(`mod-${index}`, bytes(`mod-${index}`)),
  );
  const batches = [];
  const f = await fixture(t, {
    type: "modpack",
    request: async (url, init) => {
      if (new URL(url).pathname !== "/v2/version_files") return;
      const batch = JSON.parse(init.body);
      batches.push(batch.hashes.length);
      return Response.json(
        Object.fromEntries(
          files
            .filter((file) => batch.hashes.includes(file.hashes.sha512))
            .map((file) => [
              file.hashes.sha512,
              identifiedPackFile(file, "server_only"),
            ]),
        ),
      );
    },
  });
  configureMrpack(f, files);
  const plan = await f.service.preview({ ...selection, type: "modpack" });
  assert.equal(plan.files.length, 101);
  assert.deepEqual(batches, [100, 1]);
  assert.equal(f.mutations, 0);
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

test("sequential CurseForge updates resolve each required dependency's own compatible file", async (t) => {
  const files = new Map(),
    contents = new Map();
  const addFile = (
    projectId,
    versionId,
    filename,
    value,
    dependencies = [],
  ) => {
    const data = bytes(value);
    const file = {
      id: versionId,
      modId: projectId,
      displayName: filename,
      fileName: filename,
      gameVersions: ["1.21.1", "NeoForge"],
      fileDate: `2026-02-${(versionId % 10) + 10}`,
      downloadUrl: `https://edge.forgecdn.net/${filename}`,
      fileLength: data.length,
      isAvailable: true,
      hashes: [{ algo: 1, value: hashes(data).sha1 }],
      dependencies: dependencies.map((modId) => ({ modId, relationType: 3 })),
    };
    files.set(`${projectId}/${versionId}`, file);
    contents.set(file.downloadUrl, data);
    return data;
  };
  const firstOld = addFile(11, 21, "old.jar", "existing server mod");
  const secondOld = addFile(33, 31, "second-old.jar", "second installed mod");
  addFile(11, 22, "first-new.jar", "first compatible update");
  addFile(33, 32, "second-new.jar", "second compatible update", [55]);
  addFile(55, 52, "dependency-new.jar", "required dependency", [77]);
  addFile(77, 72, "nested-new.jar", "nested required dependency");
  const projects = [11, 33, 55, 77].map((id) => ({
    id,
    gameId: 432,
    classId: 6,
    name: `Fixture mod ${id}`,
  }));
  const f = await fixture(t, {
    request: async (url, init) => {
      if (contents.has(String(url)))
        return new Response(contents.get(String(url)));
      const address = new URL(url),
        parts = address.pathname.split("/");
      if (address.hostname !== "api.curseforge.com") return;
      if (address.pathname === "/v1/categories")
        return Response.json({
          data: [{ id: 6, slug: "mc-mods", name: "Mods" }],
        });
      if (address.pathname === "/v1/mods")
        return Response.json({
          data: projects.filter((p) =>
            JSON.parse(init.body).modIds.includes(p.id),
          ),
        });
      if (parts[2] === "mods") {
        const projectId = Number(parts[3]);
        if (parts.length === 4)
          return Response.json({
            data: projects.find((p) => p.id === projectId),
          });
        if (parts.length === 5) {
          assert.equal(address.searchParams.get("gameVersion"), "1.21.1");
          assert.equal(address.searchParams.get("modLoaderType"), "6");
          return Response.json({
            data: [...files.values()].filter((f) => f.modId === projectId),
          });
        }
        const file = files.get(`${projectId}/${parts[5]}`);
        return file
          ? Response.json({ data: file })
          : new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected CurseForge fixture request ${url}`);
    },
  });
  await fs.writeFile(
    path.join(f.serverDir, "mods", "second-old.jar"),
    secondOld,
  );
  await fs.writeFile(
    path.join(f.dataDir, "launchpad", "installed.json"),
    JSON.stringify([
      {
        path: "mods/old.jar",
        sha512: hashes(firstOld).sha512,
        platform: "curseforge",
        projectId: "11",
        versionId: "21",
        type: "mod",
      },
      {
        path: "mods/second-old.jar",
        sha512: hashes(secondOld).sha512,
        platform: "curseforge",
        projectId: "33",
        versionId: "31",
        type: "mod",
      },
    ]),
  );
  const service = await f.boot();
  await service.settings({ curseforgeApiKey: "fixture-key" });
  for (const [projectId, versionId, replacePath] of [
    ["11", "22", "mods/old.jar"],
    ["33", "32", "mods/second-old.jar"],
  ]) {
    const installed = await service.installed(selection);
    assert.equal(
      installed.items.find((item) => item.projectId === projectId).update.id,
      versionId,
    );
    const plan = await service.preview({
      ...selection,
      platform: "curseforge",
      projectId,
      versionId,
      replacePath,
    });
    assert.equal(
      (await finish(service, { planId: plan.planId, confirmed: true })).status,
      "completed",
    );
  }
  const final = await service.installed({ ...selection, local: true });
  assert.deepEqual(
    final.items.map((item) => [item.projectId, item.versionId]).sort(),
    [
      ["11", "22"],
      ["33", "32"],
      ["55", "52"],
      ["77", "72"],
    ],
  );
  assert.deepEqual(
    (await f.bin.list()).map((item) => item.originalPath).sort(),
    ["mods/old.jar", "mods/second-old.jar"],
  );
  assert.ok(
    !f.requests.some(({ url }) => /\/mods\/(55|77)\/files\/32$/.test(url)),
    "root version IDs never leak into dependencies",
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
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let fingerprint,
    sha1,
    wrongHash = false;
  const f = await fixture(t, {
    request: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/v2/version_files") return Response.json({});
      if (pathname === "/v1/mods") {
        assert.deepEqual(JSON.parse(init.body), { modIds: [11] });
        return Response.json({
          data: [
            {
              id: 11,
              gameId: 432,
              name: "Identified CurseForge Project",
              authors: [{ name: "VerifiedCreator" }],
              logo: {
                thumbnailUrl: "https://media.forgecdn.net/identified.png",
              },
            },
          ],
        });
      }
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
  result = await f.service.installed({
    ...selection,
    loader: "",
    gameVersion: "",
  });
  assert.equal(result.items[0].title, "Identified CurseForge Project");
  assert.equal(result.items[0].author, "VerifiedCreator");
  assert.equal(
    result.items[0].iconUrl,
    "https://media.forgecdn.net/identified.png",
  );
  assert.equal(result.items[0].update, undefined);
  assert.equal(
    f.requests.filter(({ url }) => new URL(url).pathname === "/v1/mods").length,
    1,
  );
  wrongHash = true;
  now += 10 * 60_000 + 1;
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

test("Launchpad advertises only supported provider sorts and rejects unsupported or malformed choices before searching", async (t) => {
  const f = await fixture(t);
  const config = await f.service.config();
  assert.deepEqual(
    config.platforms.find((value) => value.id === "modrinth").sortOptions,
    [
      { id: "downloads", label: "Most downloaded" },
      { id: "relevance", label: "Relevance" },
      { id: "popular", label: "Most followed" },
      { id: "updated", label: "Recently updated" },
      { id: "newest", label: "Newest" },
    ],
  );
  assert.deepEqual(
    config.platforms
      .find((value) => value.id === "curseforge")
      .sortOptions.map((value) => value.id),
    ["popular", "downloads", "updated", "newest", "name"],
  );
  let requests = f.requests.length;
  for (const sort of ["name", "random", null, [], {}, 1, "downloads&offset=0"])
    await assert.rejects(f.service.search({ ...selection, sort }), {
      status: 400,
    });
  assert.equal(f.requests.length, requests);
  await f.service.settings({ curseforgeApiKey: "fixture-key" });
  requests = f.requests.length;
  await assert.rejects(
    f.service.search({
      ...selection,
      platform: "curseforge",
      sort: "relevance",
    }),
    { status: 400 },
  );
  assert.equal(f.requests.length, requests);
  let selected;
  const extra = await f.boot({
    extraProviders: [
      {
        id: "fixturecatalog",
        name: "Fixture catalog",
        types: ["mod"],
        available: true,
        sortOptions: [{ id: "updated", label: "Recently updated" }],
        search: async (input) => {
          selected = input;
          return { projects: [] };
        },
      },
    ],
  });
  assert.deepEqual(
    (await extra.config()).platforms.find(
      (value) => value.id === "fixturecatalog",
    ).sortOptions,
    [{ id: "updated", label: "Recently updated" }],
  );
  await extra.search({
    ...selection,
    platform: "fixturecatalog",
    sort: "updated",
    offset: 40,
  });
  assert.equal(selected.sort, "updated");
  assert.equal(selected.offset, 40);
  await assert.rejects(
    extra.search({
      ...selection,
      platform: "fixturecatalog",
      sort: "downloads",
    }),
    { status: 400 },
  );
});

test("Modrinth sorting is applied upstream before pagination and explicit sorts override query relevance", async (t) => {
  const requested = [];
  const f = await fixture(t, {
    request: async (url) => {
      const address = new URL(url);
      if (address.pathname !== "/v2/search") return;
      const query = address.searchParams;
      requested.push(Object.fromEntries(query));
      const start = Number(query.get("offset")),
        count = Number(query.get("limit"));
      // The provider's whole-catalog ordering intentionally disagrees with title
      // order, so the panel must preserve the returned page without re-sorting.
      const globallySorted = Array.from({ length: 100 }, (_, index) => ({
        project_id: `${query.get("index")}-${99 - index}`,
        title: `Project ${99 - index}`,
        downloads: index,
      }));
      return Response.json({
        hits: globallySorted.slice(start, start + count),
        total_hits: 100,
        offset: start,
        limit: count,
      });
    },
  });
  for (const [sort, expected] of [
    ["relevance", "relevance"],
    ["downloads", "downloads"],
    ["popular", "follows"],
    ["updated", "updated"],
    ["newest", "newest"],
  ]) {
    const result = await f.service.search({
      ...selection,
      query: "camera",
      sort,
      offset: 40,
      limit: 20,
    });
    assert.equal(requested.at(-1).index, expected);
    assert.equal(requested.at(-1).query, "camera");
    assert.deepEqual(JSON.parse(requested.at(-1).facets), [
      ["all_project_types:mod"],
      ["server_side!=unsupported"],
      ["versions:1.21.1"],
      ["categories:neoforge"],
    ]);
    assert.equal(result.total, 100);
    assert.equal(result.offset, 40);
    assert.deepEqual(
      result.projects.map((value) => value.id),
      Array.from({ length: 20 }, (_, index) => `${expected}-${59 - index}`),
    );
  }
  await f.service.search({ ...selection, query: "camera" });
  assert.equal(requested.at(-1).index, "relevance");
  await f.service.search({ ...selection, query: "" });
  assert.equal(requested.at(-1).index, "downloads");
  await f.service.search({ ...selection, query: "camera", sort: "" });
  assert.equal(requested.at(-1).index, "relevance");
});

test("CurseForge applies each supported sort to both upstream pages including alphabetical direction", async (t) => {
  const pages = [];
  const f = await fixture(t, {
    request: async (url) => {
      const address = new URL(url);
      if (address.pathname === "/v1/categories")
        return Response.json({
          data: [{ id: 6, slug: "mc-mods", name: "Mods" }],
        });
      if (address.pathname !== "/v1/mods/search") return;
      const query = Object.fromEntries(address.searchParams);
      pages.push(query);
      const start = Number(query.index),
        count = Number(query.pageSize),
        field = Number(query.sortField);
      const globallySorted = Array.from({ length: 300 }, (_, index) => ({
        id: field * 1000 + 299 - index,
        name: `Project ${299 - index}`,
      }));
      return Response.json({
        data: globallySorted.slice(start, start + count),
        pagination: { totalCount: 300 },
      });
    },
  });
  await f.service.settings({ curseforgeApiKey: "fixture-key" });
  for (const [sort, field, order] of [
    ["popular", 2, "desc"],
    ["downloads", 6, "desc"],
    ["updated", 3, "desc"],
    ["newest", 11, "desc"],
    ["name", 4, "asc"],
    [undefined, 2, "desc"],
  ]) {
    pages.length = 0;
    const result = await f.service.search({
      ...selection,
      platform: "curseforge",
      query: "camera",
      sort,
      offset: 100,
      limit: 100,
    });
    assert.deepEqual(
      pages.map((value) => [
        value.index,
        value.pageSize,
        value.sortField,
        value.sortOrder,
      ]),
      [
        ["100", "50", String(field), order],
        ["150", "50", String(field), order],
      ],
    );
    assert.ok(
      pages.every(
        (value) =>
          value.searchFilter === "camera" &&
          value.gameVersion === "1.21.1" &&
          value.modLoaderType === "6",
      ),
    );
    assert.equal(result.total, 300);
    assert.equal(result.offset, 100);
    assert.deepEqual(
      result.projects.map((value) => value.id),
      Array.from({ length: 100 }, (_, index) =>
        String(field * 1000 + 199 - index),
      ),
    );
  }
});

test("direct pack files and ZIP overrides replace old worlds and startup files through a clean installation", async (t) => {
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
    "Survival/level.dat",
    "config/pack.cfg",
    "custom-start.cmd",
    "mods/server.jar",
  ]);
  assert.equal(
    (
      await finish(service, {
        planId: plan.planId,
        confirmed: true,
        cleanInstall: true,
      })
    ).status,
    "completed",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "Survival", "level.dat"), "utf8"),
    "must not replace world",
  );
  assert.match(
    await fs.readFile(path.join(f.serverDir, "eula.txt"), "utf8"),
    /eula=false/,
  );
  for (const name of ["user_jvm_args.txt", "run.bat", "start.sh"])
    await assert.rejects(fs.stat(path.join(f.serverDir, name)), {
      code: "ENOENT",
    });
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "custom-start.cmd"), "utf8"),
    "replacement launcher",
  );
});

test("pack review selects its required runtime even when an older loader is installed and still rejects client-only dependencies", async (t) => {
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
  const plan = await service.preview({
    ...selection,
    platform: "fixturepack",
    type: "modpack",
  });
  assert.equal(plan.runtime.build, "21.1.200");
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

async function cleanPackFixture(t, overrides = {}) {
  const f = await fixture(t);
  const extra = {
    id: "fixturepack",
    name: "Fixture",
    types: ["modpack"],
    available: true,
    downloadHosts: ["cdn.modrinth.com"],
    resolve: async () => ({
      title: "Clean pack",
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
  };
  const service = await f.boot({ extraProviders: [extra], ...overrides });
  return {
    ...f,
    service,
    input: { ...selection, platform: "fixturepack", type: "modpack" },
  };
}

test("reinstalling identical pack bytes still clears files outside the new pack", async (t) => {
  const f = await cleanPackFixture(t);
  const first = await f.service.preview(f.input);
  assert.equal(
    (
      await finish(f.service, {
        planId: first.planId,
        confirmed: true,
        cleanInstall: true,
      })
    ).status,
    "completed",
  );
  await fs.mkdir(path.join(f.serverDir, "old-world"));
  await fs.writeFile(
    path.join(f.serverDir, "old-world", "level.dat"),
    "old world",
  );
  await fs.writeFile(
    path.join(f.serverDir, "mods", "unrelated.jar"),
    "old mod",
  );
  const second = await f.service.preview(f.input);
  assert.equal(second.files.length, 1);
  assert.equal(
    (
      await finish(f.service, {
        planId: second.planId,
        confirmed: true,
        cleanInstall: true,
      })
    ).status,
    "completed",
  );
  await assert.rejects(fs.stat(path.join(f.serverDir, "old-world")), {
    code: "ENOENT",
  });
  await assert.rejects(
    fs.stat(path.join(f.serverDir, "mods", "unrelated.jar")),
    { code: "ENOENT" },
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "server.jar")),
    f.newer,
  );
});

test("a failed required runtime download leaves all old server files untouched", async (t) => {
  const f = await cleanPackFixture(t, {
    versionsService: {
      builds: async () => ({ builds: [{ id: "21.1.200" }] }),
      stage: async () => {
        throw new Error("runtime checksum failed");
      },
    },
  });
  await fs.writeFile(path.join(f.serverDir, "run.bat"), "original startup");
  const plan = await f.service.preview(f.input);
  const job = await finish(f.service, {
    planId: plan.planId,
    confirmed: true,
    cleanInstall: true,
  });
  assert.equal(job.status, "failed");
  assert.match(job.error, /runtime checksum failed/);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "run.bat"), "utf8"),
    "original startup",
  );
  assert.deepEqual(await f.bin.list(), []);
});

test("a failed receipt write cannot prevent restoring the previous runtime configuration", async (t) => {
  const applied = [];
  const f = await cleanPackFixture(t, {
    applyConfiguration: async (value) => {
      applied.push(value);
    },
  });
  const plan = await f.service.preview(f.input);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (source, target) => {
    if (path.basename(target) === "installed.json")
      throw Object.assign(new Error("receipt disk failure"), { code: "EIO" });
    return rename(source, target);
  });
  const job = await finish(f.service, {
    planId: plan.planId,
    confirmed: true,
    cleanInstall: true,
  });
  assert.equal(job.status, "failed");
  assert.match(job.error, /receipt disk failure.*Recovery needs attention/);
  assert.equal(applied.length, 2);
  assert.equal(applied[0].jar, "runtime.jar");
  assert.equal(applied[1].jar, undefined);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "old.jar")),
    f.old,
  );
});

test("server ZIP runtime metadata accepts exact known formats and rejects ambiguous declarations", async (t) => {
  const f = await fixture(t);
  const entries = async (values) =>
    Promise.all(
      values.map(async ([name, content], index) => {
        const stagedPath = path.join(f.dataDir, `metadata-${index}`);
        await fs.writeFile(stagedPath, content);
        return { path: name, stagedPath, size: Buffer.byteLength(content) };
      }),
    );
  for (const [files, expected] of [
    [
      [
        [
          "manifest.json",
          JSON.stringify({
            minecraft: {
              version: "1.21.1",
              modLoaders: [{ id: "neoforge-21.1.200", primary: true }],
            },
          }),
        ],
      ],
      { loader: "neoforge", loaderVersion: "21.1.200", gameVersion: "1.21.1" },
    ],
    [
      [
        [
          "run.bat",
          "java @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.200/win_args.txt nogui",
        ],
      ],
      { loader: "neoforge", loaderVersion: "21.1.200", gameVersion: "1.21.1" },
    ],
    [
      [["forge-1.12.2-14.23.5.2860-universal.jar", "jar"]],
      { loader: "forge", loaderVersion: "14.23.5.2860", gameVersion: "1.12.2" },
    ],
    [
      [
        [
          "variables.txt",
          "MINECRAFT_VERSION=1.20.1\nMODLOADER=FABRIC\nMODLOADER_VERSION=0.16.14",
        ],
      ],
      { loader: "fabric", loaderVersion: "0.16.14", gameVersion: "1.20.1" },
    ],
  ])
    assert.deepEqual(
      await inferPackRuntime(await entries(files), {
        ...selection,
        gameVersion: expected.gameVersion,
      }),
      expected,
    );
  assert.equal(
    await inferPackRuntime(
      await entries([["mods/forge-1.21.1-52.0.0.jar", "not loader metadata"]]),
      selection,
    ),
    undefined,
  );
  await assert.rejects(
    inferPackRuntime(
      await entries([
        [
          "run.bat",
          "java @libraries/net/neoforged/neoforge/21.1.200/win_args.txt",
        ],
        ["variables.txt", "NEOFORGE_VERSION=21.1.201"],
      ]),
      selection,
    ),
    /conflicting runtime versions/,
  );
});
