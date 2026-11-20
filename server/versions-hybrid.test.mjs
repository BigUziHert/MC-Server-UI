import assert from "node:assert/strict";
import test from "node:test";
import { createHybridProviders } from "./versions-hybrid.mjs";

const mohist = "https://api.mohistmc.com/project/mohist";
const arclight = "https://files.hypoglycemia.icu/v1/files/arclight/minecraft";
const sponge =
  "https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla";
const sha1 = "a".repeat(40);
const sha256 = "b".repeat(64);

function fixture(entries) {
  const requests = [];
  const read = async (url) => {
    requests.push(url);
    assert.ok(Object.hasOwn(entries, url), `Unexpected URL ${url}`);
    const value = entries[url];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    requests,
    ...createHybridProviders({
      json: read,
      text: read,
      cached: (_key, work) => work(),
    }),
  };
}

test("Mohist offers builds with a published SHA-256 and a pinned official URL", async () => {
  const catalog = `${mohist}/1.20.1/builds`;
  const providers = fixture({
    [`${mohist}/versions`]: [
      { name: "../unrelated" },
      { name: "1.16.5" },
      { name: "1.20.1" },
    ],
    [catalog]: [
      { id: 10, file_sha256: sha256, build_date: "2026-11-12T00:00:00Z" },
      {
        id: 11,
        file_sha256: sha256,
        build_date: "2026-11-13T00:00:00Z",
        commit: { hash: sha1 },
      },
      { id: 12, file_sha256: sha1 },
      { id: 13.5, file_sha256: sha256 },
    ],
  });
  const versions = await providers.mohist.versions();
  assert.deepEqual(
    versions.map(({ id }) => id),
    ["1.20.1", "1.16.5"],
  );
  const builds = await providers.mohist.builds("1.20.1");
  assert.deepEqual(
    builds.map(({ id }) => id),
    ["11", "10"],
  );
  assert.deepEqual(builds[0].artifact, {
    url: `${catalog}/11/download`,
    checksums: { sha256 },
  });
  assert.equal(
    builds[0].url,
    "https://www.mohistmc.com/downloadSoftware?project=mohist&projectVersion=1.20.1#:~:text=aaaaaaaa",
  );
});

test("Arclight keeps loader variants distinct and verifies content-addressed archives", async () => {
  const loaders = `${arclight}/1.21.1/loaders`;
  const build = {
    type: "object",
    name: "1.0.1-8ec9529",
    permlink: `https://files.hypertention.cn/v1/objects/${sha1}`,
  };
  const providers = fixture({
    [arclight]: { files: [{ name: "1.21.1" }] },
    [loaders]: {
      files: [{ name: "forge" }, { name: "neoforge" }, { name: "unknown" }],
    },
    [`${loaders}/forge`]: { files: [{ name: "versions-stable" }] },
    [`${loaders}/neoforge`]: {
      files: [{ name: "versions-stable" }, { name: "versions-snapshot" }],
    },
    [`${loaders}/forge/versions-stable`]: { files: [build] },
    [`${loaders}/neoforge/versions-stable`]: {
      files: [
        build,
        { ...build, permlink: `https://other.example/v1/objects/${sha1}` },
        { ...build, permlink: `${build.permlink}?download=other.jar` },
      ],
    },
    [`${loaders}/neoforge/versions-snapshot`]: {
      files: [{ ...build, name: "1.0.2-SNAPSHOT-13579ac" }],
    },
  });
  assert.equal((await providers.arclight.versions())[0].id, "1.21.1");
  const builds = await providers.arclight.builds("1.21.1");
  assert.deepEqual(
    builds.map(({ id, stable }) => [id, stable]),
    [
      ["neoforge-1.0.1-8ec9529", true],
      ["forge-1.0.1-8ec9529", true],
      ["neoforge-1.0.2-SNAPSHOT-13579ac", false],
    ],
  );
  assert.equal(builds[0].label, "1.0.1-8ec9529 · NeoForge");
  assert.equal(
    builds[0].url,
    "https://github.com/IzzelAliz/Arclight/commit/8ec9529",
  );
  assert.deepEqual(builds[0].artifact, {
    url: `https://files.hypoglycemia.icu/v1/objects/${sha1}`,
    checksums: { sha1 },
  });
});

test("Sponge retains recommended builds and verifies the selected universal JAR", async () => {
  const version = "1.21.1";
  const build = "1.21.1-12.0.3";
  const catalog = `${sponge}/versions?tags=minecraft%3A${version}`;
  const source = `https://repo.spongepowered.org/repository/maven-releases/org/spongepowered/spongevanilla/${build}/spongevanilla-${build}`;
  const official = `${source}-universal.jar`;
  const providers = fixture({
    [sponge]: { tags: { minecraft: [version] } },
    [catalog]: {
      artifacts: {
        "1.21.1-12.0.4-RC2779": { tagValues: { minecraft: version } },
        "1.21.2-13.0.1": { tagValues: { minecraft: "1.21.2" } },
      },
    },
    [`${catalog}&recommended=true`]: {
      artifacts: {
        [build]: { recommended: true, tagValues: { minecraft: version } },
      },
    },
    [`${sponge}/versions/${build}`]: {
      assets: [
        { extension: "jar", downloadUrl: `${source}.jar`, sha1 },
        {
          extension: "jar",
          classifier: "universal",
          downloadUrl: official,
          sha1,
        },
        {
          extension: "jar",
          classifier: "universal",
          downloadUrl: official.replace(
            "repo.spongepowered.org",
            "unknown.example",
          ),
          sha1,
        },
      ],
    },
    [`${official}.sha256`]: `${sha256}\n`,
  });
  assert.equal((await providers.sponge.versions())[0].id, version);
  const builds = await providers.sponge.builds(version);
  assert.deepEqual(
    builds.map(({ id, stable }) => [id, stable]),
    [
      [build, true],
      ["1.21.1-12.0.4-RC2779", false],
    ],
  );
  assert.equal(providers.requests.length, 3);
  assert.deepEqual(await providers.sponge.artifact(version, builds[0]), {
    url: official,
    checksums: { sha256 },
  });
});

test("Sponge legacy servers use the official plain JAR and its published SHA-1 if needed", async () => {
  const id = "1.12.2-7.4.7";
  const url = `https://repo.spongepowered.org/repository/legacy-transfer/org/spongepowered/spongevanilla/${id}/spongevanilla-${id}.jar`;
  const providers = fixture({
    [`${sponge}/versions/${id}`]: {
      assets: [{ extension: "jar", downloadUrl: url, sha1 }],
    },
    [`${url}.sha256`]: new Error("No SHA-256 published"),
  });
  assert.deepEqual(await providers.sponge.artifact("1.12.2", { id }), {
    url,
    checksums: { sha1 },
  });
});
