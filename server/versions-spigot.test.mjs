import test from "node:test";
import assert from "node:assert/strict";
import { createSpigotProvider, spigotBuildTools } from "./versions-spigot.mjs";

const official = "https://hub.spigotmc.org/versions/";
const refs = {
  BuildData: "a".repeat(40),
  Bukkit: "b".repeat(40),
  CraftBukkit: "c".repeat(40),
  Spigot: "d".repeat(40),
};

test("Spigot selects exact BuildTools revisions and publishes the supported JDK", async () => {
  const current = {
    name: "4344",
    refs,
    toolsVersion: 181,
    javaVersions: [65, 67],
  };
  const legacy = { name: "1.8", refs };
  const historical = {
    name: "4195-b",
    refs,
    toolsVersion: 181,
    javaVersions: [65, 66],
  };
  const records = new Map([
    [`${official}1.8.json`, legacy],
    [`${official}1.20.6.json`, historical],
    [`${official}4195-b.json`, historical],
    [`${official}1.21.1.json`, current],
    [`${official}4344.json`, current],
  ]);
  const provider = createSpigotProvider({
    text: async (url) => {
      assert.equal(url, official);
      return `<a href="1.20.6.json">1.20.6.json</a>
        <a href="1.21.1.json">1.21.1.json</a>
        <a href="1.8.json">1.8.json</a>
        <a href="latest.json">latest.json</a>
        <a href="26.4.json">26.4.json</a>
        <a href="https://example.com/1.21.5.json">unofficial</a>`;
    },
    json: async (url) => {
      assert.ok(records.has(url), url);
      return records.get(url);
    },
    cached: async (_key, operation) => operation(),
  });
  assert.deepEqual(
    (await provider.versions()).map(({ id }) => id),
    ["1.21.1", "1.20.6", "1.8"],
  );
  assert.deepEqual(await provider.builds("1.21.1"), [
    {
      id: "4344",
      label: "Build 4344",
      stable: true,
      javaVersion: 21,
      maxJavaVersion: 23,
      url: `${official}4344.json`,
    },
  ]);
  assert.equal((await provider.builds("1.20.6"))[0].id, "4195-b");
  assert.equal((await provider.builds("1.8"))[0].javaVersion, 8);
  assert.deepEqual(await provider.builds("../latest"), []);
  assert.match(
    spigotBuildTools.url,
    /\/BuildTools\/201\/artifact\/target\/BuildTools\.jar$/,
  );
  assert.match(spigotBuildTools.sha256, /^[a-f0-9]{64}$/);
});

test("Spigot refuses a changed pinned revision and a release requiring newer BuildTools", async () => {
  let release = {
    name: "4344",
    refs,
    toolsVersion: 181,
    javaVersions: [65, 67],
  };
  let exactReads = 0;
  const provider = createSpigotProvider({
    json: async (url) => {
      if (url === `${official}1.21.1.json`) return release;
      assert.equal(url, `${official}4344.json`);
      exactReads++;
      return { ...release, refs: { ...refs, Spigot: "f".repeat(40) } };
    },
    cached: async (_key, operation) => operation(),
  });
  assert.deepEqual(await provider.builds("1.21.1"), []);
  await assert.rejects(
    provider.installer({ version: "1.21.1", build: "4344" }),
    { status: 400 },
  );
  assert.equal(exactReads, 2);
  release = { ...release, toolsVersion: 202 };
  assert.deepEqual(await provider.builds("1.21.1"), []);
  assert.equal(exactReads, 2);
});
