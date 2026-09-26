import { terminalJobs } from "./terminal-jobs.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createCoreProviders } from "./launchpad-providers.mjs";
import { safeInstallPath, unpackProviderZip } from "./launchpad-archives.mjs";
import { inspectBundledDependencies } from "./launchpad-bundled.mjs";
import { installedDependencySatisfies } from "./launchpad-dependency-ranges.mjs";
import { createModRemoval } from "./launchpad-removal.mjs";
import { createLaunchpadMetadataCache } from "./launchpad-metadata-cache.mjs";
import { createVersionsService } from "./versions.mjs";
import { cleanInstall, prepareCleanSettings } from "./clean-install.mjs";
import { inferPackRuntime } from "./launchpad-pack-runtime.mjs";
import {
  projectPageUrl,
  safeProjectUrl as projectUrl,
} from "../shared/launchpad-project.mjs";
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
const enabled = (value) => value === true || value === "true";
const fileStamp = (stat) =>
  [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.birthtimeMs,
  ].join(":");
function abortable(work, signal) {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}
async function parallel(items, count, work, signal) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, async () => {
      while (next < items.length && !signal?.aborted) {
        const index = next++;
        await work(items[index], index);
      }
    }),
  );
}
function requestLimiter(limit) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      entry.signal?.removeEventListener("abort", entry.cancel);
      if (entry.signal?.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      active++;
      Promise.resolve()
        .then(entry.work)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  };
  return (work, signal) =>
    new Promise((resolve, reject) => {
      const entry = { work, signal, resolve, reject, cancel: null };
      entry.cancel = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", entry.cancel, { once: true });
      queue.push(entry);
      drain();
    });
}
async function statOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (cause) {
    if (missing(cause)) return null;
    throw cause;
  }
}
async function fileHash(
  target,
  algorithm = "sha512",
  signal,
  maximum = 512 * 1024 ** 2,
) {
  signal?.throwIfAborted();
  const before = await fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum)
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
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
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
  const runtimeVersions =
    ctx.versionsService ?? createVersionsService(ctx.versionsOptions);
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
    ...createCoreProviders({
      fetch: request,
      recoveryFetch: rawRequest,
      lifetimeSignal: lifetime.signal,
      key,
    }),
    ...(ctx.extraProviders ?? []),
  ];
  // Fleet onboarding can browse every provider before any server exists.
  // A catalog-only instance never creates staging folders or reads receipts.
  const privateRoot = ctx.catalogOnly
    ? null
    : await safePath(dataDir, "launchpad");
  if (privateRoot) await fs.mkdir(privateRoot, { recursive: true });
  const rootIdentity = privateRoot ? await fs.realpath(privateRoot) : null;
  const privatePath = async (relative) => {
    if (ctx.catalogOnly)
      throw error(400, "Choose a server before managing installed content.");
    const root = await safePath(dataDir, "launchpad");
    if ((await fs.realpath(root)) !== rootIdentity)
      throw error(
        409,
        "Launchpad storage changed. Restart the panel before continuing.",
      );
    return safePath(root, relative);
  };
  const metadataCache = ctx.catalogOnly
    ? null
    : await createLaunchpadMetadataCache({
        pathFor: privatePath,
        platforms: providers.map((provider) => provider.id),
      });
  let receipts = [];
  try {
    const saved = ctx.catalogOnly
      ? []
      : JSON.parse(
          await fs.readFile(await privatePath("installed.json"), "utf8"),
        );
    if (Array.isArray(saved)) receipts = saved;
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
  let receiptGeneration = 0,
    receiptWrites = Promise.resolve();
  const replaceReceipts = (value) => {
    receipts = value;
    receiptGeneration++;
  };
  const saveReceipts = () => {
    // Capture at enqueue time and serialize atomic replacements so a slow
    // earlier scan cannot overwrite a later installation or rollback.
    const content = JSON.stringify(receipts);
    receiptWrites = receiptWrites
      .catch(() => {})
      .then(async () => {
        const temporary = await privatePath(`${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, content, { flag: "wx" });
          await fs.rename(temporary, await privatePath("installed.json"));
        } finally {
          await fs.rm(temporary, { force: true });
        }
      });
    return receiptWrites;
  };
  const plans = new Map();
  const noOpReviews = new Map();
  const jobs = new Map();
  const previews = new Set();
  // These caches accelerate display only. Preview and installation still hash
  // destination bytes afresh before allowing any replacement.
  const fileCache = new Map(),
    hashFlights = new Map(),
    identities = new Map();
  const updateCache = new Map(),
    updateFlights = new Map(),
    updateFailures = new Map();
  const versionCache = new Map(),
    versionFlights = new Map();
  const fallbackRequest = requestLimiter(6);
  const hashRequest = requestLimiter(4);
  const inventoryFlights = new Map();
  const remember = (cache, key, value) => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > 4000) cache.delete(cache.keys().next().value);
  };
  const identityFields = (item) =>
    Object.fromEntries(
      [
        "platform",
        "projectId",
        "versionId",
        "versionName",
        "title",
        "iconUrl",
        "author",
        "url",
      ]
        .filter((key) => item[key] !== undefined)
        .map((key) => [key, item[key]]),
    );
  const updateKey = (input, item) =>
    JSON.stringify([
      input.type,
      input.type === "modpack" ? "" : input.gameVersion,
      input.type === "modpack" ? "" : input.loader,
      item.platform,
      item.projectId,
      item.versionId,
      item.sha512,
    ]);
  let active = null,
    activeController = null,
    preparingInstall = false,
    lastJob = null,
    closing = false,
    versionsCache = null,
    versionsCachedAt = 0;
  const terminal = ctx.catalogOnly
    ? null
    : await terminalJobs(await privatePath("last-job.json"));
  if (terminal?.get()) {
    const job = { ...terminal.get(), retryable: false };
    jobs.set(job.id, job);
    lastJob = job.id;
  }
  const backgroundChecks = new Map();
  const publicJob = (job) => ({
    ...job,
    ...(job?.retryable
      ? {
          retryable: Boolean(
            plans.has(job.planId) && Date.parse(job.expiresAt) > Date.now(),
          ),
        }
      : {}),
  });
  let reportedBusy = false;
  const notifyBusy = () => {
    const busy = Boolean(active || preparingInstall || removal.busy);
    if (busy !== reportedBusy) {
      reportedBusy = busy;
      ctx.onBusyChange?.(busy);
    }
  };
  const removal = createModRemoval({
    serverDir,
    safePath,
    fileHash,
    fileStamp,
    getServer,
    recycle,
    restore,
    withMinecraftMutation,
    signal: lifetime.signal,
    isBusy: () => Boolean(active || preparingInstall),
    onBusyChange: notifyBusy,
    async onRemoved(relative, type) {
      const previous = receipts;
      replaceReceipts(receipts.filter((item) => item.path !== relative));
      try {
        await saveReceipts();
      } catch (cause) {
        replaceReceipts(previous);
        throw cause;
      }
      backgroundChecks.clear();
      const removedHash =
        fileCache.get(relative)?.sha512 ??
        previous.find((item) => item.path === relative)?.sha512;
      fileCache.delete(relative);
      if (removedHash)
        for (const [key] of updateCache)
          if (JSON.parse(key).at(-1) === removedHash) updateCache.delete(key);
      try {
        await ctx.audit?.(
          `${{ mod: "Mod", plugin: "Plugin", datapack: "Datapack" }[type]} deleted`,
          `${relative} moved to Recycle Bin.`,
        );
      } catch {
        // Audit storage failure must not undo a completed, recoverable removal.
      }
    },
  });
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
      signal:
        input.signal instanceof AbortSignal
          ? AbortSignal.any([lifetime.signal, input.signal])
          : lifetime.signal,
      gameVersion,
      loader,
      query,
      offset: Math.floor(offset),
      limit: Math.floor(limit),
    };
  }
  async function assertCompatibility(input) {
    const current = await getServer();
    if (input.type === "modpack") return current;
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
  async function resolvePackRuntime(required, input) {
    if (!required?.loader || !required?.gameVersion || !required?.loaderVersion)
      throw error(
        400,
        "This pack does not declare an exact server runtime. Choose a pack release with complete loader metadata.",
      );
    if (
      required.loader !== input.loader ||
      required.gameVersion !== input.gameVersion
    )
      throw error(
        400,
        "The pack runtime does not match the selected Minecraft version and loader.",
      );
    const listing = await runtimeVersions.builds(
      required.loader,
      required.gameVersion,
    );
    const build = listing.builds.find(
      (item) =>
        item.id === required.loaderVersion ||
        item.id === `${required.gameVersion}-${required.loaderVersion}`,
    );
    if (!build)
      throw error(
        400,
        "The pack's required loader build is unavailable from its official catalog. No server files were changed.",
      );
    return {
      provider: required.loader,
      version: required.gameVersion,
      build: build.id,
      software: listing.provider?.name ?? required.loader,
    };
  }
  async function destination(type) {
    if (type === "mod") return "mods";
    if (type === "plugin") return "plugins";
    if (type === "datapack")
      return `${safeInstallPath((await getServer()).world || "world")}/datapacks`;
    return "";
  }
  async function protectedPackPath(name) {
    const lower = name.toLowerCase();
    const startupFiles = [
      "user_jvm_args.txt",
      "run.bat",
      "run.cmd",
      "run.sh",
      "start.bat",
      "start.cmd",
      "start.sh",
      "server.jar",
      "fabric-server-launcher.properties",
      "quilt-server-launcher.properties",
    ]
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    if (startupFiles.includes(lower) || lower.startsWith("libraries/"))
      return true;
    return lower === "eula.txt";
  }
  async function scan(
    type,
    signal = lifetime.signal,
    warnings = [],
    isolated = false,
    quick = false,
  ) {
    signal.throwIfAborted();
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
    const rows = new Array(files.length),
      confirmedFiles = new Set(),
      receiptIndex = new Map();
    for (const receipt of receipts) {
      const key = `${receipt.path}\0${receipt.sha512}`;
      if (!receiptIndex.has(key)) receiptIndex.set(key, receipt);
    }
    await parallel(
      files,
      4,
      async (file, index) => {
        signal.throwIfAborted();
        let relativePath = `${relative}/${file.name}`;
        let target, stat, sha512;
        try {
          relativePath = `${relative}/${safeInstallPath(file.name)}`;
          target = await safePath(serverDir, relativePath);
          stat = await fs.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink()) return;
          confirmedFiles.add(relativePath);
          const stamp = fileStamp(stat);
          const cached = fileCache.get(relativePath);
          if (cached?.stamp === stamp) sha512 = cached.sha512;
          else if (quick) {
            // Filename-only display may precede verification, but never reuse a
            // receipt or identity for bytes whose current stamp has not been hashed.
            fileCache.delete(relativePath);
          } else if (isolated) {
            sha512 = await fileHash(target, "sha512", signal);
            signal.throwIfAborted();
            if (fileStamp(await fs.lstat(target)) !== stamp)
              throw error(
                409,
                `${file.name} changed while it was being checked. Refresh and try again.`,
              );
            remember(fileCache, relativePath, { stamp, sha512 });
          } else {
            const flightKey = `${relativePath}:${stamp}`;
            let task = hashFlights.get(flightKey);
            if (!task) {
              task = hashRequest(
                () => fileHash(target, "sha512", lifetime.signal),
                lifetime.signal,
              ).then(async (hash) => {
                if (fileStamp(await fs.lstat(target)) !== stamp)
                  throw error(
                    409,
                    `${file.name} changed while it was being checked. Refresh and try again.`,
                  );
                remember(fileCache, relativePath, { stamp, sha512: hash });
                return hash;
              });
              hashFlights.set(flightKey, task);
              void task.then(
                () => hashFlights.delete(flightKey),
                () => hashFlights.delete(flightKey),
              );
            }
            sha512 = await abortable(task, signal);
          }
        } catch (cause) {
          signal.throwIfAborted();
          // A just-updated/deleted JAR can disappear between readdir and stat.
          if (missing(cause)) return;
          fileCache.delete(relativePath);
          warnings.push(`${file.name} could not be read: ${cause.message}`);
          rows[index] = {
            path: relativePath,
            name: file.name,
            size: stat?.size ?? 0,
            platform: null,
          };
          return;
        }
        const receipt = sha512
          ? receiptIndex.get(`${relativePath}\0${sha512}`)
          : undefined;
        const known =
          identities.get(sha512)?.value ??
          // A later explicit installation may choose another provider for the
          // same bytes. Persisted inferred metadata cannot replace its receipt.
          (sha512 &&
          !(receipt?.platform && receipt.projectId && receipt.versionId)
            ? metadataCache?.identity(sha512)
            : undefined);
        rows[index] = {
          path: relativePath,
          name: file.name,
          size: stat.size,
          sha512,
          platform: null,
          ...Object.fromEntries(
            Object.entries(receipt ?? {}).filter(([, value]) => value != null),
          ),
          ...(known?.platform ? known : {}),
        };
      },
      signal,
    );
    signal.throwIfAborted();
    // Restore previews are bounded, read-only checks; leave receipt cleanup to
    // the regular inventory rather than starting a save after their deadline.
    if (!isolated) await pruneReceipts(confirmedFiles);
    return rows.filter(Boolean);
  }
  async function pruneReceipts(confirmedFiles = new Set()) {
    const mutating = () =>
      closing ||
      active ||
      preparingInstall ||
      removal.busy ||
      ctx.isContentMutationActive?.();
    if (mutating()) return;
    const snapshot = receipts,
      generation = receiptGeneration,
      retained = [];
    for (const item of snapshot) {
      if (item.pack || confirmedFiles.has(item.path)) {
        retained.push(item);
        continue;
      }
      try {
        if ((await fs.lstat(await safePath(serverDir, item.path))).isFile())
          retained.push(item);
      } catch (cause) {
        if (!missing(cause)) retained.push(item);
      }
    }
    // A transaction can start and finish while lstat awaits. Checking only the
    // current busy flag misses that schedule; the generation protects it too.
    if (mutating() || generation !== receiptGeneration || snapshot !== receipts)
      return;
    if (retained.length !== snapshot.length) {
      replaceReceipts(retained);
      const savedGeneration = receiptGeneration;
      try {
        await saveReceipts();
      } catch (cause) {
        if (receiptGeneration === savedGeneration) replaceReceipts(snapshot);
        throw cause;
      }
    }
  }
  async function enrichProjectMetadata(
    items,
    warnings,
    signal = lifetime.signal,
    urlField = "url",
    cacheGeneration = metadataCache?.generation,
  ) {
    const apply = (item, project) => {
      if (typeof project?.title === "string" && project.title.trim())
        item.title = project.title;
      if (project?.iconUrl) item.iconUrl = project.iconUrl;
      if (projectUrl(project?.url)) item[urlField] = projectUrl(project.url);
      if (typeof project?.author === "string" && project.author.trim())
        item.author = project.author;
    };
    for (const item of items) {
      const url = projectPageUrl({ ...item, url: item[urlField] });
      if (url) item[urlField] = url;
    }
    await Promise.all(
      providers.map(async (found) => {
        if (!found.projectMetadata) return;
        const known = items
          .filter((item) => item.platform === found.id && item.projectId)
          .filter((item) => {
            const cached = metadataCache?.project(
              found.id,
              String(item.projectId),
            );
            if (cached) apply(item, cached.value);
            return (
              !cached?.checkedAt || cached.checkedAt + 10 * 60_000 <= Date.now()
            );
          });
        if (!known.length) return;
        try {
          const result = await abortable(
            found.projectMetadata(known.map((item) => item.projectId)),
            signal,
          );
          signal.throwIfAborted();
          const projects = new Map(
            result.projects.map((project) => [String(project.id), project]),
          );
          for (const item of known) {
            const project = projects.get(String(item.projectId));
            apply(item, project);
            if (project)
              metadataCache?.rememberProject(
                found.id,
                String(item.projectId),
                project,
                // A partial metadata failure must remain eligible for the
                // provider's retry policy (for example a missing team author).
                result.warnings.length ? 0 : Date.now(),
                cacheGeneration,
              );
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
  async function checkUpdates(input, items, warnings) {
    if (input.type !== "modpack" && (!input.gameVersion || !input.loader)) {
      warnings.push(
        "Choose this server's Minecraft version and loader above to check for updates.",
      );
      return;
    }
    const cooldownFor = (found, item) => {
      const provider = updateFailures.get(found.id);
      return provider?.until > Date.now()
        ? provider
        : updateFailures.get(`${found.id}:${item?.projectId}`);
    };
    const cooldownMessage = (cooldown) =>
      `${cooldown.message} Retry in ${Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000))} seconds.`;
    const fail = (found, cause, item) => {
      if (cause.cachedUpdateFailure) {
        warnings.push(cause.message);
        return;
      }
      const message = `${found.name} update checks: ${cause.message}`;
      warnings.push(message);
      if (
        cause.status !== 404 &&
        !input.signal?.aborted &&
        !["AbortError", "TimeoutError"].includes(cause.name) &&
        (cause.status === 429 || item)
      )
        updateFailures.set(
          cause.status === 429 ? found.id : `${found.id}:${item.projectId}`,
          {
            message,
            until: Date.now() + (cause.status === 429 ? 60_000 : 30_000),
          },
        );
    };
    const apply = (item, value) => {
      if (value) item.update = value;
      else delete item.update;
      item.updateCheck = "checked";
      delete item.updateIssue;
    };
    await Promise.all(
      providers.map(async (found) => {
        const known = items.filter(
          (item) => item.platform === found.id && item.projectId,
        );
        if (!known.length) return;
        if (enabled(input.refresh)) {
          for (const key of updateFailures.keys())
            if (key.startsWith(`${found.id}:`)) updateFailures.delete(key);
        }
        const pending = [],
          missing = [];
        for (const item of known) {
          const key = updateKey(input, item),
            cached = updateCache.get(key);
          if (cached?.value) item.update = cached.value;
          if (!enabled(input.refresh) && cached?.expiresAt > Date.now())
            apply(item, cached.value);
          else {
            item.updateCheck = "pending";
            if (updateFlights.has(key))
              pending.push({ item, work: updateFlights.get(key) });
            else missing.push(item);
          }
        }
        const cooldown = updateFailures.get(found.id);
        if (cooldown?.until > Date.now()) {
          if (missing.length) warnings.push(cooldownMessage(cooldown));
          for (const item of missing) {
            item.updateIssue = cooldownMessage(cooldown);
            item.updateCheck = "unavailable";
          }
        } else if (
          missing.length &&
          found.updates &&
          input.type !== "modpack"
        ) {
          const work = (async () => {
            try {
              const result = await abortable(
                found.updates(input, missing),
                input.signal,
              );
              warnings.push(...(result.warnings ?? []));
              const checked = new Map();
              for (const item of missing) {
                if (!Object.hasOwn(result.updates, item.sha512)) continue;
                const value = result.updates[item.sha512];
                const key = updateKey(input, item);
                const normalized = value ? publicVersion(value) : null;
                remember(updateCache, key, {
                  value: normalized,
                  expiresAt: Date.now() + 5 * 60_000,
                });
                checked.set(key, normalized);
              }
              return {
                checked,
                issues: result.issues,
                issue: result.warnings?.join(" "),
              };
            } catch (cause) {
              fail(found, cause);
              return { issue: cause.message };
            }
          })();
          for (const item of missing) {
            const key = updateKey(input, item);
            const value = work.then((result) =>
              result.checked?.has(key)
                ? { value: result.checked.get(key) }
                : { issue: result.issues?.[item.sha512] ?? result.issue },
            );
            updateFlights.set(key, value);
            void value.then(
              () => updateFlights.delete(key),
              () => updateFlights.delete(key),
            );
            pending.push({ item, work: value });
          }
        } else {
          await parallel(
            missing,
            6,
            async (item) => {
              const cooldown = cooldownFor(found, item);
              if (cooldown?.until > Date.now()) {
                warnings.push(cooldownMessage(cooldown));
                item.updateIssue = cooldownMessage(cooldown);
                item.updateCheck = "unavailable";
                return;
              }
              const key = updateKey(input, item);
              let work = updateFlights.get(key);
              if (!work) {
                work = (async () => {
                  try {
                    const versionKey = JSON.stringify([
                      found.id,
                      input.type,
                      input.gameVersion,
                      input.loader,
                      item.projectId,
                    ]);
                    let cached = versionCache.get(versionKey);
                    if (
                      enabled(input.refresh) ||
                      !(cached?.expiresAt > Date.now())
                    ) {
                      let versionWork = versionFlights.get(versionKey);
                      if (!versionWork) {
                        versionWork = fallbackRequest(() => {
                          const cooldown = cooldownFor(found, item);
                          if (cooldown?.until > Date.now())
                            throw Object.assign(
                              new Error(cooldownMessage(cooldown)),
                              {
                                cachedUpdateFailure: true,
                              },
                            );
                          const signal = AbortSignal.any([
                            input.signal,
                            AbortSignal.timeout(8000),
                          ]);
                          return abortable(
                            found.versions({
                              ...input,
                              projectId: item.projectId,
                              signal,
                            }),
                            signal,
                          );
                        }, input.signal).then((versions) => {
                          const entry = {
                            versions,
                            expiresAt: Date.now() + 5 * 60_000,
                          };
                          remember(versionCache, versionKey, entry);
                          return entry;
                        });
                        versionFlights.set(versionKey, versionWork);
                        void versionWork.then(
                          () => versionFlights.delete(versionKey),
                          () => versionFlights.delete(versionKey),
                        );
                      }
                      cached = await abortable(versionWork, input.signal);
                    }
                    const versions = cached.versions
                      .filter((value) => value.downloadable !== false)
                      .sort((a, b) =>
                        (b.publishedAt ?? "").localeCompare(
                          a.publishedAt ?? "",
                        ),
                      );
                    let current = cached.versions.find(
                      (value) => String(value.id) === item.versionId,
                    );
                    const newest = versions[0];
                    if (!current && found.installedVersion) {
                      const installedKey = JSON.stringify([
                        found.id,
                        "installed",
                        item.projectId,
                        item.versionId,
                      ]);
                      let installed = versionCache.get(installedKey);
                      if (!(installed?.expiresAt > Date.now())) {
                        const signal = AbortSignal.any([
                          input.signal,
                          AbortSignal.timeout(8000),
                        ]);
                        installed = {
                          value: await fallbackRequest(
                            () =>
                              abortable(
                                found.installedVersion({
                                  ...input,
                                  projectId: item.projectId,
                                  versionId: item.versionId,
                                  signal,
                                }),
                                signal,
                              ),
                            signal,
                          ),
                          expiresAt: Date.now() + 5 * 60_000,
                        };
                        remember(versionCache, installedKey, installed);
                      }
                      current = installed.value;
                    }
                    if (!newest || !current)
                      throw error(
                        404,
                        !newest
                          ? "No compatible downloadable releases were returned. Update status could not be checked."
                          : "The installed release was not found in the compatible catalog. Update status could not be checked.",
                      );
                    const latestDate = Date.parse(newest.publishedAt),
                      currentDate = Date.parse(current.publishedAt);
                    if (
                      String(newest.id) !== item.versionId &&
                      (!Number.isFinite(latestDate) ||
                        !Number.isFinite(currentDate))
                    )
                      throw error(
                        409,
                        "The release dates could not be verified. Update status could not be checked.",
                      );
                    const value =
                      String(newest.id) !== item.versionId &&
                      latestDate > currentDate
                        ? publicVersion(newest)
                        : null;
                    remember(updateCache, key, {
                      value,
                      expiresAt: Date.now() + 5 * 60_000,
                    });
                    return { value };
                  } catch (cause) {
                    fail(found, cause, item);
                    return { issue: cause.message };
                  }
                })();
                updateFlights.set(key, work);
                void work.then(
                  () => updateFlights.delete(key),
                  () => updateFlights.delete(key),
                );
              }
              pending.push({ item, work });
              const result = await work;
              if (result && Object.hasOwn(result, "value"))
                apply(item, result.value);
              else {
                item.updateCheck = "unavailable";
                if (result?.issue) item.updateIssue = result.issue;
              }
            },
            input.signal,
          );
        }
        await Promise.all(
          pending.map(async ({ item, work }) => {
            const result = await abortable(work, input.signal);
            if (result && Object.hasOwn(result, "value"))
              apply(item, result.value);
            else {
              item.updateCheck = "unavailable";
              if (result?.issue) item.updateIssue = result.issue;
            }
          }),
        );
      }),
    );
    input.signal.throwIfAborted();
  }
  function markDuplicates(items) {
    for (const item of items) delete item.duplicates;
    const groups = new Map();
    for (const item of items)
      if (item.platform && item.projectId) {
        const key = `${item.platform}:${item.projectId}`;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
    for (const group of groups.values())
      if (group.length > 1)
        for (const item of group)
          item.duplicates = group
            .filter((other) => other !== item)
            .map((other) => other.path);
  }
  async function installed(input) {
    input = selection(input);
    const cacheGeneration = metadataCache?.generation;
    const scope = JSON.stringify([input.type, input.gameVersion, input.loader]);
    const existingCheck = backgroundChecks.get(scope);
    if (
      !enabled(input.local) &&
      !input.identityOnly &&
      existingCheck &&
      !existingCheck.done
    ) {
      return structuredClone({
        items: existingCheck.items,
        warnings: [...new Set(existingCheck.warnings)],
        checkingUpdates: !existingCheck.done,
        progress: {
          completed: existingCheck.items.filter(
            (item) => item.updateCheck !== "pending",
          ).length,
          total: existingCheck.items.length,
        },
      });
    }
    const completedCheck =
      !enabled(input.local) && !input.identityOnly && existingCheck?.done
        ? existingCheck
        : null;
    if (completedCheck) backgroundChecks.delete(scope);
    const scanWarnings = [];
    const items =
      input.type === "modpack"
        ? receipts
            .filter((item) => item.type === "modpack" && item.pack)
            .map((item) => ({ ...item, name: item.title }))
        : await scan(
            input.type,
            input.signal,
            scanWarnings,
            false,
            enabled(input.local) && enabled(input.quick),
          );
    for (const item of items) {
      const url = projectPageUrl(item);
      if (url) item.url = url;
      const cached = updateCache.get(updateKey(input, item));
      // Keep the last verified update visible if the provider is temporarily
      // unavailable. Its expiry controls rechecking, not erasing known updates.
      if (cached?.value) item.update = cached.value;
      item.updateCheck =
        !enabled(input.refresh) && cached?.expiresAt > Date.now()
          ? "checked"
          : "pending";
    }
    markDuplicates(items);
    if (enabled(input.local)) return { items, warnings: scanWarnings };
    if (completedCheck && !enabled(input.refresh)) {
      const previous = new Map(
        completedCheck.items.map((item) => [item.path, item]),
      );
      // The provider result only describes the files that existed when it began.
      // Reuse it only after a fresh scan verifies the same paths and checksums.
      if (
        items.every(
          (item) =>
            item.sha512 && previous.get(item.path)?.sha512 === item.sha512,
        )
      ) {
        for (const item of items) {
          const checked = previous.get(item.path);
          Object.assign(item, identityFields(checked), {
            updateCheck: checked.updateCheck,
          });
          if (checked.update) item.update = checked.update;
          else delete item.update;
          if (checked.updateIssue) item.updateIssue = checked.updateIssue;
        }
        markDuplicates(items);
        return structuredClone({
          items,
          warnings: [...new Set([...scanWarnings, ...completedCheck.warnings])],
          checkingUpdates: false,
          progress: { completed: items.length, total: items.length },
        });
      }
    }
    const flightKey = JSON.stringify([
      cacheGeneration,
      input.type,
      input.gameVersion,
      input.loader,
      enabled(input.refresh),
      Boolean(input.identityOnly),
      items.map((item) => [
        item.path,
        item.sha512,
        item.platform,
        item.projectId,
        item.versionId,
      ]),
    ]);
    let task = inventoryFlights.get(flightKey);
    if (!task) {
      task = (async () => {
        const warnings = [...scanWarnings];
        const signal = AbortSignal.any([
          lifetime.signal,
          // GET recovery may span a provider rate-limit window. Local results
          // are already visible, and polling joins this bounded background job.
          AbortSignal.timeout(90000),
        ]);
        try {
          await installedDetails(
            { ...input, signal },
            items,
            warnings,
            cacheGeneration,
          );
        } catch (cause) {
          warnings.push(
            signal.aborted
              ? "Some mod details or update checks took too long. Your installed files are still shown. Refresh to retry."
              : cause.message,
          );
        }
        const identityWarnings = [
          ...new Set(
            warnings.filter((message) => /identification:/i.test(message)),
          ),
        ];
        for (const item of items) {
          if (item.updateCheck !== "checked") item.updateCheck = "unavailable";
          if (!item.sha512) continue;
          if (item.platform)
            metadataCache?.rememberIdentity(
              item.sha512,
              identityFields(item),
              cacheGeneration,
            );
          const previous = identities.get(item.sha512);
          // Polling an unchanged negative result must not renew its retry
          // deadline forever while a provider recovers in the background.
          if (!item.platform && previous?.expiresAt > Date.now()) continue;
          if (item.platform || (!previous?.value?.platform && !signal.aborted))
            remember(identities, item.sha512, {
              value: identityFields(item),
              expiresAt:
                Date.now() +
                (item.platform
                  ? 10 * 60_000
                  : identityWarnings.length
                    ? 30_000
                    : 60_000),
              warnings: !item.platform ? identityWarnings : undefined,
            });
        }
        markDuplicates(items);
        return { items, warnings: [...new Set(warnings)] };
      })();
      inventoryFlights.set(flightKey, task);
      void task.then(
        () => inventoryFlights.delete(flightKey),
        () => inventoryFlights.delete(flightKey),
      );
    }
    if (enabled(input.background)) {
      const entry = { items, warnings: scanWarnings, done: false, task };
      backgroundChecks.set(scope, entry);
      void task.then(
        (result) => {
          entry.items = result.items;
          entry.warnings = result.warnings;
          entry.done = true;
        },
        (cause) => {
          for (const item of entry.items)
            if (item.updateCheck === "pending")
              item.updateCheck = "unavailable";
          entry.warnings = [
            ...entry.warnings,
            cause?.message ||
              "The update check could not finish. Refresh to retry.",
          ];
          entry.done = true;
        },
      );
      return structuredClone({
        items,
        warnings: scanWarnings,
        checkingUpdates: true,
        progress: { completed: 0, total: items.length },
      });
    }
    return structuredClone(await abortable(task, input.signal));
  }
  async function installedDetails(
    input,
    items,
    warnings,
    cacheGeneration = metadataCache?.generation,
  ) {
    if (input.type === "modpack") {
      await Promise.all([
        enrichProjectMetadata(
          items,
          warnings,
          input.signal,
          "url",
          cacheGeneration,
        ),
        ...(input.identityOnly
          ? []
          : [
              checkUpdates(
                { ...input, gameVersion: "", loader: "" },
                items,
                warnings,
              ),
            ]),
      ]);
      input.signal.throwIfAborted();
      for (const item of items) item.name = item.title;
      return;
    }
    const unknown = items.filter(
      (item) =>
        item.sha512 &&
        !item.platform &&
        !(identities.get(item.sha512)?.expiresAt > Date.now()),
    );
    for (const item of items) {
      const cached = identities.get(item.sha512);
      if (cached?.expiresAt > Date.now() && cached.warnings)
        warnings.push(...cached.warnings);
    }
    const modrinth = providers.find((value) => value.id === "modrinth");
    if (unknown.length) {
      try {
        const result = await abortable(
          (modrinth.identifyInstalled ?? modrinth.identify)(
            [...new Set(unknown.map((item) => item.sha512))],
            { signal: input.signal },
          ),
          input.signal,
        );
        const matches = modrinth.identifyInstalled ? result.matches : result;
        if (modrinth.identifyInstalled)
          warnings.push(
            ...(result.warnings ?? []).map(
              (warning) => `Modrinth identification: ${warning}`,
            ),
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
        input.signal.throwIfAborted();
        warnings.push(`Modrinth identification: ${cause.message}`);
      }
    }
    input.signal.throwIfAborted();
    if (await key()) {
      const candidates = items.filter(
        (item) =>
          unknown.includes(item) &&
          !item.platform &&
          item.size <= 128 * 1024 ** 2,
      );
      if (candidates.length) {
        try {
          const fingerprints = new Map();
          for (const item of candidates) {
            input.signal.throwIfAborted();
            const target = await safePath(serverDir, item.path);
            const stamp = fileStamp(await fs.lstat(target));
            const cached = fileCache.get(item.path);
            if (
              cached?.stamp === stamp &&
              cached.sha512 === item.sha512 &&
              cached.sha1 &&
              cached.fingerprint !== undefined
            ) {
              fingerprints.set(item, {
                fingerprint: cached.fingerprint,
                sha1: cached.sha1,
              });
              continue;
            }
            const bytes = await fs.readFile(target, { signal: input.signal });
            input.signal.throwIfAborted();
            if (
              createHash("sha512").update(bytes).digest("hex") !==
                item.sha512 ||
              fileStamp(await fs.lstat(target)) !== stamp
            )
              throw error(
                409,
                `${item.name} changed while checking its identity.`,
              );
            const digest = {
              fingerprint: curseFingerprint(bytes),
              sha1: createHash("sha1").update(bytes).digest("hex"),
            };
            fingerprints.set(item, digest);
            remember(fileCache, item.path, {
              stamp,
              sha512: item.sha512,
              ...digest,
            });
          }
          const result = await abortable(
            providers
              .find((value) => value.id === "curseforge")
              .identifyFingerprints(
                [...fingerprints.values()].map((value) => value.fingerprint),
                { signal: input.signal },
              ),
            input.signal,
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
          input.signal.throwIfAborted();
          warnings.push(`CurseForge identification: ${cause.message}`);
        }
      }
    }
    input.signal.throwIfAborted();
    if (input.identityOnly) return;
    // Names and icons belong to the project, even with All loaders/versions.
    // Failed metadata requests must not suppress identification or updates.
    await Promise.all([
      enrichProjectMetadata(
        items,
        warnings,
        input.signal,
        "url",
        cacheGeneration,
      ),
      checkUpdates(input, items, warnings),
    ]);
    input.signal.throwIfAborted();
  }
  async function config(input = {}) {
    const current = await getServer();
    const warnings = [];
    if (
      !versionsCache ||
      Date.now() - versionsCachedAt > 3_600_000 ||
      enabled(input.refresh)
    ) {
      try {
        versionsCache = await providers[0].gameVersions();
        versionsCachedAt = Date.now();
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
      job:
        lastJob && terminal?.visible(jobs.get(lastJob))
          ? publicJob(jobs.get(lastJob))
          : null,
    };
  }
  async function resolveTree(input, stage, local) {
    const files = [],
      warnings = [],
      unavailableDependencies = [],
      recoveredDependencies = new Set(),
      attempted = new Set(),
      visited = new Map(),
      preservedDependencies = new Set();
    let inspectedParents = 0,
      inspectionBytes = 0;
    let rootResult;
    async function preserveInstalled(found, value, parentFiles) {
      const matches = local.filter(
        (item) =>
          item.platform === value.platform &&
          item.projectId === value.projectId,
      );
      if (matches.length > 1)
        throw error(
          409,
          `Multiple installed files match this project: ${matches.map((item) => item.path).join(", ")}. Remove the duplicate before updating.`,
        );
      const existing = matches[0];
      const key = `${value.platform}:${value.projectId}`;
      if (
        !existing ||
        (existing.versionId === value.versionId &&
          !preservedDependencies.has(key))
      )
        return null;
      const fail = () =>
        error(
          409,
          `${existing.title || "The dependency"} is already installed, but its version could not be verified against this mod's requirements. Review the required dependency versions before installing.`,
        );
      if (
        !parentFiles ||
        parentFiles.length !== 1 ||
        !["forge", "neoforge"].includes(input.loader)
      )
        throw fail();
      const result = await found.resolve({
        ...value,
        stage,
        versionId: existing.versionId,
      });
      if (result.archive || result.files?.length !== 1) throw fail();
      const artifact = result.files[0],
        parent = parentFiles[0];
      const limit = 64 * 1024 ** 2;
      if (
        ![artifact, parent].every(
          (file) =>
            Number.isSafeInteger(file.size) &&
            file.size >= 0 &&
            file.size <= limit,
        )
      )
        throw fail();
      const handle = await fs.open(
        await safePath(serverDir, existing.path),
        "r",
      );
      let source;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== artifact.size) throw fail();
        const chunks = [];
        let size = 0;
        for await (const chunk of handle.createReadStream({
          autoClose: false,
        })) {
          input.signal?.throwIfAborted();
          if ((size += chunk.length) > artifact.size) throw fail();
          chunks.push(chunk);
        }
        source = Buffer.concat(chunks);
        const [algorithm, expectedHash] = strongestHash(artifact.hashes);
        if (
          fileStamp(before) !== fileStamp(await handle.stat()) ||
          source.length !== artifact.size ||
          createHash("sha512").update(source).digest("hex") !==
            existing.sha512 ||
          createHash(algorithm).update(source).digest("hex") !== expectedHash
        )
          throw error(
            409,
            `${existing.path} changed after identification. Refresh installed mods and review the update again.`,
          );
      } finally {
        await handle.close();
      }
      if (!parent.stagedPath) {
        if (
          ++inspectedParents > 16 ||
          (inspectionBytes += parent.size) > 128 * 1024 ** 2
        )
          throw fail();
        parent.stagedPath = path.join(
          stage,
          `compatibility-${inspectedParents}.jar`,
        );
        await downloadVerified(
          parent,
          parent.stagedPath,
          parent.hosts,
          request,
          { signal: input.signal },
        );
      }
      if (
        !(await verifyStaged(parent, stage, input.signal)) ||
        !(await installedDependencySatisfies(parent.stagedPath, source, {
          loader: input.loader,
          signal: input.signal,
        }))
      )
        throw fail();
      preservedDependencies.add(key);
      value.versionId = existing.versionId;
      // Keep the exact installed path, including locally renamed JARs. It must
      // pass the ordinary unchanged-byte and pre-promotion snapshot checks.
      return {
        ...result,
        files: [{ ...artifact, path: existing.path, preserveInstalled: true }],
      };
    }
    async function visit(
      value,
      depth = 0,
      requiredBy,
      parentFiles,
      parentKey = "",
    ) {
      // Different dependents must each prove their own range, even if they
      // repeat the same incorrect catalog pin. Deduplicate only the same edge.
      const attemptKey = `${parentKey}>${value.platform}:${value.projectId ?? ""}:${value.versionId ?? ""}`;
      if (attempted.has(attemptKey)) return;
      if (depth > 20 || attempted.size >= 100)
        throw error(
          400,
          "This dependency graph is too large to install automatically.",
        );
      // Missing projects count toward the budget too, before any network work.
      attempted.add(attemptKey);
      const found = await provider(value.platform);
      if (!found.types.includes(value.type))
        throw error(
          400,
          "This provider does not support the selected content type.",
        );
      let result;
      let recoveringDependency = false;
      try {
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
        if (
          visited.get(key) === String(value.versionId) &&
          !preservedDependencies.has(key)
        )
          return;
        try {
          result = await found.resolve({ ...value, stage });
        } catch (cause) {
          if (
            !depth ||
            cause.code !== "INCOMPATIBLE_VERSION" ||
            !found.compatibleDependencyVersion
          )
            throw cause;
          recoveringDependency = true;
          const compatible = await found.compatibleDependencyVersion(value);
          if (!compatible)
            throw error(
              400,
              `${cause.message} A matching release for this required dependency could not be verified. Choose another project version or correct the dependency before installing.`,
            );
          value.versionId = String(compatible.id);
          // Resolve the actual target-loader artifact and its dependencies.
          // The publisher's incorrect pin must never enter the install plan.
          result = await found.resolve({
            stage,
            ...value,
            expectedVersionNumber: compatible.version,
          });
          if (key !== `${input.platform}:${input.projectId}`)
            recoveredDependencies.add(key);
        }
        if (
          depth &&
          key !== `${input.platform}:${input.projectId}` &&
          (recoveringDependency || preservedDependencies.has(key))
        )
          result =
            (await preserveInstalled(found, value, parentFiles)) ?? result;
        if (visited.has(key)) {
          if (visited.get(key) !== String(value.versionId))
            throw error(
              409,
              "Required dependencies request conflicting versions of the same project. Resolve them manually before installing.",
            );
          return;
        }
        visited.set(key, String(value.versionId));
      } catch (cause) {
        if (cause.status !== 404) throw cause;
        const key = `${value.platform}:${value.projectId}`;
        if (visited.has(key) && visited.get(key) !== String(value.versionId))
          throw error(
            409,
            "Required dependencies request conflicting versions of the same project. Resolve them manually before installing.",
          );
        if (recoveringDependency || preservedDependencies.has(key))
          throw error(
            400,
            "A compatible release for a required dependency could not be verified. Choose another project version or correct the dependency before installing.",
          );
        if (!depth)
          throw error(
            404,
            `${found.name} could not find the selected project or version. Refresh its versions and choose another release.`,
          );
        // Missing catalog entries can be checked for bundled dependencies.
        // Known incompatible dependencies must be resolved or block the plan.
        unavailableDependencies.push({
          platform: value.platform,
          projectId: value.projectId,
          versionId: value.versionId,
          requiredBy,
        });
        return;
      }
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
      const nodeFiles = [];
      for (const file of result.files ?? []) {
        const target = safeInstallPath(
          file.path.includes("/") || !prefix
            ? file.path
            : `${prefix}/${file.path}`,
        );
        const planned = {
          ...file,
          path: target,
          platform: value.platform,
          projectId: value.projectId,
          versionId: String(value.versionId),
          versionName: result.versionName,
          title: result.title,
          iconUrl: result.iconUrl,
          author: result.author,
          projectUrl: projectUrl(result.url),
          type: value.type,
          hosts: found.downloadHosts,
        };
        files.push(planned);
        nodeFiles.push(planned);
      }
      for (const dependency of result.dependencies ?? [])
        await visit(
          {
            gameVersion: input.gameVersion,
            loader: input.loader,
            signal: input.signal,
            platform: value.platform,
            type: value.type,
            ...dependency,
          },
          depth + 1,
          result.title,
          nodeFiles,
          `${value.platform}:${value.projectId}:${value.versionId}`,
        );
    }
    await visit({ ...input });
    // Resolve optional project credits in batches for the whole plan, including
    // dependencies, so new receipts retain authors without per-file lookups.
    const rootMetadata = {
      ...rootResult,
      platform: input.platform,
      projectId: input.projectId,
    };
    await enrichProjectMetadata(
      [rootMetadata, ...files],
      warnings,
      input.signal,
      "projectUrl",
    );
    return {
      ...rootResult,
      author: rootMetadata.author,
      url: rootMetadata.projectUrl ?? projectUrl(rootResult.url),
      files,
      warnings,
      unavailableDependencies,
      recoveredDependencies,
    };
  }
  async function inspectUnavailableDependencies(result, input, stage) {
    result.bundledDependencies = [];
    if (input.type !== "mod" || !result.unavailableDependencies.length) return;
    const parents = new Set(
      result.unavailableDependencies.map((item) => item.requiredBy),
    );
    const bundles = [];
    let inspected = 0,
      total = 0;
    for (const [index, file] of result.files.entries()) {
      if (!parents.has(file.title) || !/\.jar$/i.test(file.path)) continue;
      if (
        ++inspected > 16 ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > 64 * 1024 ** 2 ||
        (total += file.size) > 128 * 1024 ** 2
      ) {
        result.warnings.push(
          `Bundled libraries in ${file.path} could not be checked within the inspection limits.`,
        );
        continue;
      }
      let source;
      if (file.installedPath) {
        // Read a bounded snapshot so inspection never follows bytes changed
        // after the checksum comparison, or needs to download an unchanged JAR.
        const handle = await fs.open(
          await safePath(serverDir, file.installedPath),
          "r",
        );
        const chunks = [];
        let size = 0;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== file.size)
            throw error(409, `${file.installedPath} changed since review.`);
          for await (const chunk of handle.createReadStream({
            autoClose: false,
          })) {
            input.signal?.throwIfAborted();
            if ((size += chunk.length) > file.size)
              throw error(409, `${file.installedPath} changed since review.`);
            chunks.push(chunk);
          }
        } finally {
          await handle.close();
        }
        source = Buffer.concat(chunks);
        const [algorithm, requiredHash] = strongestHash(file.hashes);
        if (
          source.length !== file.size ||
          createHash("sha512").update(source).digest("hex") !==
            file.installedHash ||
          createHash(algorithm).update(source).digest("hex") !== requiredHash
        )
          throw error(
            409,
            `${file.installedPath} changed since review. Review the installation again.`,
          );
      } else if (file.stagedPath) {
        await verifyStaged(file, stage, input.signal);
        source = file.stagedPath;
      } else {
        source = path.join(stage, `dependency-inspection-${index}.jar`);
        await downloadVerified(file, source, file.hosts, request, {
          signal: input.signal,
        });
        // Keep the verified download for installation instead of fetching it twice.
        file.stagedPath = source;
      }
      try {
        for (const bundled of await inspectBundledDependencies(source, {
          signal: input.signal,
          loader: input.loader,
          fingerprint: curseFingerprint,
        }))
          bundles.push({ ...bundled, bundledWith: file.path });
      } catch (cause) {
        input.signal?.throwIfAborted();
        result.warnings.push(
          `Bundled libraries in ${file.path} could not be verified: ${cause.message}`,
        );
      }
    }
    result.bundledDependencies = bundles.map(
      ({ title, version, path, bundledWith, serverCompatible }) => ({
        title,
        version,
        path,
        bundledWith,
        ...(serverCompatible === false ? { serverCompatible: false } : {}),
      }),
    );
    if (!bundles.length) return;
    const identities = [];
    for (const platform of new Set(
      result.unavailableDependencies.map((item) => item.platform),
    )) {
      const found = await provider(platform);
      const signal = AbortSignal.any(
        [input.signal, AbortSignal.timeout(8000)].filter(Boolean),
      );
      try {
        for (let offset = 0; offset < bundles.length; offset += 100) {
          const batch = bundles
            .slice(offset, offset + 100)
            .filter((item) => item.serverCompatible === true);
          if (!batch.length) continue;
          if (found.identify) {
            const matches = await abortable(
              found.identify([...new Set(batch.map((item) => item.sha512))], {
                signal,
              }),
              signal,
            );
            for (const item of batch) {
              const match = matches?.[item.sha512];
              if (
                match?.project_id &&
                match.id &&
                found.compatibleBundledVersion?.(match, input) === true &&
                match.files?.some(
                  (file) => file.hashes?.sha512?.toLowerCase() === item.sha512,
                )
              )
                identities.push({
                  platform,
                  projectId: String(match.project_id),
                  versionId: String(match.id),
                });
            }
          } else if (found.identifyFingerprints) {
            const matches = await abortable(
              found.identifyFingerprints(
                [...new Set(batch.map((item) => item.fingerprint))],
                { signal },
              ),
              signal,
            );
            for (const item of batch) {
              for (const match of matches?.exactMatches ?? []) {
                if (
                  match.file?.fileFingerprint === item.fingerprint &&
                  match.file.hashes?.some(
                    (hash) =>
                      hash.algo === 1 &&
                      hash.value?.toLowerCase() === item.sha1,
                  ) &&
                  match.file.modId &&
                  match.file.id &&
                  found.compatibleBundledVersion?.(match.file, input) === true
                )
                  identities.push({
                    platform,
                    projectId: String(match.file.modId),
                    versionId: String(match.file.id),
                  });
              }
            }
          }
        }
      } catch {
        input.signal?.throwIfAborted();
        // A failed or absent identity leaves the catalog requirement unresolved.
      }
    }
    result.unavailableDependencies = result.unavailableDependencies.filter(
      (dependency) =>
        !identities.some(
          (identity) =>
            identity.platform === dependency.platform &&
            (!dependency.projectId ||
              identity.projectId === dependency.projectId) &&
            (!dependency.versionId ||
              identity.versionId === dependency.versionId) &&
            (dependency.projectId || dependency.versionId),
        ),
    );
  }
  async function verifyStaged(file, stage, signal, archive = false) {
    if (
      typeof file.stagedPath !== "string" ||
      !path.isAbsolute(file.stagedPath)
    )
      throw error(409, "A staged download is outside its installation review.");
    const relative = path.relative(stage, file.stagedPath);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes("..")
    )
      throw error(409, "A staged download is outside its installation review.");
    const target = await safePath(stage, relative.split(path.sep).join("/"));
    const size = (await fs.lstat(target)).size;
    const [algorithm, expected] = strongestHash(file.hashes);
    const maximum = (archive ? 2 * 1024 : 512) * 1024 ** 2;
    const actual = await fileHash(target, algorithm, signal, maximum);
    if ((file.size != null && size !== file.size) || actual !== expected)
      throw error(
        502,
        "A staged download failed its size or checksum check. No server files were changed.",
      );
    return {
      size,
      sha512:
        algorithm === "sha512"
          ? actual
          : await fileHash(target, "sha512", signal, maximum),
    };
  }
  async function unpackPack(result, input, stage) {
    const found = await provider(input.platform);
    const archive =
      result.archive.stagedPath ?? path.join(stage, "package.zip");
    if (result.archive.stagedPath)
      await verifyStaged(result.archive, stage, input.signal, true);
    else
      await downloadVerified(
        { ...result.archive, archive: true },
        archive,
        found.downloadHosts,
        request,
        { signal: input.signal },
      );
    const extracted = path.join(stage, "archive");
    await fs.mkdir(extracted);
    const entries = await unpackProviderZip(archive, extracted, undefined, {
      signal: input.signal,
    });
    const protectedFile = (name) => name.toLowerCase() === "eula.txt";
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
          "The pack's required loader does not match the selected loader.",
        );
      loaderInstall = {
        loader: input.loader,
        gameVersion: input.gameVersion,
        loaderVersion: String(manifest.dependencies[declared[0]]),
      };
      // Some exporters write "unknown", which is not an mrpack side value.
      // Resolve only those entries by checksum; never infer server support from
      // their filename, download URL, or the pack's overall environment.
      const unknownFiles = manifest.files
        .filter((file) => file.env?.server === "unknown")
        .map((file) => {
          const name = safeInstallPath(file.path);
          let algorithm, hash;
          try {
            [algorithm, hash] = strongestHash({
              sha512: file.hashes?.sha512,
              sha1: file.hashes?.sha1,
            });
          } catch {
            throw error(
              400,
              `The pack does not provide a valid checksum to verify server support for ${name}.`,
            );
          }
          return { file, name, algorithm, hash };
        });
      const resolvedEnvironments = new Map();
      if (unknownFiles.length) {
        const signal = AbortSignal.any([
          input.signal,
          AbortSignal.timeout(15000),
        ]);
        const environments = new Map([
          ["client_only", "unsupported"],
          ["singleplayer_only", "unsupported"],
          ["client_only_server_optional", "optional"],
          ["client_or_server", "optional"],
          ["client_or_server_prefers_both", "optional"],
          ["client_and_server", "required"],
          ["server_only", "required"],
          ["server_only_client_optional", "required"],
          ["dedicated_server_only", "required"],
        ]);
        for (const algorithm of ["sha512", "sha1"]) {
          const candidates = unknownFiles.filter(
            (file) => file.algorithm === algorithm,
          );
          for (let offset = 0; offset < candidates.length; offset += 100) {
            const batch = candidates.slice(offset, offset + 100);
            let matches;
            try {
              matches = await abortable(
                providerJson("https://api.modrinth.com/v2/version_files", {
                  fetch: request,
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    hashes: [...new Set(batch.map((file) => file.hash))],
                    algorithm,
                  }),
                  signal,
                }),
                signal,
              );
            } catch {
              input.signal.throwIfAborted();
              throw error(
                502,
                `Could not check server support for ${batch[0].name}. Try again shortly or choose another modpack release.`,
              );
            }
            for (const file of batch) {
              const version = matches?.[file.hash];
              const environment = environments.get(version?.environment);
              if (
                !environment ||
                !Array.isArray(version.game_versions) ||
                !version.game_versions.includes(input.gameVersion) ||
                !Array.isArray(version.loaders) ||
                !version.loaders.includes(input.loader) ||
                !Array.isArray(version.files) ||
                !version.files.some(
                  (download) =>
                    typeof download.hashes?.[algorithm] === "string" &&
                    download.hashes[algorithm].toLowerCase() === file.hash,
                )
              )
                throw error(
                  400,
                  `The pack does not declare server support for ${file.name}, and its exact release could not be verified. Choose another modpack release or ask its author to correct the manifest.`,
                );
              resolvedEnvironments.set(file.file, environment);
            }
          }
        }
      }
      for (const file of manifest.files) {
        const name = safeInstallPath(file.path);
        const environment =
          file.env?.server === "unknown"
            ? resolvedEnvironments.get(file)
            : file.env?.server;
        if (
          environment !== undefined &&
          !["required", "optional", "unsupported"].includes(environment)
        )
          throw error(
            400,
            `The pack has invalid server-side dependency metadata for ${name}.`,
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
      loaderInstall =
        result.loaderInstall ?? (await inferPackRuntime(files, input));
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
    if (active || preparingInstall || removal.busy)
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
    if (plans.size >= 8) await cancelPreview(plans.keys().next().value);
    const bulk = raw.updates !== undefined;
    if (
      bulk &&
      (!Array.isArray(raw.updates) ||
        !raw.updates.length ||
        raw.updates.length > 50 ||
        raw.type === "modpack")
    )
      throw error(
        400,
        "Choose between one and 50 installed mods, plugins, or datapacks to update.",
      );
    const roots = bulk
      ? raw.updates.map((value) => {
          if (!value || typeof value.replacePath !== "string")
            throw error(400, "Each update must identify its installed file.");
          return {
            ...selection(
              {
                type: raw.type,
                gameVersion: raw.gameVersion,
                loader: raw.loader,
                platform: value.platform,
                projectId: value.projectId,
                versionId: value.versionId,
                signal: raw.signal,
              },
              true,
            ),
            replacePath: safeInstallPath(value.replacePath),
          };
        })
      : [{ ...selection(raw, true), replacePath: raw.replacePath }];
    const rootKeys = roots.map(
      (value) => `${value.platform}:${value.projectId}`,
    );
    if (new Set(rootKeys).size !== roots.length)
      throw error(
        400,
        "Choose each installed project only once in an update review.",
      );
    const input = roots[0];
    input.signal.throwIfAborted();
    await assertCompatibility(input);
    const found = await provider(input.platform);
    const planId = randomUUID();
    const stage = await privatePath(planId);
    await fs.mkdir(stage);
    try {
      const identified =
        input.type === "modpack"
          ? { items: [], warnings: [] }
          : await installed({ ...input, identityOnly: true });
      const local = identified.items;
      const trees = [];
      for (const [index, root] of roots.entries()) {
        if (
          bulk &&
          !local.some(
            (item) =>
              item.path === root.replacePath &&
              item.platform === root.platform &&
              item.projectId === root.projectId,
          )
        )
          throw error(
            409,
            `The installed file ${root.replacePath} could not be verified as this project. ${identified.warnings.join(" ")} Refresh installed files.`,
          );
        const rootStage = bulk ? path.join(stage, `item-${index}`) : stage;
        if (bulk) await fs.mkdir(rootStage);
        const tree = await resolveTree(root, rootStage, local);
        if (bulk && tree.archive)
          throw error(
            400,
            "Modpacks require their own clean installation review.",
          );
        trees.push(tree);
        if (
          trees.reduce((total, value) => total + value.files.length, 0) > 10000
        )
          throw error(400, "This update selection contains too many files.");
      }
      const result = trees[0];
      if (bulk) {
        const files = new Map(),
          versions = new Map();
        for (const tree of trees)
          for (const file of tree.files) {
            const project = `${file.platform}:${file.projectId}`;
            if (
              versions.has(project) &&
              versions.get(project) !== file.versionId
            )
              throw error(
                409,
                "Selected updates require conflicting versions of the same dependency. Update these projects separately after resolving their requirements.",
              );
            versions.set(project, file.versionId);
            const folded = file.path.toLowerCase(),
              previous = files.get(folded);
            if (
              previous &&
              (previous.platform !== file.platform ||
                previous.projectId !== file.projectId ||
                previous.versionId !== file.versionId ||
                JSON.stringify(strongestHash(previous.hashes)) !==
                  JSON.stringify(strongestHash(file.hashes)))
            )
              throw error(
                409,
                "Selected updates resolve to conflicting destination files.",
              );
            if (!previous) files.set(folded, file);
          }
        result.files = [...files.values()];
        result.title = `${roots.length} content updates`;
        result.versionName = "Reviewed together";
        result.warnings = trees.flatMap((tree) => tree.warnings);
        result.unavailableDependencies = trees.flatMap(
          (tree) => tree.unavailableDependencies,
        );
        result.recoveredDependencies = new Set(
          trees.flatMap((tree) => [...tree.recoveredDependencies]),
        );
      }
      result.warnings.push(...identified.warnings);
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
            author: result.author,
            versionName: result.versionName,
            type: input.type,
            hosts: file.hosts ?? found.downloadHosts,
          })),
        );
        result.warnings.push(...pack.warnings);
        result.loaderInstall = pack.loaderInstall ?? result.loaderInstall;
      }
      let runtime;
      if (input.type === "modpack") {
        runtime = await resolvePackRuntime(result.loaderInstall, input);
        const accepted = [];
        for (const file of result.files) {
          if (await protectedPackPath(file.path))
            result.warnings.push(
              `Skipped ${file.path}: supplied by the verified runtime.`,
            );
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
      const unchanged = [];
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
        if (input.type === "modpack") {
          files.push({
            ...file,
            expected: null,
            previous: null,
            action: "install",
          });
          continue;
        }
        const matches = local.filter(
          (item) =>
            item.platform === file.platform &&
            item.projectId === file.projectId,
        );
        if (matches.length > 1)
          throw error(
            409,
            `Multiple installed files match this project: ${matches.map((item) => item.path).join(", ")}. Remove the duplicate before updating.`,
          );
        if (
          matches[0] &&
          result.recoveredDependencies.has(
            `${file.platform}:${file.projectId}`,
          ) &&
          matches[0].versionId !== file.versionId
        )
          throw error(
            409,
            `${file.title} is already installed at a different version. This project's dependency link needs correction; Launchpad cannot safely replace the installed dependency automatically.`,
          );
        let oldPath = matches[0]?.path;
        const selectedRoot = roots.find(
          (root) =>
            root.platform === file.platform &&
            root.projectId === file.projectId,
        );
        if (selectedRoot?.replacePath) {
          if (oldPath !== selectedRoot.replacePath)
            throw error(
              409,
              `The selected installed file could not be verified as this project. ${identified.warnings.length ? identified.warnings.join(" ") + " " : ""}Refresh installed files.`,
            );
          oldPath = selectedRoot.replacePath;
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
        if (matches[0] && (previous?.sha512 ?? expected) !== matches[0].sha512)
          throw error(
            409,
            "The installed file changed after identification. Refresh installed files and review the update again.",
          );
        // Compare bytes, not names or version labels. A verified package may
        // have been renamed locally; keep it in place when the provider's
        // destination is absent so the update cannot create a duplicate JAR.
        const existingPath = previous && !current ? previous.path : file.path;
        const existingHash = previous && !current ? previous.sha512 : expected;
        if (existingHash && (!previous || !current)) {
          const [algorithm, requiredHash] = strongestHash(file.hashes);
          const actualHash =
            algorithm === "sha512"
              ? existingHash
              : await fileHash(
                  await safePath(serverDir, existingPath),
                  algorithm,
                );
          if (actualHash === requiredHash) {
            // Retain both the existing file and absent destination snapshots
            // for the final pre-mutation check, even though neither is listed
            // as a change or passed to the download/promotion loops.
            unchanged.push({
              ...file,
              expected,
              previous,
              installedPath: existingPath,
              installedHash: existingHash,
            });
            continue;
          }
        }
        if (file.preserveInstalled)
          throw error(
            409,
            `${file.path} changed since its dependency requirements were checked. Review the installation again.`,
          );
        files.push({
          ...file,
          author: file.author || matches[0]?.author,
          expected,
          previous,
          action: expected || previous ? "replace" : "install",
        });
      }
      result.files = [...files, ...unchanged];
      // Promotion recycles each original immediately before writing its new
      // file. An original claimed by another item must never remove an output
      // already installed earlier in the same review (or an unchanged file).
      const claimedPaths = new Map();
      for (const file of result.files)
        for (const relative of [
          file.path,
          file.previous?.path,
          file.installedPath,
        ].filter(Boolean)) {
          const folded = relative.toLowerCase();
          if (claimedPaths.has(folded) && claimedPaths.get(folded) !== file)
            throw error(
              409,
              `Selected files have overlapping installation and replacement paths (${relative}). Resolve the conflicting package filenames before installing.`,
            );
          claimedPaths.set(folded, file);
        }
      await inspectUnavailableDependencies(result, input, stage);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const plan = {
        id: planId,
        input,
        stage,
        files,
        unchanged,
        title: result.title,
        url: result.url,
        iconUrl: result.iconUrl,
        author:
          result.author ||
          receipts.find(
            (item) =>
              item.pack &&
              item.platform === input.platform &&
              item.projectId === input.projectId,
          )?.author,
        versionName: result.versionName,
        warnings: [...new Set(result.warnings)],
        unavailableDependencies: result.unavailableDependencies,
        bundledDependencies: result.bundledDependencies.filter((dependency) =>
          files.some((file) => file.path === dependency.bundledWith),
        ),
        loaderInstall: result.loaderInstall,
        runtime,
        expiresAt,
      };
      input.signal.throwIfAborted();
      if (files.length) plans.set(planId, plan);
      else {
        await fs.rm(stage, { recursive: true, force: true });
        // Empty reviews need no staging or install-plan slot. Keep only a few
        // recent IDs so an attempted confirmation receives a useful error.
        noOpReviews.set(planId, Date.parse(expiresAt));
        while (noOpReviews.size > 4)
          noOpReviews.delete(noOpReviews.keys().next().value);
      }
      return {
        planId,
        title: plan.title,
        versionName: plan.versionName,
        unchangedCount: unchanged.length,
        files: files.map((file) => ({
          path: file.path,
          size: file.size,
          action: file.action,
          previousPath: file.previous?.path,
        })),
        warnings: plan.warnings,
        unavailableDependencies: plan.unavailableDependencies,
        bundledDependencies: plan.bundledDependencies,
        loaderInstall: plan.loaderInstall ?? null,
        ...(input.type === "modpack"
          ? {
              cleanInstall: true,
              hasExistingContent: (await fs.readdir(serverDir)).length > 0,
              runtime: plan.runtime,
              summary: {
                fileCount: files.length,
                totalBytes: files.reduce(
                  (sum, file) => sum + (Number(file.size) || 0),
                  0,
                ),
              },
            }
          : {}),
        expiresAt,
      };
    } catch (cause) {
      await fs.rm(await privatePath(planId), { recursive: true, force: true });
      throw cause;
    }
  }
  async function promote(plan, job) {
    if (plan.input.type === "modpack") return promotePack(plan, job);
    {
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
      for (const file of [...plan.files, ...plan.unchanged]) {
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
          replaceReceipts(
            receipts.filter(
              (item) =>
                item.path !== file.path && item.path !== file.previous?.path,
            ),
          );
          replaceReceipts([
            ...receipts,
            {
              path: file.path,
              sha512,
              platform: file.platform,
              projectId: file.projectId,
              versionId: file.versionId,
              versionName: file.versionName,
              title: file.title,
              iconUrl: file.iconUrl,
              author: file.author,
              url: file.projectUrl,
              type: file.type,
              installedAt: new Date().toISOString(),
            },
          ]);
          const receipt = receipts.at(-1);
          if (receipt.platform)
            remember(identities, sha512, {
              value: identityFields(receipt),
              expiresAt: Date.now() + 10 * 60_000,
            });
          else identities.delete(sha512);
          // The next inventory hashes this changed file once. Do not attach a
          // post-verification stat to bytes that an external editor may change.
          fileCache.delete(file.path);
          job.completed++;
        }
        await saveReceipts();
        const changes = new Map();
        for (const file of plan.files) {
          const kind =
            { mod: "Mod", plugin: "Plugin", datapack: "Datapack" }[file.type] ??
            "File";
          const verb = file.action === "replace" ? "updated" : "added";
          const key = `${kind} ${verb}`;
          if (!changes.has(key)) changes.set(key, { kind, verb, files: [] });
          changes.get(key).files.push(file.path);
        }
        for (const { kind, verb, files } of changes.values()) {
          try {
            await ctx.audit?.(
              `${kind}${files.length > 1 ? "s" : ""} ${verb}`,
              `${plan.title} ${plan.versionName}: ${files.join(", ")}.${verb === "updated" ? " Replaced files are retained in Recycle Bin." : ""}`,
            );
          } catch {
            // Audit persistence must not roll back a completed installation.
          }
        }
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
        replaceReceipts(previousReceipts);
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
    }
  }
  async function promotePack(plan, job) {
    {
      lifetime.signal.throwIfAborted();
      if ((await getServer()).status !== "offline")
        throw error(409, "Stop the server before installing a modpack.");
      const {
        status: _status,
        address: _address,
        ...previousConfiguration
      } = ctx.getConfiguration();
      const previousReceipts = [...receipts];
      const runtimeStage = path.join(plan.stage, "runtime");
      await fs.mkdir(runtimeStage);
      const runtime = await runtimeVersions.stage(plan.runtime, {
        stageDir: runtimeStage,
        javaPath: previousConfiguration.javaPath,
        signal: lifetime.signal,
        onProgress: (value) => {
          job.message = value.message;
        },
      });
      const runtimePaths = new Set(
        runtime.files.map((file) => file.path.toLowerCase()),
      );
      const packFiles = [];
      for (const file of plan.files) {
        if (runtimePaths.has(file.path.toLowerCase())) continue;
        const parent = path.posix.dirname(file.path);
        await fs.mkdir(
          await safePath(runtime.stageDir, parent === "." ? "" : parent),
          { recursive: true },
        );
        const target = await safePath(runtime.stageDir, file.path);
        await fs.copyFile(file.stagedPath, target, 1);
        if ((await fileHash(target)) !== file.sha512)
          throw error(
            409,
            "A staged pack file changed before installation. No server files were changed.",
          );
        runtime.files.push({ path: file.path });
        packFiles.push(file);
      }
      await prepareCleanSettings(runtime, ctx);
      let configured = false;
      const clearCaches = () => {
        fileCache.clear();
        identities.clear();
        metadataCache?.clear();
        updateCache.clear();
        updateFailures.clear();
      };
      const recovery = await cleanInstall(runtime, {
        ...ctx,
        signal: lifetime.signal,
        onProgress: (value) => {
          job.message = value.message;
        },
        commit: async () => {
          configured = true;
          await ctx.applyConfiguration({
            ...runtime.configuration,
            mode: "live",
            minecraftVersion: runtime.summary.version,
          });
          replaceReceipts(
            packFiles.map((file) => ({
              path: file.path,
              sha512: file.sha512,
              type: "modpack",
              packPlatform: plan.input.platform,
              packProjectId: plan.input.projectId,
              packVersionId: plan.input.versionId,
              installedAt: new Date().toISOString(),
            })),
          );
          replaceReceipts([
            ...receipts,
            {
              pack: true,
              type: "modpack",
              platform: plan.input.platform,
              projectId: plan.input.projectId,
              versionId: plan.input.versionId,
              title: plan.title,
              iconUrl: plan.iconUrl,
              author: plan.author,
              url: plan.url,
              versionName: plan.versionName,
              path: "",
              installedAt: new Date().toISOString(),
            },
          ]);
          await saveReceipts();
          clearCaches();
        },
        rollback: async () => {
          replaceReceipts(previousReceipts);
          clearCaches();
          const failures = [];
          try {
            await saveReceipts();
          } catch (cause) {
            failures.push(cause);
          }
          if (configured)
            try {
              await ctx.applyConfiguration(previousConfiguration);
            } catch (cause) {
              failures.push(cause);
            }
          if (failures.length)
            throw new AggregateError(
              failures,
              "Server settings could not be fully restored.",
            );
        },
      });
      Object.assign(job, recovery);
      job.completed = job.total;
      await ctx
        .audit?.(
          "Modpack installed",
          `${plan.title}: clean installation with ${plan.runtime.software} ${plan.runtime.build}. Previous server files are retained in Recycle Bin.`,
          "file",
        )
        .catch(() => {});
    }
  }
  async function install(input) {
    if (closing) throw error(503, "Launchpad is shutting down.");
    if (input?.confirmed !== true)
      throw error(
        400,
        "Review the exact file changes and confirm the installation first.",
      );
    if (active || preparingInstall || removal.busy)
      throw error(409, "Another Launchpad installation is already running.");
    if ((noOpReviews.get(input?.planId) ?? 0) > Date.now())
      throw error(
        409,
        "All reviewed files are already up to date. No installation is needed.",
      );
    const plan = plans.get(input?.planId);
    if (!plan || Date.parse(plan.expiresAt) < Date.now())
      throw error(
        409,
        "This review expired. Review the version again before installing.",
      );
    if (plan.input.type === "modpack" && input.cleanInstall !== true)
      throw error(
        400,
        "Confirm the clean installation: all current server files, including worlds, mods and configuration, will be removed.",
      );
    if (
      plan.unavailableDependencies?.length &&
      input.acknowledgedUnavailableDependencies !== true
    )
      throw error(
        400,
        "Review the unavailable required dependencies and confirm that you will manage them yourself before installing.",
      );
    preparingInstall = true;
    notifyBusy();
    // Claim the review synchronously before status validation yields. A close
    // or Back request may dispose unclaimed reviews, never an accepted stage.
    plan.reserved = true;
    try {
      if ((await getServer()).status !== "offline")
        throw error(409, "Stop the server before installing content.");
      lifetime.signal.throwIfAborted();
    } catch (cause) {
      plan.reserved = false;
      preparingInstall = false;
      notifyBusy();
      throw cause;
    }
    backgroundChecks.clear();
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
    for (const [id, previous] of jobs) {
      if (jobs.size <= 30) break;
      if (id !== lastJob && ["completed", "failed"].includes(previous.status))
        jobs.delete(id);
    }
    const controller = new AbortController();
    activeController = controller;
    let operation;
    try {
      operation = withMinecraftMutation(async () => {
        job.status = "running";
        let failedFile;
        let outcome,
          phase = "verify",
          retained = false;
        try {
          let downloaded = 0;
          for (const [index, file] of plan.files.entries()) {
            controller.signal.throwIfAborted();
            failedFile = file.path;
            job.message = `Verifying ${file.path}`;
            if (!file.stagedPath) {
              phase = "download";
              const destination = path.join(plan.stage, `download-${index}`);
              await downloadVerified(file, destination, file.hosts, request, {
                signal: controller.signal,
              });
              file.stagedPath = destination;
            }
            phase = "verify";
            const verified = await verifyStaged(
              file,
              plan.stage,
              controller.signal,
            );
            downloaded += verified.size;
            if (
              downloaded >
              (plan.input.type === "modpack" ? 4 : 2) * 1024 ** 3
            )
              throw error(
                400,
                `This installation exceeds the ${plan.input.type === "modpack" ? 4 : 2} GB total size limit.`,
              );
            file.sha512 = verified.sha512;
          }
          controller.signal.throwIfAborted();
          phase = "promote";
          await promote(plan, job);
          removal.invalidate();
          outcome = {
            status: "completed",
            message: `${plan.title} installed. Replaced files remain recoverable in Recycle Bin.`,
          };
        } catch (cause) {
          if (
            phase === "download" &&
            !closing &&
            !lifetime.signal.aborted &&
            !controller.signal.aborted &&
            (cause.status === undefined ||
              cause.status === 429 ||
              cause.status >= 500) &&
            !/checksum|size|redirect|unsupported host|allowed host|ZIP|signature/i.test(
              cause.message,
            )
          ) {
            plan.reserved = false;
            plan.expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
            plans.set(plan.id, plan);
            retained = true;
          }
          outcome = {
            status: "failed",
            error:
              phase !== "promote" && failedFile
                ? `${failedFile}: ${cause.message}`
                : cause.message,
            message:
              phase !== "promote" && failedFile
                ? `${failedFile}: ${cause.message}`
                : cause.message,
            retryable: retained,
            ...(retained
              ? {
                  planId: plan.id,
                  expiresAt: plan.expiresAt,
                  retryInput: {
                    planId: plan.id,
                    confirmed: true,
                    ...(input.cleanInstall === true
                      ? { cleanInstall: true }
                      : {}),
                    ...(input.acknowledgedUnavailableDependencies === true
                      ? { acknowledgedUnavailableDependencies: true }
                      : {}),
                  },
                }
              : {}),
          };
        } finally {
          job.message = "Finishing installation cleanup…";
          try {
            if (!retained)
              await fs.rm(await privatePath(plan.id), {
                recursive: true,
                force: true,
              });
          } catch {
            // A leftover private stage must not keep the completed job active.
          }
        }
        return outcome;
      });
    } catch (cause) {
      plan.reserved = false;
      plans.set(plan.id, plan);
      jobs.delete(job.id);
      lastJob = terminal?.get()?.id ?? null;
      preparingInstall = false;
      notifyBusy();
      activeController = null;
      throw cause;
    }
    active = Promise.resolve(operation).then(
      async (outcome) => {
        const final = {
          ...job,
          ...outcome,
          finishedAt: new Date().toISOString(),
        };
        if (final.status === "failed")
          await ctx
            .audit?.("Content installation failed", final.error, "file")
            .catch(() => {});
        await terminal?.save(final).catch(() => {});
        active = null;
        activeController = null;
        Object.assign(job, final);
        notifyBusy();
      },
      async (cause) => {
        const final = {
          ...job,
          status: "failed",
          error: cause.message,
          message: cause.message,
          finishedAt: new Date().toISOString(),
        };
        await ctx
          .audit?.("Content installation failed", cause.message, "file")
          .catch(() => {});
        await terminal?.save(final).catch(() => {});
        active = null;
        activeController = null;
        Object.assign(job, final);
        notifyBusy();
      },
    );
    preparingInstall = false;
    notifyBusy();
    return { job: { ...job } };
  }
  async function cancelPreview(id) {
    const plan = plans.get(id);
    if (plan && !plan.reserved) {
      plans.delete(id);
      await fs.rm(await privatePath(id), { recursive: true, force: true });
    }
    noOpReviews.delete(id);
    return { ok: true };
  }
  const api = {
    isBusy: () => Boolean(active || preparingInstall || removal.busy),
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
      await ctx
        .audit?.(
          value.trim()
            ? "CurseForge API key saved"
            : "CurseForge API key removed",
          "Launchpad provider settings updated.",
          "server",
        )
        .catch(() => {});
      identities.clear();
      metadataCache?.clear();
      updateCache.clear();
      versionCache.clear();
      updateFailures.clear();
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
    previewUpdates: (input) => {
      if (!input || !Array.isArray(input.updates))
        throw error(400, "Choose installed content updates to review.");
      return preview(input);
    },
    install,
    snapshotInstalled: () => [...receipts],
    clearInstalled: async () => {
      removal.invalidate();
      metadataCache?.clear();
      replaceReceipts([]);
      backgroundChecks.clear();
      await saveReceipts();
      fileCache.clear();
      identities.clear();
      updateCache.clear();
      updateFailures.clear();
    },
    restoreInstalled: async (value) => {
      removal.invalidate();
      metadataCache?.clear();
      replaceReceipts([...value]);
      backgroundChecks.clear();
      await saveReceipts();
      fileCache.clear();
      identities.clear();
      updateCache.clear();
      updateFailures.clear();
    },
    cancelPreview,
    cancelRemovalPreview: removal.cancel,
    async dismissJob(id) {
      const job = jobs.get(id);
      if (job && ["completed", "failed"].includes(job.status)) {
        job.dismissed = true;
        await terminal?.dismiss(id);
      }
      return { ok: true };
    },
    async duplicateCheck({
      path: originalPath,
      sha512,
      signal = lifetime.signal,
    }) {
      signal = AbortSignal.any([lifetime.signal, signal]);
      signal.throwIfAborted();
      if (!/^mods\/[^/\\]+\.jar$/i.test(originalPath ?? "") || !sha512)
        return { duplicates: [], warnings: [] };
      const known =
        identities.get(sha512)?.value ??
        receipts.find((item) => item.sha512 === sha512 && item.platform);
      if (!known?.platform || !known.projectId)
        return {
          duplicates: [],
          warnings: [
            "The recycled mod could not be identified, so duplicates could not be checked.",
          ],
        };
      const current = await abortable(getServer(), signal);
      const warnings = [];
      const items = await scan("mod", signal, warnings, true);
      await installedDetails(
        {
          type: "mod",
          loader: current.loader,
          gameVersion: current.gameVersion,
          identityOnly: true,
          signal,
        },
        items,
        warnings,
      );
      signal.throwIfAborted();
      return {
        duplicates: items
          .filter(
            (item) =>
              item.path !== originalPath &&
              item.platform === known.platform &&
              item.projectId === known.projectId,
          )
          .map(({ path, title }) => ({ path, title })),
        warnings,
      };
    },
    removalPreview: removal.preview,
    remove: removal.remove,
    job(id) {
      if (!jobs.has(id))
        throw error(
          404,
          "This Launchpad job was not found for the selected server.",
        );
      return { job: publicJob(jobs.get(id)) };
    },
    async close() {
      closing = true;
      const stopped = error(
        503,
        "Launchpad closed before installation finished. No pending downloads will be installed.",
      );
      lifetime.abort(stopped);
      activeController?.abort(stopped);
      await removal.close();
      await Promise.allSettled([...previews]);
      await active;
      await Promise.allSettled(
        [...backgroundChecks.values()].map((entry) => entry.task),
      );
      await terminal?.flush();
      await receiptWrites.catch(() => {});
      await metadataCache?.close();
      for (const [id] of plans)
        await fs
          .rm(await privatePath(id), { recursive: true, force: true })
          .catch(() => {});
      plans.clear();
      noOpReviews.clear();
    },
  };
  if (ctx.catalogOnly)
    return {
      config: api.config,
      search: api.search,
      versions: api.versions,
      settings: api.settings,
      close: api.close,
    };
  await pruneReceipts();
  return api;
}
