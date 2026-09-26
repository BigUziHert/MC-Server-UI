import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createLaunchpadMetadataCache } from "./launchpad-metadata-cache.mjs";
import { createLaunchpad } from "./launchpad.mjs";
import { containedSourcePath } from "./import.mjs";

const digest = (value) => createHash("sha512").update(value).digest("hex");
const selection = { type: "mod", loader: "neoforge", gameVersion: "1.21.1" };
const identity = (id = "version") => ({
  platform: "modrinth",
  projectId: "project",
  versionId: id,
  title: "A verified project",
  author: "Author",
  url: "https://modrinth.com/project/project",
});
async function temporary(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-launchpad-cache-")),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-launchpad-cache-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
const cacheOptions = (root, extra = {}) => ({
  pathFor: (relative) => containedSourcePath(root, relative),
  platforms: ["modrinth", "curseforge"],
  ...extra,
});

test("metadata cache persists only bounded positive identities and safe display fields", async (t) => {
  const root = await temporary(t);
  const cache = await createLaunchpadMetadataCache(cacheOptions(root));
  cache.rememberIdentity(digest("unknown"), { platform: null });
  cache.rememberIdentity(digest("bad-id"), {
    ...identity(),
    projectId: "../project",
  });
  cache.rememberIdentity(digest("mod"), {
    ...identity(),
    path: "mods/private.jar",
    stamp: "trusted-stamp",
    update: { id: "new" },
    iconUrl: "javascript:alert(1)",
    author: "bad\nauthor",
  });
  cache.rememberProject(
    "modrinth",
    "project",
    {
      title: "Display",
      author: "Creator",
      token: "secret",
      url: "https://user:password@example.com/",
    },
    Date.now(),
  );
  await cache.close();
  const content = await fs.readFile(
    path.join(root, "metadata-cache.json"),
    "utf8",
  );
  assert.equal(JSON.parse(content).entries.length, 2);
  for (const value of [
    "private.jar",
    "stamp",
    "update",
    "javascript",
    "secret",
    "password",
    "bad\\n",
  ])
    assert.ok(!content.includes(value), value);
  const reopened = await createLaunchpadMetadataCache(cacheOptions(root));
  assert.equal(reopened.identity(digest("mod")).projectId, "project");
  assert.equal(reopened.identity(digest("unknown")), undefined);
  assert.equal(reopened.project("modrinth", "project").value.author, "Creator");
  await reopened.close();

  const bounded = await createLaunchpadMetadataCache(cacheOptions(root));
  for (let index = 0; index < 5000; index++)
    bounded.rememberIdentity(digest(`mod-${index}`), {
      ...identity(`v${index}`),
      title: "x".repeat(512),
      author: "y".repeat(512),
      iconUrl: `https://example.com/${"i".repeat(1900)}`,
    });
  await bounded.close();
  const saved = await fs.readFile(path.join(root, "metadata-cache.json"));
  assert.ok(saved.length <= 4 * 1024 ** 2);
  assert.ok(JSON.parse(saved).entries.length <= 4000);
  const latest = await createLaunchpadMetadataCache(cacheOptions(root));
  assert.equal(latest.identity(digest("mod-0")), undefined);
  assert.equal(latest.identity(digest("mod-4999")).versionId, "v4999");
  await latest.close();
});

test("damaged, oversized, and unavailable metadata caches remain optional", async (t) => {
  const root = await temporary(t);
  for (const content of [
    "not json",
    " ".repeat(4 * 1024 ** 2 + 1),
    JSON.stringify({
      version: 1,
      entries: [
        null,
        {
          kind: "identity",
          sha512: digest("mod"),
          value: { ...identity(), platform: "unknown-provider" },
        },
      ],
    }),
  ]) {
    await fs.writeFile(path.join(root, "metadata-cache.json"), content);
    const cache = await createLaunchpadMetadataCache(cacheOptions(root));
    assert.equal(cache.identity(digest("mod")), undefined);
    cache.rememberIdentity(digest("new"), identity());
    await cache.close();
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, "metadata-cache.json")))
        .entries.length,
      1,
    );
  }
  const cache = await createLaunchpadMetadataCache(
    cacheOptions(root, {
      pathFor: async () => {
        throw Object.assign(new Error("cache inaccessible"), {
          code: "EACCES",
        });
      },
    }),
  );
  cache.rememberIdentity(digest("mod"), identity());
  assert.equal(cache.identity(digest("mod")).projectId, "project");
  await cache.close();
});

test("metadata cache serializes atomic writes and ignores stale generations and closed writers", async (t) => {
  const root = await temporary(t);
  const cache = await createLaunchpadMetadataCache(
    cacheOptions(root, { debounceMs: 1 }),
  );
  let start, release;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const writeFile = fs.writeFile;
  let held = false;
  t.mock.method(fs, "writeFile", async (target, ...args) => {
    if (
      !held &&
      String(target).startsWith(root) &&
      String(target).endsWith(".tmp")
    ) {
      held = true;
      start();
      await blocked;
    }
    return writeFile(target, ...args);
  });
  const oldGeneration = cache.generation;
  cache.rememberIdentity(digest("old"), identity("old"));
  await started;
  cache.clear();
  cache.rememberIdentity(digest("stale"), identity("stale"), oldGeneration);
  cache.rememberIdentity(digest("current"), identity("current"));
  const closing = cache.close();
  cache.rememberIdentity(digest("too late"), identity("late"));
  release();
  await closing;
  const saved = JSON.parse(
    await fs.readFile(path.join(root, "metadata-cache.json")),
  );
  assert.deepEqual(
    saved.entries.map((row) => row.value.versionId),
    ["current"],
  );
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

async function inventoryFixture(t) {
  const root = await temporary(t),
    dataDir = path.join(root, "panel"),
    serverDir = path.join(root, "server");
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(serverDir, "mods"), { recursive: true });
  const requests = [],
    services = [];
  const versions = new Map();
  for (const [id, bytes] of [
    ["first", "first mod bytes"],
    ["other", "other mod bytes"],
  ])
    versions.set(digest(bytes), {
      id,
      project_id: id,
      name: `${id} version`,
      version_number: id,
      game_versions: ["1.21.1"],
      loaders: ["neoforge"],
      date_published: "2026-01-01",
      environment: "server_only",
      files: [
        {
          filename: `${id}.jar`,
          size: bytes.length,
          url: `https://cdn.modrinth.com/${id}.jar`,
          hashes: { sha512: digest(bytes) },
          primary: true,
        },
      ],
    });
  const original = path.join(serverDir, "mods", "manual.jar");
  await fs.writeFile(original, "first mod bytes");
  let teamsUnavailable = false;
  const boot = async (extra = {}) => {
    // A new transport also creates fresh provider caches, matching a process restart.
    const service = await createLaunchpad({
      serverDir,
      dataDir,
      safePath: (root, relative = "") =>
        relative ? containedSourcePath(root, relative) : fs.realpath(root),
      getServer: async () => ({
        status: "offline",
        mode: "live",
        ...selection,
      }),
      withMinecraftMutation: (work) => work(),
      platformConfig: { get: async () => ({}) },
      fetch: async (url, init = {}) => {
        const address = new URL(url);
        requests.push(address.pathname);
        if (
          address.pathname === "/v2/version_files" ||
          address.pathname === "/v2/version_files/update"
        )
          return Response.json(
            Object.fromEntries(
              JSON.parse(init.body)
                .hashes.filter((hash) => versions.has(hash))
                .map((hash) => [hash, versions.get(hash)]),
            ),
          );
        if (address.pathname === "/v2/versions")
          return Response.json(
            [...versions.values()].filter((version) =>
              JSON.parse(address.searchParams.get("ids")).includes(version.id),
            ),
          );
        if (address.pathname === "/v2/projects")
          return Response.json(
            JSON.parse(address.searchParams.get("ids")).map((id) => ({
              id,
              title: `${id} project`,
              team: `team-${id}`,
              icon_url: `https://cdn.modrinth.com/${id}.png`,
            })),
          );
        if (address.pathname === "/v2/teams") {
          if (teamsUnavailable)
            return new Response("temporary outage", { status: 503 });
          return Response.json(
            JSON.parse(address.searchParams.get("ids")).map((team_id) => [
              {
                team_id,
                accepted: true,
                role: "Owner",
                user: { username: "CacheAuthor" },
              },
            ]),
          );
        }
        throw new Error(`Unexpected provider request ${url}`);
      },
      ...extra,
    });
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) await service.close();
  });
  return {
    root,
    dataDir,
    serverDir,
    original,
    boot,
    requests,
    setTeamsUnavailable: (value) => {
      teamsUnavailable = value;
    },
  };
}

test("restarting Launchpad reuses verified identities and project display without persisting updates or file stamps", async (t) => {
  const f = await inventoryFixture(t);
  const first = await f.boot();
  const result = await first.installed(selection);
  assert.equal(result.items[0].title, "first project");
  assert.equal(result.items[0].author, "CacheAuthor");
  assert.equal(
    f.requests.filter((url) => url === "/v2/version_files").length,
    1,
  );
  await first.close();
  const cached = await fs.readFile(
    path.join(f.dataDir, "launchpad", "metadata-cache.json"),
    "utf8",
  );
  assert.ok(!cached.includes("manual.jar"));
  assert.ok(!cached.includes("update"));
  assert.ok(!cached.includes("stamp"));
  assert.deepEqual(await first.snapshotInstalled(), []);
  f.requests.length = 0;
  const restarted = await f.boot();
  const quick = await restarted.installed({
    ...selection,
    local: true,
    quick: true,
  });
  assert.equal(quick.items[0].platform, null);
  assert.equal(quick.items[0].sha512, undefined);
  const local = await restarted.installed({ ...selection, local: true });
  assert.equal(local.items[0].sha512, digest("first mod bytes"));
  assert.equal(local.items[0].title, "first project");
  assert.deepEqual(f.requests, []);
  const checked = await restarted.installed({ ...selection, refresh: true });
  assert.equal(checked.items[0].author, "CacheAuthor");
  assert.equal(checked.items[0].updateCheck, "checked");
  assert.ok(f.requests.includes("/v2/version_files/update"));
  assert.ok(!f.requests.includes("/v2/version_files"));
  assert.ok(!f.requests.includes("/v2/projects"));
  assert.ok(!f.requests.includes("/v2/teams"));
});

test("same-path same-size changes cannot inherit a persisted identity even with the old modified time", async (t) => {
  const f = await inventoryFixture(t);
  const first = await f.boot();
  await first.installed(selection);
  await first.close();
  const stat = await fs.stat(f.original);
  await fs.writeFile(f.original, "other mod bytes");
  await fs.utimes(f.original, stat.atime, stat.mtime);
  const restarted = await f.boot();
  const local = await restarted.installed({ ...selection, local: true });
  assert.equal(local.items[0].sha512, digest("other mod bytes"));
  assert.equal(local.items[0].platform, null);
  f.requests.length = 0;
  const checked = await restarted.installed(selection);
  assert.equal(checked.items[0].projectId, "other");
  assert.ok(f.requests.includes("/v2/version_files"));
});

test("partial project metadata failures do not become fresh persistent author results", async (t) => {
  const f = await inventoryFixture(t);
  f.setTeamsUnavailable(true);
  const first = await f.boot();
  const partial = await first.installed(selection);
  assert.equal(partial.items[0].title, "first project");
  assert.equal(partial.items[0].author, undefined);
  assert.ok(
    partial.warnings.some((warning) => warning.includes("project details")),
  );
  await first.close();
  f.setTeamsUnavailable(false);
  f.requests.length = 0;
  const restarted = await f.boot();
  const complete = await restarted.installed(selection);
  assert.equal(complete.items[0].author, "CacheAuthor");
  assert.ok(f.requests.includes("/v2/projects"));
  assert.ok(f.requests.includes("/v2/teams"));
  assert.ok(!f.requests.includes("/v2/version_files"));
});

test("expired project display metadata refreshes without reidentifying unchanged files", async (t) => {
  const f = await inventoryFixture(t);
  const first = await f.boot();
  await first.installed(selection);
  await first.close();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 10 * 60_000 + 1);
  f.requests.length = 0;
  const restarted = await f.boot();
  const result = await restarted.installed(selection);
  assert.equal(result.items[0].author, "CacheAuthor");
  assert.ok(!f.requests.includes("/v2/version_files"));
  assert.ok(f.requests.includes("/v2/projects"));
});

test("cache write errors cannot fail inventory or shutdown and preserve installed bytes", async (t) => {
  const f = await inventoryFixture(t);
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (source, destination) => {
    if (
      String(destination) ===
      path.join(f.dataDir, "launchpad", "metadata-cache.json")
    )
      throw Object.assign(new Error("cache sharing violation"), {
        code: "EPERM",
      });
    return rename(source, destination);
  });
  const service = await f.boot();
  const result = await service.installed(selection);
  assert.equal(result.items[0].title, "first project");
  assert.deepEqual(result.warnings, []);
  await service.close();
  assert.equal(await fs.readFile(f.original, "utf8"), "first mod bytes");
  assert.deepEqual(
    (await fs.readdir(path.join(f.dataDir, "launchpad"))).filter((name) =>
      name.endsWith(".tmp"),
    ),
    [],
  );
});

test("clearing inventory while identification is pending cannot republish stale cache records", async (t) => {
  const f = await inventoryFixture(t);
  let reached, resume;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const service = await f.boot({
    fetch: async (url) => {
      if (new URL(url).pathname === "/v2/version_files") {
        reached();
        await gate;
        return Response.json({
          [digest("first mod bytes")]: {
            id: "first",
            project_id: "first",
            name: "First",
            files: [{ hashes: { sha512: digest("first mod bytes") } }],
          },
        });
      }
      if (new URL(url).pathname === "/v2/projects")
        return Response.json([{ id: "first", title: "First project" }]);
      return Response.json([]);
    },
  });
  const pending = service.installed({ type: "mod" });
  await entered;
  await service.clearInstalled();
  resume();
  await pending;
  await service.close();
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(f.dataDir, "launchpad", "metadata-cache.json"),
      ),
    ).entries,
    [],
  );
});
