import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createLaunchpad } from "./launchpad.mjs";
import { containedSourcePath } from "./import.mjs";

const selection = {
  type: "mod",
  target: "automodpack",
  gameVersion: "1.21.1",
  loader: "neoforge",
};
const modFolder = "automodpack/host-modpack/main/mods";
const message = "No release is listed for Minecraft 1.21.1 and NeoForge.";
const safePath = (root, relative = "") =>
  relative ? containedSourcePath(root, relative) : fs.realpath(root);
async function fixture(
  t,
  updates,
  files = [`${modFolder}/fixture.jar`],
  providerOverrides = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-update-status-test-")),
  );
  const serverDir = path.join(root, "server");
  const dataDir = path.join(root, "data");
  await fs.mkdir(serverDir);
  await fs.mkdir(path.join(dataDir, "launchpad"), { recursive: true });
  const contents = Buffer.from("verified installed fixture");
  const sha512 = createHash("sha512").update(contents).digest("hex");
  const receipts = [];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(serverDir, file)), {
      recursive: true,
    });
    await fs.writeFile(path.join(serverDir, file), contents);
    receipts.push({
      path: file,
      sha512,
      platform: "fixture",
      projectId: "project",
      versionId: "old",
      type: file.includes("/resourcepacks/")
        ? "resourcepack"
        : file.includes("/shaderpacks/")
          ? "shader"
          : "mod",
    });
  }
  await fs.writeFile(
    path.join(dataDir, "launchpad", "installed.json"),
    JSON.stringify(receipts),
  );
  const service = await createLaunchpad({
    serverDir,
    dataDir,
    safePath,
    getServer: async () => ({ status: "offline", ...selection }),
    extraProviders: [
      {
        id: "fixture",
        name: "Fixture",
        types: ["mod", "resourcepack", "shader"],
        updates,
        ...providerOverrides,
      },
    ],
    fetch: async (url) => assert.fail(`Unexpected provider request: ${url}`),
  });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-update-status-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { service, sha512 };
}
const assertUnlisted = (item, issue = message) => {
  assert.equal(item.updateCheck, "unlisted");
  assert.equal(item.updateIssue, issue);
  assert.equal(item.update, undefined);
};

test("unlisted release results retain their meaning through caching, local snapshots, expiry and refresh", async (t) => {
  let now = Date.now(),
    calls = 0,
    mode = "unlisted";
  t.mock.method(Date, "now", () => now);
  const { service } = await fixture(t, async (input, items) => {
    calls++;
    const sha512 = items[0].sha512;
    return mode === "unlisted"
      ? { updates: {}, unlisted: { [sha512]: message }, warnings: [] }
      : {
          updates: {
            [sha512]: mode === "current" ? null : { id: "new", name: "New" },
          },
          warnings: [],
        };
  });
  const first = await service.installed(selection);
  assertUnlisted(first.items[0]);
  assert.deepEqual(first.warnings, []);
  first.items[0].updateIssue = "caller changed its snapshot";
  assertUnlisted((await service.installed(selection)).items[0]);
  assertUnlisted(
    (await service.installed({ ...selection, local: true })).items[0],
  );
  assert.equal(calls, 1);
  now += 5 * 60_000 + 1;
  const expired = await service.installed({ ...selection, local: true });
  assert.equal(expired.items[0].updateCheck, "pending");
  assert.equal(expired.items[0].updateIssue, undefined);
  assertUnlisted((await service.installed(selection)).items[0]);
  assert.equal(calls, 2);
  mode = "update";
  const updated = await service.installed({ ...selection, refresh: true });
  assert.equal(updated.items[0].updateCheck, "checked");
  assert.equal(updated.items[0].updateIssue, undefined);
  assert.equal(updated.items[0].update.id, "new");
  mode = "unlisted";
  assertUnlisted(
    (await service.installed({ ...selection, refresh: true })).items[0],
  );
  mode = "current";
  const current = await service.installed({ ...selection, refresh: true });
  assert.equal(current.items[0].updateCheck, "checked");
  assert.equal(current.items[0].updateIssue, undefined);
  assert.equal(current.items[0].update, undefined);
  assert.equal(calls, 5);
});

test("unlisted caches remain separate for server copies, AutoModpack folders and compatibility selections", async (t) => {
  const calls = [];
  const files = [
    "mods/fixture.jar",
    `${modFolder}/fixture.jar`,
    "automodpack/host-modpack/main/resourcepacks/fixture.zip",
    "automodpack/host-modpack/main/shaderpacks/fixture.zip",
  ];
  const label = (input) =>
    [input.target, input.type, input.gameVersion, input.loader].join(":");
  const { service } = await fixture(
    t,
    async (input, items) => {
      calls.push(label(input));
      const sha512 = items[0].sha512;
      return input.target === "server"
        ? { updates: { [sha512]: null } }
        : { updates: {}, unlisted: { [sha512]: label(input) } };
    },
    files,
  );
  const inputs = [
    { ...selection, target: "server" },
    selection,
    { ...selection, type: "resourcepack", loader: "" },
    { ...selection, type: "shader", loader: "" },
    { ...selection, gameVersion: "1.21.2" },
    { ...selection, loader: "fabric" },
  ];
  for (const input of inputs) {
    const result = await service.installed(input);
    assert.equal(result.items.length, 1);
    if (input.target === "server") {
      assert.equal(result.items[0].updateCheck, "checked");
      assert.equal(result.items[0].updateIssue, undefined);
      assert.equal(result.items[0].path, files[0]);
    } else assertUnlisted(result.items[0], label(input));
  }
  assert.equal(calls.length, inputs.length);
  for (const input of inputs) await service.installed(input);
  assert.equal(calls.length, inputs.length);
});

test("unlisted progress survives background inventory completion and later local copies", async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  t.after(() => release());
  const { service } = await fixture(t, async (input, items) => {
    const result = { updates: {}, unlisted: { [items[0].sha512]: message } };
    input.onProgress(result);
    entered();
    await gate;
    return result;
  });
  await service.installed({ ...selection, background: true });
  await ready;
  const progress = await service.installed(selection);
  assert.equal(progress.checkingUpdates, true);
  assert.deepEqual(progress.progress, { completed: 1, total: 1 });
  assertUnlisted(progress.items[0]);
  assertUnlisted(
    (await service.installed({ ...selection, local: true })).items[0],
  );
  release();
  let complete;
  const deadline = performance.now() + 5_000;
  do {
    complete = await service.installed(selection);
    if (!complete.checkingUpdates) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (performance.now() < deadline);
  assert.equal(complete.checkingUpdates, false);
  assertUnlisted(complete.items[0]);
  assertUnlisted((await service.installed(selection)).items[0]);
});

test("overlapping refreshes preserve unlisted flight results after a later provider failure", async (t) => {
  let release,
    entered,
    enteredSecond,
    calls = 0,
    metadataCalls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const secondReady = new Promise((resolve) => {
    enteredSecond = resolve;
  });
  t.after(() => release());
  const { service } = await fixture(
    t,
    async (input, items) => {
      calls++;
      input.onProgress({
        updates: {},
        unlisted: { [items[0].sha512]: message },
      });
      entered();
      await gate;
      throw new Error("A later batch failed");
    },
    undefined,
    {
      async projectMetadata() {
        if (++metadataCalls === 2) enteredSecond();
        return { projects: [], warnings: [] };
      },
    },
  );
  const first = service.installed(selection);
  await ready;
  const second = service.installed({ ...selection, refresh: true });
  await secondReady;
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  for (const result of results) assertUnlisted(result.items[0]);
  assertUnlisted(
    (await service.installed({ ...selection, local: true })).items[0],
  );
});
