import test from "node:test";
import assert from "node:assert/strict";
import {
  allModCategories,
  categoryIds,
  matchesCategories,
  modCategories,
  normalizeCurseforgeCategories,
  normalizeModrinthCategories,
  supportsCategory,
} from "../shared/launchpad-categories.mjs";
import { createCoreProviders } from "./launchpad-providers.mjs";

test("mod category filters validate canonical IDs and include parent descendants", () => {
  assert.deepEqual(categoryIds("mobs,technology,mobs"), ["mobs", "technology"]);
  assert.deepEqual(categoryIds(undefined), []);
  for (const value of [
    null,
    {},
    ["missing"],
    "worldgen",
    Array(11).fill("mobs"),
  ])
    assert.throws(() => categoryIds(value), /valid mod categories/);
  assert.equal(
    allModCategories.length,
    new Set(allModCategories.map((row) => row.id)).size,
  );
  assert.equal(
    modCategories.find((row) => row.id === "technology").children.length,
    7,
  );
  assert.equal(
    modCategories.find((row) => row.id === "world-gen").children.length,
    5,
  );
  assert.equal(matchesCategories(["automation"], ["technology"]), true);
  assert.equal(matchesCategories(["biomes"], ["world-gen"]), true);
  assert.equal(matchesCategories(["technology"], ["automation"]), false);
  assert.equal(matchesCategories(undefined, ["technology"]), false);
  assert.equal(matchesCategories(undefined, []), true);
  assert.equal(supportsCategory("automation", "modrinth"), false);
  assert.equal(supportsCategory("technology", "modrinth"), true);
  assert.deepEqual(
    normalizeModrinthCategories(["neoforge", "technology", "worldgen"]),
    ["technology", "world-gen"],
  );
  assert.deepEqual(
    normalizeCurseforgeCategories([
      { name: "Energy, Fluid, and Item Transport" },
      { name: "World Gen" },
    ]),
    ["energy-fluid-item-transport", "world-gen"],
  );
});

test("Modrinth sends supported category facets before pagination and rejects unsupported categories", async () => {
  const requests = [];
  const provider = createCoreProviders({
    fetch: async (url) => {
      requests.push(new URL(url));
      return Response.json({
        hits: [
          {
            project_id: "test",
            categories: ["neoforge", "technology"],
            downloads: 20,
            date_modified: "2026-01-02",
            date_created: "2025-01-01",
            versions: ["1.21.1"],
          },
        ],
        total_hits: 200,
        offset: 50,
        limit: 50,
      });
    },
  })[0];
  const result = await provider.search({
    type: "mod",
    query: "",
    categories: ["technology", "world-gen"],
    sort: "downloads",
    offset: 50,
    limit: 50,
    gameVersion: "1.21.1",
    loader: "neoforge",
  });
  assert.deepEqual(JSON.parse(requests[0].searchParams.get("facets")), [
    ["all_project_types:mod"],
    ["server_side!=unsupported"],
    ["versions:1.21.1"],
    ["categories:neoforge"],
    ["categories:technology", "categories:worldgen"],
  ]);
  assert.equal(requests[0].searchParams.get("offset"), "50");
  assert.deepEqual(result.projects[0].categories, ["technology"]);
  assert.equal(result.projects[0].updatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(result.projects[0].releasedAt, "2025-01-01T00:00:00.000Z");
  await assert.rejects(provider.search({ categories: ["automation"] }), {
    status: 400,
  });
  assert.equal(requests.length, 1);
});

test("CurseForge resolves live category IDs and applies them to both pages without changing ordering", async () => {
  const requests = [];
  const provider = createCoreProviders({
    key: async () => "fixture",
    fetch: async (url) => {
      const address = new URL(url);
      requests.push(address);
      if (address.pathname === "/v1/categories")
        return Response.json({
          data: address.searchParams.has("classesOnly")
            ? [{ id: 6, name: "Mods" }]
            : [
                { id: 123, name: "Automation", classId: 6 },
                { id: 456, name: "Biomes", classId: 6 },
              ],
        });
      return Response.json({
        data: Array.from({ length: 50 }, (_, i) => ({
          id: Number(address.searchParams.get("index")) + i,
          name: "Project",
          categories: [{ id: 123, name: "Automation" }],
          primaryCategoryId: 123,
          isFeatured: true,
          downloadCount: 100,
          dateModified: "2026-01-02",
          dateReleased: "2025-01-01",
          latestFilesIndexes: [{ gameVersion: "1.21.1" }],
        })),
        pagination: { totalCount: 300 },
      });
    },
  })[1];
  const result = await provider.search({
    type: "mod",
    query: "",
    categories: ["automation", "biomes"],
    sort: "author",
    offset: 100,
    limit: 100,
  });
  const pages = requests.filter((url) => url.pathname === "/v1/mods/search");
  assert.equal(pages.length, 2);
  for (const url of pages) {
    assert.deepEqual(
      JSON.parse(url.searchParams.get("categoryIds")),
      [123, 456],
    );
    assert.equal(url.searchParams.get("sortField"), "5");
    assert.equal(url.searchParams.get("sortOrder"), "asc");
  }
  assert.equal(result.projects[0].id, "100");
  assert.equal(result.projects.at(-1).id, "199");
  assert.deepEqual(result.projects[0].categories, ["automation"]);
  assert.equal(result.projects[0].mainCategory, "automation");
  assert.equal(result.projects[0].featured, true);
  await assert.rejects(
    provider.search({
      type: "mod",
      categories: ["magic"],
      offset: 0,
      limit: 50,
    }),
    /does not currently expose/,
  );
  assert.equal(
    requests.filter((url) => url.pathname === "/v1/mods/search").length,
    2,
  );
});

test("provider project metadata includes category and sorting fields for installed inventories", async () => {
  const [modrinth, curseforge] = createCoreProviders({
    key: async () => "fixture",
    fetch: async (url) => {
      const address = new URL(url);
      if (address.pathname === "/v2/projects")
        return Response.json([
          {
            id: "project",
            categories: ["technology", "neoforge"],
            downloads: 100,
            followers: 10,
            updated: "2026-01-02",
            published: "2025-01-01",
            game_versions: ["1.21.1"],
          },
        ]);
      if (address.pathname === "/v1/mods")
        return Response.json({
          data: [
            {
              id: 7,
              gameId: 432,
              categories: [{ id: 3, name: "World Gen" }],
              primaryCategoryId: 3,
              downloadCount: 50,
              isFeatured: true,
              dateModified: "2026-01-02",
              dateReleased: "2025-01-01",
              latestFilesIndexes: [{ gameVersion: "1.20.1" }],
            },
          ],
        });
      throw new Error(`Unexpected fixture request ${url}`);
    },
  });
  const mr = (await modrinth.projectMetadata(["project"])).projects[0];
  assert.deepEqual(mr.categories, ["technology"]);
  assert.equal(mr.downloads, 100);
  assert.equal(mr.follows, 10);
  assert.deepEqual(mr.gameVersions, ["1.21.1"]);
  const cf = (await curseforge.projectMetadata(["7"])).projects[0];
  assert.deepEqual(cf.categories, ["world-gen"]);
  assert.equal(cf.mainCategory, "world-gen");
  assert.deepEqual(cf.gameVersions, ["1.20.1"]);
});
