import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCoreProviders } from "./launchpad-providers.mjs";

const input = {
  type: "mod",
  projectId: "T9PomCSv",
  versionId: "hyQUls27",
  gameVersion: "1.21.1",
  loader: "neoforge",
};
const raw = (overrides = {}) => ({
  id: "1L6XJqnY",
  project_id: input.projectId,
  name: "Sable (NeoForge) 2.0.3",
  version_number: "2.0.3+mc1.21.1",
  game_versions: ["1.21.1"],
  loaders: ["neoforge"],
  date_published: "2026-08-01T00:00:00Z",
  environment: "server_only",
  files: [
    {
      filename: "sable-neoforge-2.0.3.jar",
      primary: true,
      url: "https://cdn.modrinth.com/data/T9PomCSv/sable-neoforge-2.0.3.jar",
      hashes: {
        sha512: createHash("sha512")
          .update("verified Sable variant")
          .digest("hex"),
      },
      size: 32,
    },
  ],
  ...overrides,
});
const fixture = ({
  pinned = {},
  rows = [raw()],
  resolved = raw(),
  failure,
} = {}) => {
  const requests = [];
  const provider = createCoreProviders({
    fetch: async (url, options) => {
      const address = new URL(url);
      requests.push({ address, options });
      if (address.pathname === `/v2/version/${input.versionId}`)
        return Response.json(
          raw({
            id: input.versionId,
            name: "Sable (Fabric) 2.0.3",
            loaders: ["fabric"],
            ...pinned,
          }),
        );
      if (address.pathname === `/v2/project/${input.projectId}`)
        return Response.json({
          id: input.projectId,
          title: "Sable",
          project_type: "mod",
          server_side: "required",
        });
      if (address.pathname === `/v2/version/${resolved.id}`)
        return Response.json(resolved);
      assert.equal(address.pathname, `/v2/project/${input.projectId}/version`);
      if (failure) return new Response(null, { status: failure });
      return Response.json(rows);
    },
  })[0];
  return { provider, requests };
};

test("a wrong-loader dependency pin resolves only the unique compatible variant of the exact same release", async () => {
  const f = fixture({
    rows: [
      raw({
        id: "newest",
        version_number: "2.0.5+mc1.21.1",
        date_published: "2026-09-01T00:00:00Z",
      }),
      raw(),
    ],
  });
  const recovered = await f.provider.compatibleDependencyVersion(input);
  assert.deepEqual(recovered, {
    id: "1L6XJqnY",
    name: "Sable (NeoForge) 2.0.3",
    version: "2.0.3+mc1.21.1",
    gameVersions: ["1.21.1"],
    loaders: ["neoforge"],
    publishedAt: "2026-08-01T00:00:00Z",
    downloadable: true,
  });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(
    JSON.parse(f.requests[1].address.searchParams.get("game_versions")),
    ["1.21.1"],
  );
  assert.deepEqual(
    JSON.parse(f.requests[1].address.searchParams.get("loaders")),
    ["neoforge"],
  );
  assert.ok(
    f.requests.every(({ address }) => address.hostname === "api.modrinth.com"),
  );
});

test("identical duplicate candidate IDs count once, while multiple compatible variant IDs remain ambiguous", async () => {
  const duplicate = fixture({ rows: [raw(), raw()] });
  assert.equal(
    (await duplicate.provider.compatibleDependencyVersion(input)).id,
    "1L6XJqnY",
  );
  const ambiguous = fixture({ rows: [raw(), raw({ id: "other-build" })] });
  assert.equal(
    await ambiguous.provider.compatibleDependencyVersion(input),
    null,
  );
});

test("final dependency resolution remains bound to the exact recovered release label", async () => {
  for (const changed of [false, true]) {
    const f = fixture({
      resolved: raw({
        version_number: changed ? "2.0.5+mc1.21.1" : "2.0.3+mc1.21.1",
      }),
    });
    const candidate = await f.provider.compatibleDependencyVersion(input);
    assert.equal(candidate.version, "2.0.3+mc1.21.1");
    const resolution = f.provider.resolve({
      ...input,
      versionId: candidate.id,
      expectedVersionNumber: candidate.version,
    });
    if (changed)
      await assert.rejects(resolution, (cause) => {
        assert.equal(cause.status, 400);
        assert.notEqual(cause.code, "INCOMPATIBLE_VERSION");
        assert.match(cause.message, /release metadata changed/);
        return true;
      });
    else
      assert.equal(
        (await resolution).files[0].path,
        "sable-neoforge-2.0.3.jar",
      );
    assert.equal(f.requests.length, 4);
    assert.ok(
      f.requests.every(
        ({ address }) => address.hostname === "api.modrinth.com",
      ),
    );
  }
});

for (const [name, conflict] of [
  ["project", { project_id: "different-project" }],
  ["release number", { version_number: "2.0.5+mc1.21.1" }],
  ["loader", { loaders: ["fabric"] }],
  ["Minecraft", { game_versions: ["1.20.1"] }],
  ["server environment", { environment: "client_only" }],
  [
    "download",
    { files: [{ ...raw().files[0], hashes: { sha512: "0".repeat(128) } }] },
  ],
]) {
  test(`conflicting ${name} metadata for the same candidate ID cannot be hidden by filtering`, async () => {
    for (const rows of [
      [raw(), raw(conflict)],
      [raw(conflict), raw()],
    ]) {
      const f = fixture({ rows });
      assert.equal(await f.provider.compatibleDependencyVersion(input), null);
    }
  });
}

for (const [name, pinned] of [
  ["another project", { project_id: "different-project" }],
  ["another pinned version", { id: "different-version" }],
  ["another Minecraft version", { game_versions: ["1.20.1"] }],
  ["an already compatible loader", { loaders: ["neoforge"] }],
  ["an empty release number", { version_number: "" }],
  ["a missing release number", { version_number: null }],
  ["a whitespace release number", { version_number: "  " }],
  ["missing loaders", { loaders: [] }],
  ["malformed Minecraft tags", { game_versions: "1.21.1" }],
]) {
  test(`dependency recovery does not search variants for ${name}`, async () => {
    const f = fixture({ pinned });
    assert.equal(await f.provider.compatibleDependencyVersion(input), null);
    assert.equal(f.requests.length, 1);
  });
}

for (const overrides of [
  { type: "plugin" },
  { gameVersion: "" },
  { loader: "" },
  { loader: "paper" },
]) {
  test(`dependency variant lookup requires an explicit mod runtime ${JSON.stringify(overrides)}`, async () => {
    const f = fixture();
    assert.equal(
      await f.provider.compatibleDependencyVersion({ ...input, ...overrides }),
      null,
    );
    assert.equal(f.requests.length, 0);
  });
}

for (const [name, candidate] of [
  ["another project", { project_id: "different-project" }],
  [
    "another release despite matching name",
    { version_number: "2.0.5+mc1.21.1" },
  ],
  ["a normalized but unequal release label", { version_number: "2.0.3" }],
  ["another Minecraft version", { game_versions: ["1.20.1"] }],
  ["another loader", { loaders: ["fabric"] }],
  ["client-only content", { environment: "client_only" }],
  ["singleplayer-only content", { environment: "singleplayer_only" }],
  ["the unchanged pinned ID", { id: input.versionId }],
  ["a malformed version ID", { id: "../wrong" }],
  ["missing downloads", { files: [] }],
  ["malformed download entries", { files: [null] }],
  ["an unverified file", { files: [{ ...raw().files[0], hashes: {} }] }],
  [
    "an invalid checksum",
    { files: [{ ...raw().files[0], hashes: { sha512: "bad" } }] },
  ],
  [
    "an unsupported host",
    { files: [{ ...raw().files[0], url: "https://example.com/mod.jar" }] },
  ],
  [
    "an incompatible file type",
    { files: [{ ...raw().files[0], filename: "mod.zip" }] },
  ],
]) {
  test(`dependency recovery never substitutes ${name}`, async () => {
    const f = fixture({ rows: [raw(candidate)] });
    assert.equal(await f.provider.compatibleDependencyVersion(input), null);
    assert.equal(f.requests.length, 2);
  });
}

test("variant lookup errors propagate without guessing a replacement", async () => {
  const f = fixture({ failure: 503 });
  await assert.rejects(f.provider.compatibleDependencyVersion(input), {
    status: 502,
  });
  assert.equal(f.requests.length, 2);
});
