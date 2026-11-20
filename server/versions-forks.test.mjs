import assert from "node:assert/strict";
import test from "node:test";
import { createForkProviders } from "./versions-forks.mjs";

const LEAVES = "https://api.leavesmc.org/v2/projects/leaves";
const MAGMA = "https://magmafoundation.org/api/versions?limit=0";
const SHA256 = "a".repeat(64);

function adapters(records, checksums = {}) {
  const requests = [];
  const entries = new Map();
  return {
    requests,
    providers: createForkProviders({
      json: async (url) => {
        requests.push(url);
        assert.ok(Object.hasOwn(records, url), `Unexpected request: ${url}`);
        return records[url];
      },
      text: async (url) => {
        requests.push(url);
        if (!Object.hasOwn(checksums, url)) throw new Error("HTTP 404");
        return checksums[url];
      },
      cached: (key, work) => {
        if (!entries.has(key)) entries.set(key, work());
        return entries.get(key);
      },
    }),
  };
}

test("Leaves groups official builds and excludes artifacts without a SHA-256 checksum", async () => {
  const catalog = `${LEAVES}/versions/1.21.8/builds`;
  const { providers } = adapters({
    [LEAVES]: { versions: ["1.21.8", "1.21.11", null, "../invalid"] },
    [catalog]: {
      builds: [
        { build: 2, channel: "experimental", downloads: {} },
        {
          build: 9,
          time: "2025-10-18T16:15:44.975Z",
          channel: "default",
          downloads: { application: { sha256: SHA256 } },
        },
        {
          build: 10,
          channel: "experimental",
          downloads: { application: { sha256: SHA256 } },
        },
      ],
    },
  });

  const releases = await providers.leaves.versions();
  assert.deepEqual(
    releases.map(({ id }) => id),
    ["1.21.11", "1.21.8"],
  );
  assert.equal(releases[1].url, catalog);
  const builds = await providers.leaves.builds("1.21.8");
  assert.deepEqual(
    builds.map(({ id, stable }) => [id, stable]),
    [
      ["10", false],
      ["9", true],
    ],
  );
  assert.deepEqual(builds[1], {
    id: "9",
    label: "Build 9",
    stable: true,
    javaVersion: 21,
    publishedAt: "2025-10-18T16:15:44.975Z",
    url: `${catalog}/9`,
    artifact: {
      url: `${catalog}/9/downloads/application`,
      checksums: { sha256: SHA256 },
    },
  });
});

test("Magma offers the 1.21.1 launcher series and requires a valid official checksum for the chosen build", async () => {
  const id = "21.1.70-beta";
  const base = `https://repo.magmafoundation.org/releases/org/magmafoundation/magma/${id}/magma-${id}`;
  const launcherUrl = `${base}-launcher.jar`;
  const changelogUrl = `${base}-changelog.txt`;
  const checksumUrl = `${launcherUrl}.sha256`;
  const advertised = {
    version: id,
    minecraftVersion: "1.21.x",
    hasLauncher: true,
    isStable: false,
    launcherUrl,
    changelogUrl,
  };
  const checksums = {};
  const { requests, providers } = adapters(
    {
      [MAGMA]: {
        versions: [
          null,
          { ...advertised, minecraftVersion: "1.12.x" },
          { ...advertised, version: "21.1.71-beta", hasLauncher: false },
          {
            ...advertised,
            launcherUrl: "https://nonofficial.example/server.jar",
          },
          advertised,
        ],
      },
    },
    checksums,
  );
  assert.deepEqual(
    (await providers.magma.versions()).map(({ id }) => id),
    ["1.21.1"],
  );
  assert.deepEqual(await providers.magma.builds("1.12.2"), []);
  const builds = await providers.magma.builds("1.21.1");
  assert.deepEqual(requests, [MAGMA]);
  assert.deepEqual(builds, [
    {
      id,
      label: id,
      stable: false,
      javaVersion: 21,
      url: changelogUrl,
      artifact: { url: launcherUrl },
    },
  ]);

  const resolve = () => providers.magma.artifact("1.21.1", builds[0]);
  await assert.rejects(
    resolve,
    /official Magma launcher checksum is unavailable/,
  );
  checksums[checksumUrl] = "bad";
  await assert.rejects(resolve, /invalid launcher checksum/);
  checksums[checksumUrl] = `${SHA256}\n`;
  assert.deepEqual(await resolve(), {
    url: launcherUrl,
    checksums: { sha256: SHA256 },
  });
});
