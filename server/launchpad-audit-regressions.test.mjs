import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createLaunchpad } from "./launchpad.mjs";
import { createCoreProviders } from "./launchpad-providers.mjs";
import { createExtraProviders } from "./launchpad-extra.mjs";
import { containedSourcePath } from "./import.mjs";

for (const limit of [5, 10, 50, 75, 100])
  test(`CurseForge canonical paging respects its 10000-result window at page size ${limit}`, async () => {
    const pages = [];
    const provider = createCoreProviders({
      key: async () => "fixture",
      fetch: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/categories"))
          return Response.json({ data: [{ id: 5, slug: "bukkit-plugins" }] });
        const index = Number(parsed.searchParams.get("index")),
          size = Number(parsed.searchParams.get("pageSize"));
        pages.push({ index, size });
        assert.ok(index + size <= 10000);
        return Response.json({
          data: Array.from({ length: size }, (_, n) => ({
            id: index + n,
            name: `Item ${index + n}`,
          })),
          pagination: { totalCount: 12000 },
        });
      },
    }).find((p) => p.id === "curseforge");
    const result = await provider.search({
      type: "plugin",
      query: "",
      offset: 10000,
      limit,
    });
    assert.equal(result.total, 10000);
    assert.equal(result.offset, Math.floor(9999 / limit) * limit);
    assert.equal(result.projects.length, 10000 - result.offset);
  });

test("extra-provider cancellation keeps another subscriber alive and stops an abandoned hydration", async () => {
  const first = new AbortController(),
    second = new AbortController();
  let finish,
    receivedSignal,
    requests = 0;
  const provider = createExtraProviders({
    fetch: async (_url, { signal }) => {
      receivedSignal = signal;
      requests++;
      return new Promise((resolve, reject) => {
        finish = () => resolve(Response.json({ packs: [] }));
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  }).find((p) => p.id === "ftb");
  const options = {
    type: "modpack",
    query: "",
    offset: 0,
    limit: 10,
    refresh: true,
  };
  const a = provider.search({ ...options, signal: first.signal });
  const failed = assert.rejects(a, { name: "AbortError" });
  const b = provider.search({ ...options, signal: second.signal });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  first.abort();
  await failed;
  assert.equal(receivedSignal.aborted, false);
  finish();
  assert.equal((await b).total, 0);
  assert.equal(requests, 1);
  const last = new AbortController();
  finish = null;
  const c = provider.search({ ...options, signal: last.signal });
  const cancelled = assert.rejects(c, { name: "AbortError" });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  last.abort();
  await cancelled;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receivedSignal.aborted, true);
});

const directory = os.tmpdir();
const input = {
  platform: "audit",
  type: "plugin",
  projectId: "11",
  versionId: "22",
  gameVersion: "1.21.1",
  loader: "paper",
};
const content = Buffer.from("audit plugin bytes, never executed");
const digest = createHash("sha1").update(content).digest("hex");
const safePath = (root, name = "") =>
  name ? containedSourcePath(root, name) : fs.realpath(root);
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(directory, "fixture-"));
  const serverDir = path.join(root, "server"),
    dataDir = path.join(root, "panel");
  await fs.mkdir(serverDir);
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(serverDir, "preserved.txt"), "original");
  const service = await createLaunchpad({
    serverDir,
    dataDir,
    safePath,
    getServer: async () => ({
      status: "offline",
      gameVersion: "1.21.1",
      loader: "paper",
      software: "Paper",
    }),
    withMinecraftMutation: async (work) => work(),
    recycle: async () => {
      throw new Error("No existing files should be recycled");
    },
    restore: async () => {},
    ...overrides,
  });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(path.resolve(root)), directory);
    assert.ok(path.basename(root).startsWith("fixture-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { service, root, serverDir, dataDir };
}
async function finished(service, id) {
  for (let n = 0; n < 500; n++) {
    const { job } = service.job(id);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Fixture job did not finish");
}

test("Regression L1: retry after a mid-body failure removes its owned partial and succeeds", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    extraProviders: [
      {
        id: "audit",
        name: "Audit provider",
        types: ["plugin"],
        available: true,
        downloadHosts: ["cdn.modrinth.com"],
        async resolve() {
          return {
            title: "Audit plugin",
            versionName: "22",
            files: [
              {
                path: "audit.jar",
                url: "https://cdn.modrinth.com/audit.jar",
                size: content.length,
                hashes: { sha1: digest },
              },
            ],
            dependencies: [],
            warnings: [],
          };
        },
      },
    ],
    fetch: async (url) => {
      assert.equal(String(url), "https://cdn.modrinth.com/audit.jar");
      if (++attempts === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(content.subarray(0, 5));
              setTimeout(
                () => controller.error(new Error("fixture connection reset")),
                15,
              );
            },
          }),
        );
      return new Response(content);
    },
  });
  const plan = await f.service.preview(input);
  const first = await finished(
    f.service,
    (await f.service.install({ planId: plan.planId, confirmed: true })).job.id,
  );
  assert.equal(first.status, "failed");
  assert.equal(first.retryable, true);
  await assert.rejects(
    fs.stat(path.join(f.dataDir, "launchpad", plan.planId, "download-0")),
    { code: "ENOENT" },
  );
  const second = await finished(
    f.service,
    (await f.service.install(first.retryInput)).job.id,
  );
  assert.equal(second.status, "completed");
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "plugins", "audit.jar")),
    content,
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "preserved.txt"), "utf8"),
    "original",
  );
});

function curseFixture({ restricted = false } = {}) {
  const requests = [];
  const request = async (url, init = {}) => {
    const parsed = new URL(url),
      headers = new Headers(init.headers);
    requests.push({
      host: parsed.hostname,
      path: parsed.pathname,
      keyPresent: headers.has("x-api-key"),
    });
    if (parsed.hostname === "edge.forgecdn.net")
      return headers.get("x-api-key") === "audit-authorized-fixture-key"
        ? new Response(content)
        : new Response("API key required", { status: 401 });
    assert.equal(headers.get("x-api-key"), "audit-authorized-fixture-key");
    if (parsed.pathname === "/v1/categories")
      return Response.json({ data: [{ id: 5, slug: "bukkit-plugins" }] });
    if (parsed.pathname === "/v1/mods/11")
      return Response.json({
        data: {
          id: 11,
          gameId: 432,
          classId: 5,
          name: "Audit plugin",
          allowModDistribution: !restricted,
        },
      });
    if (parsed.pathname === "/v1/mods/11/files/22")
      return Response.json({
        data: {
          id: 22,
          modId: 11,
          fileName: "audit.jar",
          displayName: "Audit 22",
          gameVersions: ["1.21.1", "Bukkit"],
          fileDate: "2026-09-01",
          isAvailable: true,
          downloadUrl: "https://edge.forgecdn.net/files/1/2/audit.jar",
          fileLength: content.length,
          hashes: [{ algo: 1, value: digest }],
        },
      });
    throw new Error("Unexpected fixture request " + url);
  };
  return { request, requests };
}

test("accepted installation cancellation aborts its transfer before server mutation", async (t) => {
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const f = await fixture(t, {
    extraProviders: [
      {
        id: "audit",
        name: "Audit",
        types: ["plugin"],
        available: true,
        downloadHosts: ["cdn.modrinth.com"],
        resolve: async () => ({
          title: "Cancelled plugin",
          versionName: "22",
          files: [
            {
              path: "audit.jar",
              url: "https://cdn.modrinth.com/audit.jar",
              size: content.length,
              hashes: { sha1: digest },
            },
          ],
          warnings: [],
        }),
      },
    ],
    fetch: async (_url, { signal }) => {
      began();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const plan = await f.service.preview(input);
  const { job } = await f.service.install({
    planId: plan.planId,
    confirmed: true,
  });
  await started;
  assert.equal((await f.service.cancelInstall(job.id)).job.cancellable, false);
  const final = await finished(f.service, job.id);
  assert.equal(final.cancelled, true);
  assert.equal(final.retryable, false);
  assert.match(final.message, /Installation cancelled/);
  await assert.rejects(fs.stat(path.join(f.serverDir, "plugins/audit.jar")), {
    code: "ENOENT",
  });
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "preserved.txt"), "utf8"),
    "original",
  );
});
test("Regression L2: authorized key reaches CurseForge CDN without entering public results", async (t) => {
  const fixtureRequest = curseFixture();
  const f = await fixture(t, {
    fetch: fixtureRequest.request,
    platformConfig: {
      get: async () => ({ curseforgeApiKey: "audit-authorized-fixture-key" }),
    },
  });
  const plan = await f.service.preview({ ...input, platform: "curseforge" });
  const job = await finished(
    f.service,
    (await f.service.install({ planId: plan.planId, confirmed: true })).job.id,
  );
  assert.equal(job.status, "completed");
  assert.ok(
    !JSON.stringify({ plan, job }).includes("audit-authorized-fixture-key"),
  );
  assert.ok(
    fixtureRequest.requests
      .filter((x) => x.host === "api.curseforge.com")
      .every((x) => x.keyPresent),
  );
  assert.equal(
    fixtureRequest.requests.find((x) => x.host === "edge.forgecdn.net")
      .keyPresent,
    true,
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "plugins", "audit.jar")),
    content,
  );
});
test("Regression C3: explicit author denial is honored even with a download URL", async () => {
  const f = curseFixture({ restricted: true });
  const provider = createCoreProviders({
    fetch: f.request,
    key: async () => "audit-authorized-fixture-key",
  }).find((p) => p.id === "curseforge");
  await assert.rejects(
    provider.resolve({ ...input, platform: "curseforge" }),
    /author restricts/,
  );
});
test("Regression L3: non-CurseForge catalog pages beyond 9900 remain distinct", async (t) => {
  const calls = [];
  const f = await fixture(t, {
    extraProviders: [
      {
        id: "audit",
        name: "Audit",
        types: ["plugin"],
        available: true,
        async search(selection) {
          calls.push(selection.offset);
          return {
            projects: [{ id: String(selection.offset) }],
            total: 12000,
            offset: selection.offset,
            limit: selection.limit,
          };
        },
      },
    ],
  });
  const a = await f.service.search({ ...input, offset: 9900, limit: 100 });
  const b = await f.service.search({ ...input, offset: 10000, limit: 100 });
  assert.notEqual(b.projects[0].id, a.projects[0].id);
  assert.equal(b.total, 12000);
  assert.deepEqual(calls, [9900, 10000]);
});
test("Regression L4: CurseForge update retries honor the provider Retry-After deadline", async (t) => {
  let now = Date.now(),
    fileRequests = 0;
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t, {
    platformConfig: { get: async () => ({ curseforgeApiKey: "fixture-only" }) },
    fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/mods")
        return Response.json({
          data: [{ id: 11, gameId: 432, name: "Audit plugin" }],
        });
      if (u.pathname === "/v1/mods/11/files") {
        fileRequests++;
        return new Response("Rate limited", {
          status: 429,
          headers: { "retry-after": "300" },
        });
      }
      throw new Error("Unexpected rate-limit request " + url);
    },
  });
  await fs.mkdir(path.join(f.serverDir, "plugins"));
  await fs.writeFile(path.join(f.serverDir, "plugins", "audit.jar"), content);
  await f.service.restoreInstalled([
    {
      path: "plugins/audit.jar",
      sha512: createHash("sha512").update(content).digest("hex"),
      platform: "curseforge",
      type: "plugin",
      projectId: "11",
      versionId: "22",
    },
  ]);
  let result = await f.service.installed({ ...input, platform: "curseforge" });
  assert.equal(fileRequests, 1);
  assert.equal(result.items[0].updateCheck, "unavailable");
  now += 61000;
  result = await f.service.installed({
    ...input,
    platform: "curseforge",
    refresh: true,
  });
  assert.equal(fileRequests, 1);
  assert.equal(result.items[0].updateCheck, "unavailable");
  now += 240000;
  await f.service.installed({
    ...input,
    platform: "curseforge",
    refresh: true,
  });
  assert.equal(fileRequests, 2);
});
test("Regression L6: FTB forced refresh revalidates catalog, releases and installed updates", async (t) => {
  let revision = 1,
    requests = 0;
  const provider = createExtraProviders({
    fetch: async (url) => {
      requests++;
      const u = new URL(url);
      if (u.pathname.endsWith("/popular/installs/500"))
        return Response.json({ packs: [1] });
      if (u.pathname.endsWith("/modpack/1"))
        return Response.json({
          id: 1,
          name: `Pack revision ${revision}`,
          versions: Array.from({ length: revision }, (_, i) => ({
            id: i + 1,
            name: `Release ${i + 1}`,
            released: i + 1,
            targets: [
              { type: "game", name: "minecraft", version: "1.21.1" },
              { type: "modloader", name: "neoforge", version: "21.1.1" },
            ],
          })),
        });
      throw new Error("Unexpected FTB request " + url);
    },
  }).find((p) => p.id === "ftb");
  const selection = {
    platform: "ftb",
    type: "modpack",
    projectId: "1",
    gameVersion: "1.21.1",
    loader: "neoforge",
    query: "",
    offset: 0,
    limit: 10,
  };
  const f = await fixture(t, { extraProviders: [provider] });
  await f.service.restoreInstalled([
    {
      type: "modpack",
      pack: true,
      platform: "ftb",
      projectId: "1",
      versionId: "1",
      title: "Pack revision 1",
    },
  ]);
  const old = await provider.search(selection);
  assert.equal(
    (await f.service.installed(selection)).items[0].updateCheck,
    "checked",
  );
  revision = 2;
  const fresh = await provider.search({ ...selection, refresh: true });
  const releases = await provider.versions({ ...selection, refresh: true });
  const updates = await f.service.installed({ ...selection, refresh: true });
  assert.notEqual(fresh.projects[0].title, old.projects[0].title);
  assert.equal(releases[0].id, "2");
  assert.ok(requests > 2);
  assert.equal(updates.items[0].updateCheck, "checked");
  assert.equal(updates.items[0].update.id, "2");
});
test("Regression L7: aborted Modrinth catalog search never dispatches a provider request", async () => {
  const controller = new AbortController();
  controller.abort();
  let requested = 0,
    receivedAborted;
  const provider = createCoreProviders({
    fetch: async (_url, init) => {
      requested++;
      receivedAborted = init.signal.aborted;
      return Response.json({ hits: [], total_hits: 0, offset: 0, limit: 10 });
    },
  }).find((p) => p.id === "modrinth");
  await assert.rejects(
    provider.search({
      type: "mod",
      query: "fixture",
      offset: 0,
      limit: 10,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(requested, 0);
  assert.equal(receivedAborted, undefined);
});
