import test from "node:test";
import assert from "node:assert/strict";
import { projectPageUrl } from "../shared/launchpad-project.mjs";

test("project links preserve valid metadata and resolve identified legacy entries", () => {
  assert.equal(
    projectPageUrl({
      platform: "modrinth",
      projectId: "P7dR8mSH",
      url: "https://modrinth.com/mod/fabric-api",
    }),
    "https://modrinth.com/mod/fabric-api",
  );
  for (const [platform, projectId, expected] of [
    ["modrinth", "P7dR8mSH", "https://modrinth.com/project/P7dR8mSH"],
    ["curseforge", "238222", "https://www.curseforge.com/projects/238222"],
    ["spigot", "9089", "https://www.spigotmc.org/resources/9089/"],
    ["ftb", "123", "https://www.feed-the-beast.com/modpacks/123"],
    ["atlauncher", "TestPack", "https://atlauncher.com/pack/TestPack"],
  ])
    assert.equal(projectPageUrl({ platform, projectId }), expected);
});

test("project links do not guess unknown files or accept unsafe URLs and IDs", () => {
  for (const value of [
    { platform: null, projectId: "mods/fabric-api.jar" },
    { platform: "unsupported", projectId: "123" },
    { platform: "modrinth", projectId: "../malformed" },
    { platform: "modrinth", projectId: "mod?download=true" },
    { platform: "curseforge", projectId: "jei" },
    { url: "javascript:alert(1)" },
    { url: "http://example.com/mod" },
    { url: "https://account:password@example.com/mod" },
  ])
    assert.equal(projectPageUrl(value), undefined);
  assert.equal(
    projectPageUrl({
      platform: "modrinth",
      projectId: "fabric-api",
      url: "javascript:alert(1)",
    }),
    "https://modrinth.com/project/fabric-api",
  );
});
