import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { catalogSettings } from "./catalog-settings.mjs";
import { createLaunchpad } from "./launchpad.mjs";
import { createCoreProviders } from "./launchpad-providers.mjs";

test("legacy credentials migrate once and explicit clearing remains shared across servers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-catalog-settings-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("mc-catalog-settings-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const safePath = async (base, relative) => path.join(base, relative);
  const legacy = path.join(root, "legacy.json");
  await fs.writeFile(
    legacy,
    JSON.stringify({ curseforgeApiKey: "legacy-fixture-key" }),
  );
  const first = catalogSettings(root, safePath, [legacy]);
  const second = catalogSettings(root, safePath);
  assert.equal((await first.get()).curseforgeApiKey, "legacy-fixture-key");
  assert.equal((await second.get()).curseforgeApiKey, "legacy-fixture-key");
  await second.set({ curseforgeApiKey: null });
  assert.equal((await first.get()).curseforgeApiKey, null);
  const setting = first.set({ curseforgeApiKey: "replacement-fixture-key" });
  const reading = second.get();
  await setting;
  assert.equal((await reading).curseforgeApiKey, "replacement-fixture-key");
});

test("saving a shared key invalidates every subscribed catalog and close removes the subscription", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-catalog-settings-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("mc-catalog-settings-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const safePath = async (base, relative) => path.join(base, relative);
  const first = catalogSettings(root, safePath),
    second = catalogSettings(root, safePath);
  await first.set({ curseforgeApiKey: "old-key" });
  let requests = 0,
    notifications = 0;
  const unsubscribe = await second.subscribe(() => notifications++);
  const fetch = async (_url, options) => {
    if (String(_url).includes("/categories?"))
      return Response.json({ data: [{ id: 6, slug: "mods" }] });
    if (String(_url).includes("/tag/game_version")) return Response.json([]);
    requests++;
    return Response.json({
      data: [{ id: 1, name: options.headers["x-api-key"], summary: "fixture" }],
      pagination: { totalCount: 1 },
    });
  };
  const catalogs = await Promise.all(
    [first, second].map((platformConfig) =>
      createLaunchpad({
        catalogOnly: true,
        platformConfig,
        fetch,
        safePath,
        getServer: async () => ({ status: "offline" }),
      }),
    ),
  );
  t.after(async () => {
    unsubscribe();
    await Promise.all(catalogs.map((value) => value.close()));
  });
  const selection = {
    platform: "curseforge",
    type: "mod",
    query: "library",
    limit: 20,
  };
  for (const catalog of catalogs)
    assert.equal(
      (await catalog.search(selection)).projects[0].title,
      "old-key",
    );
  assert.equal(requests, 2);
  await catalogs[0].settings({ curseforgeApiKey: "new-key" });
  assert.equal(notifications, 1);
  for (const catalog of catalogs)
    assert.equal(
      (await catalog.search(selection)).projects[0].title,
      "new-key",
    );
  assert.equal(requests, 4);
  unsubscribe();
  await first.set({ curseforgeApiKey: null });
  assert.equal(notifications, 1);
});

test("provider invalidation clears credential failure cooldowns immediately", async () => {
  let valid = false,
    calls = 0;
  const provider = createCoreProviders({
    key: async () => "fixture",
    fetch: async () => {
      calls++;
      return valid
        ? Response.json({
            data: [{ id: 1, gameId: 432, name: "Recovered project" }],
          })
        : new Response("Denied", { status: 403 });
    },
  }).find((value) => value.id === "curseforge");
  assert.equal((await provider.projectMetadata(["1"])).warnings.length, 1);
  valid = true;
  assert.equal((await provider.projectMetadata(["1"])).projects.length, 0);
  assert.equal(calls, 1);
  provider.invalidateCatalogCaches();
  assert.equal(
    (await provider.projectMetadata(["1"])).projects[0].title,
    "Recovered project",
  );
  assert.equal(calls, 2);
});
