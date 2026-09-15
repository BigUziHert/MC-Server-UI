import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createExtraProviders } from "./launchpad-extra.mjs";

const digest = (algorithm, bytes) =>
  createHash(algorithm).update(bytes).digest("hex");
const jar = Buffer.concat([
  Buffer.from("504b0304", "hex"),
  Buffer.from("isolated test package"),
]);
function fixture(data, handler = () => null) {
  const requests = [];
  const providers = createExtraProviders({
    json: async (url) => {
      requests.push(url);
      if (!Object.hasOwn(data, url))
        throw new Error(`Unexpected API request: ${url}`);
      return structuredClone(
        typeof data[url] === "function" ? data[url]() : data[url],
      );
    },
    fetch: async (url, options) => {
      requests.push(url);
      const response = handler(url, options);
      if (!response) throw new Error(`Unexpected network request: ${url}`);
      return response;
    },
  });
  return {
    providers,
    requests,
    provider: (id) => providers.find((provider) => provider.id === id),
  };
}
const FTB = "https://api.feed-the-beast.com/v1/modpacks/public/modpack";
const ATL = "https://api.atlauncher.com/v1";
const CDN = "https://download.nodecdn.net/containers/atl/";
const SPIGOT = "https://api.spiget.org/v2";
const version = {
  id: 10,
  name: "1.0",
  released: 1700000000,
  type: "release",
  private: false,
  targets: [
    { type: "game", name: "minecraft", version: "1.21.1" },
    { type: "modloader", name: "neoforge", version: "21.1.1" },
  ],
};
const ftbSelection = {
  type: "modpack",
  projectId: "1",
  versionId: "10",
  gameVersion: "1.21.1",
  loader: "neoforge",
};

test("extra source capabilities expose only supported content types", () => {
  const { providers } = fixture({});
  assert.deepEqual(
    providers.map(({ id, types, available }) => ({ id, types, available })),
    [
      { id: "spigot", types: ["plugin"], available: true },
      { id: "ftb", types: ["modpack"], available: true },
      { id: "atlauncher", types: ["modpack"], available: true },
      { id: "voidswrath", types: ["modpack"], available: true },
    ],
  );
  assert.deepEqual(
    Object.fromEntries(
      providers.map(({ id, sortOptions }) => [
        id,
        sortOptions.map((option) => option.id),
      ]),
    ),
    {
      spigot: ["downloads", "updated", "newest", "name"],
      ftb: ["downloads", "popular", "updated", "newest", "name"],
      atlauncher: ["updated", "name"],
      voidswrath: ["name"],
    },
  );
  assert.equal(
    providers.find(({ id }) => id === "ftb").sortOptions[1].label,
    "Most played",
  );
});

test("FTB sorts every matching pack before paging and preserves the default cached order", async () => {
  const names = [
    "Golf",
    "Alpha",
    "Echo",
    "Charlie",
    "Foxtrot",
    "Bravo",
    "Delta",
    "Hotel",
  ];
  const installs = [10, 70, 30, 50, 20, 60, 40];
  const plays = [70, 10, 60, 20, 50, 30, 40];
  const released = [100, 300, 200, 700, 400, 500, 600];
  const updated = [80, 30, 10, 70, 20, 60, 50];
  const packs = names.map((name, index) => ({
    id: index + 1,
    name,
    installs: installs[index],
    plays: plays[index],
    released: released[index],
    updated: updated[index],
    versions: [
      { ...version, released: 1 },
      ...(index === 3 ? [{ ...version, released: 99 }] : []),
    ],
  }));
  packs.push({ ...packs[0], id: 9, private: true, installs: 1000 });
  packs.push({ ...packs[0], id: 10, installs: 1000, versions: [] });
  const data = Object.fromEntries(
    packs.map((pack) => [`${FTB}/${pack.id}`, pack]),
  );
  data[`${FTB}/search/500?term=fixture`] = {
    packs: packs.map((pack) => pack.id),
  };
  const { provider, requests } = fixture(data);
  const input = { ...ftbSelection, query: "fixture", offset: 0, limit: 3 };
  const expected = {
    downloads: [2, 6, 4, 7, 3, 5, 1, 8],
    popular: [1, 3, 5, 7, 6, 4, 2, 8],
    updated: [4, 1, 6, 7, 2, 5, 3, 8],
    newest: [4, 7, 6, 5, 2, 3, 1, 8],
    name: [2, 6, 4, 7, 3, 5, 1, 8],
  };
  for (const [sort, order] of Object.entries(expected)) {
    const pages = [];
    for (const offset of [0, 3, 6]) {
      const result = await provider("ftb").search({ ...input, sort, offset });
      assert.equal(result.total, 8);
      pages.push(...result.projects.map((project) => Number(project.id)));
    }
    assert.deepEqual(pages, order, sort);
  }
  const unchanged = await provider("ftb").search(input);
  assert.deepEqual(
    unchanged.projects.map(({ id }) => id),
    ["1", "2", "3"],
  );
  assert.equal(
    requests.length,
    11,
    "catalog and pack metadata remain cached across sorts",
  );
});

test("ATLauncher sorts the complete filtered catalog by latest published version or name", async () => {
  const data = [
    ["Golf", [10, 80]],
    ["Alpha", [30]],
    ["Echo", [10]],
    ["Charlie", [70]],
    ["Foxtrot", [20]],
    ["Bravo", [60]],
    ["Delta", [50]],
    ["Hotel", [null]],
  ].map(([name, published]) => ({
    name,
    safeName: name,
    description: "Fixture",
    versions: published.map((time, index) => ({
      version: String(index),
      minecraft: "1.21.1",
      published: time,
    })),
  }));
  data.push({
    name: "Excluded",
    safeName: "Excluded",
    description: "Fixture",
    versions: [{ minecraft: "1.20.1", published: 1000 }],
  });
  const { provider, requests } = fixture({
    [`${ATL}/packs/full/public`]: { data },
  });
  const input = {
    type: "modpack",
    query: "fixture",
    gameVersion: "1.21.1",
    loader: "",
    offset: 0,
    limit: 3,
  };
  for (const [sort, expected] of Object.entries({
    updated: [
      "Golf",
      "Charlie",
      "Bravo",
      "Delta",
      "Alpha",
      "Foxtrot",
      "Echo",
      "Hotel",
    ],
    name: [
      "Alpha",
      "Bravo",
      "Charlie",
      "Delta",
      "Echo",
      "Foxtrot",
      "Golf",
      "Hotel",
    ],
  })) {
    const titles = [];
    for (const offset of [0, 3, 6]) {
      const result = await provider("atlauncher").search({
        ...input,
        sort,
        offset,
      });
      assert.equal(result.total, 8);
      titles.push(...result.projects.map(({ title }) => title));
    }
    assert.deepEqual(titles, expected, sort);
  }
  assert.deepEqual(
    (await provider("atlauncher").search(input)).projects.map(
      ({ title }) => title,
    ),
    ["Golf", "Alpha", "Echo"],
  );
  assert.equal(requests.length, 1);
});

test("FTB search applies compatibility and resolves required server files with publisher hashes", async () => {
  const pack = {
    id: 1,
    name: "Fixture Pack",
    synopsis: "An isolated fixture",
    versions: [version],
    installs: 30,
  };
  const file = {
    name: "fixture.jar",
    path: "./mods",
    size: jar.length,
    url: "https://files.feed-the-beast.com/fixture.jar",
    hashes: { sha512: digest("sha512", jar) },
    clientonly: false,
    optional: false,
  };
  const { provider, requests } = fixture({
    [`${FTB}/popular/installs/500`]: { packs: [1] },
    [`${FTB}/1`]: pack,
    [`${FTB}/1/10`]: {
      ...version,
      parent: 1,
      files: [
        file,
        { ...file, name: "client.jar", clientonly: true },
        { ...file, name: "optional.jar", optional: true },
      ],
    },
  });
  const ftb = provider("ftb");
  const search = await ftb.search({
    ...ftbSelection,
    query: "",
    offset: 0,
    limit: 5,
  });
  assert.equal(search.total, 1);
  assert.equal(search.projects[0].downloads, 30);
  assert.equal(
    (
      await ftb.search({
        ...ftbSelection,
        gameVersion: "1.20.1",
        query: "",
        offset: 0,
        limit: 5,
      })
    ).total,
    0,
  );
  const result = await ftb.resolve(ftbSelection);
  assert.deepEqual(result.loaderInstall, {
    loader: "neoforge",
    gameVersion: "1.21.1",
    loaderVersion: "21.1.1",
  });
  assert.deepEqual(result.files, [
    {
      path: "mods/fixture.jar",
      url: file.url,
      size: jar.length,
      hashes: file.hashes,
    },
  ]);
  assert.match(result.warnings.join(" "), /Skipped 2/);
  assert.equal(requests.filter((url) => url === `${FTB}/1`).length, 1);
});

test("FTB rejects changed project identity, traversal, foreign downloads, and missing hashes", async () => {
  const file = {
    name: "fixture.jar",
    path: "mods",
    size: jar.length,
    url: "https://files.feed-the-beast.com/fixture.jar",
    sha1: digest("sha1", jar),
  };
  for (const [patch, pattern] of [
    [{ parent: 2 }, /invalid or incompatible/],
    [{ files: [{ ...file, path: "../outside" }] }, /unsafe file path/],
    [
      { files: [{ ...file, url: "https://127.0.0.1/fixture.jar" }] },
      /outside the provider/,
    ],
    [{ files: [{ ...file, sha1: null }] }, /checksum/],
  ]) {
    const { provider } = fixture({
      [`${FTB}/1`]: { id: 1, name: "Pack", versions: [version] },
      [`${FTB}/1/10`]: { ...version, parent: 1, files: [file], ...patch },
    });
    await assert.rejects(provider("ftb").resolve(ftbSelection), pattern);
  }
});

function atFixture(modPatch = {}) {
  const pack = {
    id: 7,
    name: "Fixture AT Pack",
    safeName: "FixturePack",
    description: "Fixture",
    versions: [{ version: "1.0", minecraft: "1.21.1", published: 1700000000 }],
  };
  const manifest = {
    version: "1.0",
    minecraft: "1.21.1",
    loader: { type: "neoforge", version: "21.1.1" },
    configs: { filesize: 8, sha1: "a".repeat(40) },
    mods: [
      {
        name: "Fixture",
        file: "fixture.jar",
        url: "packs/FixturePack/files/fixture.jar",
        filesize: jar.length,
        md5: digest("md5", jar),
        type: "mods",
        download: "server",
        server: true,
        optional: false,
        ...modPatch,
      },
      { name: "Client", server: false },
      { name: "Optional", server: true, optional: true },
    ],
  };
  return { pack, manifest };
}
test("ATLauncher resolves required mods and config archive together and pins legacy checksums", async () => {
  const { pack, manifest } = atFixture();
  const { provider } = fixture(
    { [`${ATL}/packs/full/public`]: { data: [pack] } },
    (url) => {
      if (url.endsWith("/Configs.json"))
        return new Response(JSON.stringify(manifest));
      if (url.endsWith("/fixture.jar")) return new Response(jar);
    },
  );
  const at = provider("atlauncher");
  const input = { ...ftbSelection, projectId: "FixturePack", versionId: "1.0" };
  assert.equal((await at.versions(input))[0].downloadable, true);
  const resolved = await at.resolve(input);
  assert.deepEqual(resolved.loaderInstall, {
    loader: "neoforge",
    gameVersion: "1.21.1",
    loaderVersion: "21.1.1",
  });
  assert.equal(resolved.files.length, 1);
  assert.deepEqual(resolved.files[0], {
    path: "mods/fixture.jar",
    url: `${CDN}packs/FixturePack/files/fixture.jar`,
    size: jar.length,
    hashes: { sha512: digest("sha512", jar) },
  });
  assert.deepEqual(resolved.archive, {
    format: "server-zip",
    url: `${CDN}packs/FixturePack/versions/1.0/Configs.zip`,
    size: 8,
    hashes: { sha1: "a".repeat(40) },
  });
  assert.match(resolved.warnings.join(" "), /pins the downloaded file/);
  assert.match(resolved.warnings.join(" "), /Skipped 2/);
});

test("ATLauncher refuses required extraction steps and MD5 mismatches without silently skipping content", async () => {
  for (const patch of [{ type: "extract" }, { md5: "0".repeat(32) }]) {
    const { pack, manifest } = atFixture(patch);
    const { provider } = fixture(
      { [`${ATL}/packs/full/public`]: { data: [pack] } },
      (url) =>
        url.endsWith("/Configs.json")
          ? new Response(JSON.stringify(manifest))
          : new Response(jar),
    );
    await assert.rejects(
      provider("atlauncher").resolve({
        ...ftbSelection,
        projectId: "FixturePack",
        versionId: "1.0",
      }),
      /manual installation step|does not match/,
    );
  }
});

function spigotData(patch = {}) {
  return {
    [`${SPIGOT}/resources/1`]: {
      id: 1,
      name: "Fixture Plugin",
      premium: false,
      external: false,
      file: { type: ".jar" },
      version: { id: 10 },
      testedVersions: ["1.21"],
      ...patch,
    },
    [`${SPIGOT}/resources/1/versions?size=100&sort=-releaseDate`]: [
      { id: 9, resource: 1, name: "0.9", releaseDate: 1600000000 },
    ],
    [`${SPIGOT}/resources/1/versions/latest`]: {
      id: 10,
      resource: 1,
      name: "1.0",
      releaseDate: 1700000000,
    },
    [`${SPIGOT}/resources/1/versions/10`]: {
      id: 10,
      resource: 1,
      name: "1.0",
      releaseDate: 1700000000,
    },
  };
}
const spigotSelection = {
  type: "plugin",
  projectId: "1",
  versionId: "10",
  gameVersion: "1.21.1",
  loader: "paper",
};
test("Spigot includes separately published latest versions and pins only official directly hosted JARs", async () => {
  const { provider } = fixture(spigotData(), (url) =>
    url === `${SPIGOT}/resources/1/download`
      ? new Response(null, {
          status: 302,
          headers: { location: "https://cdn.spiget.org/file/fixture.jar" },
        })
      : new Response(jar),
  );
  const spigot = provider("spigot");
  const versions = await spigot.versions(spigotSelection);
  assert.deepEqual(
    versions.map(({ id, downloadable }) => ({ id, downloadable })),
    [
      { id: "10", downloadable: true },
      { id: "9", downloadable: false },
    ],
  );
  const resolved = await spigot.resolve(spigotSelection);
  assert.equal(resolved.files[0].path, "plugins/spigot-1-10.jar");
  assert.equal(resolved.files[0].hashes.sha512, digest("sha512", jar));
  assert.match(resolved.warnings[0], /does not publish a strong checksum/);
});

test("Spigot blocks premium/external files, unsafe redirects, and updates racing preview", async () => {
  for (const patch of [{ premium: true }, { external: true }]) {
    const { provider } = fixture(spigotData(patch));
    await assert.rejects(
      provider("spigot").resolve(spigotSelection),
      /paid or external/,
    );
  }
  const foreign = fixture(
    spigotData(),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
  );
  await assert.rejects(
    foreign.provider("spigot").resolve(spigotSelection),
    /outside the provider/,
  );
  assert.equal(
    foreign.requests.some((url) => url.includes("127.0.0.1")),
    false,
  );
  const changed = spigotData();
  changed[`${SPIGOT}/resources/1/versions/latest`].id = 11;
  const raced = fixture(changed, () => new Response(jar));
  await assert.rejects(
    raced.provider("spigot").resolve(spigotSelection),
    /updated during review/,
  );
});

test("Spigot project paging uses provider totals and never fabricates download counts", async () => {
  const { provider, requests } = fixture(
    {},
    () =>
      new Response(JSON.stringify([{ id: 1, name: "One", tag: "Sample" }]), {
        headers: { "x-total": "24" },
      }),
  );
  const result = await provider("spigot").search({
    type: "plugin",
    query: "",
    gameVersion: "",
    loader: "paper",
    offset: 10,
    limit: 5,
  });
  assert.equal(result.total, 24);
  assert.equal(result.offset, 10);
  assert.equal(result.projects[0].downloads, undefined);
  assert.match(requests[0], /page=3/);
  assert.equal(new URL(requests[0]).searchParams.get("sort"), "-downloads");
});

test("Spigot search never reports zero results when the total header is absent or inconsistent", async () => {
  for (const total of [undefined, "0", "garbage"]) {
    const { provider } = fixture(
      {},
      () =>
        new Response(JSON.stringify([{ id: 1, name: "One" }]), {
          headers: total === undefined ? {} : { "x-total": total },
        }),
    );
    const result = await provider("spigot").search({
      type: "plugin",
      query: "",
      gameVersion: "",
      loader: "paper",
      offset: 10,
      limit: 5,
    });
    assert.equal(result.total, 11);
    assert.equal(result.projects.length, 1);
  }
});

test("Spigot delegates each advertised sort to the upstream catalog before pagination on every search route", async () => {
  const { provider, requests } = fixture(
    {},
    () =>
      new Response(
        JSON.stringify([
          { id: 8, name: "Zulu" },
          { id: 3, name: "Alpha" },
        ]),
        { headers: { "x-total": "24" } },
      ),
  );
  for (const [query, gameVersion, route] of [
    ["", "", "/resources/free"],
    ["", "1.21", "/resources/for/1.21"],
    ["Fixture", "1.21", "/search/resources/Fixture"],
  ]) {
    for (const [sort, expected] of Object.entries({
      downloads: "-downloads",
      updated: "-updateDate",
      newest: "-releaseDate",
      name: "name",
    })) {
      const result = await provider("spigot").search({
        type: "plugin",
        query,
        gameVersion,
        loader: "paper",
        offset: 10,
        limit: 5,
        sort,
      });
      const url = new URL(requests.at(-1));
      assert.equal(url.pathname, `/v2${route}`);
      assert.equal(url.searchParams.get("sort"), expected);
      assert.equal(url.searchParams.get("page"), "3");
      assert.equal(url.searchParams.get("size"), "5");
      assert.equal(result.total, 24);
      assert.deepEqual(
        result.projects.map(({ id }) => id),
        ["8", "3"],
        "the upstream page order is retained",
      );
    }
  }
});

const voidCatalog =
  '<a href="https://voidswrath.com/modpacks/fixture-pack/"><div class="mod-pack-thumb" style="background-image:url(\'https://voidswrath.com/icon.png\');"><div class="mod-pack-title-list">Fixture &amp; Pack</div><ul><li>Version: 1.0</li><li>Minecraft: 1.7.10</li></ul></div></a>';
test("Voids Wrath sorts all matching names before pagination without inventing catalog dates", async () => {
  const names = [
    "Golf",
    "Alpha",
    "Echo",
    "Charlie",
    "Foxtrot",
    "Bravo",
    "Delta",
  ];
  const body = names
    .map((name) =>
      voidCatalog
        .replace("fixture-pack", name.toLowerCase())
        .replace("Fixture &amp; Pack", `${name} Pack`),
    )
    .join("");
  const { provider, requests } = fixture({}, () => new Response(body));
  const input = {
    type: "modpack",
    query: "Pack",
    gameVersion: "1.7.10",
    loader: "forge",
    offset: 0,
    limit: 3,
  };
  const sorted = [];
  for (const offset of [0, 3, 6]) {
    const result = await provider("voidswrath").search({
      ...input,
      sort: "name",
      offset,
    });
    assert.equal(result.total, 7);
    sorted.push(...result.projects.map(({ title }) => title));
  }
  assert.deepEqual(sorted, [
    "Alpha Pack",
    "Bravo Pack",
    "Charlie Pack",
    "Delta Pack",
    "Echo Pack",
    "Foxtrot Pack",
    "Golf Pack",
  ]);
  const original = await provider("voidswrath").search(input);
  assert.deepEqual(
    original.projects.map(({ title }) => title),
    ["Golf Pack", "Alpha Pack", "Echo Pack"],
  );
  assert.equal(original.projects[0].publishedAt, undefined);
  assert.equal(original.projects[0].downloads, undefined);
  assert.equal(requests.length, 1);
});

test("Voids Wrath discovers current official packs and verifies direct server archives", async () => {
  const { provider } = fixture({}, (url, options) => {
    if (url.endsWith("/mod-packs/")) return new Response(voidCatalog);
    if (url.includes("/modpacks/"))
      return new Response(
        '<a href="https://vl4.voidswrath.com/releases/fixture.zip">Download the Server Pack</a>',
      );
    if (options.method === "HEAD")
      return new Response(null, {
        headers: { "content-length": String(jar.length) },
      });
    return new Response(jar);
  });
  const voids = provider("voidswrath");
  const input = {
    type: "modpack",
    projectId: "fixture-pack",
    versionId: "1.0",
    gameVersion: "1.7.10",
    loader: "forge",
    query: "fixture",
    offset: 0,
    limit: 5,
  };
  const results = await voids.search(input);
  assert.equal(results.total, 1);
  assert.equal(results.projects[0].title, "Fixture & Pack");
  assert.equal(results.projects[0].downloads, undefined);
  assert.equal((await voids.versions(input))[0].downloadable, true);
  const resolved = await voids.resolve(input);
  assert.equal(resolved.archive.format, "server-zip");
  assert.equal(resolved.archive.hashes.sha512, digest("sha512", jar));
});

test("Voids Wrath exposes oversized archives as manual downloads and never fetches their contents", async () => {
  let downloads = 0;
  const { provider } = fixture({}, (url, options) => {
    if (url.endsWith("/mod-packs/")) return new Response(voidCatalog);
    if (url.includes("/modpacks/"))
      return new Response(
        '<a href="https://vl4.voidswrath.com/releases/fixture.zip">Download the Server Pack</a>',
      );
    if (options.method === "HEAD")
      return new Response(null, {
        headers: { "content-length": String(3 * 1024 ** 3) },
      });
    downloads++;
    return new Response(jar);
  });
  const input = {
    type: "modpack",
    projectId: "fixture-pack",
    versionId: "1.0",
    gameVersion: "1.7.10",
    loader: "forge",
  };
  assert.equal(
    (await provider("voidswrath").versions(input))[0].downloadable,
    false,
  );
  await assert.rejects(provider("voidswrath").resolve(input), /2 GB/);
  assert.equal(downloads, 0);
});

test("Voids Wrath accepts a 696 MiB archive catalog entry without applying the individual-mod limit", async () => {
  const { provider } = fixture({}, (url, options) => {
    if (url.endsWith("/mod-packs/")) return new Response(voidCatalog);
    if (url.includes("/modpacks/"))
      return new Response(
        '<a href="https://vl4.voidswrath.com/releases/fixture.zip">Download the Server Pack</a>',
      );
    assert.equal(options.method, "HEAD");
    return new Response(null, { headers: { "content-length": "729602057" } });
  });
  const versions = await provider("voidswrath").versions({
    type: "modpack",
    projectId: "fixture-pack",
    gameVersion: "1.7.10",
    loader: "forge",
  });
  assert.equal(versions[0].downloadable, true);
});
