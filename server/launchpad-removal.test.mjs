import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { createLaunchpad } from "./launchpad.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { containedSourcePath } from "./import.mjs";

const safePath = (root, relative = "") =>
  relative ? containedSourcePath(root, relative) : fs.realpath(root);
const hash = (value) => createHash("sha512").update(value).digest("hex");
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function zip(entries) {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename),
      data = Buffer.from(value);
    const local = Buffer.alloc(30),
      row = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    row.writeUInt32LE(0x02014b50);
    row.writeUInt16LE(0x314, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt32LE(crc32(data), 16);
    row.writeUInt32LE(data.length, 20);
    row.writeUInt32LE(data.length, 24);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt32LE((0o100644 << 16) >>> 0, 38);
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
function mod(loader, id, dependencies = [], extra = {}) {
  if (loader === "fabric" || loader === "quilt") {
    const metadata = {
      schemaVersion: 1,
      id,
      version: "1.0",
      name: id,
      depends: Object.fromEntries(dependencies.map((value) => [value, "*"])),
      ...extra,
    };
    return zip([["fabric.mod.json", JSON.stringify(metadata)]]);
  }
  const declaration = [
    'modLoader="javafml"',
    'loaderVersion="[1,)"',
    'license="MIT"',
    "[[mods]]",
    `modId="${id}"`,
    'version="1.0"',
    `displayName="${id}"`,
    ...dependencies.flatMap((value) => [
      `[[dependencies.${id}]]`,
      `modId="${value.id ?? value}"`,
      loader === "neoforge"
        ? `type="${value.type ?? "required"}"`
        : `mandatory=${value.mandatory ?? true}`,
      'versionRange="[1,)"',
      `side="${value.side ?? "BOTH"}"`,
    ]),
  ].join("\n");
  return zip([
    [
      `META-INF/${loader === "neoforge" ? "neoforge.mods.toml" : "mods.toml"}`,
      declaration,
    ],
  ]);
}
async function fixture(
  t,
  { loader = "neoforge", files = {}, ...options } = {},
) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, "mc-removal-test-"));
  const serverDir = path.join(root, "server"),
    dataDir = path.join(root, "panel");
  await fs.mkdir(path.join(serverDir, "mods"), { recursive: true });
  await fs.mkdir(dataDir);
  for (const [name, contents] of Object.entries(files))
    await fs.writeFile(path.join(serverDir, "mods", name), contents);
  const bin = await createRecycleBin({ serverDir, dataDir, safePath });
  const state = {
    server: {
      status: "offline",
      mode: "live",
      loader,
      gameVersion: "1.21.1",
      world: "world",
    },
    mutations: 0,
    locked: false,
    recycleGate: null,
    downloadGate: null,
    network: [],
  };
  const payload = mod(loader, "installed");
  const selection = {
    platform: "fixture",
    type: "mod",
    projectId: "installed",
    versionId: "v1",
    loader,
    gameVersion: "1.21.1",
  };
  const service = await createLaunchpad({
    serverDir,
    dataDir,
    safePath,
    getServer: async () => state.server,
    recycle: async (relative) => {
      if (state.recycleGate) {
        state.recycleGate.entered.resolve();
        await state.recycleGate.release.promise;
      }
      return bin.recycle(relative);
    },
    restore: (id) => bin.restore(id),
    withMinecraftMutation: async (work) => {
      if (state.locked)
        throw Object.assign(new Error("Mutation is locked"), { status: 409 });
      state.locked = true;
      state.mutations++;
      try {
        return await work();
      } finally {
        state.locked = false;
      }
    },
    fetch: async (url) => {
      state.network.push(String(url));
      if (String(url) === "https://cdn.modrinth.com/installed.jar") {
        if (state.downloadGate) {
          state.downloadGate.entered.resolve();
          await state.downloadGate.release.promise;
        }
        return new Response(payload);
      }
      if (new URL(url).pathname === "/v2/version_files")
        return Response.json({});
      throw new Error(`Unexpected network access: ${url}`);
    },
    extraProviders: [
      {
        id: "fixture",
        name: "Fixture catalog",
        types: ["mod"],
        available: true,
        downloadHosts: ["cdn.modrinth.com"],
        resolve: async () => ({
          title: "Installed mod",
          versionName: "1.0",
          dependencies: [],
          files: [
            {
              path: "installed.jar",
              size: payload.length,
              hashes: { sha512: hash(payload) },
              url: "https://cdn.modrinth.com/installed.jar",
            },
          ],
        }),
      },
    ],
    ...options,
  });
  t.after(async () => {
    state.recycleGate?.release.resolve();
    state.downloadGate?.release.resolve();
    await service.close();
    assert.equal(path.dirname(root), temp);
    assert.match(path.basename(root), /^mc-removal-test-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    serverDir,
    dataDir,
    service,
    bin,
    state,
    selection,
    payload,
    read: (relative) => fs.readFile(path.join(serverDir, relative)),
    write: (relative, bytes) =>
      fs.writeFile(path.join(serverDir, relative), bytes),
    receipts: async () =>
      JSON.parse(
        await fs.readFile(
          path.join(dataDir, "launchpad", "installed.json"),
          "utf8",
        ),
      ),
  };
}
async function finish(service, id) {
  for (let i = 0; i < 200; i++) {
    const { job } = service.job(id);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Installation fixture did not finish");
}
async function install(f) {
  const plan = await f.service.preview(f.selection);
  const { job } = await f.service.install({
    planId: plan.planId,
    confirmed: true,
  });
  const result = await finish(f.service, job.id);
  assert.equal(result.status, "completed", result.error);
}

for (const loader of ["neoforge", "forge", "fabric", "quilt"]) {
  test(`${loader} removal blocks installed required dependents without any provider request`, async (t) => {
    const library = mod(loader, "library"),
      consumer = mod(loader, "consumer", ["library"]);
    const f = await fixture(t, {
      loader,
      files: { "library.jar": library, "consumer.jar": consumer },
    });
    const result = await f.service.removalPreview({ path: "mods/library.jar" });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.dependents, [
      { path: "mods/consumer.jar", title: "consumer" },
    ]);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.planId, undefined);
    await assert.rejects(
      f.service.remove({ planId: result.planId, confirmed: true }),
      { status: 409 },
    );
    assert.deepEqual(await f.read("mods/library.jar"), library);
    assert.deepEqual(await f.bin.list(), []);
    assert.deepEqual(f.state.network, []);
    assert.equal(f.state.mutations, 0);
  });
}

for (const loader of ["neoforge", "forge", "fabric"]) {
  test(`${loader} optional and client-only dependencies do not prevent removal`, async (t) => {
    const files = { "library.jar": mod(loader, "library") };
    if (loader === "fabric") {
      files["optional.jar"] = mod(loader, "optional", [], {
        suggests: { library: "*" },
        recommends: { library: "*" },
      });
      files["client.jar"] = mod(loader, "client", ["library"], {
        environment: "client",
      });
    } else {
      files["optional.jar"] = mod(loader, "optional", [
        { id: "library", type: "optional", mandatory: false },
      ]);
      files["client.jar"] = mod(loader, "client", [
        { id: "library", side: "CLIENT" },
      ]);
    }
    const f = await fixture(t, { loader, files });
    const plan = await f.service.removalPreview({ path: "mods/library.jar" });
    assert.equal(plan.blocked, false);
    const result = await f.service.remove({
      planId: plan.planId,
      confirmed: true,
    });
    assert.equal(result.recycled.originalPath, "mods/library.jar");
    await assert.rejects(f.read("mods/library.jar"), { code: "ENOENT" });
    for (const name of ["optional.jar", "client.jar"])
      assert.deepEqual(await f.read(`mods/${name}`), files[name]);
  });
}

test("removing a consumer retains its shared dependencies, other mods and configuration", async (t) => {
  const files = {
    "library.jar": mod("neoforge", "library"),
    "consumer.jar": mod("neoforge", "consumer", ["library"]),
    "other.jar": mod("neoforge", "other", ["library"]),
  };
  const events = [];
  const f = await fixture(t, {
    files,
    audit: async (...event) => events.push(event),
  });
  await fs.mkdir(path.join(f.serverDir, "config"));
  await f.write("config/consumer.toml", "keep configuration\n");
  const plan = await f.service.removalPreview({ path: "mods/consumer.jar" });
  assert.equal(plan.blocked, false);
  assert.deepEqual(
    plan.files.map((value) => value.path),
    ["mods/consumer.jar"],
  );
  assert.deepEqual(events, []);
  await f.service.remove({ planId: plan.planId, confirmed: true });
  assert.deepEqual(events, [
    ["Mod deleted", "mods/consumer.jar moved to Recycle Bin."],
  ]);
  for (const name of ["library.jar", "other.jar"])
    assert.deepEqual(await f.read(`mods/${name}`), files[name]);
  assert.equal(
    (await f.read("config/consumer.toml")).toString(),
    "keep configuration\n",
  );
  assert.equal((await f.bin.list()).length, 1);
});

test("bundled mod IDs and dependencies protect their containing JARs", async (t) => {
  const container = (id, nested) =>
    zip([
      [
        "fabric.mod.json",
        JSON.stringify({
          schemaVersion: 1,
          id,
          version: "1.0",
          jars: [{ file: "libs/nested.jar" }],
        }),
      ],
      ["libs/nested.jar", nested],
    ]);
  const library = container(
    "library_container",
    mod("fabric", "library", [], { provides: ["library_alias"] }),
  );
  const consumer = container(
    "consumer_container",
    mod("fabric", "consumer", ["library_alias"]),
  );
  const f = await fixture(t, {
    loader: "fabric",
    files: { "library.jar": library, "consumer.jar": consumer },
  });
  const blocked = await f.service.removalPreview({ path: "mods/library.jar" });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(
    blocked.dependents.map((value) => value.path),
    ["mods/consumer.jar"],
  );
  assert.deepEqual(blocked.warnings, []);
  const removable = await f.service.removalPreview({
    path: "mods/consumer.jar",
  });
  assert.equal(removable.blocked, false);
  await f.service.remove({ planId: removable.planId, confirmed: true });
  assert.deepEqual(await f.read("mods/library.jar"), library);
});

test("native Quilt metadata protects qualified aliases while optional and client dependencies stay removable", async (t) => {
  const quilt = (id, extra = {}) =>
    zip([
      [
        "quilt.mod.json",
        JSON.stringify({
          schema_version: 1,
          quilt_loader: {
            group: "test",
            id,
            version: "1.0",
            metadata: { name: id },
            ...extra,
          },
        }),
      ],
    ]);
  const f = await fixture(t, {
    loader: "quilt",
    files: {
      "library.jar": quilt("library", {
        provides: [{ id: "library_alias", version: "1.0" }],
      }),
      "consumer.jar": quilt("consumer", {
        depends: [{ id: "test:library_alias", versions: "*" }],
      }),
      "optional.jar": quilt("optional", {
        depends: [{ id: "library_alias", optional: true }],
      }),
      "client.jar": quilt("client", {
        depends: [{ id: "library_alias", environment: "client" }],
      }),
    },
  });
  const blocked = await f.service.removalPreview({ path: "mods/library.jar" });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(
    blocked.dependents.map((value) => value.path),
    ["mods/consumer.jar"],
  );
  assert.deepEqual(blocked.warnings, []);
  const consumerPlan = await f.service.removalPreview({
    path: "mods/consumer.jar",
  });
  await f.service.remove({ planId: consumerPlan.planId, confirmed: true });
  assert.equal(
    (await f.service.removalPreview({ path: "mods/library.jar" })).blocked,
    false,
  );
});

for (const change of ["add", "replace", "remove"]) {
  test(`${change} of another mod invalidates an earlier removal review`, async (t) => {
    const selected = mod("neoforge", "selected");
    const f = await fixture(t, {
      files: {
        "selected.jar": selected,
        "other.jar": mod("neoforge", "other"),
      },
    });
    const plan = await f.service.removalPreview({ path: "mods/selected.jar" });
    if (change === "add")
      await f.write("mods/added.jar", mod("neoforge", "added", ["selected"]));
    if (change === "replace")
      await f.write("mods/other.jar", mod("neoforge", "other", ["selected"]));
    if (change === "remove")
      await fs.unlink(path.join(f.serverDir, "mods", "other.jar"));
    await assert.rejects(
      f.service.remove({ planId: plan.planId, confirmed: true }),
      /Installed mods changed/,
    );
    assert.deepEqual(await f.read("mods/selected.jar"), selected);
    assert.deepEqual(await f.bin.list(), []);
  });
}

test("removal requires a stopped supported server, an exact confirmation and a current review", async (t) => {
  const f = await fixture(t, {
    files: { "selected.jar": mod("neoforge", "selected") },
  });
  f.state.server.status = "running";
  await assert.rejects(
    f.service.removalPreview({ path: "mods/selected.jar" }),
    { status: 409 },
  );
  f.state.server.status = "offline";
  const plan = await f.service.removalPreview({ path: "mods/selected.jar" });
  for (const confirmed of [undefined, false, "true", 1])
    await assert.rejects(f.service.remove({ planId: plan.planId, confirmed }), {
      status: 400,
    });
  f.state.server.status = "running";
  await assert.rejects(
    f.service.remove({ planId: plan.planId, confirmed: true }),
    { status: 409 },
  );
  f.state.server.status = "offline";
  f.state.server.loader = "fabric";
  await assert.rejects(
    f.service.remove({ planId: plan.planId, confirmed: true }),
    /server changed/,
  );
  f.state.server.loader = "paper";
  await assert.rejects(
    f.service.removalPreview({ path: "mods/selected.jar" }),
    { status: 400 },
  );
  assert.deepEqual(await f.bin.list(), []);
});

test("removal paths stay in root-level mod JARs and unreadable declarations block a review", async (t) => {
  const selected = mod("neoforge", "selected");
  const f = await fixture(t, { files: { "selected.jar": selected } });
  for (const value of [
    undefined,
    "../selected.jar",
    "plugins/selected.jar",
    "mods/sub/selected.jar",
    "mods\\selected.jar",
    "mods/selected.jar/other",
    "mods/selected.txt",
    "mods/../selected.jar",
  ])
    await assert.rejects(f.service.removalPreview({ path: value }), {
      status: 400,
    });
  await assert.rejects(f.service.removalPreview({ path: "mods/missing.jar" }), {
    status: 404,
  });
  await f.write("mods/unreadable.jar", "not a ZIP");
  const result = await f.service.removalPreview({ path: "mods/selected.jar" });
  assert.equal(result.blocked, true);
  assert.equal(result.planId, undefined);
  assert.match(result.warnings.join("\n"), /unreadable.jar/);
  assert.deepEqual(await f.read("mods/selected.jar"), selected);
});

test("removal drops the install receipt and restoration recovers cached identity by content hash offline", async (t) => {
  const f = await fixture(t);
  await install(f);
  const [receipt] = await f.receipts();
  assert.equal(receipt.path, "mods/installed.jar");
  const networkBefore = [...f.state.network];
  const plan = await f.service.removalPreview({ path: receipt.path });
  const result = await f.service.remove({
    planId: plan.planId,
    confirmed: true,
  });
  assert.deepEqual(await f.receipts(), []);
  assert.deepEqual(
    (await f.service.installed({ type: "mod", local: true })).items,
    [],
  );
  await f.bin.restore(result.recycled.id);
  const restored = await f.service.installed({ type: "mod", local: true });
  assert.equal(restored.items[0].platform, "fixture");
  assert.equal(restored.items[0].versionId, "v1");
  assert.equal(restored.items[0].sha512, hash(f.payload));
  assert.deepEqual(await f.read(receipt.path), f.payload);
  assert.deepEqual(f.state.network, networkBefore);
});

test("receipt persistence failure restores the original mod and retains its saved receipt", async (t) => {
  const f = await fixture(t);
  await install(f);
  const originalReceipts = await f.receipts();
  const plan = await f.service.removalPreview({ path: "mods/installed.jar" });
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (String(to) === path.join(f.dataDir, "launchpad", "installed.json"))
      throw new Error("Fixture receipt write failure");
    return rename(from, to);
  });
  await assert.rejects(
    f.service.remove({ planId: plan.planId, confirmed: true }),
    /original mod was restored/,
  );
  assert.deepEqual(await f.read("mods/installed.jar"), f.payload);
  assert.deepEqual(await f.receipts(), originalReceipts);
  assert.deepEqual(await f.bin.list(), []);
});

test("removal and installation serialize in both directions and shutdown drains accepted removal", async (t) => {
  const f = await fixture(t, {
    files: { "selected.jar": mod("neoforge", "selected") },
  });
  const installPlan = await f.service.preview(f.selection);
  const removePlan = await f.service.removalPreview({
    path: "mods/selected.jar",
  });
  f.state.recycleGate = { entered: gate(), release: gate() };
  const removing = f.service.remove({
    planId: removePlan.planId,
    confirmed: true,
  });
  await f.state.recycleGate.entered.promise;
  await assert.rejects(
    f.service.install({ planId: installPlan.planId, confirmed: true }),
    { status: 409 },
  );
  await assert.rejects(
    f.service.removalPreview({ path: "mods/selected.jar" }),
    { status: 409 },
  );
  await assert.rejects(
    f.service.remove({ planId: removePlan.planId, confirmed: true }),
    { status: 409 },
  );
  f.state.recycleGate.release.resolve();
  await removing;
  f.state.recycleGate = null;
  f.state.downloadGate = { entered: gate(), release: gate() };
  const { job } = await f.service.install({
    planId: installPlan.planId,
    confirmed: true,
  });
  await f.state.downloadGate.entered.promise;
  await assert.rejects(
    f.service.removalPreview({ path: "mods/installed.jar" }),
    { status: 409 },
  );
  f.state.downloadGate.release.resolve();
  assert.equal((await finish(f.service, job.id)).status, "completed");
  const next = await f.service.removalPreview({ path: "mods/installed.jar" });
  f.state.recycleGate = { entered: gate(), release: gate() };
  const accepted = f.service.remove({ planId: next.planId, confirmed: true });
  await f.state.recycleGate.entered.promise;
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  f.state.recycleGate.release.resolve();
  await accepted;
  await closing;
  assert.equal(closed, true);
  await assert.rejects(f.read("mods/installed.jar"), { code: "ENOENT" });
});

test("removal plans and recovery data belong only to their selected server", async (t) => {
  const first = await fixture(t, {
    files: { "same.jar": mod("neoforge", "first") },
  });
  const secondBytes = mod("neoforge", "second");
  const second = await fixture(t, { files: { "same.jar": secondBytes } });
  const plan = await first.service.removalPreview({ path: "mods/same.jar" });
  await assert.rejects(
    second.service.remove({ planId: plan.planId, confirmed: true }),
    { status: 409 },
  );
  await first.service.remove({ planId: plan.planId, confirmed: true });
  await assert.rejects(first.read("mods/same.jar"), { code: "ENOENT" });
  assert.deepEqual(await second.read("mods/same.jar"), secondBytes);
  assert.equal((await first.bin.list()).length, 1);
  assert.deepEqual(await second.bin.list(), []);
});
