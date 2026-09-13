import { createHash } from "node:crypto";
import {
  checkedProviderUrl,
  launchpadError as error,
  providerJson,
  strongestHash,
  USER_AGENT,
} from "./launchpad-network.mjs";
import { safeInstallPath } from "./launchpad-archives.mjs";

const FTB = "https://api.feed-the-beast.com/v1/modpacks/public/modpack";
const ATL = "https://api.atlauncher.com/v1";
const ATL_CDN = "https://download.nodecdn.net/containers/atl/";
const SPIGOT = "https://api.spiget.org/v2";
const VOID = "https://voidswrath.com";
const pluginLoaders = ["bukkit", "spigot", "paper", "purpur"];
const ftbHosts = [
  "files.feed-the-beast.com",
  "cdn.feed-the-beast.com",
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "media.forgecdn.net",
];
const atHosts = [
  "download.nodecdn.net",
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "media.forgecdn.net",
  "cdn.modrinth.com",
];
const spigotHosts = ["api.spiget.org", "cdn.spiget.org"];
const voidHosts = [
  "voidswrath.com",
  "www.voidswrath.com",
  "vl4.voidswrath.com",
  "download.voidswrath.com",
];
const MAX_FILE = 512 * 1024 ** 2;
const MAX_ARCHIVE = 2 * 1024 ** 3;
const pinWarning =
  "The provider does not publish a strong checksum; this review pins the downloaded file content.";
const enc = encodeURIComponent;
const token = (value) => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.+-]{1,100}$/.test(value) ||
    value === "." ||
    value === ".."
  )
    throw error(
      400,
      "Choose a project and version from this platform’s catalog.",
    );
  return value;
};
const numeric = (value) => {
  if (!/^\d{1,12}$/.test(String(value)))
    throw error(400, "Choose a valid catalog project or version.");
  return String(value);
};
const date = (seconds) =>
  Number.isFinite(Number(seconds)) && Number(seconds) > 0
    ? new Date(Number(seconds) * 1000).toISOString()
    : "";
const text = (value) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|#38);/g, "&")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const compatible = (version, input) =>
  (!input.gameVersion || version.gameVersions.includes(input.gameVersion)) &&
  (!input.loader || version.loaders.includes(input.loader));
const sortNumber = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : -Infinity;
const latestTimestamp = (values) =>
  values.reduce(
    (latest, value) => Math.max(latest, sortNumber(value)),
    -Infinity,
  );
// Decorate the complete matching catalog before paging, without changing cached
// provider order. Names and IDs break ties so page boundaries remain stable.
function sortCatalog(entries, sort, numericValues = {}) {
  if (!sort) return entries;
  if (sort !== "name" && !numericValues[sort]) return entries;
  return entries
    .map((entry) => ({
      entry,
      name: text(entry.name ?? entry.title),
      value: sort === "name" ? 0 : sortNumber(numericValues[sort](entry)),
    }))
    .sort(
      (a, b) =>
        b.value - a.value ||
        a.name.localeCompare(b.name, "en", {
          sensitivity: "base",
          numeric: true,
        }) ||
        String(a.entry.id ?? a.entry.safeName).localeCompare(
          String(b.entry.id ?? b.entry.safeName),
          "en",
        ),
    )
    .map(({ entry }) => entry);
}
const resultPage = (projects, input, warnings = []) => ({
  projects: projects.slice(input.offset, input.offset + input.limit),
  total: projects.length,
  offset: input.offset,
  limit: input.limit,
  warnings,
});
const requiredType = (input, type) => {
  if (input.type !== type)
    throw error(
      400,
      `This platform only supplies ${type === "plugin" ? "plugins" : "modpacks"}.`,
    );
};
async function pooled(values, fn, concurrency = 5) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        output[index] = await fn(values[index], index);
      }
    }),
  );
  return output;
}

// Extra platforms use only these explicit HTTPS hosts. Redirect destinations are
// checked before fetching, and catalog bodies and pinning downloads are bounded.
export function createExtraProviders({ fetch: request = fetch, json } = {}) {
  const cache = new Map();
  async function response(url, hosts, method = "GET", timeout = 60000) {
    let address = checkedProviderUrl(url, hosts);
    const signal = AbortSignal.timeout(timeout);
    for (let redirects = 0; redirects <= 4; redirects++) {
      let reply;
      try {
        reply = await request(address, {
          method,
          redirect: "manual",
          signal,
          headers: { "User-Agent": USER_AGENT },
        });
      } catch {
        throw error(
          502,
          "The platform could not be reached. Please try again shortly.",
        );
      }
      if ([301, 302, 303, 307, 308].includes(reply.status)) {
        await reply.body?.cancel();
        address = checkedProviderUrl(
          new URL(reply.headers.get("location") || "", address).href,
          hosts,
        );
        continue;
      }
      if (!reply.ok) {
        await reply.body?.cancel();
        throw error(
          reply.status === 404 ? 404 : reply.status === 429 ? 429 : 502,
          reply.status === 429
            ? "The platform’s request limit was reached. Wait a little before retrying."
            : `The platform request failed (${reply.status}). Please try again or use the author’s website.`,
        );
      }
      return { reply, url: address };
    }
    throw error(502, "The platform redirected this download too many times.");
  }
  async function read(url, hosts) {
    const { reply } = await response(url, hosts);
    const chunks = [];
    let size = 0;
    for await (const chunk of reply.body) {
      size += chunk.length;
      if (size > 12 * 1024 ** 2)
        throw error(502, "The platform returned too much catalog data.");
      chunks.push(chunk);
    }
    return {
      body: Buffer.concat(chunks).toString("utf8"),
      headers: reply.headers,
    };
  }
  function remember(key, load, duration = 5 * 60 * 1000) {
    const existing = cache.get(key);
    if (existing?.until > Date.now()) return existing.value;
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    const value = Promise.resolve()
      .then(load)
      .catch((cause) => {
        cache.delete(key);
        throw cause;
      });
    cache.set(key, { until: Date.now() + duration, value });
    return value;
  }
  const apiJson = (url) =>
    remember(url, () =>
      json ? json(url) : providerJson(url, { fetch: request }),
    );
  const cdnJson = (url) =>
    remember(url, async () => {
      try {
        return JSON.parse((await read(url, ["download.nodecdn.net"])).body);
      } catch (cause) {
        if (cause.status) throw cause;
        throw error(502, "ATLauncher returned invalid package metadata.");
      }
    });
  async function pin(url, hosts, expected = {}) {
    const maximum = expected.archive ? MAX_ARCHIVE : MAX_FILE;
    const limitName = expected.archive ? "2 GB archive" : "512 MB file";
    const { reply, url: finalUrl } = await response(
      url,
      hosts,
      "GET",
      expected.archive ? 300000 : 60000,
    );
    const declared = Number(reply.headers.get("content-length"));
    if (declared > maximum) {
      await reply.body?.cancel();
      throw error(
        400,
        `This download exceeds the supported ${limitName} size. Download the author’s server pack manually and import its folder.`,
      );
    }
    const sha512 = createHash("sha512");
    const md5 = expected.md5 ? createHash("md5") : null;
    let size = 0;
    let signature = Buffer.alloc(0);
    for await (const chunk of reply.body) {
      size += chunk.length;
      if (size > maximum)
        throw error(
          400,
          `This download exceeds the supported ${limitName} limit.`,
        );
      if (signature.length < 4)
        signature = Buffer.concat([signature, chunk]).subarray(0, 4);
      sha512.update(chunk);
      md5?.update(chunk);
    }
    if (
      expected.zip &&
      !["504b0304", "504b0506", "504b0708"].includes(signature.toString("hex"))
    )
      throw error(
        502,
        "The platform did not return a JAR or ZIP file. Download it manually from the author’s website.",
      );
    if (
      (expected.size != null && size !== expected.size) ||
      (md5 && md5.digest("hex") !== expected.md5.toLowerCase())
    )
      throw error(
        502,
        "The package does not match the platform’s file metadata. No server files were changed.",
      );
    return { url: finalUrl, size, hashes: { sha512: sha512.digest("hex") } };
  }
  const basename = (value) => {
    const name = safeInstallPath(value);
    if (name.includes("/"))
      throw error(400, "The platform supplied an invalid file name.");
    return name;
  };
  const hashesFor = (file) => ({
    ...file.hashes,
    ...(file.sha1 ? { sha1: file.sha1 } : {}),
    ...(file.sha512 ? { sha512: file.sha512 } : {}),
  });
  function verifiedFile(file, hosts) {
    const hashes = hashesFor(file);
    strongestHash(hashes);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE
    )
      throw error(400, "The platform supplied an unsupported file size.");
    return {
      url: checkedProviderUrl(file.url, hosts),
      size: file.size,
      hashes,
    };
  }

  const ftbPack = (projectId) => apiJson(`${FTB}/${numeric(projectId)}`);
  function ftbVersion(value) {
    return {
      id: String(value.id),
      name: value.name,
      version: value.name,
      gameVersions: (value.targets ?? [])
        .filter(
          (target) => target.type === "game" && target.name === "minecraft",
        )
        .map((target) => target.version),
      loaders: (value.targets ?? [])
        .filter((target) => target.type === "modloader")
        .map((target) => target.name.toLowerCase()),
      publishedAt: date(value.released || value.updated),
      downloadable: !value.private && value.type !== "archived",
    };
  }
  const ftb = {
    id: "ftb",
    name: "Feed The Beast",
    types: ["modpack"],
    available: true,
    sortOptions: [
      { id: "downloads", label: "Most installed" },
      { id: "popular", label: "Most played" },
      { id: "updated", label: "Recently updated" },
      { id: "newest", label: "Newest" },
      { id: "name", label: "Name (A–Z)" },
    ],
    downloadHosts: ftbHosts,
    async search(input) {
      requiredType(input, "modpack");
      const index = await apiJson(
        input.query
          ? `${FTB}/search/500?term=${enc(input.query)}`
          : `${FTB}/popular/installs/500`,
      );
      if (!Array.isArray(index.packs))
        throw error(502, "Feed The Beast returned an invalid pack catalog.");
      const packs = await pooled(index.packs.slice(0, 500), (id) =>
        ftbPack(String(id)),
      );
      const matching = packs.filter(
        (pack) =>
          !pack.private &&
          (pack.versions ?? []).some((version) =>
            compatible(ftbVersion(version), input),
          ),
      );
      const projects = sortCatalog(matching, input.sort, {
        downloads: (pack) => pack.installs,
        popular: (pack) => pack.plays,
        updated: (pack) =>
          latestTimestamp([
            pack.updated,
            ...(pack.versions ?? [])
              .filter((version) => !version.private)
              .flatMap((version) => [version.updated, version.released]),
          ]),
        newest: (pack) => pack.released,
      }).map((pack) => ({
        id: String(pack.id),
        platform: "ftb",
        title: pack.name,
        description: text(pack.synopsis),
        iconUrl: pack.art?.find((art) => art.type === "square")?.url,
        downloads: pack.installs,
        author: pack.authors?.map((author) => author.name).join(", "),
        url: `https://www.feed-the-beast.com/modpacks/${pack.id}`,
      }));
      return resultPage(projects, input);
    },
    async versions(input) {
      requiredType(input, "modpack");
      const pack = await ftbPack(input.projectId);
      return (pack.versions ?? [])
        .filter((value) => !value.private)
        .map(ftbVersion)
        .filter((value) => compatible(value, input))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    },
    async resolve(input) {
      requiredType(input, "modpack");
      const pack = await ftbPack(input.projectId);
      const selected = (pack.versions ?? []).find(
        (version) => String(version.id) === String(input.versionId),
      );
      if (
        !selected ||
        !ftbVersion(selected).downloadable ||
        !compatible(ftbVersion(selected), input)
      )
        throw error(
          400,
          "This pack version does not match the selected Minecraft version or loader.",
        );
      const manifest = await apiJson(
        `${FTB}/${numeric(input.projectId)}/${numeric(input.versionId)}`,
      );
      if (
        String(manifest.parent) !== String(input.projectId) ||
        String(manifest.id) !== String(input.versionId) ||
        manifest.private ||
        !compatible(ftbVersion(manifest), input) ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > 10000
      )
        throw error(
          400,
          "Feed The Beast returned an invalid or incompatible server manifest.",
        );
      const files = [];
      let skipped = 0;
      for (const file of manifest.files) {
        if (file.clientonly === true || file.optional === true) {
          skipped++;
          continue;
        }
        const directory = String(file.path ?? "")
          .replace(/^\.\//, "")
          .replace(/\/$/, "");
        const relative = safeInstallPath(
          `${directory ? directory + "/" : ""}${basename(file.name)}`,
        );
        files.push({ path: relative, ...verifiedFile(file, ftbHosts) });
      }
      return {
        title: pack.name,
        versionName: manifest.name,
        files,
        warnings: [
          `Requires ${input.loader} ${manifest.targets?.find((target) => target.type === "modloader")?.version ?? ""}. Install the matching runtime in Versions before starting.`,
          ...(skipped
            ? [`Skipped ${skipped} client-only or optional files.`]
            : []),
        ],
      };
    },
  };

  const atCatalog = () =>
    apiJson(`${ATL}/packs/full/public`).then((value) => {
      if (!Array.isArray(value.data))
        throw error(502, "ATLauncher returned an invalid pack catalog.");
      return value.data;
    });
  const atPack = async (projectId) => {
    const pack = (await atCatalog()).find(
      (pack) => pack.safeName === token(projectId),
    );
    if (!pack) throw error(404, "This ATLauncher pack is no longer listed.");
    return pack;
  };
  const atManifest = (pack, version) =>
    cdnJson(
      `${ATL_CDN}packs/${enc(token(pack.safeName))}/versions/${enc(token(version.version))}/Configs.json`,
    );
  function atLoader(manifest) {
    return String(manifest.loader?.type ?? "").toLowerCase();
  }
  async function atVersion(pack, version) {
    const manifest = await atManifest(pack, version);
    return {
      id: version.version,
      name: version.version,
      version: version.version,
      gameVersions: [manifest.minecraft ?? version.minecraft],
      loaders: atLoader(manifest) ? [atLoader(manifest)] : [],
      publishedAt: date(version.published),
      downloadable: Array.isArray(manifest.mods) && Boolean(atLoader(manifest)),
    };
  }
  const at = {
    id: "atlauncher",
    name: "ATLauncher",
    types: ["modpack"],
    available: true,
    sortOptions: [
      { id: "updated", label: "Recently updated" },
      { id: "name", label: "Name (A–Z)" },
    ],
    downloadHosts: atHosts,
    async search(input) {
      requiredType(input, "modpack");
      const packs = (await atCatalog()).filter(
        (pack) =>
          `${pack.name} ${text(pack.description)}`
            .toLowerCase()
            .includes(input.query.toLowerCase()) &&
          (pack.versions ?? []).some(
            (version) =>
              !input.gameVersion || version.minecraft === input.gameVersion,
          ),
      );
      const projects = sortCatalog(packs, input.sort, {
        updated: (pack) =>
          latestTimestamp(
            (pack.versions ?? []).map((version) => version.published),
          ),
      }).map((pack) => ({
        id: pack.safeName,
        platform: "atlauncher",
        title: pack.name,
        description: text(pack.description),
        iconUrl: `${ATL_CDN}packs/${enc(token(pack.safeName))}/Images/300x150.png`,
        url: `https://atlauncher.com/pack/${pack.safeName}`,
      }));
      return resultPage(
        projects,
        input,
        input.loader
          ? [
              "ATLauncher loader compatibility is checked when selecting a version.",
            ]
          : [],
      );
    },
    async versions(input) {
      requiredType(input, "modpack");
      const pack = await atPack(input.projectId);
      const values = (pack.versions ?? [])
        .filter(
          (version) =>
            !input.gameVersion || version.minecraft === input.gameVersion,
        )
        .slice(0, 100);
      const versions = await pooled(values, async (version) => {
        try {
          return await atVersion(pack, version);
        } catch (cause) {
          if (cause.status === 404)
            return {
              id: version.version,
              name: version.version,
              version: version.version,
              gameVersions: [version.minecraft],
              loaders: [],
              publishedAt: date(version.published),
              downloadable: false,
            };
          throw cause;
        }
      });
      return versions
        .filter((version) => compatible(version, input))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    },
    async resolve(input) {
      requiredType(input, "modpack");
      const pack = await atPack(input.projectId);
      const selected = (pack.versions ?? []).find(
        (version) => version.version === token(input.versionId),
      );
      if (!selected)
        throw error(
          400,
          "This version does not belong to the selected ATLauncher pack.",
        );
      const manifest = await atManifest(pack, selected);
      const version = await atVersion(pack, selected);
      if (
        !version.downloadable ||
        !compatible(version, input) ||
        manifest.version !== selected.version ||
        manifest.mods.length > 1000
      )
        throw error(
          400,
          "This ATLauncher manifest does not match the selected Minecraft version or loader.",
        );
      const mods = manifest.mods.filter(
        (mod) => mod.server !== false && !(mod.serverOptional ?? mod.optional),
      );
      let pinned = false;
      const files = await pooled(
        mods,
        async (mod) => {
          const separate = Boolean(mod.serverSeparate);
          const kind = separate ? (mod.serverType ?? mod.type) : mod.type;
          const download = separate
            ? (mod.serverDownload ?? mod.download)
            : mod.download;
          if (
            kind !== "mods" ||
            !["server", "direct"].includes(download) ||
            mod.filePattern ||
            mod.extractFolder ||
            mod.decompFile
          )
            throw error(
              400,
              `ATLauncher requires a manual installation step for ${text(mod.name)}. Create this server with ATLauncher, then import its folder.`,
            );
          const name = basename(separate ? mod.serverFile : mod.file);
          const rawUrl = separate ? mod.serverUrl : mod.url;
          const url = checkedProviderUrl(
            download === "server" ? new URL(rawUrl, ATL_CDN).href : rawUrl,
            atHosts,
          );
          const hashes = separate ? {} : hashesFor(mod);
          let downloadFile;
          try {
            strongestHash(hashes);
            downloadFile = { url, size: mod.filesize, hashes };
          } catch {
            pinned = true;
            const md5 = separate ? mod.serverMD5 : mod.md5;
            if (md5 && !/^[a-f0-9]{32}$/i.test(md5))
              throw error(400, "ATLauncher supplied an invalid checksum.");
            downloadFile = await pin(url, atHosts, {
              ...(md5 ? { md5 } : {}),
              ...(!separate && mod.filesize ? { size: mod.filesize } : {}),
              zip: true,
            });
          }
          return {
            path: `mods/${manifest.caseAllFiles === "lower" ? name.toLowerCase() : name}`,
            ...downloadFile,
          };
        },
        4,
      );
      const archive = manifest.noConfigs
        ? undefined
        : {
            format: "server-zip",
            ...verifiedFile(
              {
                url: `${ATL_CDN}packs/${enc(pack.safeName)}/versions/${enc(selected.version)}/Configs.zip`,
                size: manifest.configs?.filesize,
                sha1: manifest.configs?.sha1,
              },
              atHosts,
            ),
          };
      return {
        title: pack.name,
        versionName: selected.version,
        files,
        archive,
        warnings: [
          `Requires ${input.loader} ${manifest.loader?.version ?? manifest.loader?.metadata?.loader ?? ""}. Set up the matching runtime in Versions before starting.`,
          ...(pinned ? [pinWarning] : []),
          ...(manifest.mods.length > mods.length
            ? [
                `Skipped ${manifest.mods.length - mods.length} client-only or optional mods.`,
              ]
            : []),
        ],
      };
    },
  };

  const resource = (projectId) =>
    apiJson(`${SPIGOT}/resources/${numeric(projectId)}`);
  const tested = (pack, gameVersion) =>
    !gameVersion ||
    (pack.testedVersions ?? []).some(
      (value) =>
        value === gameVersion ||
        (/^\d+\.\d+$/.test(value) && gameVersion.startsWith(value + ".")),
    );
  const spigot = {
    id: "spigot",
    name: "Spigot",
    types: ["plugin"],
    available: true,
    sortOptions: [
      { id: "downloads", label: "Most downloaded" },
      { id: "updated", label: "Recently updated" },
      { id: "newest", label: "Newest" },
      { id: "name", label: "Name (A–Z)" },
    ],
    downloadHosts: spigotHosts,
    async search(input) {
      requiredType(input, "plugin");
      if (input.loader && !pluginLoaders.includes(input.loader))
        return resultPage([], input);
      const fields =
        "id,name,tag,downloads,icon.url,external,premium,testedVersions,version.id,file.type";
      const route = input.query
        ? `/search/resources/${enc(input.query)}?field=name`
        : input.gameVersion
          ? `/resources/for/${enc(input.gameVersion)}?method=any`
          : "/resources/free?";
      const sort =
        {
          downloads: "-downloads",
          updated: "-updateDate",
          newest: "-releaseDate",
          name: "name",
        }[input.sort] ?? "-downloads";
      const url = `${SPIGOT}${route}${route.endsWith("?") ? "" : "&"}size=${input.limit}&page=${Math.floor(input.offset / input.limit) + 1}&sort=${sort}&fields=${enc(fields)}`;
      const loaded = await remember(url, async () => {
        const reply = await read(url, ["api.spiget.org"]);
        try {
          return {
            values: JSON.parse(reply.body),
            total: Number(reply.headers.get("x-total")),
          };
        } catch {
          throw error(502, "Spigot returned invalid catalog data.");
        }
      });
      if (!Array.isArray(loaded.values))
        throw error(502, "Spigot returned invalid catalog data.");
      return {
        projects: loaded.values.map((pack) => ({
          id: String(pack.id),
          platform: "spigot",
          title: text(pack.name),
          description: text(pack.tag),
          iconUrl: pack.icon?.url
            ? new URL(pack.icon.url, "https://www.spigotmc.org/").href
            : undefined,
          downloads: pack.downloads,
          url: `https://www.spigotmc.org/resources/${pack.id}/`,
        })),
        total:
          Number.isSafeInteger(loaded.total) && loaded.total >= 0
            ? loaded.total
            : input.offset + loaded.values.length,
        offset: input.offset,
        limit: input.limit,
        warnings:
          input.query && input.gameVersion
            ? [
                "Spigot text search lists matching projects; tested Minecraft versions are checked when choosing a release.",
              ]
            : [],
      };
    },
    async versions(input) {
      requiredType(input, "plugin");
      const pack = await resource(input.projectId);
      if (
        !tested(pack, input.gameVersion) ||
        (input.loader && !pluginLoaders.includes(input.loader))
      )
        return [];
      const versions = await apiJson(
        `${SPIGOT}/resources/${numeric(input.projectId)}/versions?size=100&sort=-releaseDate`,
      );
      if (!Array.isArray(versions))
        throw error(502, "Spigot returned an invalid version catalog.");
      const latest = await apiJson(
        `${SPIGOT}/resources/${numeric(input.projectId)}/versions/latest`,
      );
      const candidates = [
        latest,
        ...versions.filter(
          (version) => String(version.id) !== String(latest.id),
        ),
      ];
      return candidates
        .map((version) => ({
          id: String(version.id),
          name: text(version.name),
          version: text(version.name),
          gameVersions: [
            ...new Set([
              ...(pack.testedVersions ?? []),
              ...(input.gameVersion && tested(pack, input.gameVersion)
                ? [input.gameVersion]
                : []),
            ]),
          ],
          loaders: pluginLoaders,
          publishedAt: date(version.releaseDate),
          downloadable:
            !pack.premium &&
            !pack.external &&
            pack.file?.type === ".jar" &&
            String(version.id) === String(pack.version?.id),
        }))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    },
    async resolve(input) {
      requiredType(input, "plugin");
      const pack = await resource(input.projectId);
      if (pack.premium || pack.external || pack.file?.type !== ".jar")
        throw error(
          400,
          "This author uses a paid or external download. Obtain the plugin from its official project page and upload it with File Manager.",
        );
      if (
        !pluginLoaders.includes(input.loader) ||
        !tested(pack, input.gameVersion) ||
        String(pack.version?.id) !== numeric(input.versionId)
      )
        throw error(
          400,
          "Only the latest directly hosted Spigot release is available automatically. Check its tested Minecraft versions or download historical releases manually.",
        );
      const version = await apiJson(
        `${SPIGOT}/resources/${numeric(input.projectId)}/versions/${numeric(input.versionId)}`,
      );
      if (
        String(version.id) !== input.versionId ||
        String(version.resource) !== input.projectId
      )
        throw error(
          400,
          "This Spigot release does not belong to the selected plugin.",
        );
      const file = await pin(
        `${SPIGOT}/resources/${numeric(input.projectId)}/download`,
        spigotHosts,
        { zip: true },
      );
      // Bypass metadata cache to reject an update racing the unversioned CDN URL.
      const latest = json
        ? await json(
            `${SPIGOT}/resources/${numeric(input.projectId)}/versions/latest`,
          )
        : await providerJson(
            `${SPIGOT}/resources/${numeric(input.projectId)}/versions/latest`,
            { fetch: request },
          );
      if (String(latest.id) !== input.versionId)
        throw error(
          409,
          "The plugin updated during review. Refresh versions and review the new release.",
        );
      return {
        title: text(pack.name),
        versionName: text(version.name),
        files: [
          {
            path: `plugins/spigot-${input.projectId}-${input.versionId}.jar`,
            ...file,
          },
        ],
        warnings: [
          pinWarning,
          "Install any dependencies required by the plugin author. Spigot does not provide a dependency manifest.",
        ],
      };
    },
  };

  const voidCatalog = () =>
    remember("void-catalog", async () => {
      const html = (await read(`${VOID}/mod-packs/`, voidHosts)).body;
      const entries = [];
      const pattern =
        /<a\b[^>]*href=["'](https:\/\/(?:www\.)?voidswrath\.com\/modpacks\/([a-z0-9-]+)\/)["'][^>]*>([\s\S]*?)<\/a>/gi;
      for (const match of html.matchAll(pattern)) {
        const title = text(
          match[3].match(
            /class=["']mod-pack-title-list["'][^>]*>([\s\S]*?)<\/div>/i,
          )?.[1],
        );
        const gameVersion = text(match[3].match(/Minecraft:\s*([^<]+)/i)?.[1]);
        const version = text(match[3].match(/Version:\s*([^<]+)/i)?.[1]);
        if (
          !title ||
          !gameVersion ||
          !version ||
          entries.some((entry) => entry.id === match[2])
        )
          continue;
        entries.push({
          id: match[2],
          platform: "voidswrath",
          title,
          description: "Official Voids Wrath server pack.",
          iconUrl: match[3].match(
            /background-image:\s*url\(['"]?([^)'"\s]+)/i,
          )?.[1],
          gameVersion,
          version,
          url: match[1],
        });
      }
      if (!entries.length)
        throw error(
          502,
          "Voids Wrath changed its pack catalog. Browse the official website and import a downloaded server folder.",
        );
      return entries;
    });
  const voidPack = async (projectId) => {
    const pack = (await voidCatalog()).find(
      (entry) => entry.id === token(projectId),
    );
    if (!pack) throw error(404, "This Voids Wrath pack is no longer listed.");
    return pack;
  };
  const voidDownload = (pack) =>
    remember(`void-download:${pack.id}`, async () => {
      const html = (await read(pack.url, voidHosts)).body;
      const links = [
        ...html.matchAll(
          /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        ),
      ]
        .filter((match) =>
          /download (?:the )?server(?: pack)?/i.test(text(match[2])),
        )
        .map((match) => {
          try {
            return checkedProviderUrl(match[1], voidHosts);
          } catch {
            return null;
          }
        })
        .filter((url) => url && /\.zip(?:\?|$)/i.test(url));
      if (links.length !== 1) return null;
      const { reply } = await response(links[0], voidHosts, "HEAD");
      const length = Number(reply.headers.get("content-length"));
      await reply.body?.cancel();
      return {
        url: links[0],
        size: Number.isSafeInteger(length) && length > 0 ? length : null,
      };
    });
  const voids = {
    id: "voidswrath",
    name: "Voids Wrath",
    types: ["modpack"],
    available: true,
    sortOptions: [{ id: "name", label: "Name (A–Z)" }],
    downloadHosts: voidHosts,
    async search(input) {
      requiredType(input, "modpack");
      const packs = (await voidCatalog()).filter(
        (pack) =>
          pack.title.toLowerCase().includes(input.query.toLowerCase()) &&
          (!input.gameVersion || input.gameVersion === pack.gameVersion) &&
          (!input.loader || input.loader === "forge"),
      );
      return resultPage(sortCatalog(packs, input.sort), input);
    },
    async versions(input) {
      requiredType(input, "modpack");
      const pack = await voidPack(input.projectId);
      const download = await voidDownload(pack);
      const version = {
        id: pack.version,
        name: pack.version,
        version: pack.version,
        gameVersions: [pack.gameVersion],
        loaders: ["forge"],
        publishedAt: "",
        downloadable: Boolean(
          download && (download.size === null || download.size <= MAX_ARCHIVE),
        ),
      };
      return compatible(version, input) ? [version] : [];
    },
    async resolve(input) {
      requiredType(input, "modpack");
      const pack = await voidPack(input.projectId);
      if (
        input.versionId !== pack.version ||
        input.gameVersion !== pack.gameVersion ||
        input.loader !== "forge"
      )
        throw error(
          400,
          "This Voids Wrath version does not match the selected pack or Minecraft Forge runtime.",
        );
      const download = await voidDownload(pack);
      if (!download)
        throw error(
          400,
          "This pack has no supported direct server ZIP. Download its server pack from the official website and import the extracted folder.",
        );
      if (download.size > MAX_ARCHIVE)
        throw error(
          400,
          "This server ZIP exceeds the supported 2 GB archive size. Download it from the author and import the extracted folder.",
        );
      const archive = await pin(download.url, voidHosts, {
        ...(download.size ? { size: download.size } : {}),
        zip: true,
        archive: true,
      });
      cache.delete("void-catalog");
      const current = await voidPack(input.projectId);
      if (
        current.version !== input.versionId ||
        current.gameVersion !== input.gameVersion
      )
        throw error(
          409,
          "The pack updated during review. Refresh the catalog and choose its current version.",
        );
      return {
        title: pack.title,
        versionName: pack.version,
        archive: { format: "server-zip", ...archive },
        warnings: [
          pinWarning,
          "Use the Forge build required by this pack before starting. Review included startup files and configuration changes.",
        ],
      };
    },
  };
  return [spigot, ftb, at, voids];
}
