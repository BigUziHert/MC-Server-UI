import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import yazl from "yazl";
import { createLaunchpad } from "./launchpad.mjs";
import { containedSourcePath } from "./import.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { inspectInstalledMod } from "./launchpad-mod-metadata.mjs";
import { installedDependencySatisfies } from "./launchpad-dependency-ranges.mjs";

const folders = {
  mod: "automodpack/host-modpack/main/mods",
  resourcepack: "automodpack/host-modpack/main/resourcepacks",
  shader: "automodpack/host-modpack/main/shaderpacks",
};
const safePath = (root, relative = "") =>
  relative ? containedSourcePath(root, relative) : fs.realpath(root);
const hash = (bytes) => createHash("sha512").update(bytes).digest("hex");
async function archive(entries) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries))
    zip.addBuffer(
      Buffer.from(
        typeof content === "string" ? content : JSON.stringify(content),
      ),
      name,
    );
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  zip.end();
  return result;
}
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-automodpack-test-")),
  );
  const serverDir = path.join(root, "server"),
    dataDir = path.join(root, "data");
  await fs.mkdir(serverDir);
  await fs.mkdir(dataDir);
  const bin = await createRecycleBin({ serverDir, dataDir, safePath });
  const downloads = new Map(),
    resolved = [],
    catalog = [];
  const versions = ["3", "2", "1"].map((id) => ({
    id,
    name: `Release ${id}`,
    version: id,
    gameVersions: ["1.21.1"],
    loaders: ["fabric"],
    publishedAt: `2026-01-0${id}T00:00:00Z`,
    downloadable: true,
  }));
  const provider = {
    id: "fixture",
    name: "Fixture",
    types: ["mod", "resourcepack", "shader"],
    downloadHosts: ["cdn.modrinth.com"],
    search: async (input) => {
      catalog.push(input);
      return {
        projects: [{ id: "project", platform: "fixture", title: "Project" }],
        total: 1,
      };
    },
    versions: async () => versions,
    dependencyInfo: async (input) => ({
      clientOnly: input.projectId === "clientlib",
      title: "Client library",
    }),
    resolve: async (input) => {
      resolved.push(input);
      const extension = input.type === "mod" ? "jar" : "zip";
      const filename = `${input.projectId}-${input.versionId}.${extension}`;
      const content =
        input.type === "mod"
          ? await archive({
              "fabric.mod.json": {
                schemaVersion: 1,
                id: input.projectId,
                name: input.projectId,
                version: input.versionId,
                environment:
                  input.projectId === "clientlib" ||
                  input.projectId === "dependent"
                    ? "client"
                    : "*",
                ...(input.projectId === "dependent"
                  ? { depends: { clientlib: "*" } }
                  : {}),
              },
            })
          : await archive({
              "pack.mcmeta": {
                pack: { description: filename, pack_format: 34 },
              },
            });
      const url = `https://cdn.modrinth.com/${filename}`;
      downloads.set(url, content);
      return {
        title: input.projectId,
        versionName: input.versionId,
        files: [
          {
            path: input.projectId === "escape" ? "mods/escape.jar" : filename,
            size: content.length,
            hashes: { sha512: hash(content) },
            url,
          },
        ],
        dependencies:
          input.projectId === "dependent" ? [{ projectId: "clientlib" }] : [],
      };
    },
  };
  const service = await createLaunchpad({
    serverDir,
    dataDir,
    safePath,
    getServer: async () => ({
      status: "offline",
      loader: "fabric",
      gameVersion: "1.21.1",
      world: "world",
    }),
    withMinecraftMutation: async (work) => work(),
    recycle: (relative) => bin.recycle(relative),
    restore: (id) => bin.restore(id),
    extraProviders: [provider],
    fetch: async (url) => {
      if (downloads.has(String(url)))
        return new Response(downloads.get(String(url)));
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/tag/game_version") return Response.json([]);
      if (parsed.pathname === "/v2/version_files") return Response.json({});
      return new Response(null, { status: 404 });
    },
  });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-automodpack-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { service, serverDir, downloads, resolved, catalog };
}
const input = (type = "mod", extra = {}) => ({
  type,
  target: "automodpack",
  platform: "fixture",
  projectId: "project",
  versionId: "1",
  gameVersion: "1.21.1",
  loader: type === "mod" ? "fabric" : "",
  ...extra,
});
async function install(service, selection) {
  const review = await service.preview(selection);
  await finish(service, review);
  return review;
}
async function finish(service, review, expected = "completed") {
  const { job } = await service.install({
    planId: review.planId,
    confirmed: true,
  });
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const latest = service.job(job.id).job;
    if (["completed", "failed"].includes(latest.status)) {
      assert.equal(latest.status, expected, latest.error ?? latest.message);
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail("Installation did not finish");
}

for (const type of Object.keys(folders)) {
  test(`AutoModpack ${type} stages, updates, toggles, and removes from its own missing folder`, async (t) => {
    const { service, serverDir, catalog } = await fixture(t);
    assert.ok((await service.config()).targets.includes("automodpack"));
    const selection = input(type),
      folder = folders[type];
    const regular = await install(service, input("mod", { target: "server" }));
    const regularPath = regular.files[0].path;
    const regularBytes = await fs.readFile(path.join(serverDir, regularPath));
    assert.deepEqual(
      (await service.installed({ ...selection, local: true })).items,
      [],
    );
    await service.search(selection);
    assert.equal(catalog[0].target, "automodpack");
    await assert.rejects(fs.access(path.join(serverDir, "automodpack")), {
      code: "ENOENT",
    });
    const review = await service.preview(selection);
    assert.ok(review.files.every((file) => file.path.startsWith(`${folder}/`)));
    await assert.rejects(fs.access(path.join(serverDir, folder)), {
      code: "ENOENT",
    });
    await finish(service, review);
    let items = (await service.installed({ ...selection, local: true })).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].versionId, "1");
    assert.equal(items[0].active, true);
    const disabled = await service.setActive({
      ...selection,
      path: items[0].path,
      active: false,
    });
    assert.equal(disabled.active, false);
    assert.ok(disabled.path.endsWith(".disabled"));
    items = (await service.installed({ ...selection, local: true })).items;
    assert.equal(items[0].active, false);
    const checked = await service.installed(selection);
    assert.equal(checked.items[0].update.id, "3");
    const updated = await service.previewUpdates({
      ...selection,
      updates: [
        {
          platform: "fixture",
          projectId: "project",
          versionId: "2",
          replacePath: disabled.path,
        },
      ],
    });
    assert.ok(updated.files[0].path.startsWith(`${folder}/`));
    assert.ok(updated.files[0].path.endsWith(".disabled"));
    await finish(service, updated);
    items = (await service.installed({ ...selection, local: true })).items;
    assert.equal(items[0].versionId, "2");
    const active = await service.setActive({
      ...selection,
      path: items[0].path,
      active: true,
    });
    const removal = await service.removalPreview({
      ...selection,
      path: active.path,
    });
    assert.equal(removal.blocked, false);
    await service.remove({ planId: removal.planId, confirmed: true });
    assert.deepEqual(
      (await service.installed({ ...selection, local: true })).items,
      [],
    );
    assert.deepEqual(
      await fs.readFile(path.join(serverDir, regularPath)),
      regularBytes,
    );
    assert.equal(
      (await service.installed(input("mod", { target: "server", local: true })))
        .items[0].versionId,
      "1",
    );
    assert.deepEqual(await fs.readdir(path.join(serverDir, "mods")), [
      "project-1.jar",
    ]);
  });
}

test("regular Mods and AutoModpack retain separate versions, update checks, active state, and inventory snapshots", async (t) => {
  const { service, serverDir } = await fixture(t);
  await install(service, input("mod", { target: "server" }));
  await install(service, input("mod", { versionId: "2" }));
  const [regular, staged] = await Promise.all([
    service.installed(input("mod", { target: "server", background: true })),
    service.installed(input("mod", { background: true })),
  ]);
  assert.deepEqual(
    regular.items.map((item) => item.path),
    ["mods/project-1.jar"],
  );
  assert.deepEqual(
    staged.items.map((item) => item.path),
    [`${folders.mod}/project-2.jar`],
  );
  await service.setActive({
    type: "mod",
    path: regular.items[0].path,
    active: false,
  });
  assert.equal(
    (await service.installed(input("mod", { local: true }))).items[0].active,
    true,
  );
  const review = await service.preview(input("mod", { versionId: "3" }));
  await fs.writeFile(
    path.join(serverDir, "mods", "unrelated.jar"),
    "unrelated server copy",
  );
  await finish(service, review);
  assert.equal(
    (await service.installed(input("mod", { local: true }))).items[0].versionId,
    "3",
  );
  const serverItems = (
    await service.installed(input("mod", { target: "server", local: true }))
  ).items;
  assert.equal(
    serverItems.find((item) => item.projectId === "project").versionId,
    "1",
  );
  assert.equal(
    serverItems.find((item) => item.projectId === "project").active,
    false,
  );
});

test("AutoModpack resolves client-only dependencies locally and protects them during removal", async (t) => {
  const { service, resolved } = await fixture(t);
  await install(
    service,
    input("mod", { target: "server", projectId: "clientlib" }),
  );
  const review = await install(
    service,
    input("mod", { projectId: "dependent" }),
  );
  assert.deepEqual(review.files.map((file) => file.path).sort(), [
    `${folders.mod}/clientlib-3.jar`,
    `${folders.mod}/dependent-1.jar`,
  ]);
  assert.ok(
    resolved
      .filter((value) => value.projectId === "clientlib")
      .some((value) => value.target === "automodpack"),
  );
  const blocked = await service.removalPreview(
    input("mod", { path: `${folders.mod}/clientlib-3.jar` }),
  );
  assert.equal(blocked.blocked, true);
  assert.deepEqual(
    blocked.dependents.map((row) => row.path),
    [`${folders.mod}/dependent-1.jar`],
  );
});

test("AutoModpack rejects other targets and cross-folder writes, replacements, activation, and removals", async (t) => {
  const { service } = await fixture(t);
  await install(service, input("mod", { target: "server" }));
  await assert.rejects(
    service.installed(input("mod", { target: "../mods" })),
    /valid Launchpad content target/,
  );
  await assert.rejects(
    service.installed(input("plugin")),
    /AutoModpack supports/,
  );
  await assert.rejects(
    service.search(input("shader", { loader: "fabric" })),
    /valid Minecraft version and loader/,
  );
  await assert.rejects(
    service.search(input("mod", { loader: "iris" })),
    /valid Minecraft version and loader/,
  );
  await assert.rejects(
    service.preview(input("mod", { projectId: "escape" })),
    /selected content folder/,
  );
  await assert.rejects(
    service.preview(input("mod", { replacePath: "mods/project-1.jar" })),
    /could not be verified/,
  );
  await assert.rejects(
    service.setActive(
      input("mod", { path: "mods/project-1.jar", active: false }),
    ),
    /Choose an installed mod/,
  );
  await assert.rejects(
    service.removalPreview(input("mod", { path: "mods/project-1.jar" })),
    /Choose an installed mod/,
  );
  await assert.rejects(
    service.removalPreview(
      input("shader", { path: `${folders.resourcepack}/project-1.zip` }),
    ),
    /Choose an installed shader/,
  );
});

test("AutoModpack rechecks only its reviewed folder and refuses symlinked ancestors", async (t) => {
  const { service, serverDir } = await fixture(t);
  const review = await service.preview(input("resourcepack"));
  await fs.mkdir(path.join(serverDir, folders.resourcepack), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(serverDir, folders.resourcepack, "later.zip"),
    "added after review",
  );
  assert.match(
    (await finish(service, review, "failed")).error,
    /changed since review/,
  );
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-automodpack-outside-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(outside), os.tmpdir());
    assert.ok(path.basename(outside).startsWith("mc-automodpack-outside-"));
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.symlink(
    outside,
    path.join(serverDir, folders.shader),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    service.installed(input("shader", { local: true })),
    /symbolic|symlink|outside|link/i,
  );
  await assert.rejects(
    service.preview(input("shader")),
    /symbolic|symlink|outside|link/i,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

for (const loader of ["fabric", "quilt", "forge", "neoforge"]) {
  test(`AutoModpack retains client dependency metadata for ${loader} safeguards`, async () => {
    const entries =
      loader === "fabric"
        ? {
            "fabric.mod.json": {
              schemaVersion: 1,
              id: "clientmod",
              name: "Client Mod",
              version: "1.0",
              environment: "client",
              depends: { clientlib: "*" },
            },
          }
        : loader === "quilt"
          ? {
              "quilt.mod.json": {
                schema_version: 1,
                minecraft: { environment: "client" },
                quilt_loader: {
                  id: "clientmod",
                  version: "1.0",
                  depends: [
                    { id: "clientlib", versions: "*", environment: "client" },
                  ],
                },
              },
            }
          : {
              [`META-INF/${loader === "neoforge" ? "neoforge.mods.toml" : "mods.toml"}`]: `modLoader="javafml"
loaderVersion="[1,)"
clientSideOnly=true
[[mods]]
modId="clientmod"
version="1.0"
[[dependencies.clientmod]]
modId="clientlib"
mandatory=true
type="required"
versionRange="[1,)"
side="CLIENT"
`,
            };
    const bytes = await archive(entries);
    const regular = await inspectInstalledMod(bytes, { loader });
    assert.ok(!regular.required.includes("clientlib"));
    const staged = await inspectInstalledMod(bytes, {
      loader,
      includeClient: true,
    });
    assert.ok(staged.provided.includes("clientmod"));
    assert.ok(staged.required.includes("clientlib"));
    if (["forge", "neoforge"].includes(loader)) {
      const child = await archive({
        [`META-INF/${loader === "neoforge" ? "neoforge.mods.toml" : "mods.toml"}`]: `modLoader="javafml"
loaderVersion="[1,)"
clientSideOnly=true
[[mods]]
modId="clientlib"
version="1.0"
`,
      });
      assert.equal(
        await installedDependencySatisfies(bytes, child, { loader }),
        false,
      );
      assert.equal(
        await installedDependencySatisfies(bytes, child, {
          loader,
          includeClient: true,
        }),
        true,
      );
    }
  });
}
