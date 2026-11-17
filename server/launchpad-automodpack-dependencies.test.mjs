import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import yazl from "yazl";
import { createLaunchpad } from "./launchpad.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { containedSourcePath } from "./import.mjs";

const folder = "automodpack/host-modpack/main/mods";
const hash = (bytes) => createHash("sha512").update(bytes).digest("hex");
const safePath = (root, relative = "") =>
  relative ? containedSourcePath(root, relative) : fs.realpath(root);
const selection = (projectId = "compat", versionId = "2", extra = {}) => ({
  type: "mod",
  target: "automodpack",
  platform: "fixture",
  projectId,
  versionId,
  loader: "neoforge",
  gameVersion: "1.21.1",
  ...extra,
});
const regular = (projectId, versionId = "1", disabled = false) => ({
  projectId,
  versionId,
  path: `mods/${projectId}-${versionId}.jar${disabled ? ".disabled" : ""}`,
});
const staged = (projectId, versionId = "1", disabled = false) => ({
  ...regular(projectId, versionId, disabled),
  path: `${folder}/${projectId}-${versionId}.jar${disabled ? ".disabled" : ""}`,
});

async function archive(projectId, versionId, dependencies) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(`modLoader="javafml"
loaderVersion="[1,)"
license="MIT"
[[mods]]
modId="${projectId}"
version="${versionId}.0.0"
displayName="${projectId}"
${dependencies
  .map(
    ({ projectId: dependency, range }) => `
[[dependencies.${projectId}]]
modId="${dependency}"
type="required"
versionRange="${range}"
side="BOTH"
`,
  )
  .join("")}`),
    "META-INF/neoforge.mods.toml",
  );
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  zip.end();
  return finished;
}

async function fixture(
  t,
  installed = [],
  { watutPin = "1", range = "[1,)", graph = {} } = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-automodpack-dependencies-")),
  );
  const serverDir = path.join(root, "server"),
    dataDir = path.join(root, "data");
  await fs.mkdir(serverDir);
  await fs.mkdir(path.join(dataDir, "launchpad"), { recursive: true });
  const artifacts = new Map();
  const dependencies = (projectId) =>
    graph[projectId] ??
    (projectId === "compat"
      ? [{ projectId: "watut", versionId: watutPin, range }]
      : projectId === "watut"
        ? [{ projectId: "coroutil", versionId: "1", range: "[1,)" }]
        : []);
  for (const projectId of new Set([
    "compat",
    "watut",
    "coroutil",
    ...Object.keys(graph),
  ]))
    for (const versionId of ["1", "2"])
      artifacts.set(`${projectId}:${versionId}`, {
        bytes: await archive(projectId, versionId, dependencies(projectId)),
        projectId,
        versionId,
        filename: `${projectId}-${versionId}.jar`,
      });
  const receipts = [];
  for (const item of installed) {
    const bytes = artifacts.get(`${item.projectId}:${item.versionId}`).bytes;
    await fs.mkdir(path.dirname(path.join(serverDir, item.path)), {
      recursive: true,
    });
    await fs.writeFile(path.join(serverDir, item.path), bytes);
    receipts.push({
      ...item,
      type: "mod",
      platform: "fixture",
      sha512: hash(bytes),
      title: item.projectId,
    });
  }
  await fs.writeFile(
    path.join(dataDir, "launchpad", "installed.json"),
    JSON.stringify(receipts),
  );
  const resolved = [],
    downloads = [];
  let beforeDownload;
  const provider = {
    id: "fixture",
    name: "Fixture",
    types: ["mod"],
    downloadHosts: ["cdn.modrinth.com"],
    versions: async () =>
      ["2", "1"].map((id) => ({
        id,
        name: `Release ${id}`,
        version: `${id}.0.0`,
        gameVersions: ["1.21.1"],
        loaders: ["neoforge"],
        publishedAt: `2026-01-0${id}T00:00:00Z`,
        downloadable: true,
      })),
    async resolve(input) {
      resolved.push(input);
      const artifact = artifacts.get(`${input.projectId}:${input.versionId}`);
      assert.ok(
        artifact,
        `Unexpected artifact: ${input.projectId}:${input.versionId}`,
      );
      return {
        title: input.projectId,
        versionName: `${input.versionId}.0.0`,
        files: [
          {
            path: artifact.filename,
            url: `https://cdn.modrinth.com/${artifact.filename}`,
            hashes: { sha512: hash(artifact.bytes) },
            size: artifact.bytes.length,
          },
        ],
        dependencies: dependencies(input.projectId).map(
          ({ range, ...dependency }) => dependency,
        ),
      };
    },
  };
  const bin = await createRecycleBin({ serverDir, dataDir, safePath });
  const service = await createLaunchpad({
    serverDir,
    dataDir,
    safePath,
    getServer: async () => ({
      status: "offline",
      loader: "neoforge",
      gameVersion: "1.21.1",
    }),
    withMinecraftMutation: async (work) => work(),
    recycle: (relative) => bin.recycle(relative),
    restore: (id) => bin.restore(id),
    extraProviders: [provider],
    fetch: async (url) => {
      const address = new URL(url);
      const artifact = [...artifacts.values()].find(
        (value) =>
          address.hostname === "cdn.modrinth.com" &&
          address.pathname === `/${value.filename}`,
      );
      if (artifact) {
        await beforeDownload?.(artifact);
        downloads.push(artifact.filename);
        return new Response(artifact.bytes);
      }
      assert.fail(`Unexpected provider request: ${url}`);
    },
  });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-automodpack-dependencies-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    service,
    serverDir,
    artifacts,
    resolved,
    downloads,
    setBeforeDownload: (callback) => {
      beforeDownload = callback;
    },
  };
}

async function finish(service, review, expected = "completed") {
  const { job } = await service.install({
    planId: review.planId,
    confirmed: true,
  });
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const current = service.job(job.id).job;
    if (["completed", "failed"].includes(current.status)) {
      assert.equal(current.status, expected, current.error ?? current.message);
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail("Installation did not finish");
}
const planned = (review) => review.files.map((file) => file.path).sort();
const inventory = async (service, target) =>
  (await service.installed({ ...selection(), target, local: true })).items;

test("AutoModpack updates reuse regular WATUT and transitive CoroUtil without adding them to its inventory", async (t) => {
  const { service, serverDir, artifacts, downloads } = await fixture(t, [
    staged("compat"),
    regular("watut"),
    regular("coroutil"),
  ]);
  const review = await service.previewUpdates({
    ...selection(),
    updates: [
      {
        platform: "fixture",
        projectId: "compat",
        versionId: "2",
        replacePath: staged("compat").path,
      },
    ],
  });
  assert.deepEqual(planned(review), [`${folder}/compat-2.jar`]);
  await finish(service, review);
  assert.deepEqual(
    (await inventory(service, "automodpack")).map((item) => item.projectId),
    ["compat"],
  );
  assert.deepEqual(
    (await inventory(service, "server")).map((item) => item.projectId).sort(),
    ["coroutil", "watut"],
  );
  assert.deepEqual(await fs.readdir(path.join(serverDir, folder)), [
    "compat-2.jar",
  ]);
  for (const id of ["watut", "coroutil"])
    assert.deepEqual(
      await fs.readFile(path.join(serverDir, regular(id).path)),
      artifacts.get(`${id}:1`).bytes,
    );
  assert.deepEqual(downloads, ["compat-2.jar"]);
});

test("explicit AutoModpack roots still install and update their own copies of regular mods", async (t) => {
  const { service, serverDir, artifacts } = await fixture(t, [
    regular("watut"),
    regular("coroutil"),
  ]);
  const first = await service.preview(selection("watut", "1"));
  assert.deepEqual(planned(first), [`${folder}/watut-1.jar`]);
  await finish(service, first);
  const update = await service.preview(
    selection("watut", "2", { replacePath: `${folder}/watut-1.jar` }),
  );
  assert.deepEqual(planned(update), [`${folder}/watut-2.jar`]);
  await finish(service, update);
  assert.equal((await inventory(service, "automodpack"))[0].versionId, "2");
  assert.equal(
    (await inventory(service, "server")).find(
      (item) => item.projectId === "watut",
    ).versionId,
    "1",
  );
  assert.deepEqual(
    await fs.readFile(path.join(serverDir, regular("watut").path)),
    artifacts.get("watut:1").bytes,
  );
});

test("an explicit AutoModpack dependency copy takes precedence over an eligible regular copy", async (t) => {
  const { service } = await fixture(
    t,
    [staged("watut"), regular("watut", "2"), regular("coroutil")],
    { watutPin: "2" },
  );
  const review = await service.preview(selection());
  assert.deepEqual(planned(review), [
    `${folder}/compat-2.jar`,
    `${folder}/watut-2.jar`,
  ]);
  assert.equal(
    review.files.find((file) => file.path === `${folder}/watut-2.jar`).action,
    "replace",
  );
});

test("an explicit disabled AutoModpack dependency cannot be bypassed by its active regular copy", async (t) => {
  const { service } = await fixture(t, [
    staged("watut", "1", true),
    regular("watut"),
    regular("coroutil"),
  ]);
  await assert.rejects(
    service.preview(selection()),
    /disabled.*required|Enable it/i,
  );
});

test("disabled regular mods are staged as AutoModpack copies without activating the originals", async (t) => {
  const { service, serverDir, artifacts } = await fixture(t, [
    regular("watut", "1", true),
    regular("coroutil"),
  ]);
  const review = await service.preview(selection());
  assert.deepEqual(planned(review), [
    `${folder}/compat-2.jar`,
    `${folder}/watut-1.jar`,
  ]);
  await finish(service, review);
  assert.deepEqual(
    await fs.readFile(path.join(serverDir, regular("watut", "1", true).path)),
    artifacts.get("watut:1").bytes,
  );
  assert.equal(
    (await inventory(service, "server")).find(
      (item) => item.projectId === "watut",
    ).active,
    false,
  );
});

test("a missing transitive dependency is staged while its regular parent is reused", async (t) => {
  const { service } = await fixture(t, [regular("watut")]);
  const review = await service.preview(selection());
  assert.deepEqual(planned(review), [
    `${folder}/compat-2.jar`,
    `${folder}/coroutil-1.jar`,
  ]);
});

test("regular mods excluded from AutoModpack are staged in its content folder", async (t) => {
  const { service, serverDir } = await fixture(t, [
    regular("watut"),
    regular("coroutil"),
  ]);
  await fs.mkdir(path.join(serverDir, "automodpack"), { recursive: true });
  await fs.writeFile(
    path.join(serverDir, "automodpack", "server.conf"),
    "modpack { General { main { from-server: [] } } }",
  );
  const review = await service.preview(selection());
  assert.deepEqual(planned(review), [
    `${folder}/compat-2.jar`,
    `${folder}/coroutil-1.jar`,
    `${folder}/watut-1.jar`,
  ]);
});

test("a verified different regular version can satisfy the parent's declared NeoForge range", async (t) => {
  const { service } = await fixture(t, [
    regular("watut", "2"),
    regular("coroutil"),
  ]);
  const review = await service.preview(selection());
  assert.deepEqual(planned(review), [`${folder}/compat-2.jar`]);
});

test("an incompatible included regular version blocks duplication and points to regular Mods", async (t) => {
  const { service } = await fixture(
    t,
    [regular("watut", "2"), regular("coroutil")],
    { range: "[1.0.0]" },
  );
  await assert.rejects(
    service.preview(selection()),
    (cause) => cause.status === 409 && /regular Mods/i.test(cause.message),
  );
});

test("every parent must accept a reused regular version even when a later catalog pin matches it", async (t) => {
  const { service } = await fixture(
    t,
    [regular("watut", "2"), regular("coroutil")],
    {
      graph: {
        compat: [
          { projectId: "firstparent", versionId: "1", range: "[1,)" },
          { projectId: "secondparent", versionId: "1", range: "[1,)" },
        ],
        firstparent: [{ projectId: "watut", versionId: "1", range: "[1,)" }],
        secondparent: [
          { projectId: "watut", versionId: "2", range: "[1.0.0]" },
        ],
      },
    },
  );
  await assert.rejects(
    service.preview(selection()),
    (cause) => cause.status === 409 && /regular Mods/i.test(cause.message),
  );
});

test("duplicate active regular identities cannot silently satisfy an AutoModpack dependency", async (t) => {
  const { service } = await fixture(t, [
    regular("watut"),
    regular("watut", "2"),
    regular("coroutil"),
  ]);
  await assert.rejects(service.preview(selection()), /Multiple|duplicate/i);
});

for (const mutation of ["modify", "remove", "disable", "config"])
  test(`changing a reused regular dependency after review blocks promotion: ${mutation}`, async (t) => {
    const { service, serverDir } = await fixture(t, [
      regular("watut"),
      regular("coroutil"),
    ]);
    const review = await service.preview(selection());
    assert.deepEqual(planned(review), [`${folder}/compat-2.jar`]);
    const existing = path.join(serverDir, regular("watut").path);
    if (mutation === "modify") await fs.appendFile(existing, "changed");
    if (mutation === "remove") await fs.unlink(existing);
    if (mutation === "disable")
      await fs.rename(existing, `${existing}.disabled`);
    if (mutation === "config") {
      await fs.mkdir(path.join(serverDir, "automodpack"), { recursive: true });
      await fs.writeFile(
        path.join(serverDir, "automodpack", "server.conf"),
        "modpack { General { main { from-server: [] } } }",
      );
    }
    const job = await finish(service, review, "failed");
    assert.match(job.error, /changed|review/i);
    assert.deepEqual(
      await fs.readdir(path.join(serverDir, folder)).catch((cause) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      }),
      [],
    );
  });

test("reused regular bytes are rechecked after downloads before any AutoModpack promotion", async (t) => {
  const { service, serverDir, setBeforeDownload } = await fixture(t, [
    regular("watut"),
    regular("coroutil"),
  ]);
  const review = await service.preview(selection());
  assert.deepEqual(planned(review), [`${folder}/compat-2.jar`]);
  setBeforeDownload(async () => {
    await fs.appendFile(
      path.join(serverDir, regular("coroutil").path),
      "changed during download",
    );
  });
  const job = await finish(service, review, "failed");
  assert.match(job.error, /changed|review/i);
  await assert.rejects(
    fs.access(path.join(serverDir, folder, "compat-2.jar")),
    { code: "ENOENT" },
  );
});

test("bulk-selected AutoModpack roots keep their explicit versions even when regular copies match", async (t) => {
  const { service } = await fixture(
    t,
    [
      staged("compat"),
      staged("watut"),
      regular("watut", "2"),
      regular("coroutil"),
    ],
    { watutPin: "2" },
  );
  const review = await service.previewUpdates({
    ...selection(),
    updates: ["compat", "watut"].map((projectId) => ({
      platform: "fixture",
      projectId,
      versionId: "2",
      replacePath: staged(projectId).path,
    })),
  });
  assert.deepEqual(planned(review), [
    `${folder}/compat-2.jar`,
    `${folder}/watut-2.jar`,
  ]);
});
