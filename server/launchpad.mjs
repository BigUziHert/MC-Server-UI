import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createCoreProviders } from "./launchpad-providers.mjs";
import { safeInstallPath, unpackProviderZip } from "./launchpad-archives.mjs";
import {
  checkedProviderUrl,
  downloadVerified,
  strongestHash,
  launchpadError as error,
  providerJson,
} from "./launchpad-network.mjs";
export { providerJson };

const types = ["mod", "modpack", "datapack", "plugin"];
const sorts = new Set([
  "relevance",
  "downloads",
  "popular",
  "updated",
  "newest",
  "name",
]);
const loaders = [
  "fabric",
  "forge",
  "neoforge",
  "quilt",
  "paper",
  "purpur",
  "spigot",
  "bukkit",
  "folia",
  "velocity",
  "waterfall",
  "bungeecord",
  "datapack",
];
const missing = (cause) => cause.code === "ENOENT" || cause.code === "ENOTDIR";
async function statOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (cause) {
    if (missing(cause)) return null;
    throw cause;
  }
}
async function fileHash(target, algorithm = "sha512") {
  const before = await fs.lstat(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 512 * 1024 ** 2
  )
    throw error(
      400,
      "Only regular files under 512 MB can be managed by Launchpad.",
    );
  const handle = await fs.open(target, "r");
  const hash = createHash(algorithm);
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw error(
        409,
        "A file changed while it was being checked. Refresh and try again.",
      );
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw error(
        409,
        "A file changed while it was being checked. Refresh and try again.",
      );
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
const publicVersion = (value) => ({
  id: String(value.id),
  name: value.name,
  version: value.version,
  gameVersions: value.gameVersions ?? [],
  loaders: value.loaders ?? [],
  publishedAt: value.publishedAt,
  downloadable: value.downloadable !== false,
});

// CurseForge's fingerprint is only a lookup hint. Matches below are additionally
// verified against the API's SHA-1 file hash before an update can be offered.
export function curseFingerprint(bytes) {
  const whitespace = (byte) =>
    byte === 9 || byte === 10 || byte === 13 || byte === 32;
  let length = 0;
  for (const byte of bytes) if (!whitespace(byte)) length++;
  let hash = 1 ^ length,
    value = 0,
    shift = 0;
  for (const byte of bytes) {
    if (whitespace(byte)) continue;
    value |= byte << shift;
    shift += 8;
    if (shift === 32) {
      value = Math.imul(value, 0x5bd1e995);
      value ^= value >>> 24;
      hash = Math.imul(hash, 0x5bd1e995) ^ Math.imul(value, 0x5bd1e995);
      value = 0;
      shift = 0;
    }
  }
  if (shift) hash = Math.imul(hash ^ value, 0x5bd1e995);
  hash = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995);
  return (hash ^ (hash >>> 15)) >>> 0;
}

export async function createLaunchpad(ctx) {
  const {
    serverDir,
    dataDir,
    safePath,
    withMinecraftMutation,
    recycle,
    restore,
    getServer,
    fetch: rawRequest = fetch,
  } = ctx;
  const lifetime = new AbortController();
  const request = (url, init = {}) => {
    lifetime.signal.throwIfAborted();
    return rawRequest(url, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([lifetime.signal, init.signal])
        : lifetime.signal,
    });
  };
  const key = async () =>
    (await ctx.platformConfig?.get?.())?.curseforgeApiKey ?? null;
  const providers = [
    ...createCoreProviders({ fetch: request, key }),
    ...(ctx.extraProviders ?? []),
  ];
  const privateRoot = await safePath(dataDir, "launchpad");
  await fs.mkdir(privateRoot, { recursive: true });
  const rootIdentity = await fs.realpath(privateRoot);
  const privatePath = async (relative) => {
    const root = await safePath(dataDir, "launchpad");
    if ((await fs.realpath(root)) !== rootIdentity)
      throw error(
        409,
        "Launchpad storage changed. Restart the panel before continuing.",
      );
    return safePath(root, relative);
  };
  let receipts = [];
  try {
    const saved = JSON.parse(
      await fs.readFile(await privatePath("installed.json"), "utf8"),
    );
    if (Array.isArray(saved)) receipts = saved;
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
  const saveReceipts = async () => {
    const temporary = await privatePath(`${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(receipts), { flag: "wx" });
    await fs.rename(temporary, await privatePath("installed.json"));
  };
  const plans = new Map();
  const jobs = new Map();
  const previews = new Set();
  let active = null,
    activeController = null,
    preparingInstall = false,
    lastJob = null,
    closing = false,
    versionsCache = null;
  const provider = async (platform) => {
    const found = providers.find((value) => value.id === platform);
    if (!found || found.available === false)
      throw error(
        400,
        found?.reason ?? "Choose an available Launchpad provider.",
      );
    if (found.requiresKey && !(await key()))
      throw error(
        400,
        "Add your CurseForge API key in Launchpad settings first.",
      );
    return found;
  };
  function selection(input = {}, strict = false) {
    if (!types.includes(input.type))
      throw error(400, "Choose Mods, Modpacks, Datapacks, or Plugins.");
    const gameVersion =
      typeof input.gameVersion === "string" ? input.gameVersion.trim() : "";
    const loader =
      input.type === "datapack"
        ? "datapack"
        : typeof input.loader === "string"
          ? input.loader.toLowerCase()
          : "";
    if (
      (gameVersion && !/^[A-Za-z0-9._+-]{1,40}$/.test(gameVersion)) ||
      (loader && !loaders.includes(loader))
    )
      throw error(400, "Choose a valid Minecraft version and loader.");
    if (
      loader &&
      input.type === "mod" &&
      !["forge", "neoforge", "fabric", "quilt"].includes(loader)
    )
      throw error(
        400,
        "Mods require Forge, NeoForge, Fabric, or Quilt. Use the Plugins tab for Paper, Spigot, and other plugin servers.",
      );
    if (
      loader &&
      input.type === "plugin" &&
      ["forge", "neoforge", "fabric", "quilt", "datapack"].includes(loader)
    )
      throw error(
        400,
        "Plugins require a compatible plugin server such as Paper or Spigot. Use the Mods tab for mod loaders.",
      );
    if (strict && (!gameVersion || !loader))
      throw error(
        400,
        "Choose the target Minecraft version and loader before reviewing an install.",
      );
    const query =
      typeof input.query === "string" ? input.query.trim().slice(0, 200) : "";
    const offset = Math.min(9900, Math.max(0, Number(input.offset) || 0));
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
    return {
      ...input,
      signal: lifetime.signal,
      gameVersion,
      loader,
      query,
      offset: Math.floor(offset),
      limit: Math.floor(limit),
    };
  }
  async function assertCompatibility(input) {
    const current = await getServer();
    if (current.gameVersion && current.gameVersion !== input.gameVersion)
      throw error(
        409,
        `This server uses Minecraft ${current.gameVersion}. Select that version or change the server version first.`,
      );
    if (
      input.type !== "datapack" &&
      current.loader &&
      current.loader !== input.loader
    )
      throw error(
        409,
        `This server uses ${current.loader}. Choose its compatible loader or change the server runtime first.`,
      );
    return current;
  }
  async function assertPackRuntime(required) {
    if (!required) return;
    const current = await getServer();
    if (
      required.gameVersion &&
      current.gameVersion &&
      required.gameVersion !== current.gameVersion
    )
      throw error(
        409,
        `This pack requires Minecraft ${required.gameVersion}. Install the matching runtime in Versions first.`,
      );
    if (required.loader && current.loader && required.loader !== current.loader)
      throw error(
        409,
        `This pack requires ${required.loader}. Install the matching runtime in Versions first.`,
      );
    const actual =
      current.loaderVersion ??
      (current.loader === "neoforge"
        ? current.version
        : current.loader === "forge"
          ? current.version?.replace(/^1\.\d+(?:\.\d+)?-/, "")
          : null);
    if (
      required.loaderVersion &&
      actual &&
      actual !== "Unknown" &&
      actual !== required.loaderVersion
    )
      throw error(
        409,
        `This pack requires ${required.loader} ${required.loaderVersion}; the configured loader is ${actual}. Install the required loader build in Versions first.`,
      );
  }
  async function destination(type) {
    if (type === "mod") return "mods";
    if (type === "plugin") return "plugins";
    if (type === "datapack")
      return `${safeInstallPath((await getServer()).world || "world")}/datapacks`;
    return "";
  }
  async function protectedPackPath(name) {
    const current = await getServer();
    const world = safeInstallPath(current.world || "world").toLowerCase();
    const lower = name.toLowerCase();
    const startupFiles = [
      "user_jvm_args.txt",
      "run.bat",
      "run.cmd",
      "run.sh",
      "start.bat",
      "start.cmd",
      "start.sh",
      current.launchScript,
    ]
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    if (
      startupFiles.includes(lower) &&
      (await statOrNull(await safePath(serverDir, name)))
    )
      return true;
    return (
      /^(?:eula\.txt|server\.properties|ops\.json|whitelist\.json|banned-players\.json|banned-ips\.json)$/i.test(
        name,
      ) ||
      lower === world ||
      lower.startsWith(world + "/") ||
      /^(?:world_nether|world_the_end|logs|backups|recycle-bin)(?:\/|$)/i.test(
        name,
      )
    );
  }
  async function scan(type) {
    if (type === "modpack") return [];
    const relative = await destination(type);
    const directory = await safePath(serverDir, relative);
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((cause) => {
        if (missing(cause)) return [];
        throw cause;
      });
    const files = entries.filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        (type === "datapack" ? /\.zip$/i : /\.jar$/i).test(entry.name),
    );
    if (files.length > 1000)
      throw error(
        400,
        "This folder has over 1,000 packages. Use File Manager to narrow the installed collection.",
      );
    const rows = [];
    for (const file of files) {
      const relativePath = `${relative}/${safeInstallPath(file.name)}`;
      const target = await safePath(serverDir, relativePath);
      const stat = await fs.lstat(target);
      const sha512 = await fileHash(target);
      const receipt = receipts.find(
        (item) => item.path === relativePath && item.sha512 === sha512,
      );
      rows.push({
        path: relativePath,
        name: file.name,
        size: stat.size,
        sha512,
        platform: null,
        ...receipt,
      });
    }
    return rows;
  }
  async function enrichProjectMetadata(items, warnings) {
    await Promise.all(
      providers.map(async (found) => {
        if (!found.projectMetadata) return;
        const known = items.filter(
          (item) => item.platform === found.id && item.projectId,
        );
        if (!known.length) return;
        try {
          const result = await found.projectMetadata(
            known.map((item) => item.projectId),
          );
          const projects = new Map(
            result.projects.map((project) => [String(project.id), project]),
          );
          for (const item of known) {
            const project = projects.get(String(item.projectId));
            if (typeof project?.title === "string" && project.title.trim())
              item.title = project.title;
            if (project?.iconUrl) item.iconUrl = project.iconUrl;
          }
          warnings.push(
            ...result.warnings.map(
              (warning) => `${found.name} project details: ${warning}`,
            ),
          );
        } catch (cause) {
          warnings.push(`${found.name} project details: ${cause.message}`);
        }
      }),
    );
  }
  async function installed(input) {
    input = selection(input);
    if (input.type === "modpack") {
      const items = receipts
        .filter((item) => item.type === "modpack" && item.pack)
        .map((item) => ({ ...item }));
      const warnings = [];
      await enrichProjectMetadata(items, warnings);
      return {
        items: items.map((item) => ({ ...item, name: item.title })),
        warnings,
      };
    }
    const items = await scan(input.type),
      warnings = [];
    const unknown = items.filter((item) => !item.platform);
    const modrinth = providers.find((value) => value.id === "modrinth");
    if (unknown.length) {
      try {
        const matches = await modrinth.identify(
          unknown.map((item) => item.sha512),
        );
        for (const item of unknown) {
          const version = matches[item.sha512];
          if (version)
            Object.assign(item, {
              platform: "modrinth",
              projectId: String(version.project_id),
              versionId: String(version.id),
              versionName: version.name,
              title: version.name,
            });
        }
      } catch (cause) {
        warnings.push(`Modrinth identification: ${cause.message}`);
      }
    }
    if (await key()) {
      const candidates = items.filter(
        (item) => !item.platform && item.size <= 128 * 1024 ** 2,
      );
      if (candidates.length) {
        try {
          const fingerprints = new Map();
          for (const item of candidates) {
            const bytes = await fs.readFile(
              await safePath(serverDir, item.path),
            );
            if (
              createHash("sha512").update(bytes).digest("hex") !== item.sha512
            )
              throw error(
                409,
                `${item.name} changed while checking its identity.`,
              );
            fingerprints.set(item, {
              fingerprint: curseFingerprint(bytes),
              sha1: createHash("sha1").update(bytes).digest("hex"),
            });
          }
          const result = await providers
            .find((value) => value.id === "curseforge")
            .identifyFingerprints(
              [...fingerprints.values()].map((value) => value.fingerprint),
            );
          for (const [item, digest] of fingerprints) {
            const match = result.exactMatches?.find(
              (value) =>
                value.file?.fileFingerprint === digest.fingerprint &&
                value.file.hashes?.some(
                  (hash) =>
                    hash.algo === 1 &&
                    hash.value?.toLowerCase() === digest.sha1,
                ),
            );
            if (match)
              Object.assign(item, {
                platform: "curseforge",
                projectId: String(match.file.modId ?? match.id),
                versionId: String(match.file.id),
                versionName: match.file.displayName,
                title: match.file.displayName,
              });
          }
        } catch (cause) {
          warnings.push(`CurseForge identification: ${cause.message}`);
        }
      }
    }
    // Names and icons belong to the project, even with All loaders/versions.
    // Failed metadata requests must not suppress identification or updates.
    await enrichProjectMetadata(items, warnings);
    const checked = new Map();
    for (const item of items) {
      if (!item.platform || !input.gameVersion || !input.loader) continue;
      try {
        const found = await provider(item.platform);
        const key = `${item.platform}:${item.projectId}`;
        if (!checked.has(key))
          checked.set(
            key,
            await found.versions({ ...input, projectId: item.projectId }),
          );
        const versions = checked
          .get(key)
          .filter((value) => value.downloadable !== false)
          .sort((a, b) =>
            (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
          );
        const current = versions.find(
          (value) => String(value.id) === item.versionId,
        );
        const newest = versions[0];
        if (
          newest &&
          String(newest.id) !== item.versionId &&
          (!current || (newest.publishedAt ?? "") > (current.publishedAt ?? ""))
        )
          item.update = publicVersion(newest);
      } catch (cause) {
        warnings.push(`${item.name}: ${cause.message}`);
      }
    }
    if (items.some((item) => !item.platform))
      warnings.push(
        "Unidentified files are left untouched. Only checksum-identified files or verified Launchpad installations can be updated.",
      );
    return { items, warnings: [...new Set(warnings)] };
  }
  async function config() {
    const current = await getServer();
    const warnings = [];
    if (!versionsCache) {
      try {
        versionsCache = await providers[0].gameVersions();
      } catch (cause) {
        warnings.push(`Minecraft version catalog: ${cause.message}`);
      }
    }
    const secret = await key();
    return {
      platforms: providers.map((value) => ({
        id: value.id,
        name: value.name,
        types: value.types,
        sortOptions: (value.sortOptions ?? []).map(({ id, label }) => ({
          id,
          label,
        })),
        available:
          value.available !== false && (!value.requiresKey || !!secret),
        requiresKey: !!value.requiresKey,
        keyConfigured: value.requiresKey ? !!secret : undefined,
        reason:
          value.requiresKey && !secret
            ? "Add a CurseForge API key in Launchpad settings."
            : value.reason,
      })),
      types,
      loaders,
      gameVersions: versionsCache ?? [],
      gameVersion: current.gameVersion ?? null,
      loader: current.loader ?? null,
      status: current.status,
      warnings,
      job: lastJob ? { ...jobs.get(lastJob) } : null,
    };
  }
  async function resolveTree(input) {
    const files = [],
      warnings = [],
      visited = new Map();
    let rootResult;
    async function visit(value, depth = 0) {
      if (depth > 20 || visited.size >= 100)
        throw error(
          400,
          "This dependency graph is too large to install automatically.",
        );
      const found = await provider(value.platform);
      if (!found.types.includes(value.type))
        throw error(
          400,
          "This provider does not support the selected content type.",
        );
      if (!value.projectId && value.versionId && found.version)
        value.projectId = String(
          (await found.version(value.versionId)).project_id,
        );
      if (!value.versionId) {
        const versions = (await found.versions(value)).filter(
          (version) => version.downloadable !== false,
        );
        value.versionId = versions.sort((a, b) =>
          (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
        )[0]?.id;
        if (!value.versionId)
          throw error(
            400,
            "A required dependency has no compatible downloadable version. Install the dependency manually before continuing.",
          );
      }
      const key = `${value.platform}:${value.projectId}`;
      if (visited.has(key)) {
        if (visited.get(key) !== String(value.versionId))
          throw error(
            409,
            "Required dependencies request conflicting versions of the same project. Resolve them manually before installing.",
          );
        return;
      }
      visited.set(key, String(value.versionId));
      const result = await found.resolve(value);
      if (!rootResult) rootResult = result;
      warnings.push(...(result.warnings ?? []));
      if (result.archive) {
        if (depth)
          throw error(
            400,
            "A required dependency unexpectedly contains a modpack.",
          );
      }
      const prefix = await destination(value.type);
      for (const file of result.files ?? []) {
        const target = safeInstallPath(
          file.path.includes("/") || !prefix
            ? file.path
            : `${prefix}/${file.path}`,
        );
        files.push({
          ...file,
          path: target,
          platform: value.platform,
          projectId: value.projectId,
          versionId: String(value.versionId),
          versionName: result.versionName,
          title: result.title,
          iconUrl: result.iconUrl,
          type: value.type,
          hosts: found.downloadHosts,
        });
      }
      for (const dependency of result.dependencies ?? [])
        await visit({ ...input, ...dependency }, depth + 1);
    }
    await visit({ ...input });
    return { ...rootResult, files, warnings };
  }
  async function unpackPack(result, input, stage) {
    const found = await provider(input.platform);
    const archive = path.join(stage, "package.zip");
    await downloadVerified(
      { ...result.archive, archive: true },
      archive,
      found.downloadHosts,
      request,
    );
    const extracted = path.join(stage, "archive");
    await fs.mkdir(extracted);
    const entries = await unpackProviderZip(archive, extracted, undefined, {
      signal: lifetime.signal,
    });
    const current = await getServer();
    const world = safeInstallPath(current.world || "world");
    const protectedFile = (name) =>
      /^(?:eula\.txt|server\.properties|ops\.json|whitelist\.json|banned-players\.json|banned-ips\.json)$/i.test(
        name,
      ) ||
      name.toLowerCase() === world.toLowerCase() ||
      name.toLowerCase().startsWith(world.toLowerCase() + "/") ||
      /^(?:world_nether|world_the_end|logs|backups|recycle-bin)(?:\/|$)/i.test(
        name,
      );
    const files = [],
      warnings = [];
    let loaderInstall;
    if (result.archive.format === "mrpack") {
      const manifestFile = entries.find(
        (entry) => entry.path === "modrinth.index.json",
      );
      if (!manifestFile || manifestFile.size > 4 * 1024 ** 2)
        throw error(
          400,
          "This modpack is missing a supported Modrinth manifest.",
        );
      let manifest;
      try {
        manifest = JSON.parse(
          await fs.readFile(manifestFile.stagedPath, "utf8"),
        );
      } catch {
        throw error(400, "The modpack manifest is invalid.");
      }
      if (
        manifest.formatVersion !== 1 ||
        manifest.game !== "minecraft" ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > 10000
      )
        throw error(400, "This Modrinth pack format is unsupported.");
      if (manifest.dependencies?.minecraft !== input.gameVersion)
        throw error(
          400,
          "The pack manifest requires a different Minecraft version.",
        );
      const loaderKeys = {
        "fabric-loader": "fabric",
        "quilt-loader": "quilt",
        forge: "forge",
        neoforge: "neoforge",
      };
      const declared = Object.keys(loaderKeys).filter(
        (key) => manifest.dependencies?.[key],
      );
      if (declared.length !== 1 || loaderKeys[declared[0]] !== input.loader)
        throw error(
          400,
          "The pack's required loader does not match this server. Set up the matching runtime in Versions first.",
        );
      warnings.push(
        `Requires ${input.loader} ${manifest.dependencies[declared[0]]}. Install that runtime in Versions before starting this pack.`,
      );
      loaderInstall = {
        loader: input.loader,
        gameVersion: input.gameVersion,
        loaderVersion: String(manifest.dependencies[declared[0]]),
      };
      for (const file of manifest.files) {
        const name = safeInstallPath(file.path);
        const environment = file.env?.server;
        if (
          environment &&
          !["required", "optional", "unsupported"].includes(environment)
        )
          throw error(
            400,
            "The pack has invalid server-side dependency metadata.",
          );
        if (environment === "unsupported" || environment === "optional") {
          warnings.push(
            `Skipped ${name}: ${environment === "unsupported" ? "client-only" : "optional server file"}.`,
          );
          continue;
        }
        if (protectedFile(name)) {
          warnings.push(`Preserved server data: ${name}.`);
          continue;
        }
        if (!Array.isArray(file.downloads) || !file.downloads.length)
          throw error(
            400,
            `The pack has no automated download for ${name}. Obtain this file from its author manually.`,
          );
        const hosts = [
          ...new Set([
            ...found.downloadHosts,
            "cdn.modrinth.com",
            "edge.forgecdn.net",
            "mediafilez.forgecdn.net",
            "media.forgecdn.net",
          ]),
        ];
        const url = file.downloads.find((url) => {
          try {
            checkedProviderUrl(url, hosts);
            return true;
          } catch {
            return false;
          }
        });
        if (!url)
          throw error(
            400,
            `The pack requires ${name} from an unsupported host. Download restricted files manually from the author.`,
          );
        strongestHash(file.hashes);
        files.push({
          path: name,
          url,
          size: file.fileSize,
          hashes: file.hashes,
          hosts,
        });
      }
      const overrides = new Map();
      for (const prefix of ["overrides/", "server-overrides/"])
        for (const entry of entries.filter((entry) =>
          entry.path.startsWith(prefix),
        )) {
          const name = safeInstallPath(entry.path.slice(prefix.length));
          if (protectedFile(name)) {
            warnings.push(`Preserved server data: ${name}.`);
            continue;
          }
          overrides.set(name.toLowerCase(), { ...entry, path: name });
        }
      files.push(...overrides.values());
    } else if (result.archive.format === "server-zip") {
      const roots = new Set(entries.map((entry) => entry.path.split("/")[0]));
      const root = roots.size === 1 ? [...roots][0] : null;
      const wrapped =
        root &&
        entries.every((entry) => entry.path.includes("/")) &&
        !/^(?:mods|config|defaultconfigs|libraries|plugins|datapacks|kubejs|scripts|overrides|server-overrides)$/i.test(
          root,
        ) &&
        entries.some((entry) =>
          /^(?:mods|config|libraries|plugins)\//i.test(
            entry.path.slice(root.length + 1),
          ),
        );
      if (wrapped)
        warnings.push(
          `Installed files from the archive's ${root} folder into the server folder.`,
        );
      for (const entry of entries) {
        const relative = wrapped
          ? entry.path.slice(root.length + 1)
          : entry.path;
        if (protectedFile(relative)) {
          warnings.push(`Preserved server data: ${relative}.`);
          continue;
        }
        files.push({ ...entry, path: relative });
      }
    } else throw error(400, "This provider's archive format is unsupported.");
    return { files, warnings, loaderInstall };
  }
  function preview(raw) {
    const task = preparePreview(raw);
    previews.add(task);
    task.then(
      () => previews.delete(task),
      () => previews.delete(task),
    );
    return task;
  }
  async function preparePreview(raw) {
    if (closing) throw error(503, "Launchpad is shutting down.");
    if (active)
      throw error(
        409,
        "Wait for the current Launchpad installation to finish.",
      );
    for (const [id, plan] of plans) {
      if (Date.parse(plan.expiresAt) < Date.now()) {
        await fs.rm(await privatePath(id), { recursive: true, force: true });
        plans.delete(id);
      }
    }
    if (plans.size >= 4)
      throw error(
        409,
        "There are several pending installation reviews. Finish a review or wait for it to expire before preparing another.",
      );
    const input = selection(raw, true);
    await assertCompatibility(input);
    const found = await provider(input.platform);
    const result = await resolveTree(input);
    const planId = randomUUID();
    const stage = await privatePath(planId);
    await fs.mkdir(stage);
    try {
      if (result.archive) {
        const pack = await unpackPack(result, input, stage);
        result.files.push(
          ...pack.files.map((file) => ({
            ...file,
            platform: input.platform,
            projectId: input.projectId,
            versionId: input.versionId,
            title: result.title,
            iconUrl: result.iconUrl,
            versionName: result.versionName,
            type: input.type,
            hosts: file.hosts ?? found.downloadHosts,
          })),
        );
        result.warnings.push(...pack.warnings);
        result.loaderInstall = pack.loaderInstall ?? result.loaderInstall;
      }
      if (input.type === "modpack") {
        await assertPackRuntime(result.loaderInstall);
        const accepted = [];
        for (const file of result.files) {
          if (await protectedPackPath(file.path))
            result.warnings.push(`Preserved server data: ${file.path}.`);
          else accepted.push(file);
        }
        result.files = accepted;
      }
      if (!result.files.length || result.files.length > 10000)
        throw error(
          400,
          "This selection contains no supported server files or too many files.",
        );
      const paths = new Set();
      const files = [];
      const local =
        input.type === "modpack" ? [] : (await installed(input)).items;
      for (const file of result.files) {
        file.path = safeInstallPath(file.path);
        const folded = file.path.toLowerCase();
        if (
          paths.has(folded) ||
          [...paths].some(
            (existing) =>
              folded.startsWith(existing + "/") ||
              existing.startsWith(folded + "/"),
          )
        )
          throw error(
            400,
            "The package resolves to conflicting destination paths.",
          );
        paths.add(folded);
        if (!file.stagedPath) {
          strongestHash(file.hashes);
          checkedProviderUrl(file.url, file.hosts);
        }
        const matches = local.filter(
          (item) =>
            item.platform === file.platform &&
            item.projectId === file.projectId,
        );
        if (matches.length > 1)
          throw error(
            409,
            "Multiple installed files match this project. Use File Manager to resolve duplicates before updating.",
          );
        let oldPath = matches[0]?.path;
        if (raw.replacePath && file.projectId === input.projectId) {
          if (oldPath !== raw.replacePath)
            throw error(
              409,
              "The selected installed file could not be verified as this project. Refresh installed files.",
            );
          oldPath = raw.replacePath;
        }
        const target = await safePath(serverDir, file.path);
        const current = await statOrNull(target);
        if (current && !current.isFile())
          throw error(
            409,
            `The destination ${file.path} is not a regular file.`,
          );
        const expected = current ? await fileHash(target) : null;
        let previous = null;
        if (oldPath && oldPath !== file.path)
          previous = {
            path: oldPath,
            sha512: await fileHash(await safePath(serverDir, oldPath)),
          };
        files.push({
          ...file,
          expected,
          previous,
          action: expected || previous ? "replace" : "install",
        });
      }
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const plan = {
        id: planId,
        input,
        stage,
        files,
        title: result.title,
        iconUrl: result.iconUrl,
        versionName: result.versionName,
        warnings: [...new Set(result.warnings)],
        loaderInstall: result.loaderInstall,
        expiresAt,
      };
      lifetime.signal.throwIfAborted();
      plans.set(planId, plan);
      return {
        planId,
        title: plan.title,
        versionName: plan.versionName,
        files: files.map((file) => ({
          path: file.path,
          size: file.size,
          action: file.action,
          previousPath: file.previous?.path,
        })),
        warnings: plan.warnings,
        expiresAt,
      };
    } catch (cause) {
      await fs.rm(await privatePath(planId), { recursive: true, force: true });
      throw cause;
    }
  }
  async function promote(plan, job) {
    return withMinecraftMutation(async () => {
      lifetime.signal.throwIfAborted();
      await assertCompatibility(plan.input);
      await assertPackRuntime(plan.loaderInstall);
      if ((await getServer()).status !== "offline")
        throw error(409, "Stop the server before installing content.");
      lifetime.signal.throwIfAborted();
      const previousReceipts = [...receipts];
      const recovered = [],
        promoted = [];
      // Validate the entire reviewed snapshot before making any server changes.
      for (const file of plan.files) {
        const target = await safePath(serverDir, file.path);
        const stat = await statOrNull(target);
        if ((stat ? await fileHash(target) : null) !== file.expected)
          throw error(
            409,
            `${file.path} changed since review. Review the installation again.`,
          );
        if (
          file.previous &&
          (await fileHash(await safePath(serverDir, file.previous.path))) !==
            file.previous.sha512
        )
          throw error(
            409,
            `${file.previous.path} changed since review. Review the update again.`,
          );
      }
      try {
        for (const file of plan.files) {
          job.message = `Installing ${file.path}`;
          for (const relative of [
            file.expected ? file.path : null,
            file.previous?.path,
          ].filter(Boolean)) {
            const item = await recycle(relative);
            recovered.push({ id: item.id, path: relative });
          }
          const relativeParent = path.posix.dirname(file.path);
          await fs.mkdir(
            await safePath(
              serverDir,
              relativeParent === "." ? "" : relativeParent,
            ),
            { recursive: true },
          );
          const target = await safePath(serverDir, file.path);
          const output = await fs.open(target, "wx");
          const identity = await output.stat();
          promoted.push({
            path: file.path,
            ino: identity.ino,
            dev: identity.dev,
          });
          try {
            const source = await fs.open(file.stagedPath, "r");
            try {
              for await (const chunk of source.createReadStream({
                autoClose: false,
              }))
                await output.writeFile(chunk);
              await output.sync();
            } finally {
              await source.close();
            }
          } finally {
            await output.close();
          }
          const sha512 = await fileHash(await safePath(serverDir, file.path));
          if (sha512 !== file.sha512)
            throw error(409, "An installed file failed verification.");
          receipts = receipts.filter(
            (item) =>
              item.path !== file.path && item.path !== file.previous?.path,
          );
          receipts.push({
            path: file.path,
            sha512,
            ...(file.type === "modpack"
              ? { platform: null }
              : {
                  platform: file.platform,
                  projectId: file.projectId,
                  versionId: file.versionId,
                  versionName: file.versionName,
                  title: file.title,
                  iconUrl: file.iconUrl,
                }),
            type: file.type,
            installedAt: new Date().toISOString(),
          });
          job.completed++;
        }
        if (plan.input.type === "modpack") {
          receipts = receipts.filter((item) => !item.pack);
          receipts.push({
            pack: true,
            type: "modpack",
            platform: plan.input.platform,
            projectId: plan.input.projectId,
            versionId: plan.input.versionId,
            title: plan.title,
            iconUrl: plan.iconUrl,
            versionName: plan.versionName,
            path: "",
            installedAt: new Date().toISOString(),
          });
        }
        await saveReceipts();
        await ctx.audit?.(
          "Launchpad installation completed",
          `${plan.title} ${plan.versionName}: ${plan.files.length} files. Replaced files are retained in Recycle Bin.`,
        );
      } catch (cause) {
        const failures = [];
        for (const written of promoted.reverse()) {
          try {
            const current = await fs.lstat(
              await safePath(serverDir, written.path),
            );
            if (
              current.ino !== written.ino ||
              current.dev !== written.dev ||
              !current.isFile() ||
              current.isSymbolicLink()
            )
              throw new Error("The installed file was externally replaced.");
            await recycle(written.path);
          } catch {
            failures.push(written.path);
          }
        }
        for (const item of recovered.reverse()) {
          try {
            await restore(item.id);
          } catch {
            failures.push(item.path);
          }
        }
        receipts = previousReceipts;
        await saveReceipts().catch(() => {});
        if (failures.length)
          throw error(
            409,
            `${cause.message} Rollback needs attention for: ${[...new Set(failures)].join(", ")}. Preserved originals remain in Recycle Bin.`,
          );
        throw error(
          cause.status ?? 500,
          `${cause.message} Previous server files were restored.`,
        );
      }
    });
  }
  async function install(input) {
    if (closing) throw error(503, "Launchpad is shutting down.");
    if (input?.confirmed !== true)
      throw error(
        400,
        "Review the exact file changes and confirm the installation first.",
      );
    if (active || preparingInstall)
      throw error(409, "Another Launchpad installation is already running.");
    const plan = plans.get(input?.planId);
    if (!plan || Date.parse(plan.expiresAt) < Date.now())
      throw error(
        409,
        "This review expired. Review the version again before installing.",
      );
    preparingInstall = true;
    try {
      if ((await getServer()).status !== "offline")
        throw error(409, "Stop the server before installing content.");
      lifetime.signal.throwIfAborted();
    } catch (cause) {
      preparingInstall = false;
      throw cause;
    }
    plans.delete(plan.id);
    const job = {
      id: randomUUID(),
      status: "queued",
      message: "Preparing verified downloads…",
      completed: 0,
      total: plan.files.length,
      createdAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    lastJob = job.id;
    const controller = new AbortController();
    activeController = controller;
    active = (async () => {
      job.status = "running";
      let outcome;
      try {
        let downloaded = 0;
        for (const [index, file] of plan.files.entries()) {
          controller.signal.throwIfAborted();
          job.message = `Verifying ${file.path}`;
          if (!file.stagedPath) {
            file.stagedPath = path.join(plan.stage, `download-${index}`);
            await downloadVerified(file, file.stagedPath, file.hosts, request, {
              signal: controller.signal,
            });
          }
          downloaded += (await fs.stat(file.stagedPath)).size;
          if (downloaded > (plan.input.type === "modpack" ? 4 : 2) * 1024 ** 3)
            throw error(
              400,
              `This installation exceeds the ${plan.input.type === "modpack" ? 4 : 2} GB total size limit.`,
            );
          file.sha512 = await fileHash(file.stagedPath);
        }
        controller.signal.throwIfAborted();
        await promote(plan, job);
        outcome = {
          status: "completed",
          message: `${plan.title} installed. Replaced files remain recoverable in Recycle Bin.`,
        };
      } catch (cause) {
        outcome = {
          status: "failed",
          error: cause.message,
          message: cause.message,
        };
      } finally {
        job.message = "Finishing installation cleanup…";
        try {
          await fs.rm(await privatePath(plan.id), {
            recursive: true,
            force: true,
          });
        } catch {
          // A leftover private stage must not keep the completed job active.
        }
        active = null;
        activeController = null;
        Object.assign(job, outcome, { finishedAt: new Date().toISOString() });
      }
    })();
    preparingInstall = false;
    return { job: { ...job } };
  }
  return {
    config,
    async settings(input) {
      const value = input?.curseforgeApiKey;
      if (
        typeof value !== "string" ||
        value.length > 500 ||
        /[\r\n\0]/.test(value)
      )
        throw error(
          400,
          "Enter a valid CurseForge API key, or leave it empty to remove the saved key.",
        );
      if (!ctx.platformConfig?.set)
        throw error(400, "Provider key storage is unavailable.");
      await ctx.platformConfig.set({ curseforgeApiKey: value.trim() || null });
      return config();
    },
    async search(input) {
      input = selection(input);
      const found = await provider(input.platform);
      if (!found.types.includes(input.type))
        throw error(400, "This provider does not support this content type.");
      if (
        input.sort !== undefined &&
        input.sort !== "" &&
        (typeof input.sort !== "string" ||
          !sorts.has(input.sort) ||
          !found.sortOptions?.some((option) => option.id === input.sort))
      )
        throw error(400, "Choose a sort order supported by this provider.");
      input.sort ||= undefined;
      return found.search(input);
    },
    async versions(input) {
      input = selection(input);
      return {
        versions: (await (await provider(input.platform)).versions(input)).map(
          publicVersion,
        ),
      };
    },
    installed,
    preview,
    install,
    job(id) {
      if (!jobs.has(id))
        throw error(
          404,
          "This Launchpad job was not found for the selected server.",
        );
      return { job: { ...jobs.get(id) } };
    },
    async close() {
      closing = true;
      const stopped = error(
        503,
        "Launchpad closed before installation finished. No pending downloads will be installed.",
      );
      lifetime.abort(stopped);
      activeController?.abort(stopped);
      await Promise.allSettled([...previews]);
      await active;
      for (const [id] of plans)
        await fs
          .rm(await privatePath(id), { recursive: true, force: true })
          .catch(() => {});
      plans.clear();
    },
  };
}
