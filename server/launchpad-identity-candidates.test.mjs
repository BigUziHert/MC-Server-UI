import test from "node:test";
import assert from "node:assert/strict";
import { createCoreProviders } from "./launchpad-providers.mjs";

const name = "aether-1.21.1-1.5.10-neoforge.jar";
const input = {
  name,
  title: "The Aether",
  gameVersion: "1.21.1",
  loader: "neoforge",
};
const json = (value) => new Response(JSON.stringify(value));
const release = (project = "p1", version = "v1", changes = {}) => ({
  id: version,
  project_id: project,
  name: "The Aether 1.5.10",
  version_number: "1.21.1-1.5.10-neoforge",
  game_versions: ["1.21.1"],
  loaders: ["neoforge"],
  files: [
    {
      filename: name,
      size: 40223909,
      hashes: { sha512: "a".repeat(128) },
      url: "https://cdn.modrinth.com/data/p1/versions/v1/aether.jar",
    },
  ],
  ...changes,
});
function fixture({
  hits = [{ project_id: "p1", project_type: "mod" }],
  versions = [release()],
} = {}) {
  const calls = [];
  const [provider] = createCoreProviders({
    fetch: async (address) => {
      const url = new URL(address);
      calls.push(url);
      if (url.pathname === "/v2/search") return json({ hits });
      const project = url.pathname.split("/")[3];
      return json(
        typeof versions === "function" ? versions(project, url) : versions,
      );
    },
  });
  return { provider, calls };
}

test("candidate discovery preserves raw release fields and only the exact filename artifact", async () => {
  const version = release();
  version.files.push({ ...version.files[0], filename: "aether-other.jar" });
  const { provider, calls } = fixture({ versions: [version] });
  const candidates = await provider.installedCandidates(input);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], { ...version, files: [version.files[0]] });
  assert.equal(calls[0].searchParams.get("query"), "The Aether");
  assert.equal(calls[0].searchParams.get("limit"), "5");
  assert.deepEqual(JSON.parse(calls[0].searchParams.get("facets")), [
    ["all_project_types:mod"],
  ]);
  assert.deepEqual(JSON.parse(calls[1].searchParams.get("game_versions")), [
    "1.21.1",
  ]);
  assert.deepEqual(JSON.parse(calls[1].searchParams.get("loaders")), [
    "neoforge",
  ]);
  assert.equal(
    calls.length,
    2,
    "a compatible filename avoids unfiltered history reads",
  );
});

test("name similarity alone and another project's history never produce artifact candidates", async () => {
  const changedName = release();
  changedName.files[0].filename = "aether-1.21.1-1.5.11-neoforge.jar";
  const { provider } = fixture({
    versions: [changedName, release("other", "v2")],
  });
  assert.deepEqual(await provider.installedCandidates(input), []);
});

test("an installed artifact from a different runtime is discovered through bounded unfiltered histories", async () => {
  const installed = release("p1", "older", {
    game_versions: ["1.20.1"],
    loaders: ["forge"],
  });
  const { provider, calls } = fixture({
    versions: (_project, url) =>
      url.searchParams.has("game_versions") || url.searchParams.has("loaders")
        ? []
        : [installed],
  });
  assert.deepEqual(await provider.installedCandidates(input), [installed]);
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[0].searchParams.get("facets")), [
    ["all_project_types:mod"],
  ]);
  assert.equal(calls[1].pathname, calls[2].pathname);
  assert.equal(calls[2].searchParams.size, 0);
  // This only proposes a downloadable artifact. The recovery caller still
  // compares its archive contents before accepting any identity.
});

test("a missing display title uses only the filename prefix as a search hint", async () => {
  const { provider, calls } = fixture();
  await provider.installedCandidates({ ...input, title: undefined });
  assert.equal(calls[0].searchParams.get("query"), "aether");
  assert.deepEqual(
    await provider.installedCandidates({ ...input, name: "../aether.jar" }),
    [],
  );
  assert.deepEqual(
    await provider.installedCandidates({ ...input, name: "aether.zip" }),
    [],
  );
  assert.equal(calls.length, 2);
});

test("candidate discovery inspects at most five projects and refuses more than three matching artifacts", async () => {
  const hits = Array.from({ length: 7 }, (_, index) => ({
    project_id: `p${index}`,
  }));
  const bounded = fixture({ hits, versions: [] });
  assert.deepEqual(await bounded.provider.installedCandidates(input), []);
  assert.equal(bounded.calls.length, 11);
  assert.equal(
    new Set(bounded.calls.slice(1).map((url) => url.pathname)).size,
    5,
  );
  const unfiltered = fixture({ hits, versions: [] });
  assert.deepEqual(
    await unfiltered.provider.installedCandidates({
      ...input,
      loader: "",
      gameVersion: "",
    }),
    [],
  );
  assert.equal(
    unfiltered.calls.length,
    6,
    "an unfiltered initial query is not repeated",
  );
  const ambiguous = fixture({
    hits,
    versions: (project) => [release(project, `v${project}`)],
  });
  assert.deepEqual(await ambiguous.provider.installedCandidates(input), []);
  assert.equal(ambiguous.calls.length, 5);
});

test("invalid file hashes, sizes, hosts, ids and ambiguous filenames are rejected", async () => {
  const files = [
    { hashes: { sha512: "invalid" } },
    { size: 128 * 1024 ** 2 + 1 },
    { size: -1 },
    { size: 1.5 },
    { url: "http://cdn.modrinth.com/aether.jar" },
    { url: "https://example.com/aether.jar" },
    { url: "https://user@cdn.modrinth.com/aether.jar" },
  ];
  const versions = files.map((changes, index) => {
    const version = release("p1", `v${index}`);
    Object.assign(version.files[0], changes);
    return version;
  });
  versions.push(release("p1", "../wrong"));
  const duplicate = release("p1", "dup");
  duplicate.files.push({ ...duplicate.files[0] });
  versions.push(duplicate);
  const { provider } = fixture({ versions });
  assert.deepEqual(await provider.installedCandidates(input), []);
});

test("conflicting metadata for a single candidate version does not select an arbitrary artifact", async () => {
  const first = release(),
    second = release();
  second.files[0].hashes.sha512 = "b".repeat(128);
  const { provider } = fixture({ versions: [first, second] });
  assert.deepEqual(await provider.installedCandidates(input), []);
});

test("cancelling a shared candidate search leaves its other subscriber active", async () => {
  let releaseSearch, startedSearch;
  const gate = new Promise((resolve) => {
    releaseSearch = resolve;
  });
  const started = new Promise((resolve) => {
    startedSearch = resolve;
  });
  let calls = 0;
  const [provider] = createCoreProviders({
    fetch: async (address) => {
      calls++;
      if (new URL(address).pathname === "/v2/search") {
        startedSearch();
        await gate;
        return json({ hits: [{ project_id: "p1" }] });
      }
      return json([release()]);
    },
  });
  const controller = new AbortController();
  const first = provider.installedCandidates({
    ...input,
    signal: controller.signal,
  });
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = provider.installedCandidates(input);
  await started;
  controller.abort();
  await rejected;
  releaseSearch();
  assert.equal((await second).length, 1);
  assert.equal(calls, 2);
  await assert.rejects(
    provider.installedCandidates({ ...input, signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(calls, 2);
});
