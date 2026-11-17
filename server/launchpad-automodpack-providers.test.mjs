import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCoreProviders } from "./launchpad-providers.mjs";

const json = (value) => new Response(JSON.stringify(value));
const hash = (value) => createHash("sha512").update(value).digest("hex");
const input = {
  target: "automodpack",
  type: "mod",
  loader: "fabric",
  gameVersion: "1.21.1",
  projectId: "project",
  versionId: "new",
  query: "",
  offset: 0,
  limit: 20,
};
const release = (type, overrides = {}) => ({
  id: "new",
  project_id: "project",
  name: "New release",
  version_number: "2.0",
  game_versions: ["1.21.1"],
  loaders:
    type === "mod" ? ["fabric"] : type === "shader" ? ["iris"] : ["minecraft"],
  environment: "client_only",
  date_published: "2026-08-01T00:00:00Z",
  files: [
    {
      filename: type === "mod" ? "file.jar" : "file.zip",
      primary: true,
      url: "https://cdn.modrinth.com/data/project/file",
      size: 20,
      hashes: { sha512: hash("new") },
    },
  ],
  dependencies: [],
  ...overrides,
});
const mr = (fetch) => createCoreProviders({ fetch })[0];

test("AutoModpack Modrinth catalogs include client content and use content-specific filters", async () => {
  const requests = [];
  const provider = mr(async (url) => {
    requests.push(new URL(url));
    return json({ hits: [], total_hits: 0, offset: 0, limit: 20 });
  });
  await provider.search({ ...input, target: undefined });
  await provider.search(input);
  await provider.search({
    ...input,
    type: "resourcepack",
    categories: ["realistic"],
  });
  await provider.search({
    ...input,
    type: "shader",
    loader: "iris",
    categories: ["fantasy"],
  });
  const facets = requests.map((url) =>
    JSON.parse(url.searchParams.get("facets")).flat(),
  );
  assert.ok(facets[0].includes("server_side!=unsupported"));
  assert.ok(!facets[1].includes("server_side!=unsupported"));
  assert.ok(facets[1].includes("categories:fabric"));
  assert.deepEqual(facets[2], [
    "all_project_types:resourcepack",
    "versions:1.21.1",
    "categories:realistic",
  ]);
  assert.deepEqual(facets[3], [
    "all_project_types:shader",
    "versions:1.21.1",
    "categories:iris",
    "categories:fantasy",
  ]);
});

test("AutoModpack resolves client-only mods and dependencies while regular Mods still rejects them", async () => {
  const provider = mr(async (url) => {
    if (new URL(url).pathname === "/v2/project/project/version")
      return json([release("mod")]);
    if (url.endsWith("/project/project"))
      return json({
        id: "project",
        title: "Client mod",
        project_type: "mod",
        server_side: "unsupported",
      });
    if (url.endsWith("/version/new")) return json(release("mod"));
    assert.fail(`Unexpected request: ${url}`);
  });
  assert.equal((await provider.versions(input))[0].downloadable, true);
  assert.equal(
    (await provider.versions({ ...input, target: undefined }))[0].downloadable,
    false,
  );
  assert.equal((await provider.resolve(input)).files[0].path, "file.jar");
  await assert.rejects(
    provider.resolve({ ...input, target: undefined }),
    /intended for clients/,
  );
  assert.equal((await provider.dependencyInfo(input)).clientOnly, false);
  assert.equal(
    (await provider.dependencyInfo({ ...input, target: undefined })).clientOnly,
    true,
  );
  assert.equal(provider.compatibleBundledVersion(release("mod"), input), true);
  assert.equal(
    provider.compatibleBundledVersion(release("mod"), {
      ...input,
      target: undefined,
    }),
    false,
  );
});

for (const type of ["resourcepack", "shader"]) {
  test(`Modrinth ${type} versions, verified ZIP downloads and updates use AutoModpack compatibility`, async () => {
    const scoped = {
      ...input,
      type,
      loader: type === "shader" ? "iris" : "fabric",
    };
    const requests = [];
    const oldHash = hash("old");
    const old = release(type, {
      id: "old",
      date_published: "2026-07-01T00:00:00Z",
      files: [{ ...release(type).files[0], hashes: { sha512: oldHash } }],
    });
    let candidate = release(type);
    const provider = mr(async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (url.endsWith("/version_files/update"))
        return json({ [oldHash]: candidate });
      if (new URL(url).pathname === "/v2/versions") return json([old]);
      if (new URL(url).pathname === "/v2/project/project/version")
        return json([candidate]);
      if (url.endsWith("/project/project"))
        return json({
          id: "project",
          title: "Client pack",
          project_type: type,
          server_side: "unsupported",
        });
      if (url.endsWith("/version/new")) return json(candidate);
      assert.fail(`Unexpected request: ${url}`);
    });
    assert.equal((await provider.versions(scoped))[0].downloadable, true);
    const loaders = requests[0].url.searchParams.get("loaders");
    assert.equal(loaders, type === "shader" ? '["iris"]' : null);
    assert.equal((await provider.resolve(scoped)).files[0].path, "file.zip");
    const updates = await provider.updates(scoped, [
      { projectId: "project", versionId: "old", sha512: oldHash },
    ]);
    assert.equal(updates.updates[oldHash].id, "new");
    assert.deepEqual(updates.issues, {});
    assert.deepEqual(
      JSON.parse(
        requests.find(({ url }) => url.pathname.endsWith("/update")).options
          .body,
      ).loaders,
      type === "shader" ? ["iris"] : [],
    );
    assert.deepEqual(
      await provider.versions({ ...scoped, gameVersion: "1.20.1" }),
      [],
    );
    if (type === "shader")
      assert.deepEqual(
        await provider.versions({ ...scoped, loader: "optifine" }),
        [],
      );
    candidate = {
      ...candidate,
      files: [{ ...candidate.files[0], filename: "wrong.jar" }],
    };
    await assert.rejects(provider.resolve(scoped), /single supported/);
  });
}

test("Modrinth client-only update checks are independent from the regular Mods environment", async () => {
  const oldHash = hash("old");
  const old = release("mod", {
    id: "old",
    date_published: "2026-07-01T00:00:00Z",
    files: [{ ...release("mod").files[0], hashes: { sha512: oldHash } }],
  });
  const provider = mr(async (url) => {
    if (url.endsWith("/version_files/update"))
      return json({ [oldHash]: release("mod") });
    if (new URL(url).pathname === "/v2/versions") return json([old]);
    assert.fail(`Unexpected request: ${url}`);
  });
  const items = [{ projectId: "project", versionId: "old", sha512: oldHash }];
  const regular = await provider.updates(
    { ...input, target: undefined },
    items,
  );
  assert.match(regular.issues[oldHash], /client-only/);
  assert.equal(
    (await provider.updates(input, items)).updates[oldHash].id,
    "new",
  );
});

for (const type of ["mod", "resourcepack", "shader"]) {
  for (const status of [403, 200])
    test(`AutoModpack ${type} updates recover through indexed GETs after bulk ${status} without excluding client releases`, async () => {
      const scoped = {
        ...input,
        type,
        loader: type === "shader" ? "iris" : type === "mod" ? "fabric" : "",
      };
      const oldHash = hash("old");
      const old = release(type, {
        id: "old",
        date_published: "2026-07-01T00:00:00Z",
        files: [{ ...release(type).files[0], hashes: { sha512: oldHash } }],
      });
      let searchFacets;
      const provider = mr(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v2/version_files/update")
          return status === 200
            ? json({})
            : new Response("denied", {
                status: 403,
                headers: { "Content-Type": "text/html" },
              });
        if (parsed.pathname === "/v2/search") {
          searchFacets = JSON.parse(parsed.searchParams.get("facets")).flat();
          return json({
            hits: [{ project_id: "project", latest_version: "new" }],
          });
        }
        if (parsed.pathname === "/v2/projects")
          return json([{ id: "project", versions: ["old", "new"] }]);
        if (parsed.pathname === "/v2/versions")
          return json([old, release(type)]);
        assert.fail(`Unexpected request: ${url}`);
      });
      const result = await provider.updates(scoped, [
        { projectId: "project", versionId: "old", sha512: oldHash },
      ]);
      assert.equal(result.updates[oldHash].id, "new");
      assert.deepEqual(result.issues, {});
      assert.ok(
        !searchFacets.some((facet) => facet.startsWith("environment:")),
      );
    });
}

test("installed pack metadata preserves the selected type's categories across provider caches", async () => {
  const requests = [];
  const providers = createCoreProviders({
    key: async () => "test",
    fetch: async (url) => {
      requests.push(url);
      if (new URL(url).pathname === "/v2/projects")
        return json([
          {
            id: "project",
            title: "Pack",
            categories: ["realistic", "decoration"],
          },
        ]);
      if (new URL(url).pathname === "/v1/mods")
        return json({
          data: [
            {
              id: 10,
              gameId: 432,
              name: "Pack",
              categories: [{ name: "Photo Realistic" }, { name: "Realistic" }],
            },
          ],
        });
      assert.fail(`Unexpected request: ${url}`);
    },
  });
  const mod = await providers[0].projectMetadata(["project"]);
  const resource = await providers[0].projectMetadata(["project"], {
    type: "resourcepack",
  });
  const shader = await providers[0].projectMetadata(["project"], {
    type: "shader",
  });
  assert.deepEqual(mod.projects[0].categories, ["cosmetic"]);
  assert.deepEqual(resource.projects[0].categories, [
    "realistic",
    "decoration",
  ]);
  assert.deepEqual(shader.projects[0].categories, ["realistic"]);
  for (const type of ["resourcepack", "shader"])
    assert.deepEqual(
      (await providers[1].projectMetadata(["10"], { type })).projects[0]
        .categories,
      ["realistic"],
    );
  const before = requests.length;
  await providers[0].projectMetadata(["project"], { type: "shader" });
  await providers[1].projectMetadata(["10"], { type: "resourcepack" });
  assert.equal(requests.length, before);
});

for (const [type, classId, slug] of [
  ["resourcepack", 12, "texture-packs"],
  ["shader", 6552, "shaders"],
]) {
  test(`CurseForge ${type} uses its class, categories and ZIP files without server mod-loader filters`, async () => {
    const scoped = {
      ...input,
      type,
      loader: type === "shader" ? "iris" : "fabric",
      projectId: "10",
      versionId: "20",
      categories: ["realistic"],
    };
    const requests = [];
    const file = {
      id: 20,
      modId: 10,
      displayName: "Pack release",
      gameVersions: ["1.21.1", ...(type === "shader" ? ["Iris"] : [])],
      fileDate: "2026-08-01T00:00:00Z",
      fileName: "pack.zip",
      fileLength: 20,
      downloadUrl: "https://edge.forgecdn.net/files/pack.zip",
      hashes: [{ algo: 1, value: "a".repeat(40) }],
      dependencies: [],
    };
    const provider = createCoreProviders({
      key: async () => "test",
      fetch: async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        if (parsed.pathname === "/v1/categories")
          return json({
            data: parsed.searchParams.get("classesOnly")
              ? [{ id: classId, slug }]
              : [
                  {
                    id: 99,
                    classId,
                    name:
                      type === "resourcepack" ? "Photo Realistic" : "Realistic",
                  },
                ],
          });
        if (parsed.pathname === "/v1/mods/search")
          return json({
            data: [
              {
                id: 10,
                name: "Pack",
                categories: [
                  {
                    name:
                      type === "resourcepack" ? "Photo Realistic" : "Realistic",
                  },
                ],
              },
            ],
            pagination: { totalCount: 1 },
          });
        if (parsed.pathname === "/v1/mods/10/files")
          return json({ data: [file] });
        if (parsed.pathname === "/v1/mods/10/files/20")
          return json({ data: file });
        if (parsed.pathname === "/v1/mods/10")
          return json({ data: { id: 10, gameId: 432, classId, name: "Pack" } });
        assert.fail(`Unexpected request: ${url}`);
      },
    })[1];
    const results = await provider.search(scoped);
    assert.deepEqual(results.projects[0].categories, ["realistic"]);
    const search = requests.find((url) => url.pathname.endsWith("/search"));
    assert.equal(search.searchParams.get("classId"), String(classId));
    assert.equal(search.searchParams.get("modLoaderType"), null);
    assert.equal(search.searchParams.get("categoryIds"), "[99]");
    assert.equal((await provider.versions(scoped))[0].id, "20");
    assert.equal(
      requests
        .find((url) => url.pathname.endsWith("/files"))
        .searchParams.get("modLoaderType"),
      null,
    );
    assert.equal((await provider.resolve(scoped)).files[0].path, "pack.zip");
    assert.deepEqual(
      await provider.versions({ ...scoped, gameVersion: "1.20.1" }),
      [],
    );
    if (type === "shader")
      assert.deepEqual(
        await provider.versions({ ...scoped, loader: "optifine" }),
        [],
      );
  });
}
