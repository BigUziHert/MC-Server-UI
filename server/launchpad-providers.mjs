import {
  checkedProviderUrl,
  launchpadError,
  providerJson,
  strongestHash,
} from "./launchpad-network.mjs";
import { safeInstallPath } from "./launchpad-archives.mjs";

const mr = "https://api.modrinth.com/v2";
const cf = "https://api.curseforge.com/v1";
const enc = encodeURIComponent;
const id = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw launchpadError(
      400,
      "Choose a project or version from the provider catalog.",
    );
  return value;
};
// Optional server installation is supported, even when the client is required.
// https://modrinth.com/news/article/new-environments/#new-system
const serverEnvironment = (value) =>
  !["client_only", "singleplayer_only"].includes(value);
const fileName = (value) => {
  const name = safeInstallPath(value);
  if (name.includes("/"))
    throw launchpadError(400, "The provider returned an invalid file name.");
  return name;
};
const fits = (version, input) =>
  (!input.gameVersion || version.gameVersions.includes(input.gameVersion)) &&
  (!input.loader || version.loaders.includes(input.loader));
const iconUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};
const authorNames = (values) => {
  const names = [
    ...new Set(
      (values ?? [])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    ),
  ];
  return names.length ? names.join(", ") : undefined;
};
const projectAuthors = (project) =>
  authorNames(
    Array.isArray(project.authors)
      ? project.authors.map((author) => author?.name)
      : [],
  );
function teamAuthors(members) {
  const accepted = members.filter((member) => member.accepted === true);
  const owners = accepted.filter(
    (member) =>
      member.is_owner === true ||
      (typeof member.is_owner !== "boolean" &&
        String(member.role).toLowerCase() === "owner"),
  );
  return authorNames(
    (owners.length ? owners : accepted)
      .map((member) => member.user?.username)
      .filter((name) => typeof name === "string")
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
  );
}
// Project identity is independent of the selected Minecraft version or loader.
// Batch up to 100 IDs, coalesce overlapping callers, and briefly cache failures
// so polling an unavailable provider does not create a request storm.
function projectMetadataLookup(loadBatch, normalize) {
  const cache = new Map(),
    pending = new Map();
  let queue = Promise.resolve(),
    failureUntil = 0,
    failureWarning = "";
  return async (projectIds) => {
    const ids = [...new Set(projectIds.map((value) => id(String(value))))];
    if (ids.length > 1000)
      throw launchpadError(400, "Too many projects were requested at once.");
    const now = Date.now();
    for (const [key, entry] of cache)
      if (entry.expiresAt <= now) cache.delete(key);
    const missing = ids.filter(
      (value) => !cache.has(value) && !pending.has(value),
    );
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const task = queue.then(async () => {
        const entries = new Map();
        const coolingDown = failureUntil > Date.now();
        try {
          if (coolingDown) throw new Error(failureWarning);
          const rows = await loadBatch(batch, AbortSignal.timeout(8000));
          if (!Array.isArray(rows))
            throw launchpadError(
              502,
              "The provider returned invalid project metadata.",
            );
          const projects = new Map(
            rows.map((row) => [String(row.id), normalize(row)]),
          );
          for (const value of batch)
            entries.set(value, {
              project: projects.get(value),
              expiresAt: Date.now() + 10 * 60_000,
            });
        } catch (cause) {
          if (!coolingDown) {
            failureUntil = Date.now() + 30_000;
            failureWarning =
              cause.name === "TimeoutError"
                ? "Project details took too long to load. Cached details are still available. Try again shortly."
                : cause.message;
          }
          for (const value of batch)
            entries.set(value, {
              warning: failureWarning,
              expiresAt: failureUntil,
            });
        }
        for (const [value, entry] of entries) {
          cache.delete(value);
          cache.set(value, entry);
        }
        while (cache.size > 2000) cache.delete(cache.keys().next().value);
        return entries;
      });
      queue = task.then(() => {});
      for (const value of batch) {
        const lookup = task.then((entries) => entries.get(value));
        pending.set(value, lookup);
        void lookup.then(() => pending.delete(value));
      }
    }
    const entries = await Promise.all(
      ids.map((value) => pending.get(value) ?? cache.get(value)),
    );
    return {
      projects: entries.flatMap((entry) =>
        entry?.project ? [entry.project] : [],
      ),
      warnings: [
        ...new Set(
          entries.flatMap((entry) => (entry?.warning ? [entry.warning] : [])),
        ),
      ],
    };
  };
}
function mrVersion(value) {
  return {
    id: String(value.id),
    name: value.name,
    version: value.version_number,
    gameVersions: value.game_versions ?? [],
    loaders: value.loaders ?? [],
    publishedAt: value.date_published,
    downloadable:
      serverEnvironment(value.environment) &&
      Array.isArray(value.files) &&
      value.files.some(
        (file) => file.url && (file.hashes?.sha512 || file.hashes?.sha1),
      ),
  };
}
function mrUpdateFile(value, input) {
  const extension =
    input.type === "modpack"
      ? /\.mrpack$/i
      : input.type === "datapack"
        ? /\.zip$/i
        : /\.jar$/i;
  const files = value.files.filter((file) => extension.test(file.filename));
  const file =
    files.find((file) => file.primary) ??
    (files.length === 1 ? files[0] : null);
  if (!file) return null;
  const limit = input.type === "modpack" ? 2 * 1024 ** 3 : 512 * 1024 ** 2;
  if (
    file.size != null &&
    (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limit)
  )
    throw launchpadError(400, "This update exceeds the supported file size.");
  fileName(file.filename);
  strongestHash(file.hashes);
  checkedProviderUrl(file.url, ["cdn.modrinth.com"]);
  return file;
}
// Batch updates avoid a full release-history request per installed file. Current
// versions are fetched in a second batch only when the API suggests a different
// version, so its publication date can be checked before offering an update.
// https://docs.modrinth.com/api/operations/getlatestversionsfromhashes/
// https://docs.modrinth.com/api/operations/getversions/
function modrinthUpdates(json) {
  // Releasing a queue lane must not depend on a fetch implementation or response
  // reader honoring abort. The same signal still cancels cooperative network I/O.
  const request = (url, options) =>
    new Promise((resolve, reject) => {
      const { signal } = options;
      let settled = false;
      const finish = (complete, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        complete(value);
      };
      const aborted = () => finish(reject, signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return json(url, options);
        })
        .then(
          (value) => finish(resolve, value),
          (cause) => finish(reject, cause),
        );
    });
  const lanes = [Promise.resolve(), Promise.resolve()];
  let nextLane = 0,
    failureUntil = 0,
    failureWarning = "";
  return async (input, items) => {
    input.signal?.throwIfAborted();
    if (!Array.isArray(items) || items.length > 5000)
      throw launchpadError(
        400,
        "Request updates for at most 5000 installed files.",
      );
    const distinct = new Map();
    for (const item of items) {
      if (!/^[a-f0-9]{128}$/i.test(item?.sha512 ?? ""))
        throw launchpadError(
          400,
          "Installed files need a valid SHA512 checksum.",
        );
      const normalized = {
        sha512: item.sha512.toLowerCase(),
        projectId: id(item.projectId),
        versionId: id(item.versionId),
      };
      const prior = distinct.get(normalized.sha512);
      if (
        prior &&
        (prior.projectId !== normalized.projectId ||
          prior.versionId !== normalized.versionId)
      )
        throw launchpadError(
          400,
          "The same installed file has conflicting version identities.",
        );
      distinct.set(normalized.sha512, normalized);
    }
    const rows = [...distinct.values()];
    const tasks = [];
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      const lane = nextLane++ % lanes.length;
      const task = lanes[lane].then(async () => {
        input.signal?.throwIfAborted();
        const updates = {},
          issues = {},
          warnings = new Set();
        if (failureUntil > Date.now())
          return { updates, issues, warnings: [failureWarning] };
        const timeout = AbortSignal.timeout(8000);
        const signal = input.signal
          ? AbortSignal.any([input.signal, timeout])
          : timeout;
        try {
          const result = await request(`${mr}/version_files/update`, {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hashes: batch.map((item) => item.sha512),
              algorithm: "sha512",
              loaders: input.loader ? [input.loader] : [],
              game_versions: input.gameVersion ? [input.gameVersion] : [],
            }),
          });
          signal.throwIfAborted();
          if (!result || typeof result !== "object" || Array.isArray(result))
            throw launchpadError(
              502,
              "Modrinth returned invalid update metadata.",
            );
          const candidates = [];
          for (const item of batch) {
            const value = result[item.sha512];
            if (!value) {
              issues[item.sha512] =
                "Modrinth did not return an update result for this file checksum.";
              continue;
            }
            try {
              if (
                !Array.isArray(value.game_versions) ||
                !Array.isArray(value.loaders) ||
                !value.game_versions.every(
                  (entry) => typeof entry === "string",
                ) ||
                !value.loaders.every((entry) => typeof entry === "string")
              )
                throw launchpadError(
                  502,
                  "Modrinth returned invalid update compatibility data.",
                );
              if (
                !Array.isArray(value.files) ||
                value.files.some((file) => !file || typeof file !== "object")
              )
                throw launchpadError(
                  502,
                  "Modrinth returned invalid update download metadata.",
                );
              if (
                typeof value.id !== "string" ||
                !/^[A-Za-z0-9_-]{1,100}$/.test(value.id)
              )
                throw launchpadError(
                  502,
                  "Modrinth returned an invalid update version ID.",
                );
              const version = mrVersion(value);
              if (value.project_id !== item.projectId)
                throw new Error(
                  "Modrinth returned an update for a different project.",
                );
              if (!serverEnvironment(value.environment))
                throw new Error(
                  value.environment === "singleplayer_only"
                    ? "The returned version is marked singleplayer-only and does not support a dedicated server."
                    : "The returned version is marked client-only and does not support server installation.",
                );
              if (
                input.gameVersion &&
                !version.gameVersions.includes(input.gameVersion)
              )
                throw new Error(
                  `The returned version does not support Minecraft ${input.gameVersion}.`,
                );
              if (input.loader && !version.loaders.includes(input.loader))
                throw new Error(
                  `The returned version does not support the selected ${input.loader} loader.`,
                );
              if (!version.downloadable)
                throw new Error(
                  "The returned version has no downloadable file with a verification checksum.",
                );
              if (version.id === item.versionId) {
                if (
                  !value.files.some(
                    (file) =>
                      typeof file.hashes?.sha512 === "string" &&
                      file.hashes.sha512.toLowerCase() === item.sha512,
                  )
                )
                  throw new Error(
                    "Modrinth returned an installed version with a different file checksum.",
                  );
                updates[item.sha512] = null;
                continue;
              }
              const file = mrUpdateFile(value, input);
              if (!file)
                throw new Error(
                  "The returned version does not contain a single supported server download.",
                );
              if (file.hashes?.sha512?.toLowerCase() === item.sha512) {
                updates[item.sha512] = null;
                continue;
              }
              candidates.push({ item, version });
            } catch (cause) {
              issues[item.sha512] = cause.message;
            }
          }
          if (candidates.length) {
            const ids = [
              ...new Set(candidates.map(({ item }) => item.versionId)),
            ];
            const current = await request(
              `${mr}/versions?${new URLSearchParams({ ids: JSON.stringify(ids) })}`,
              { signal },
            );
            signal.throwIfAborted();
            if (!Array.isArray(current))
              throw launchpadError(
                502,
                "Modrinth returned invalid installed-version metadata.",
              );
            const byId = new Map(current.map((value) => [value?.id, value]));
            for (const { item, version } of candidates) {
              const installed = byId.get(item.versionId);
              const before = Date.parse(installed?.date_published);
              const after = Date.parse(version.publishedAt);
              if (!installed) {
                issues[item.sha512] =
                  "Modrinth did not return metadata for the installed version, so this update could not be verified.";
                continue;
              }
              if (installed.project_id !== item.projectId) {
                issues[item.sha512] =
                  "The installed-version metadata belongs to a different project, so this update could not be verified.";
                continue;
              }
              if (
                !Array.isArray(installed.files) ||
                !installed.files.some(
                  (file) =>
                    typeof file?.hashes?.sha512 === "string" &&
                    file.hashes.sha512.toLowerCase() === item.sha512,
                )
              ) {
                issues[item.sha512] =
                  "The installed file checksum does not match Modrinth's version metadata, so this update could not be verified.";
                continue;
              }
              if (!Number.isFinite(before) || !Number.isFinite(after)) {
                issues[item.sha512] =
                  "Modrinth returned an invalid publication date, so a newer version could not be verified.";
                continue;
              }
              updates[item.sha512] = after > before ? version : null;
            }
          }
        } catch (cause) {
          if (input.signal?.aborted) throw input.signal.reason;
          failureUntil = Date.now() + (cause.status === 429 ? 60_000 : 30_000);
          failureWarning =
            timeout.aborted || cause.name === "TimeoutError"
              ? "Modrinth update checks took too long. Try again shortly."
              : cause.message;
          warnings.add(failureWarning);
        }
        return { updates, issues, warnings: [...warnings] };
      });
      lanes[lane] = task.catch(() => {});
      tasks.push(task);
    }
    const results = await Promise.all(tasks);
    return {
      updates: Object.assign({}, ...results.map((result) => result.updates)),
      issues: Object.assign({}, ...results.map((result) => result.issues)),
      warnings: [...new Set(results.flatMap((result) => result.warnings))],
    };
  };
}
const cfLoaders = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
// Provider sorting is sent with the upstream request, before its pagination.
// https://docs.modrinth.com/api/operations/searchprojects/
const mrSortOptions = [
  { id: "downloads", label: "Most downloaded" },
  { id: "relevance", label: "Relevance" },
  { id: "popular", label: "Most followed" },
  { id: "updated", label: "Recently updated" },
  { id: "newest", label: "Newest" },
];
// https://docs.curseforge.com/rest-api/#modssearchsortfield
const cfSortOptions = [
  { id: "popular", label: "Most popular" },
  { id: "downloads", label: "Most downloaded" },
  { id: "updated", label: "Recently updated" },
  { id: "newest", label: "Newest" },
  { id: "name", label: "Name (A–Z)" },
];
const cfSortFields = {
  popular: 2,
  downloads: 6,
  updated: 3,
  newest: 11,
  name: 4,
};
function cfVersion(value, type) {
  const versions = value.gameVersions ?? [];
  return {
    id: String(value.id),
    name: value.displayName,
    version: value.displayName,
    gameVersions: versions.filter((value) => /^\d/.test(value)),
    loaders:
      type === "datapack"
        ? ["datapack"]
        : type === "plugin"
          ? ["bukkit", "spigot", "paper", "purpur"]
          : versions
              .map((value) => value.toLowerCase())
              .filter((value) => Object.hasOwn(cfLoaders, value)),
    publishedAt: value.fileDate,
    downloadable:
      value.isAvailable !== false &&
      (type === "modpack"
        ? !!(value.isServerPack || value.serverPackFileId)
        : !!value.downloadUrl),
  };
}
export function createCoreProviders({
  fetch: request = fetch,
  key = async () => null,
} = {}) {
  const json = (url, options) =>
    providerJson(url, { ...options, fetch: request });
  const mrProject = async (projectId) =>
    json(`${mr}/project/${enc(id(projectId))}`);
  const mrVersions = async (input) => {
    const query = new URLSearchParams();
    if (input.gameVersion)
      query.set("game_versions", JSON.stringify([input.gameVersion]));
    if (input.loader) query.set("loaders", JSON.stringify([input.loader]));
    return json(`${mr}/project/${enc(id(input.projectId))}/version?${query}`, {
      signal: input.signal,
    });
  };
  const curseJson = async (route, options) => {
    const secret = await key();
    if (!secret)
      throw launchpadError(
        400,
        "Add a CurseForge API key in Launchpad settings to use this provider.",
      );
    return json(cf + route, {
      ...options,
      headers: { "x-api-key": secret, ...(options?.headers ?? {}) },
    });
  };
  // Official batch endpoints avoid one request per installed JAR:
  // https://docs.modrinth.com/api/operations/getprojects/
  // https://docs.curseforge.com/rest-api/#get-mods
  const mrMetadata = projectMetadataLookup(
    (ids, signal) =>
      json(
        `${mr}/projects?${new URLSearchParams({ ids: JSON.stringify(ids) })}`,
        { signal },
      ),
    (project) => ({
      id: String(project.id),
      title: project.title,
      iconUrl: iconUrl(project.icon_url),
      teamId: project.team,
    }),
  );
  // /teams returns members for multiple teams; associate by team_id rather
  // than response order. Only accepted members are public project credits.
  // https://docs.modrinth.com/api/operations/getteams/
  const mrTeams = projectMetadataLookup(
    async (ids, signal) => {
      const rows = await json(
        `${mr}/teams?${new URLSearchParams({ ids: JSON.stringify(ids) })}`,
        { signal },
      );
      if (
        !Array.isArray(rows) ||
        rows.some((members) => !Array.isArray(members))
      )
        throw launchpadError(
          502,
          "Modrinth returned invalid project contributors.",
        );
      const groups = new Map();
      for (const members of rows) {
        for (const member of members) {
          if (!member || typeof member.team_id !== "string") continue;
          if (!groups.has(member.team_id)) groups.set(member.team_id, []);
          groups.get(member.team_id).push(member);
        }
      }
      return [...groups].map(([id, members]) => ({
        id,
        author: teamAuthors(members),
      }));
    },
    (team) => team,
  );
  const mrProjectMetadata = async (ids) => {
    const result = await mrMetadata(ids);
    const teamIds = result.projects
      .map((project) => project.teamId)
      .filter(
        (value) =>
          typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value),
      );
    const teams = await mrTeams(teamIds);
    const authors = new Map(
      teams.projects.map((team) => [team.id, team.author]),
    );
    return {
      projects: result.projects.map(({ teamId, ...project }) => ({
        ...project,
        ...(authors.get(teamId) ? { author: authors.get(teamId) } : {}),
      })),
      warnings: [
        ...result.warnings,
        ...teams.warnings.map((warning) => `Project contributors: ${warning}`),
      ],
    };
  };
  const cfMetadata = projectMetadataLookup(
    async (ids, signal) =>
      (
        await curseJson("/mods", {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modIds: ids.map((value) => {
              const number = Number(value);
              if (!Number.isSafeInteger(number) || number <= 0)
                throw launchpadError(400, "Choose a valid CurseForge project.");
              return number;
            }),
          }),
        })
      ).data,
    (project) =>
      project.gameId === 432
        ? {
            id: String(project.id),
            title: project.name,
            iconUrl: iconUrl(project.logo?.thumbnailUrl ?? project.logo?.url),
            author: projectAuthors(project),
          }
        : undefined,
  );
  let categories;
  async function cfClass(type) {
    categories ??= curseJson("/categories?gameId=432&classesOnly=true")
      .then((result) => result.data)
      .catch((cause) => {
        categories = undefined;
        throw cause;
      });
    const rows = await categories;
    const names = {
      mod: ["mods", "mc-mods"],
      modpack: ["modpacks"],
      plugin: ["bukkit-plugins", "bukkit plugins"],
      datapack: ["data-packs", "datapacks", "data packs"],
    }[type];
    const category = rows.find(
      (row) =>
        names.includes(String(row.slug ?? "").toLowerCase()) ||
        names.includes(String(row.name ?? "").toLowerCase()),
    );
    if (!category)
      throw launchpadError(
        400,
        `CurseForge does not expose a supported ${type} catalog for this game.`,
      );
    return category.id;
  }
  const cfFiles = async (input) => {
    const query = new URLSearchParams({ pageSize: "50" });
    if (input.gameVersion) query.set("gameVersion", input.gameVersion);
    if (cfLoaders[input.loader])
      query.set("modLoaderType", String(cfLoaders[input.loader]));
    return (
      await curseJson(`/mods/${enc(id(input.projectId))}/files?${query}`, {
        signal: input.signal,
      })
    ).data;
  };
  return [
    {
      id: "modrinth",
      name: "Modrinth",
      types: ["mod", "modpack", "datapack", "plugin"],
      available: true,
      sortOptions: mrSortOptions,
      downloadHosts: ["cdn.modrinth.com"],
      projectMetadata: mrProjectMetadata,
      updates: modrinthUpdates(json),
      async search(input) {
        const facets = [
          [`all_project_types:${input.type}`],
          ["server_side!=unsupported"],
        ];
        if (input.gameVersion) facets.push([`versions:${input.gameVersion}`]);
        if (input.loader) facets.push([`categories:${input.loader}`]);
        const query = new URLSearchParams({
          query: input.query,
          facets: JSON.stringify(facets),
          offset: String(input.offset),
          limit: String(input.limit),
          index:
            input.sort === "popular"
              ? "follows"
              : input.sort || (input.query ? "relevance" : "downloads"),
        });
        const result = await json(`${mr}/search?${query}`);
        return {
          projects: result.hits.map((value) => ({
            id: value.project_id,
            platform: "modrinth",
            title: value.title,
            description: value.description,
            iconUrl: value.icon_url,
            downloads: value.downloads,
            author: value.author,
            url: `https://modrinth.com/${input.type}/${value.slug ?? value.project_id}`,
          })),
          total: result.total_hits,
          offset: result.offset,
          limit: result.limit,
        };
      },
      async versions(input) {
        return (await mrVersions(input))
          .map(mrVersion)
          .filter((version) => fits(version, input));
      },
      async compatibleDependencyVersion(input) {
        if (
          input.type !== "mod" ||
          !input.gameVersion ||
          !["fabric", "forge", "neoforge", "quilt"].includes(input.loader)
        )
          return null;
        const pinned = await json(`${mr}/version/${enc(id(input.versionId))}`, {
          signal: input.signal,
        });
        const tags = (value) =>
          Array.isArray(value) && value.every((tag) => typeof tag === "string");
        if (
          !pinned ||
          pinned.id !== input.versionId ||
          pinned.project_id !== input.projectId ||
          typeof pinned.version_number !== "string" ||
          !pinned.version_number.trim() ||
          !tags(pinned.game_versions) ||
          !pinned.game_versions.includes(input.gameVersion) ||
          !tags(pinned.loaders) ||
          !pinned.loaders.length ||
          pinned.loaders.includes(input.loader)
        )
          return null;
        const rows = await mrVersions(input);
        if (!Array.isArray(rows)) return null;
        const distinct = new Map();
        for (const row of rows) {
          if (
            !row ||
            typeof row.id !== "string" ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(row.id)
          )
            continue;
          // Conflicting representations of one ID are ambiguous, even when
          // only one representation would pass the compatibility filters.
          const prior = distinct.get(row.id);
          if (prior && JSON.stringify(prior) !== JSON.stringify(row))
            return null;
          distinct.set(row.id, row);
        }
        const candidates = [];
        for (const row of distinct.values()) {
          if (
            row.id === pinned.id ||
            row.project_id !== input.projectId ||
            row.version_number !== pinned.version_number ||
            !tags(row.game_versions) ||
            !tags(row.loaders) ||
            !Array.isArray(row.files) ||
            row.files.some((file) => !file || typeof file !== "object")
          )
            continue;
          const version = mrVersion(row);
          if (!fits(version, input) || !version.downloadable) continue;
          try {
            if (mrUpdateFile(row, input)) candidates.push(version);
          } catch {
            // A manual-only or invalid download is not an automatic recovery.
          }
        }
        // Version numbers are opaque provider labels. Never parse names,
        // choose a newer release, or guess between same-release variants.
        return candidates.length === 1 ? candidates[0] : null;
      },
      async resolve(input) {
        const project = await mrProject(input.projectId);
        const value = await json(`${mr}/version/${enc(id(input.versionId))}`);
        const supportedTypes = project.project_types ??
          project.all_project_types ?? [project.project_type];
        // Legacy Modrinth represents datapacks/plugins as mods with a loader tag.
        const matchesType =
          supportedTypes.includes(input.type) ||
          (["plugin", "datapack"].includes(input.type) &&
            supportedTypes.includes("mod"));
        if (String(value.project_id) !== input.projectId || !matchesType)
          throw launchpadError(
            400,
            "This version does not match the selected project, Minecraft version, or loader.",
          );
        if (
          input.expectedVersionNumber !== undefined &&
          (typeof input.expectedVersionNumber !== "string" ||
            value.version_number !== input.expectedVersionNumber)
        )
          throw launchpadError(
            400,
            "The required dependency's release metadata changed while it was being checked. Review the installation again.",
          );
        const version = mrVersion(value);
        if (!fits(version, input))
          throw Object.assign(
            launchpadError(
              400,
              `${value.name || project.title} targets ${version.loaders.join(", ") || "an unspecified loader"} on Minecraft ${version.gameVersions.join(", ") || "an unspecified version"}; the selected target is ${input.loader || "any loader"} on Minecraft ${input.gameVersion || "any version"}.`,
            ),
            { code: "INCOMPATIBLE_VERSION" },
          );
        if (
          project.server_side === "unsupported" ||
          !serverEnvironment(value.environment)
        )
          throw launchpadError(
            400,
            "This version is intended for clients and cannot be installed on a server.",
          );
        const extension =
          input.type === "modpack"
            ? /\.mrpack$/i
            : input.type === "datapack"
              ? /\.zip$/i
              : /\.jar$/i;
        const candidates = value.files.filter((file) =>
          extension.test(file.filename),
        );
        const file =
          candidates.find((file) => file.primary) ??
          (candidates.length === 1 ? candidates[0] : null);
        if (!file)
          throw launchpadError(
            400,
            "This version does not provide a single supported server download.",
          );
        const download = {
          url: file.url,
          size: file.size,
          hashes: file.hashes,
        };
        strongestHash(file.hashes);
        if (input.type === "modpack")
          return {
            title: project.title,
            iconUrl: iconUrl(project.icon_url),
            versionName: value.name,
            archive: { ...download, format: "mrpack" },
            warnings: [],
          };
        const dependencies = (value.dependencies ?? [])
          .filter((dep) => dep.dependency_type === "required")
          .map((dep) => ({
            platform: "modrinth",
            projectId: dep.project_id,
            versionId: dep.version_id,
            type: input.type,
          }));
        if (dependencies.some((dep) => !dep.projectId && !dep.versionId))
          throw launchpadError(
            400,
            "This version requires an external dependency. Install its required dependencies manually before using this file.",
          );
        return {
          title: project.title,
          iconUrl: iconUrl(project.icon_url),
          versionName: value.name,
          files: [{ path: fileName(file.filename), ...download }],
          dependencies,
          warnings: [],
        };
      },
      async identify(hashes, { signal } = {}) {
        return json(`${mr}/version_files`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hashes, algorithm: "sha512" }),
        });
      },
      compatibleBundledVersion(value, input) {
        return (
          fits(mrVersion(value), input) && serverEnvironment(value.environment)
        );
      },
      project: mrProject,
      async version(versionId) {
        return json(`${mr}/version/${enc(id(versionId))}`);
      },
      async gameVersions() {
        // Launchpad shows main Minecraft releases, newest first.
        // https://docs.modrinth.com/api/operations/versionlist/
        const versions = (await json(`${mr}/tag/game_version`))
          .filter(
            (row) =>
              row?.version_type === "release" &&
              typeof row.version === "string" &&
              /^\d+(?:\.\d+)+$/.test(row.version),
          )
          .sort(
            (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0),
          );
        return [...new Set(versions.map((row) => row.version))];
      },
    },
    {
      id: "curseforge",
      name: "CurseForge",
      types: ["mod", "modpack", "datapack", "plugin"],
      available: true,
      requiresKey: true,
      sortOptions: cfSortOptions,
      downloadHosts: [
        "edge.forgecdn.net",
        "mediafilez.forgecdn.net",
        "media.forgecdn.net",
      ],
      async projectMetadata(ids) {
        // A newly configured key should work immediately instead of reusing a
        // cached missing-key failure from a previous installed-files poll.
        if (!(await key())) return { projects: [], warnings: [] };
        return cfMetadata(ids);
      },
      async search(input) {
        const query = new URLSearchParams({
          gameId: "432",
          classId: String(await cfClass(input.type)),
          searchFilter: input.query,
          index: String(input.offset),
          pageSize: String(Math.min(input.limit, 50)),
          sortField: String(cfSortFields[input.sort || "popular"]),
          sortOrder: input.sort === "name" ? "asc" : "desc",
        });
        if (input.gameVersion) query.set("gameVersion", input.gameVersion);
        if (cfLoaders[input.loader])
          query.set("modLoaderType", String(cfLoaders[input.loader]));
        const result = await curseJson(`/mods/search?${query}`);
        if (input.limit > 50 && result.data.length === 50) {
          query.set("index", String(input.offset + 50));
          query.set("pageSize", String(input.limit - 50));
          const next = await curseJson(`/mods/search?${query}`);
          result.data.push(...next.data);
        }
        return {
          projects: result.data.map((value) => ({
            id: String(value.id),
            platform: "curseforge",
            title: value.name,
            description: value.summary,
            iconUrl: value.logo?.thumbnailUrl,
            downloads: value.downloadCount,
            author: value.authors?.map((author) => author.name).join(", "),
            url: value.links?.websiteUrl,
          })),
          total: result.pagination?.totalCount ?? result.data.length,
          offset: input.offset,
          limit: input.limit,
        };
      },
      async versions(input) {
        return (await cfFiles(input))
          .map((file) => cfVersion(file, input.type))
          .filter((version) => fits(version, input));
      },
      async identifyFingerprints(fingerprints, { signal } = {}) {
        return (
          await curseJson("/fingerprints/432", {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fingerprints }),
          })
        ).data;
      },
      compatibleBundledVersion(value, input) {
        return fits(cfVersion(value, input.type), input);
      },
      async resolve(input) {
        const project = (await curseJson(`/mods/${enc(id(input.projectId))}`))
          .data;
        let file = (
          await curseJson(
            `/mods/${enc(id(input.projectId))}/files/${enc(id(input.versionId))}`,
          )
        ).data;
        if (
          project.gameId !== 432 ||
          project.classId !== (await cfClass(input.type)) ||
          String(file.modId) !== input.projectId ||
          !fits(cfVersion(file, input.type), input)
        )
          throw launchpadError(
            400,
            "This CurseForge file does not match the selected project or server compatibility.",
          );
        if (input.type === "modpack" && !file.isServerPack) {
          if (!file.serverPackFileId)
            throw launchpadError(
              400,
              "This modpack has no author-provided server pack. Client manifests are not installed onto servers; use the author's manual server instructions.",
            );
          file = (
            await curseJson(
              `/mods/${enc(id(input.projectId))}/files/${file.serverPackFileId}`,
            )
          ).data;
          if (!file.isServerPack || String(file.modId) !== input.projectId)
            throw launchpadError(
              400,
              "The provider returned an invalid server pack.",
            );
        }
        if (!file.downloadUrl || file.isAvailable === false)
          throw launchpadError(
            400,
            "The author restricts automated downloads of this file. Download it manually from CurseForge and use File Manager.",
          );
        const hashes = Object.fromEntries(
          (file.hashes ?? [])
            .filter((hash) => hash.algo === 1)
            .map((hash) => ["sha1", hash.value]),
        );
        strongestHash(hashes);
        const download = {
          url: file.downloadUrl,
          size: file.fileLength,
          hashes,
        };
        if (input.type === "modpack")
          return {
            title: project.name,
            iconUrl: iconUrl(project.logo?.thumbnailUrl ?? project.logo?.url),
            author: projectAuthors(project),
            versionName: file.displayName,
            archive: { ...download, format: "server-zip" },
            warnings: [],
          };
        const extension = input.type === "datapack" ? /\.zip$/i : /\.jar$/i;
        if (!extension.test(file.fileName))
          throw launchpadError(
            400,
            "The provider does not supply a supported file for this content type.",
          );
        return {
          title: project.name,
          iconUrl: iconUrl(project.logo?.thumbnailUrl ?? project.logo?.url),
          author: projectAuthors(project),
          versionName: file.displayName,
          files: [{ path: fileName(file.fileName), ...download }],
          dependencies: (file.dependencies ?? [])
            .filter((dep) => dep.relationType === 3)
            .map((dep) => ({
              platform: "curseforge",
              projectId: String(dep.modId),
              type: input.type,
            })),
          warnings: [
            "CurseForge does not declare client/server support for individual mods. Check the author's server requirements before installing.",
          ],
        };
      },
    },
  ];
}
