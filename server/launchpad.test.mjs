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
    [8000, 8000],
    "the optional metadata request uses its own eight-second limit",
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
