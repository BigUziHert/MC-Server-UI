import { terminalJobs } from "./terminal-jobs.mjs";
import { createLaunchpadRecovery } from "./launchpad-transaction.mjs";
import { createLaunchpadHistory } from "./launchpad-history.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createCoreProviders } from "./launchpad-providers.mjs";
import { safeInstallPath, unpackProviderZip } from "./launchpad-archives.mjs";
import { inspectBundledDependencies } from "./launchpad-bundled.mjs";
import { installedDependencySatisfies } from "./launchpad-dependency-ranges.mjs";
import { inspectInstalledMod } from "./launchpad-mod-metadata.mjs";
import { inspectPluginIdentity } from "./launchpad-plugin-metadata.mjs";
import {
  updatedModDependencyWarnings,
  updateDependencySatisfies,
} from "./launchpad-update-dependencies.mjs";
import { probeJava } from "./java-discovery.mjs";
import { createModRemoval } from "./launchpad-removal.mjs";
import { createModActivation } from "./launchpad-activation.mjs";
import { categoryIds } from "../shared/launchpad-categories.mjs";
import { createLaunchpadMetadataCache } from "./launchpad-metadata-cache.mjs";
import { createLaunchpadCatalogCache } from "./launchpad-catalog-cache.mjs";
import { mapReview, parallelTransfers } from "./launchpad-transfers.mjs";
import { recoverJarIdentity } from "./launchpad-jar-recovery.mjs";
import { createVersionsService } from "./versions.mjs";
import { cleanInstall, prepareCleanSettings } from "./clean-install.mjs";
import { inferPackRuntime } from "./launchpad-pack-runtime.mjs";
import {
  normalizeAuthorLinks,
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
  "featured",
  "category",
  "gameVersion",
  "author",
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
// Creation time tracks this local file, including manually added mods. Some
// filesystems do not expose birthtime; use their modification time as a fallback.
const fileAddedAt = (stat) => {
  const milliseconds =
    Number.isFinite(stat?.birthtimeMs) && stat.birthtimeMs > 0
      ? stat.birthtimeMs
      : stat?.mtimeMs;
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
};
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
  return (await fileHashes(target, [algorithm], signal, maximum))[algorithm];
}
async function fileHashes(
  target,
  algorithms,
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
  const hashes = new Map(
    [...new Set(algorithms)].map((algorithm) => [
      algorithm,
      createHash(algorithm),
    ]),
  );
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
      for (const hash of hashes.values()) hash.update(chunk);
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw error(
        409,
        "A file changed while it was being checked. Refresh and try again.",
      );
    return Object.fromEntries(
      [...hashes].map(([algorithm, hash]) => [algorithm, hash.digest("hex")]),
    );
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
  channel: value.channel ?? "release",
  downloadable: value.downloadable !== false,
  unavailableReason:
    value.downloadable === false
      ? (value.reason ??
        value.warning ??
        "No verified automatic server download is available for this release.")
      : undefined,
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
    recoveryFetch = rawRequest,
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
      recoveryFetch,
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
  const history = ctx.catalogOnly
    ? null
    : await createLaunchpadHistory({ privatePath, safePath, fileHash });
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
  const catalogCache = createLaunchpadCatalogCache();
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
        "installReason",
        "requiredBy",
        "updateHeld",
        "previousVersionId",
        "previousVersionName",
        "title",
        "iconUrl",
        "author",
        "authorLinks",
        "url",
        "identityMethod",
        "canonicalSha512",
        "categories",
        "mainCategory",
        "downloads",
        "follows",
        "featured",
        "updatedAt",
        "releasedAt",
        "gameVersions",
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
      item.canonicalSha512,
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
  const recovery = ctx.catalogOnly
    ? null
    : await createLaunchpadRecovery({
        privatePath,
        serverDir,
        safePath,
        applyConfiguration: ctx.applyConfiguration,
        getConfiguration: ctx.getConfiguration,
      });
  let recoveryRequired = false;
  async function reconcileInstallation({ publish = true } = {}) {
    const pending = recovery?.get();
    if (!pending) return { ok: true };
    let result, issue;
    try {
      result = await recovery.reconcile();
      if (!result.committed) {
        replaceReceipts(result.record.receipts);
        const persisted = await fs
          .readFile(await privatePath("installed.json"), "utf8")
          .then((value) => JSON.parse(value))
          .catch((cause) => {
            if (cause.code === "ENOENT") return [];
            throw cause;
          });
        if (JSON.stringify(persisted) !== JSON.stringify(receipts))
          await saveReceipts();
        if (!result.record.job?.undoOf)
          await history?.discard(result.record.job.id);
      } else if (result.record.job?.undoOf) {
        await history?.markUndone(result.record.job.undoOf);
      }
      if (result.committed) await history?.prune().catch(() => {});
    } catch (cause) {
      issue = cause;
    }
    recoveryRequired = Boolean(issue);
    recovery?.release();
    const job = {
      ...pending.job,
      status: result?.committed ? "completed" : "failed",
      recoveryRequired,
      cancellable: false,
      retryable: false,
      message: issue
        ? `Interrupted installation needs recovery. ${issue.message}`
        : result.committed
          ? "Installation completed before the panel stopped."
          : "The interrupted installation was rolled back. Previous server files were restored, along with their settings.",
      ...(issue
        ? { retainedRecoveryPath: await privatePath(pending.directory) }
        : {}),
      finishedAt: new Date().toISOString(),
    };
    if (job.status === "failed") job.error = job.message;
    if (publish) {
      jobs.set(job.id, job);
      lastJob = job.id;
      await terminal.save(job);
    }
    if (!issue) await recovery.clear();
    return { ok: !issue, job };
  }
  await reconcileInstallation();
  const preparingStages = new Set();
  const cleanupStages = async () => {
    if (ctx.catalogOnly || closing) return;
    const root = await privatePath();
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (
        !/^(?:[a-f0-9-]{36}|identity-[a-zA-Z0-9]{6}|[a-f0-9-]{36}(?:\.journal)?\.tmp)$/.test(
          entry.name,
        ) ||
        plans.has(entry.name) ||
        preparingStages.has(entry.name) ||
        recovery?.get()?.planId === entry.name
      )
        continue;
      try {
        const target = await privatePath(entry.name),
          stat = await fs.lstat(target);
        if (!stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 15 * 60_000)
          await fs.rm(target, { recursive: stat.isDirectory(), force: true });
      } catch {
        /* A concurrent cleanup or read-only orphan must not break startup. */
      }
    }
    for (const [id, plan] of plans)
      if (!plan.reserved && Date.parse(plan.expiresAt) <= Date.now())
        await cancelPreview(id);
  };
  await cleanupStages();
  const cleanupTimer = ctx.catalogOnly
    ? null
    : setInterval(() => {
        void cleanupStages().catch(() => {});
      }, 60_000);
  cleanupTimer?.unref();
  const backgroundChecks = new Map();
  let catalogController = new AbortController(),
    unsubscribeCatalogSettings;
  function invalidateCatalogCaches() {
    catalogController.abort(
      new DOMException(
        "Catalog credentials changed. Refresh to retry.",
        "AbortError",
      ),
    );
    catalogController = new AbortController();
    identities.clear();
    metadataCache?.clear();
    updateCache.clear();
    versionCache.clear();
    updateFailures.clear();
    updateFlights.clear();
    versionFlights.clear();
    backgroundChecks.clear();
    catalogCache.clear();
    for (const found of providers) found.invalidateCatalogCaches?.();
  }
  const publicJob = (job) => ({
    ...Object.fromEntries(
      Object.entries(job ?? {})
        .filter(
          ([key]) =>
            ![
              "retainedRecoveryPath",
              "retainedStagePath",
              "stagePath",
            ].includes(key),
        )
        .map(([key, value]) => [
          key,
          typeof value === "string"
            ? value
                .replaceAll(serverDir, "[server folder]")
                .replaceAll(dataDir, "[panel data]")
            : value,
        ]),
    ),
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
    const busy = Boolean(
      active || preparingInstall || removal.busy || activation.busy,
    );
    if (busy !== reportedBusy) {
      reportedBusy = busy;
      try {
        ctx.onBusyChange?.(busy);
      } catch {
        /* Observers cannot strand a transaction. */
      }
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
    isBusy: () => Boolean(active || preparingInstall || activation.busy),
    isRecoveryRequired: () => recoveryRequired,
    getReceipts: () => receipts,
    onBusyChange: notifyBusy,
    async beginRemoval({ jobId, paths, type }) {
      await recovery.begin({
        job: {
          id: jobId,
          kind: "remove",
          title: `Removed ${paths.length} ${type}${paths.length === 1 ? "" : "s"}`,
          createdAt: new Date().toISOString(),
        },
        originals: paths,
        files: [],
        receipts: [...receipts],
      });
    },
    async commitRemoval() {
      await recovery.commit();
      await history.prune().catch(() => {});
      recovery.release();
      await recovery.clear().catch(() => {});
    },
    async onRemovalFailed() {
      if (recovery.get()) {
        const result = await reconcileInstallation({ publish: false });
        if (!result.ok) throw error(409, result.job.message);
      }
    },
    async onRemovedMany(paths, type, recycled, jobId) {
      const previous = receipts;
      const removed = new Set(paths);
      replaceReceipts(receipts.filter((item) => !removed.has(item.path)));
      try {
        await saveReceipts();
        if (jobId)
          await history.save(
            {
              jobId,
              kind: "remove",
              title: recovery.get().job.title,
              createdAt: recovery.get().job.createdAt,
              written: [],
              recycled: recycled.map(({ path, entry }) => ({
                id: entry.id,
                path,
              })),
              receipts: previous,
              afterReceipts: receipts,
            },
            recovery.get(),
          );
      } catch (cause) {
        replaceReceipts(previous);
        await saveReceipts().catch(() => {});
        throw cause;
      }
      backgroundChecks.clear();
      for (const relative of paths) {
        const hash =
          fileCache.get(relative)?.sha512 ??
          previous.find((item) => item.path === relative)?.sha512;
        if (hash)
          for (const [key] of updateCache)
            if (key.includes(hash)) updateCache.delete(key);
        fileCache.delete(relative);
        removal.invalidate(relative);
      }
      await ctx
        .audit?.(
          paths.length === 1
            ? `${{ mod: "Mod", plugin: "Plugin", datapack: "Datapack" }[type]} deleted`
            : "Content deleted",
          `${paths.join(", ")} moved to Recycle Bin.`,
        )
        .catch(() => {});
    },
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
  const activation = createModActivation({
    serverDir,
    safePath,
    fileAddedAt,
    getServer,
    withMinecraftMutation,
    signal: lifetime.signal,
    isBusy: () => Boolean(active || preparingInstall || removal.busy),
    isRecoveryRequired: () => recoveryRequired,
    onBusyChange: notifyBusy,
    async onChanged(previousPath, nextPath, isActive) {
      const previous = receipts;
      replaceReceipts(
        receipts.map((item) =>
          item.path === previousPath ? { ...item, path: nextPath } : item,
        ),
      );
      try {
        await saveReceipts();
      } catch (cause) {
        replaceReceipts(previous);
        throw cause;
      }
      fileCache.delete(previousPath);
      fileCache.delete(nextPath);
      backgroundChecks.clear();
      removal.invalidate();
      try {
        await ctx.audit?.(
          `${previousPath.startsWith("plugins/") ? "Plugin" : "Mod"} ${isActive ? "enabled" : "disabled"}`,
          `${previousPath} renamed to ${nextPath}.`,
        );
      } catch {
        // An audit storage failure must not undo a completed state change.
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
    const offset = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, Number(input.offset) || 0),
    );
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
    return {
      ...input,
      ...(input.type === "modpack"
        ? { preserveWorld: input.preserveWorld !== false }
        : {}),
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
  async function snapshotInventory(type, signal = lifetime.signal) {
    if (type === "modpack") return null;
    const folder = await destination(type);
    const directory = await safePath(serverDir, folder);
    const entries = await fs.readdir(directory).catch((cause) => {
      if (missing(cause)) return [];
      throw cause;
    });
    const packages = entries
      .filter((name) =>
        (type === "datapack"
          ? /\.zip$/i
          : type === "mod"
            ? /\.jar(?:\.disabled)?$/i
            : /\.jar(?:\.disabled)?$/i
        ).test(name),
      )
      .sort();
    if (packages.length > 1000)
      throw error(
        400,
        "This folder has over 1,000 packages. Use File Manager to narrow the installed collection.",
      );
    const rows = await mapReview(
      packages,
      async (name) => {
        signal.throwIfAborted();
        const stat = await statOrNull(
          await safePath(serverDir, `${folder}/${name}`),
        );
        return [name, stat ? fileStamp(stat) : null];
      },
      signal,
      16,
    );
    return JSON.stringify([folder, rows]);
  }
  async function assertReviewedInventory(plan, signal = lifetime.signal) {
    const current = await snapshotInventory(plan.input.type, signal);
    if (current !== plan.inventorySnapshot) {
      const [folder, entries] = JSON.parse(current);
      const [reviewedFolder, reviewedEntries] = JSON.parse(
        plan.inventorySnapshot,
      );
      const before = new Map(reviewedEntries),
        after = new Map(entries);
      const changed = [...new Set([...before.keys(), ...after.keys()])].find(
        (name) => before.get(name) !== after.get(name),
      );
      throw error(
        409,
        `${folder === reviewedFolder && changed ? `${folder}/${changed}` : "Installed content"} changed since review. Refresh installed files and review the installation again.`,
      );
    }
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
        (type === "datapack"
          ? /\.zip$/i
          : type === "mod"
            ? /\.jar(?:\.disabled)?$/i
            : /\.jar(?:\.disabled)?$/i
        ).test(entry.name),
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
            ...(["mod", "plugin"].includes(type)
              ? { active: !/\.disabled$/i.test(file.name) }
              : {}),
            modifiedAt: stat?.mtime.toISOString(),
            addedAt: fileAddedAt(stat),
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
          ...(["mod", "plugin"].includes(type)
            ? { active: !/\.disabled$/i.test(file.name) }
            : {}),
          modifiedAt: stat.mtime.toISOString(),
          addedAt: fileAddedAt(stat),
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
      activation.busy ||
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
      const authorLinks = normalizeAuthorLinks(project?.authorLinks);
      if (authorLinks) item.authorLinks = authorLinks;
      for (const field of [
        "categories",
        "mainCategory",
        "downloads",
        "follows",
        "featured",
        "updatedAt",
        "releasedAt",
        "gameVersions",
      ])
        if (project?.[field] !== undefined) item[field] = project[field];
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
              !cached?.checkedAt ||
              cached.checkedAt + 10 * 60_000 <= Date.now() ||
              (cached.value.author && !cached.value.authorLinks)
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
    for (const item of items)
      if (item.updateHeld) {
        delete item.update;
        item.updateCheck = "checked";
      }
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
            until: Math.max(
              updateFailures.get(
                cause.status === 429
                  ? found.id
                  : `${found.id}:${item.projectId}`,
              )?.until ?? 0,
              Date.now() +
                Math.max(
                  cause.status === 429 ? 60_000 : 30_000,
                  Number.isFinite(cause.retryAfterMs) ? cause.retryAfterMs : 0,
                ),
            ),
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
          (item) =>
            item.platform === found.id && item.projectId && !item.updateHeld,
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
          const providerHash = (item) =>
            found.id === "modrinth" &&
            ["jar-timestamps", "jar-contents"].includes(item.identityMethod)
              ? item.canonicalSha512
              : item.sha512;
          const work = (async () => {
            const checked = new Map();
            const cacheGeneration = metadataCache?.generation;
            let accepting = true;
            const accept = (result) => {
              if (
                !accepting ||
                input.signal?.aborted ||
                cacheGeneration !== metadataCache?.generation ||
                !result?.updates ||
                typeof result.updates !== "object"
              )
                return;
              for (const item of missing) {
                const key = updateKey(input, item);
                if (
                  checked.has(key) ||
                  !Object.hasOwn(result.updates, providerHash(item))
                )
                  continue;
                const value = result.updates[providerHash(item)];
                const normalized = value ? publicVersion(value) : null;
                remember(updateCache, key, {
                  value: normalized,
                  expiresAt: Date.now() + 5 * 60_000,
                });
                checked.set(key, normalized);
                apply(item, normalized);
              }
            };
            try {
              const result = await abortable(
                found.updates(
                  { ...input, onProgress: accept },
                  missing.map((item) => ({
                    ...item,
                    sha512: providerHash(item),
                  })),
                ),
                input.signal,
              );
              warnings.push(...(result.warnings ?? []));
              accept(result);
              return {
                checked,
                issues: result.issues,
                issue: result.warnings?.join(" "),
              };
            } catch (cause) {
              fail(found, cause);
              return { checked, issue: cause.message };
            } finally {
              accepting = false;
            }
          })();
          for (const item of missing) {
            const key = updateKey(input, item);
            const value = work.then((result) =>
              result.checked?.has(key)
                ? { value: result.checked.get(key) }
                : {
                    issue: result.issues?.[providerHash(item)] ?? result.issue,
                  },
            );
            updateFlights.set(key, value);
            void value.then(
              () => {
                if (updateFlights.get(key) === value) updateFlights.delete(key);
              },
              () => {
                if (updateFlights.get(key) === value) updateFlights.delete(key);
              },
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
                          input.signal.throwIfAborted();
                          const entry = {
                            versions,
                            expiresAt: Date.now() + 5 * 60_000,
                          };
                          remember(versionCache, versionKey, entry);
                          return entry;
                        });
                        versionFlights.set(versionKey, versionWork);
                        void versionWork.then(
                          () => {
                            if (versionFlights.get(versionKey) === versionWork)
                              versionFlights.delete(versionKey);
                          },
                          () => {
                            if (versionFlights.get(versionKey) === versionWork)
                              versionFlights.delete(versionKey);
                          },
                        );
                      }
                      cached = await abortable(versionWork, input.signal);
                    }
                    const versions = cached.versions
                      .filter(
                        (value) =>
                          value.downloadable !== false &&
                          (!value.channel || value.channel === "release"),
                      )
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
                        input.signal.throwIfAborted();
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
                    input.signal.throwIfAborted();
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
                  () => {
                    if (updateFlights.get(key) === work)
                      updateFlights.delete(key);
                  },
                  () => {
                    if (updateFlights.get(key) === work)
                      updateFlights.delete(key);
                  },
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
    const catalogSignal = catalogController.signal;
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
            .map((item) => ({
              ...item,
              name: item.title,
              addedAt: item.installedAt,
            }))
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
      // Unreadable files stay unverified placeholders; they cannot benefit from
      // another provider check and must not restart a completed background job.
      if (
        items.every(
          (item) =>
            (input.type !== "modpack" && !item.sha512) ||
            (item.sha512 && previous.get(item.path)?.sha512 === item.sha512),
        )
      ) {
        for (const item of items) {
          if (!item.sha512) {
            item.updateCheck = "unavailable";
            continue;
          }
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
          catalogSignal,
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
          if (cacheGeneration !== metadataCache?.generation || signal.aborted)
            continue;
          const previous = identities.get(item.sha512);
          // Polling an unchanged negative result must not renew its retry
          // deadline forever while a provider recovers in the background.
          if (
            !item.platform &&
            previous?.expiresAt > Date.now() &&
            !enabled(input.refresh)
          )
            continue;
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
        ...(input.identityOnly ? [] : [checkUpdates(input, items, warnings)]),
      ]);
      input.signal.throwIfAborted();
      for (const item of items) item.name = item.title;
      return;
    }
    const unknown = items.filter(
      (item) =>
        item.sha512 &&
        !item.platform &&
        (enabled(input.refresh) ||
          !(identities.get(item.sha512)?.expiresAt > Date.now())),
    );
    for (const item of items) {
      const cached = identities.get(item.sha512);
      if (
        !enabled(input.refresh) &&
        cached?.expiresAt > Date.now() &&
        cached.warnings
      )
        warnings.push(...cached.warnings);
    }
    const modrinth = providers.find((value) => value.id === "modrinth");
    if (unknown.length) {
      const applyIdentities = (matches) => {
        if (input.signal.aborted) return;
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
      };
      try {
        const result = await abortable(
          (modrinth.identifyInstalled ?? modrinth.identify)(
            [...new Set(unknown.map((item) => item.sha512))],
            {
              signal: input.signal,
              refresh: enabled(input.refresh),
              // Keep confirmed identities visible even when another file's
              // fallback lookup outlasts this inventory's deadline.
              onProgress: ({ matches }) => applyIdentities(matches),
            },
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
        applyIdentities(matches);
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
    const known = new Set(items.filter((item) => item.platform));
    const details = (entries) =>
      Promise.all([
        enrichProjectMetadata(
          entries,
          warnings,
          input.signal,
          "url",
          cacheGeneration,
        ),
        checkUpdates(input, entries, warnings),
      ]);
    const recoverMissing = async () => {
      if (input.type === "mod" && modrinth.installedCandidates) {
        let downloadBytes = 0;
        await parallel(
          unknown.filter(
            (item) =>
              !item.platform && item.size >= 22 && item.size <= 128 * 1024 ** 2,
          ),
          2,
          async (item) => {
            try {
              const target = await safePath(serverDir, item.path);
              const before = await fs.lstat(target);
              if (
                !before.isFile() ||
                before.isSymbolicLink() ||
                before.size > 128 * 1024 ** 2
              )
                return;
              const handle = await fs.open(target, "r");
              let source;
              try {
                if (fileStamp(await handle.stat()) !== fileStamp(before))
                  return;
                const chunks = [];
                let size = 0;
                input.signal.throwIfAborted();
                for await (const chunk of handle.createReadStream({
                  autoClose: false,
                  signal: input.signal,
                })) {
                  if ((size += chunk.length) > 128 * 1024 ** 2) return;
                  chunks.push(chunk);
                }
                source = Buffer.concat(chunks);
                if (
                  fileStamp(await handle.stat()) !== fileStamp(before) ||
                  createHash("sha512").update(source).digest("hex") !==
                    item.sha512
                )
                  return;
              } finally {
                await handle.close();
              }
              const identity = await recoverJarIdentity(source, {
                ...input,
                name: item.name,
                provider: modrinth,
                request,
                temporaryDirectory: async () =>
                  fs.mkdtemp(await privatePath("identity-")),
                reserve: (bytes) => {
                  if (downloadBytes + bytes > 256 * 1024 ** 2) return false;
                  downloadBytes += bytes;
                  return true;
                },
              });
              input.signal.throwIfAborted();
              if (
                identity &&
                fileStamp(await fs.lstat(target)) === fileStamp(before)
              )
                Object.assign(item, identity);
            } catch (cause) {
              input.signal.throwIfAborted();
              warnings.push(
                `Modrinth identification: ${item.name}: ${cause.message}`,
              );
            }
          },
          input.signal,
        );
      }
      await details(items.filter((item) => item.platform && !known.has(item)));
    };
    // Slow discovery of unknown files must not block already-known projects.
    await Promise.all([details([...known]), recoverMissing()]);
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
    const rootIsActive = !local.some(
      (item) =>
        item.platform === input.platform &&
        item.projectId === input.projectId &&
        item.active === false,
    );
    const files = [],
      warnings = [],
      unavailableDependencies = [],
      recoveredDependencies = new Set(),
      attempted = new Set(),
      visited = new Map(),
      preservedDependencies = new Set();
    let inspectedParents = 0,
      inspectionBytes = 0;
    const declaredConflicts = [];
    let rootResult;
    let localDeclarations;
    const dependencyDecisions = new Map();
    const resolutions = input.resolutions ?? {};
    if (
      !resolutions ||
      typeof resolutions !== "object" ||
      Array.isArray(resolutions) ||
      Object.keys(resolutions).length > 100 ||
      Object.values(resolutions).some(
        (choice) =>
          !["keep-installed", "use-proposed", "skip"].includes(choice),
      )
    )
      throw error(400, "Choose valid dependency resolutions from the review.");
    const metadataFor = async (file) => {
      if (!file.stagedPath) {
        if (
          ++inspectedParents > 100 ||
          (inspectionBytes += file.size ?? 0) > 512 * 1024 ** 2 ||
          !Number.isSafeInteger(file.size) ||
          file.size > 64 * 1024 ** 2
        )
          throw error(
            400,
            "Dependency metadata exceeds the inspection limits.",
          );
        const stagedPath = path.join(
          stage,
          `compatibility-${inspectedParents}.jar`,
        );
        const [algorithm, expected] = strongestHash(file.hashes);
        const identical =
          algorithm === "sha512" &&
          local.find((item) => item.sha512 === expected.toLowerCase());
        if (identical)
          await fs.copyFile(
            await safePath(serverDir, identical.path),
            stagedPath,
            fs.constants.COPYFILE_EXCL,
          );
        else
          await downloadVerified(
            file,
            stagedPath,
            file.hosts ?? (await provider(input.platform)).downloadHosts,
            request,
            { signal: input.signal, curseforgeKey: key },
          );
        file.stagedPath = stagedPath;
      }
      await verifyStaged(file, stage, input.signal);
      return inspectInstalledMod(file.stagedPath, {
        loader: input.loader,
        signal: input.signal,
      });
    };
    const decisionFor = (value, requiredBy, existing, proposed) => {
      const key = `${value.platform}:${value.projectId}`;
      let decision = dependencyDecisions.get(key);
      if (!decision) {
        decision = {
          key,
          platform: value.platform,
          projectId: value.projectId,
          title: existing?.title || proposed?.title || value.projectId,
          installedVersion:
            existing?.versionName || existing?.versionId || null,
          proposedVersion: proposed?.versionName || value.versionId || null,
          installedPath: existing?.path || null,
          requiredBy: [],
          choice:
            resolutions[key] ??
            (existing &&
            !input.selectedUpdates?.some(
              (root) => `${root.platform}:${root.projectId}` === key,
            )
              ? "keep-installed"
              : "use-proposed"),
          allowedChoices: existing
            ? ["keep-installed", "use-proposed", "skip"]
            : ["use-proposed", "skip"],
          direction:
            existing?.versionId === value.versionId
              ? "unchanged"
              : "different-release",
          status: "unverified",
        };
        dependencyDecisions.set(key, decision);
      }
      if (requiredBy && !decision.requiredBy.includes(requiredBy))
        decision.requiredBy.push(requiredBy);
      if (!decision.allowedChoices.includes(decision.choice))
        throw error(
          400,
          `The selected resolution is unavailable for ${decision.title}.`,
        );
      return decision;
    };
    const warnDependency = (value, requiredBy, message) => {
      warnings.push(message);
      if (
        !unavailableDependencies.some(
          (row) =>
            row.platform === value.platform &&
            row.projectId === value.projectId &&
            row.requiredBy === requiredBy,
        )
      )
        unavailableDependencies.push({
          platform: value.platform,
          projectId: value.projectId,
          versionId: value.versionId,
          requiredBy,
          issue: message,
        });
    };
    async function preserveInstalled(
      found,
      value,
      parentFiles,
      requiredBy,
      existing,
      proposed,
    ) {
      const matches = existing
        ? [existing]
        : local.filter(
            (item) =>
              item.active !== false &&
              item.platform === value.platform &&
              item.projectId === value.projectId,
          );
      if (matches.length > 1)
        throw error(
          409,
          `Multiple active installed files match ${value.projectId}: ${matches.map((item) => item.path).join(", ")}. Remove a duplicate before updating.`,
        );
      existing = matches[0];
      if (!existing) return null;
      const decision = decisionFor(value, requiredBy, existing, proposed);
      if (decision.choice !== "keep-installed") return null;
      const target = await safePath(serverDir, existing.path);
      const before = await fs.lstat(target);
      if (!before.isFile() || before.isSymbolicLink())
        throw error(409, `${existing.path} is not a regular installed file.`);
      const source =
        before.size <= 64 * 1024 ** 2 ? await fs.readFile(target) : null;
      const digest = source
        ? createHash("sha512").update(source).digest("hex")
        : await fileHash(target);
      if (
        fileStamp(before) !== fileStamp(await fs.lstat(target)) ||
        digest !== existing.sha512
      )
        throw error(
          409,
          `${existing.path} changed after identification. Refresh installed mods and review again.`,
        );
      let proven = existing.versionId === value.versionId;
      try {
        if (source && parentFiles?.length === 1) {
          const parent = await metadataFor(parentFiles[0]);
          const installed = await inspectInstalledMod(source, {
            loader: input.loader,
            signal: input.signal,
          });
          const requirements = parent.requirements.filter(
            (requirement) =>
              parent.required.includes(requirement.id) &&
              installed.provided.includes(requirement.id),
          );
          if (requirements.length) {
            proven = requirements.every((requirement) =>
              installed.providers.some(
                (provided) =>
                  provided.id === requirement.id &&
                  updateDependencySatisfies(
                    provided.version,
                    requirement.range,
                    input.loader,
                  ),
              ),
            );
            if (!proven) decision.status = "conflict";
          } else if (!proven)
            proven = await installedDependencySatisfies(
              parentFiles[0].stagedPath,
              source,
              { loader: input.loader, signal: input.signal },
            );
        }
      } catch (cause) {
        input.signal.throwIfAborted();
        // An unreadable declaration is explicitly uncertain; file identity and
        // checksum errors above remain hard failures.
        decision.warning = cause.message;
      }
      if (!proven) {
        decision.warning = `Keeping ${decision.title} (${decision.installedVersion || existing.path}) for ${requiredBy}: its declared compatibility could not be verified. The server may fail to start. You can use the proposed version or acknowledge keeping the installed copy.`;
        warnDependency(value, requiredBy, decision.warning);
      } else if (!decision.warning) decision.status = "compatible";
      preservedDependencies.add(decision.key);
      value.versionId =
        existing.versionId ?? `installed-${digest.slice(0, 16)}`;
      return {
        title: existing.title || value.projectId,
        versionName: existing.versionName || value.versionId,
        dependencies: [],
        warnings: [],
        files: [
          {
            path: existing.path,
            size: before.size,
            hashes: { sha512: digest },
            preserveInstalled: true,
            installedIdentity: {
              platform: existing.platform,
              projectId: existing.projectId,
              versionId: value.versionId,
            },
            title: existing.title,
            versionName: existing.versionName,
          },
        ],
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
      const skipClientDependency = (title) => {
        warnings.push(
          `Skipped ${title || value.projectId}, required by ${requiredBy}: ${found.name} marks it as client-only content.`,
        );
      };
      try {
        if (!value.projectId && value.versionId && found.version)
          value.projectId = String(
            (await found.version(value.versionId, input.signal)).project_id,
          );
        const dependencyKey = `${value.platform}:${value.projectId}`;
        if (
          depth &&
          value.type === "mod" &&
          `${value.platform}:${value.projectId}` !==
            `${input.platform}:${input.projectId}`
        ) {
          const selectedUpdate = input.selectedUpdates?.find(
            (root) => `${root.platform}:${root.projectId}` === dependencyKey,
          );
          if (selectedUpdate && !resolutions[dependencyKey])
            value.versionId = selectedUpdate.versionId;
          const existing = local.find(
            (item) =>
              item.active !== false &&
              item.platform === value.platform &&
              item.projectId === value.projectId,
          );
          const choice =
            resolutions[dependencyKey] ??
            (selectedUpdate ? "use-proposed" : undefined);
          if (choice === "skip") {
            const decision = decisionFor(value, requiredBy, existing);
            decision.warning = `Skipped ${decision.title}, required by ${requiredBy}, by your choice. The server may fail to start.`;
            warnDependency(value, requiredBy, decision.warning);
            return;
          }
          if (existing && choice !== "use-proposed")
            result = await preserveInstalled(
              found,
              value,
              parentFiles,
              requiredBy,
              existing,
            );
        }
        if (!result && !value.versionId) {
          const dependency =
            depth && value.type === "mod"
              ? await found.dependencyInfo?.(value)
              : null;
          if (dependency?.clientOnly === true) {
            skipClientDependency(dependency.title);
            return;
          }
          const versions = (await found.versions(value)).filter(
            (version) =>
              version.downloadable !== false &&
              (!version.channel || version.channel === "release"),
          );
          value.versionId = versions.sort(
            (a, b) =>
              (({ release: 0, beta: 1, alpha: 2 })[a.channel] ?? 0) -
                ({ release: 0, beta: 1, alpha: 2 }[b.channel] ?? 0) ||
              (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
          )[0]?.id;
          if (!value.versionId)
            throw error(
              400,
              `${dependency?.title || value.projectId || "The selected project"}${requiredBy ? `, required by ${requiredBy},` : ""} has no compatible downloadable version for ${input.loader} on Minecraft ${input.gameVersion}. Choose another project version or install a compatible dependency manually before continuing.`,
            );
        }
        const key = `${value.platform}:${value.projectId}`;
        if (depth && rootIsActive) {
          const inactive =
            !local.some(
              (item) =>
                item.active !== false &&
                item.platform === value.platform &&
                item.projectId === value.projectId,
            ) &&
            local.find(
              (item) =>
                item.platform === value.platform &&
                item.projectId === value.projectId &&
                item.active === false,
            );
          if (inactive)
            warnings.push(
              `${inactive.title || inactive.path} is disabled. This review will install an active dependency for ${requiredBy || "this mod"}; the disabled copy is retained.`,
            );
        }
        if (
          visited.get(key) === String(value.versionId) &&
          !preservedDependencies.has(key)
        )
          return;
        try {
          result ??= await found.resolve({ ...value, stage });
        } catch (cause) {
          // Only the selected dependency's metadata can exclude it. A failure
          // while verifying a different installed release must still block.
          if (
            depth &&
            value.type === "mod" &&
            cause.code === "CLIENT_ONLY_CONTENT"
          ) {
            skipClientDependency(cause.title);
            return;
          }
          if (
            !depth ||
            (cause.code !== "INCOMPATIBLE_VERSION" && cause.status !== 404) ||
            (cause.code === "INCOMPATIBLE_VERSION" &&
              !found.compatibleDependencyVersion)
          )
            throw cause;
          recoveringDependency = true;
          let compatible =
            cause.status === 404
              ? null
              : await found.compatibleDependencyVersion(value);
          if (!compatible) {
            const candidates = (await found.versions(value)).filter(
              (version) =>
                version.downloadable !== false &&
                (!version.channel || version.channel === "release"),
            );
            compatible = candidates.sort(
              (a, b) =>
                (({ release: 0, beta: 1, alpha: 2 })[a.channel] ?? 0) -
                  ({ release: 0, beta: 1, alpha: 2 }[b.channel] ?? 0) ||
                (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
            )[0];
            if (!compatible) {
              const decision = decisionFor(value, requiredBy);
              decision.warning = `${decision.title}, required by ${requiredBy}, has no compatible downloadable release. Install a compatible copy manually or explicitly proceed without it.`;
              warnDependency(value, requiredBy, decision.warning);
              return;
            }
            warnDependency(
              value,
              requiredBy,
              `${value.projectId}, required by ${requiredBy}: pinned ${value.versionId} is unavailable for this runtime. This review substitutes ${compatible.name || compatible.id}; confirm the change before installing.`,
            );
          }
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
          visited.get(key) === String(value.versionId) &&
          !preservedDependencies.has(key)
        ) {
          const decision = dependencyDecisions.get(key);
          if (
            decision &&
            requiredBy &&
            !decision.requiredBy.includes(requiredBy)
          )
            decision.requiredBy.push(requiredBy);
          return;
        }
        if (
          depth &&
          value.type === "mod" &&
          key !== `${input.platform}:${input.projectId}` &&
          !preservedDependencies.has(key)
        ) {
          let existing = local.find(
            (item) =>
              item.active !== false &&
              item.platform === value.platform &&
              item.projectId === value.projectId,
          );
          if (!existing && result.files?.length === 1) {
            const [algorithm, expected] = strongestHash(result.files[0].hashes);
            for (const item of local.filter(
              (item) =>
                item.active !== false && item.size === result.files[0].size,
            )) {
              const digest =
                algorithm === "sha512"
                  ? item.sha512
                  : await fileHash(
                      await safePath(serverDir, item.path),
                      algorithm,
                      input.signal,
                    );
              if (digest?.toLowerCase() === expected.toLowerCase()) {
                existing = {
                  ...item,
                  platform: value.platform,
                  projectId: value.projectId,
                  versionId: value.versionId,
                  versionName: result.versionName,
                };
                break;
              }
            }
          }
          if (!existing && result.files?.length === 1 && rootIsActive) {
            try {
              localDeclarations ??= mapReview(
                local.filter((item) => item.active !== false),
                async (item) => {
                  const metadata = await inspectInstalledMod(
                    await safePath(serverDir, item.path),
                    { loader: input.loader, signal: input.signal },
                  ).catch(() => null);
                  return metadata ? { item, metadata } : null;
                },
                input.signal,
              );
              const declarations = (await localDeclarations).filter(Boolean);
              const candidate = declarations.length
                ? await metadataFor(result.files[0])
                : null;
              for (const { item, metadata } of declarations) {
                if (
                  metadata.provided.some((id) =>
                    candidate.provided.includes(id),
                  )
                ) {
                  if (existing)
                    throw error(
                      409,
                      `Multiple installed files provide ${candidate.provided.join(", ")}. Remove duplicate mods first.`,
                    );
                  existing = item;
                }
              }
            } catch (cause) {
              input.signal.throwIfAborted();
              if (cause.status === 409) throw cause;
              warnings.push(
                `Could not compare installed mod identities for ${result.title}: ${cause.message}`,
              );
            }
          }
          const decision = decisionFor(value, requiredBy, existing, result);
          if (existing && decision.choice === "keep-installed")
            result =
              (await preserveInstalled(
                found,
                value,
                parentFiles,
                requiredBy,
                existing,
                result,
              )) ?? result;
          else if (existing && decision.choice === "use-proposed") {
            for (const file of result.files ?? [])
              file.replaceInstalledPath = existing.path;
            warnings.push(
              `${result.title}: you selected ${result.versionName || value.versionId} instead of the installed ${existing.versionName || existing.versionId}.`,
            );
          }
        }
        if (visited.has(key)) {
          if (visited.get(key) !== String(value.versionId)) {
            const decision = decisionFor(value, requiredBy, null, result);
            decision.status = "conflict";
            decision.warning = `${decision.title} is required at both ${visited.get(key)} and ${value.versionId} by ${decision.requiredBy.join(", ")}. This review uses ${visited.get(key)}. Confirm only if you accept the compatibility risk, or skip this dependency.`;
            warnDependency(value, requiredBy, decision.warning);
          }
          return;
        }
        visited.set(key, String(value.versionId));
      } catch (cause) {
        if (
          depth &&
          cause.status === 400 &&
          /no compatible downloadable version/.test(cause.message)
        ) {
          const decision = decisionFor(value, requiredBy);
          decision.warning = cause.message;
          warnDependency(value, requiredBy, cause.message);
          return;
        }
        if (cause.status !== 404) throw cause;
        const key = `${value.platform}:${value.projectId}`;
        if (visited.has(key) && visited.get(key) !== String(value.versionId)) {
          const decision = decisionFor(value, requiredBy);
          decision.status = "conflict";
          warnDependency(
            value,
            requiredBy,
            `${decision.title}, required by ${decision.requiredBy.join(", ")}, requests unavailable ${value.versionId}. This review keeps ${visited.get(key)}; acknowledge the compatibility risk before installing.`,
          );
          return;
        }
        if (!depth)
          throw error(
            404,
            `${found.name} could not find the selected project or version. Refresh its versions and choose another release.`,
          );
        // Missing catalog entries can be checked for bundled dependencies.
        // Known incompatible dependencies must be resolved or block the plan.
        const decision = decisionFor(value, requiredBy);
        decision.warning = `${decision.title}, required by ${requiredBy}, is no longer available from ${found.name}. Choose another release or acknowledge proceeding without it.`;
        warnDependency(value, requiredBy, decision.warning);
        return;
      }
      for (const conflict of result.incompatibilities ?? [])
        declaredConflicts.push({
          ...conflict,
          requiredBy: result.title,
          source: value,
        });
      if (depth && result.channel && result.channel !== "release")
        warnDependency(
          value,
          requiredBy,
          `${result.title} requires a ${result.channel} release. Confirm its prerelease status before installing.`,
        );
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
          platform: file.installedIdentity
            ? file.installedIdentity.platform
            : value.platform,
          projectId: file.installedIdentity
            ? file.installedIdentity.projectId
            : value.projectId,
          versionId: String(
            file.installedIdentity?.versionId ?? value.versionId,
          ),
          versionName: file.versionName ?? result.versionName,
          installReason: depth ? "dependency" : "requested",
          requiredBy: requiredBy ? [requiredBy] : [],
          title: result.title,
          iconUrl: result.iconUrl,
          author: result.author,
          authorLinks: result.authorLinks,
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
    for (const conflict of declaredConflicts) {
      if (!conflict.projectId && conflict.versionId) {
        const found = await provider(conflict.platform);
        try {
          conflict.projectId = (
            await found.version?.(conflict.versionId, input.signal)
          )?.project_id;
        } catch {
          input.signal.throwIfAborted();
        }
      }
      const plannedKeys = new Set(
        files.map((file) => `${file.platform}:${file.projectId}`),
      );
      const after = [
        ...local.filter(
          (item) =>
            item.active !== false &&
            !plannedKeys.has(`${item.platform}:${item.projectId}`),
        ),
        ...files,
      ];
      const match = after.find(
        (item) =>
          item.platform === conflict.platform &&
          item.projectId === conflict.projectId &&
          (!conflict.versionId || item.versionId === conflict.versionId),
      );
      if (match)
        warnDependency(
          conflict.source,
          conflict.requiredBy,
          `${conflict.requiredBy} declares an incompatibility with ${match.title || match.path}. Confirm only if you accept the risk of startup failure.`,
        );
    }

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
      authorLinks: rootMetadata.authorLinks,
      url: rootMetadata.projectUrl ?? projectUrl(rootResult.url),
      files,
      warnings,
      unavailableDependencies,
      dependencyDecisions: [...dependencyDecisions.values()],
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
          curseforgeKey: key,
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
    const hashes = await fileHashes(
      target,
      [algorithm, "sha512"],
      signal,
      maximum,
    );
    if (
      (file.size != null && size !== file.size) ||
      hashes[algorithm] !== expected
    )
      throw error(
        502,
        "A staged download failed its size or checksum check. No server files were changed.",
      );
    return {
      size,
      sha512: hashes.sha512,
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
        { signal: input.signal, curseforgeKey: key },
      );
    const extracted = path.join(stage, "archive");
    await fs.mkdir(extracted);
    const entries = (
      await unpackProviderZip(archive, extracted, undefined, {
        signal: input.signal,
      })
    ).filter(
      (entry) =>
        !/(?:^|\/)__MACOSX(?:\/|$)|(?:^|\/)\.DS_Store$|(?:^|\/)\._/.test(
          entry.path,
        ),
    );
    const protectedFile = (name) => name.toLowerCase() === "eula.txt";
    const files = [],
      warnings = [];
    let loaderInstall, clientManifest, clientManifestFormat;
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
      // Keep the author's client manifest, including client-only dependencies.
      // Export code must still filter paths and never include live server data.
      clientManifest = manifest;
      clientManifestFormat = "modrinth";
      const loaderKeys = {
        "fabric-loader": "fabric",
        "quilt-loader": "quilt",
        forge: "forge",
        neoforge: "neoforge",
      };
      const declared = Object.keys(loaderKeys).filter(
        (key) => manifest.dependencies?.[key],
      );
      const detectedRuntime =
        declared.length === 1
          ? {
              loader: loaderKeys[declared[0]],
              gameVersion: manifest.dependencies?.minecraft,
              loaderVersion: String(manifest.dependencies[declared[0]]),
            }
          : undefined;
      if (manifest.dependencies?.minecraft !== input.gameVersion)
        throw Object.assign(
          error(
            400,
            "The pack manifest requires a different Minecraft version. Review its detected runtime before installing.",
          ),
          { detectedRuntime },
        );
      if (declared.length !== 1 || loaderKeys[declared[0]] !== input.loader)
        throw Object.assign(
          error(
            400,
            "The pack's required loader does not match the selected loader.",
          ),
          { detectedRuntime },
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
            "github.com",
            "raw.githubusercontent.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com",
            "gitlab.com",
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
      const clientIndex = entries.find(
        (entry) =>
          /(?:^|\/)manifest\.json$/i.test(entry.path) &&
          entry.size <= 4 * 1024 ** 2,
      );
      if (clientIndex) {
        try {
          const manifest = JSON.parse(
            await fs.readFile(clientIndex.stagedPath, "utf8"),
          );
          if (
            manifest.manifestType === "minecraftModpack" &&
            manifest.manifestVersion === 1 &&
            Array.isArray(manifest.files) &&
            manifest.files.length <= 10000
          ) {
            clientManifest = manifest;
            clientManifestFormat = "curseforge";
          }
        } catch {
          warnings.push(
            "The pack's client manifest could not be read; client export will need verified catalog metadata.",
          );
        }
      }
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
    return {
      files,
      warnings,
      loaderInstall,
      clientManifest,
      clientManifestFormat,
    };
  }
  async function reviewRuntimeRequirements(input, stage, files, warnings) {
    if (ctx.reviewRuntimeRequirements)
      return ctx.reviewRuntimeRequirements(input, stage, files, warnings);
    if (input.type !== "mod") return [];
    const current = await getServer();
    const issues = [];
    const candidates = files.filter((file) => !/\.disabled$/i.test(file.path));
    if (
      candidates.reduce((sum, file) => sum + (file.size ?? 0), 0) >
      2 * 1024 ** 3
    )
      throw error(400, "This installation exceeds the 2 GB total size limit.");
    let java;
    await mapReview(
      candidates,
      async (file, index) => {
        if (!file.stagedPath) {
          file.stagedPath = path.join(
            stage,
            `runtime-requirements-${index}.jar`,
          );
          await downloadVerified(file, file.stagedPath, file.hosts, request, {
            signal: input.signal,
            curseforgeKey: key,
          });
        }
        await verifyStaged(file, stage, input.signal);
        let metadata;
        try {
          metadata = await inspectInstalledMod(file.stagedPath, {
            loader: input.loader,
            signal: input.signal,
            includeRuntime: true,
          });
        } catch (cause) {
          input.signal.throwIfAborted();
          warnings.push(
            `Runtime requirements in ${file.path} could not be inspected: ${cause.message}`,
          );
          return;
        }
        for (const { id, range } of metadata.requirements) {
          if (
            !metadata.required.includes(id) ||
            ![
              "forge",
              "neoforge",
              "fabricloader",
              "quilt_loader",
              "javafml",
              "minecraft",
              "java",
            ].includes(id)
          )
            continue;
          let installed =
            id === "minecraft"
              ? current.gameVersion
              : id === "javafml" && input.loader === "forge"
                ? current.loaderVersion?.split(".")[0]
                : id === "fabricloader" && input.loader === "quilt"
                  ? undefined
                  : current.loaderVersion;
          if (id === "java") {
            java ??= Promise.resolve(
              ctx.probeJava?.(ctx.getConfiguration?.().javaPath) ??
                probeJava(ctx.getConfiguration?.().javaPath ?? "java", {
                  timeoutMs: 2000,
                }),
            );
            const runtime = await java;
            installed = runtime.available
              ? String(runtime.majorVersion)
              : undefined;
          }
          if (
            installed &&
            updateDependencySatisfies(String(installed), range, input.loader)
          )
            continue;
          const status =
            !installed ||
            typeof range !== "string" ||
            !/^(?:[[(]|[><=~^*0-9])/.test(range)
              ? "unverified"
              : "incompatible";
          const issue = {
            mod: metadata.title || file.title || file.path,
            path: file.path,
            id,
            range,
            installed: installed ?? null,
            status,
          };
          issues.push(issue);
          warnings.push(
            `${issue.mod} requires ${id} ${JSON.stringify(range ?? "any version")}; installed ${installed ?? "version unknown"}. ${status === "unverified" ? "Compatibility could not be checked" : "This requirement may not be satisfied"}. Update the runtime in Versions or acknowledge installing anyway.`,
          );
        }
      },
      input.signal,
    );
    return issues;
  }
  async function reviewUpdatedDependencies(
    input,
    stage,
    local,
    files,
    warnings,
  ) {
    if (
      input.type !== "mod" ||
      !files.some((file) => file.action === "replace")
    )
      return;
    const replaced = new Set(
      files.flatMap((file) =>
        [file.expected ? file.path : null, file.previous?.path].filter(Boolean),
      ),
    );
    const inspect = async (source, row) => {
      try {
        return {
          row: {
            ...row,
            ...(await inspectInstalledMod(source, {
              loader: input.loader,
              signal: input.signal,
            })),
          },
        };
      } catch (cause) {
        input.signal.throwIfAborted();
        return {
          row,
          warning: `Dependency requirements in ${row.path} could not be verified: ${cause.message}`,
        };
      }
    };
    const inspected = await mapReview(
      local.filter((row) => row.active !== false),
      async (row) => inspect(await safePath(serverDir, row.path), row),
      input.signal,
    );
    const before = inspected.map((value) => value.row);
    warnings.push(
      ...inspected.flatMap((value) => (value.warning ? [value.warning] : [])),
    );
    const knownProviders = new Set(before.flatMap((row) => row.provided ?? []));
    const affected = new Set(
      before
        .filter((row) => replaced.has(row.path))
        .flatMap((row) => row.provided ?? []),
    );
    // Unrelated, already missing requirements do not become new update warnings.
    // New declarations in a combined dependent update must also be inspected.
    if (!affected.size) return;
    const after = before.filter((row) => !replaced.has(row.path));
    if (
      files.reduce((total, file) => total + (file.size ?? 0), 0) >
      2 * 1024 ** 3
    )
      throw error(400, "This installation exceeds the 2 GB total size limit.");
    let downloaded = 0;
    const candidates = await mapReview(
      files.filter((file) => !/\.disabled$/i.test(file.path)),
      async (file, index) => {
        if (!file.stagedPath) {
          const source = path.join(stage, `update-dependency-${index}.jar`);
          await downloadVerified(file, source, file.hosts, request, {
            signal: input.signal,
            curseforgeKey: key,
          });
          file.stagedPath = source;
        }
        const verified = await verifyStaged(file, stage, input.signal);
        if ((downloaded += verified.size) > 2 * 1024 ** 3)
          throw error(
            400,
            "This installation exceeds the 2 GB total size limit.",
          );
        return inspect(file.stagedPath, file);
      },
      input.signal,
    );
    for (const { row, warning } of candidates) {
      if (warning) warnings.push(warning);
      after.push(row);
      // Updating a dependent can tighten its requirements without changing
      // the provider. Check known local providers even if the catalog omitted
      // that dependency; unrelated pre-existing missing requirements stay out.
      for (const id of row.required ?? [])
        if (knownProviders.has(id)) affected.add(id);
    }
    warnings.push(
      ...updatedModDependencyWarnings(before, after, affected, input.loader),
    );
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
    if (active || preparingInstall || removal.busy || activation.busy)
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
    const ownerId = raw.ownerId ?? "local-owner";
    if (
      [...plans.values()].filter((plan) => plan.ownerId === ownerId).length >= 8
    )
      throw error(
        429,
        "You have eight open installation reviews. Close an earlier review before creating another.",
      );
    if (plans.size >= 64)
      throw error(
        429,
        "Too many installation reviews are open. Try again after another review finishes.",
      );
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
    let roots = bulk
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
                resolutions: raw.resolutions,
              },
              true,
            ),
            replacePath: safeInstallPath(value.replacePath),
          };
        })
      : [{ ...selection(raw, true), replacePath: raw.replacePath }];
    const skippedUpdates = [];
    const uniqueRoots = new Map();
    for (const root of roots) {
      const key = `${root.platform}:${root.projectId}`;
      if (uniqueRoots.has(key)) {
        skippedUpdates.push({
          platform: root.platform,
          projectId: root.projectId,
          title: root.projectId,
          reason:
            "A second copy of this project was omitted from the update selection.",
        });
      } else uniqueRoots.set(key, root);
    }
    roots = [...uniqueRoots.values()];
    const input = roots[0];
    input.signal.throwIfAborted();
    await assertCompatibility(input);
    const found = await provider(input.platform);
    const planId = randomUUID();
    const stage = await privatePath(planId);
    await fs.mkdir(stage);
    preparingStages.add(planId);
    try {
      // Capture before identification: new paths must not silently expand an
      // approved replacement, even when another client uploads the same project.
      const inventorySnapshot = await snapshotInventory(
        input.type,
        input.signal,
      );
      const identified =
        input.type === "modpack"
          ? { items: [], warnings: [] }
          : await installed({ ...input, identityOnly: true });
      const local = identified.items;
      for (const root of roots) {
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
      }
      let resolvedFileCount = 0;
      const treeResults = await mapReview(
        roots,
        async (root, index) => {
          const rootStage = bulk ? path.join(stage, `item-${index}`) : stage;
          if (bulk) await fs.mkdir(rootStage);
          try {
            if (
              bulk &&
              local.find((item) => item.path === root.replacePath)?.updateHeld
            )
              throw error(
                400,
                "This installed version is held. Allow updates before including it in Update all.",
              );
            const tree = await resolveTree(
              { ...root, selectedUpdates: bulk ? roots : undefined },
              rootStage,
              local,
            );
            if (bulk && tree.archive)
              throw error(
                400,
                "Modpacks require their own clean installation review.",
              );
            resolvedFileCount += tree.files.length;
            if (resolvedFileCount > 10000)
              throw error(
                400,
                "This update selection contains too many files.",
              );
            return { root, tree };
          } catch (cause) {
            input.signal.throwIfAborted();
            // Destination, identity, checksum and concurrency failures remain
            // hard stops. A catalog/dependency failure can skip that update.
            if (
              !bulk ||
              ![400, 404, 429, 502].includes(cause.status) ||
              /invalid.*(?:path|file|hash)|checksum|verification|size limit|too many files|unsafe|outside|destination/i.test(
                cause.message,
              )
            )
              throw cause;
            skippedUpdates.push({
              platform: root.platform,
              projectId: root.projectId,
              title:
                local.find((item) => item.path === root.replacePath)?.title ||
                root.projectId,
              reason: cause.message,
            });
            return null;
          }
        },
        input.signal,
      );
      const trees = treeResults.filter(Boolean).map(({ tree }) => tree);
      if (bulk) roots = treeResults.filter(Boolean).map(({ root }) => root);
      const result = trees[0]
        ? { ...trees[0] }
        : {
            files: [],
            title: "No updates ready",
            warnings: [],
            unavailableDependencies: [],
            dependencyDecisions: [],
            bundledDependencies: [],
            recoveredDependencies: new Set(),
          };
      if (bulk) {
        const files = new Map(),
          versions = new Map();
        const acceptedTrees = [],
          acceptedRoots = [];
        for (const tree of trees) {
          const conflict = tree.files.find(
            (file) =>
              versions.has(`${file.platform}:${file.projectId}`) &&
              versions.get(`${file.platform}:${file.projectId}`) !==
                file.versionId,
          );
          if (conflict) {
            const treeIndex = trees.indexOf(tree),
              root = roots[treeIndex];
            skippedUpdates.push({
              platform: root.platform,
              projectId: root.projectId,
              title: tree.title || root.projectId,
              reason: `${conflict.title || conflict.projectId} requires a different version (${conflict.versionName || conflict.versionId}) from another selected update. Review this item separately or keep its installed dependency.`,
            });
            continue;
          }
          acceptedTrees.push(tree);
          acceptedRoots.push(roots[trees.indexOf(tree)]);
          for (const file of tree.files) {
            const project = `${file.platform}:${file.projectId}`;
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
            else {
              previous.requiredBy = [
                ...new Set([
                  ...(previous.requiredBy ?? []),
                  ...(file.requiredBy ?? []),
                ]),
              ];
              if (file.installReason === "requested")
                previous.installReason = "requested";
            }
          }
        }
        result.files = [...files.values()];
        roots = acceptedRoots;
        result.title = `${roots.length} content updates`;
        result.versionName = "Reviewed together";
        result.warnings = acceptedTrees.flatMap((tree) => tree.warnings);
        const decisions = new Map();
        for (const decision of acceptedTrees.flatMap(
          (tree) => tree.dependencyDecisions,
        )) {
          const previous = decisions.get(decision.key);
          decisions.set(
            decision.key,
            previous
              ? {
                  ...previous,
                  requiredBy: [
                    ...new Set([
                      ...previous.requiredBy,
                      ...decision.requiredBy,
                    ]),
                  ],
                  status:
                    previous.status === "conflict" ||
                    decision.status === "conflict"
                      ? "conflict"
                      : previous.status === "unverified" ||
                          decision.status === "unverified"
                        ? "unverified"
                        : "compatible",
                  warning:
                    [previous.warning, decision.warning]
                      .filter(Boolean)
                      .join(" ") || undefined,
                }
              : decision,
          );
        }
        result.dependencyDecisions = [...decisions.values()];
        result.unavailableDependencies = acceptedTrees.flatMap(
          (tree) => tree.unavailableDependencies,
        );
        result.recoveredDependencies = new Set(
          acceptedTrees.flatMap((tree) => [...tree.recoveredDependencies]),
        );
      }
      for (const key of Object.keys(raw.resolutions ?? {})) {
        if (
          !result.dependencyDecisions?.some((decision) => decision.key === key)
        )
          throw error(
            400,
            `The dependency resolution ${key} is not part of this review.`,
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
            authorLinks: result.authorLinks,
            versionName: result.versionName,
            type: input.type,
            hosts: file.hosts ?? found.downloadHosts,
          })),
        );
        result.warnings.push(...pack.warnings);
        result.loaderInstall = pack.loaderInstall ?? result.loaderInstall;
        result.clientManifest = pack.clientManifest;
        result.clientManifestFormat = pack.clientManifestFormat;
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
      if ((!bulk && !result.files.length) || result.files.length > 10000)
        throw error(
          400,
          "This selection contains no supported server files or too many files.",
        );
      const paths = new Set();
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
        if (!file.stagedPath && !file.preserveInstalled) {
          strongestHash(file.hashes);
          checkedProviderUrl(file.url, file.hosts);
        }
      }
      const compared = await mapReview(
        result.files,
        async (file) => {
          if (input.type === "modpack") {
            return {
              file: {
                ...file,
                expected: null,
                previous: null,
                action: "install",
              },
            };
          }
          const selectedRoot = roots.find(
            (root) =>
              root.platform === file.platform &&
              root.projectId === file.projectId,
          );
          const matches = local.filter((item) =>
            file.preserveInstalled
              ? item.path === file.path
              : file.replaceInstalledPath
                ? item.path === file.replaceInstalledPath
                : item.platform === file.platform &&
                  item.projectId === file.projectId &&
                  (selectedRoot?.replacePath?.endsWith(".disabled")
                    ? item.path === selectedRoot.replacePath
                    : item.active !== false),
          );
          if (matches.length > 1)
            throw error(
              409,
              `Multiple installed files match this project: ${matches.map((item) => item.path).join(", ")}. Remove the duplicate before updating.`,
            );
          let oldPath = matches[0]?.path;
          // Case-only provider renames refer to one path on Windows/macOS.
          if (
            oldPath &&
            oldPath !== file.path &&
            oldPath.toLowerCase() === file.path.toLowerCase()
          ) {
            const [oldStat, newStat] = await Promise.all(
              [oldPath, file.path].map(async (relative) =>
                fs
                  .stat(await safePath(serverDir, relative), { bigint: true })
                  .catch((cause) => {
                    if (missing(cause)) return null;
                    throw cause;
                  }),
              ),
            );
            if (
              oldStat &&
              newStat &&
              oldStat.ino === newStat.ino &&
              oldStat.dev === newStat.dev
            )
              file.path = oldPath;
          }
          if (selectedRoot?.replacePath) {
            if (oldPath !== selectedRoot.replacePath)
              throw error(
                409,
                `The selected installed file could not be verified as this project. ${identified.warnings.length ? identified.warnings.join(" ") + " " : ""}Refresh installed files.`,
              );
            oldPath = selectedRoot.replacePath;
          }
          // Updating an inactive mod keeps the new release inactive too.
          if (
            ["mod", "plugin"].includes(input.type) &&
            matches[0]?.active === false &&
            /\.jar$/i.test(file.path)
          )
            file.path += ".disabled";
          const target = await safePath(serverDir, file.path);
          const current = await statOrNull(target);
          if (current && !current.isFile())
            throw error(
              409,
              `The destination ${file.path} is not a regular file.`,
            );
          const [algorithm, requiredHash] = strongestHash(file.hashes);
          const currentHashes = current
            ? await fileHashes(target, ["sha512", algorithm], input.signal)
            : null;
          const expected = currentHashes?.sha512 ?? null;
          let previous = null;
          let previousHashes = null;
          if (oldPath && oldPath !== file.path) {
            previousHashes = await fileHashes(
              await safePath(serverDir, oldPath),
              ["sha512", algorithm],
              input.signal,
            );
            previous = {
              path: oldPath,
              sha512: previousHashes.sha512,
            };
          }
          if (
            matches[0] &&
            (previous?.sha512 ?? expected) !== matches[0].sha512
          )
            throw error(
              409,
              "The installed file changed after identification. Refresh installed files and review the update again.",
            );
          // Compare bytes, not names or version labels. A verified package may
          // have been renamed locally; keep it in place when the provider's
          // destination is absent so the update cannot create a duplicate JAR.
          const existingPath = previous && !current ? previous.path : file.path;
          const existingHash =
            previous && !current ? previous.sha512 : expected;
          if (existingHash && (!previous || !current)) {
            const actualHash = (
              previous && !current ? previousHashes : currentHashes
            )[algorithm];
            if (actualHash === requiredHash) {
              // Retain both the existing file and absent destination snapshots
              // for the final pre-mutation check, even though neither is listed
              // as a change or passed to the download/promotion loops.
              return {
                unchanged: true,
                file: {
                  ...file,
                  expected,
                  previous,
                  installedPath: existingPath,
                  installedHash: existingHash,
                },
              };
            }
          }
          if (file.preserveInstalled)
            throw error(
              409,
              `${file.path} changed since its dependency requirements were checked. Review the installation again.`,
            );
          return {
            file: {
              ...file,
              author: file.author || matches[0]?.author,
              authorLinks: file.authorLinks || matches[0]?.authorLinks,
              expected,
              previous,
              action: expected || previous ? "replace" : "install",
              installedVersion:
                matches[0]?.versionName || matches[0]?.versionId || null,
              previousVersionId: matches[0]?.versionId,
              previousVersionName: matches[0]?.versionName,
              proposedVersion: file.versionName || file.versionId,
              direction:
                matches[0]?.versionId === file.versionId
                  ? "unchanged"
                  : "different-release",
            },
          };
        },
        input.signal,
      );
      const files = compared
        .filter((value) => !value.unchanged)
        .map((value) => value.file);
      const unchanged = compared
        .filter((value) => value.unchanged)
        .map((value) => value.file);
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
      await reviewUpdatedDependencies(
        input,
        stage,
        local,
        files,
        result.warnings,
      );
      const runtimeRequirements = await reviewRuntimeRequirements(
        input,
        stage,
        files,
        result.warnings,
      );
      await inspectUnavailableDependencies(result, input, stage);
      await assertReviewedInventory({ input, inventorySnapshot }, input.signal);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const plan = {
        ownerId,
        id: planId,
        input,
        stage,
        files,
        unchanged,
        inventorySnapshot,
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
        authorLinks:
          result.authorLinks ||
          receipts.find(
            (item) =>
              item.pack &&
              item.platform === input.platform &&
              item.projectId === input.projectId,
          )?.authorLinks,
        versionName: result.versionName,
        warnings: [...new Set(result.warnings)],
        unavailableDependencies: result.unavailableDependencies,
        dependencyDecisions: result.dependencyDecisions ?? [],
        skippedUpdates,
        runtimeRequirements,
        bundledDependencies: result.bundledDependencies.filter((dependency) =>
          files.some((file) => file.path === dependency.bundledWith),
        ),
        loaderInstall: result.loaderInstall,
        runtime,
        clientManifest: result.clientManifest,
        clientManifestFormat: result.clientManifestFormat,
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
          title: file.title || file.path,
          size: file.size,
          action: file.action,
          previousPath: file.previous?.path,
          installedVersion: file.installedVersion,
          proposedVersion: file.proposedVersion,
          direction: file.direction,
          installReason: file.installReason,
          requiredBy: file.requiredBy ?? [],
        })),
        warnings: plan.warnings,
        unavailableDependencies: plan.unavailableDependencies,
        dependencyDecisions: plan.dependencyDecisions,
        skippedUpdates: plan.skippedUpdates,
        runtimeRequirements: plan.runtimeRequirements,
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
    } finally {
      preparingStages.delete(planId);
    }
  }
  async function promote(plan, job) {
    if (plan.input.type === "modpack") return promotePack(plan, job);
    {
      lifetime.signal.throwIfAborted();
      await assertCompatibility(plan.input);
      const runtimeRequirements = await reviewRuntimeRequirements(
        plan.input,
        plan.stage,
        plan.files,
        [],
      );
      if (runtimeRequirements.length && !plan.acknowledgedRuntimeRequirements)
        throw error(
          409,
          "The runtime changed after review. Review its requirements and acknowledge before installing.",
        );
      await assertPackRuntime(plan.loaderInstall);
      if ((await getServer()).status !== "offline")
        throw error(409, "Stop the server before installing content.");
      lifetime.signal.throwIfAborted();
      const previousReceipts = [...receipts];
      const recovered = [],
        promoted = [];
      job.recoveryEntries = recovered;
      // Validate the entire reviewed snapshot before making any server changes.
      await assertReviewedInventory(plan);
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
        await recovery.begin({
          job: { ...job },
          planId: plan.id,
          files: plan.files.map((file) => ({
            path: file.path,
            sha512: file.sha512,
          })),
          originals: plan.files.flatMap((file) =>
            [file.expected ? file.path : null, file.previous?.path].filter(
              Boolean,
            ),
          ),
          receipts: previousReceipts,
        });
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
          const previousReceipt = previousReceipts.find(
            (item) => item.path === (file.previous?.path ?? file.path),
          );
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
              authorLinks: file.authorLinks,
              url: file.projectUrl,
              type: file.type,
              installedAt: new Date().toISOString(),
              installReason: file.installReason ?? "requested",
              requiredBy: file.requiredBy ?? [],
              downloadUrl: file.url,
              hashes: file.hashes,
              environment: file.environment,
              previousVersionId:
                previousReceipt?.versionId ?? file.previousVersionId,
              previousVersionName:
                previousReceipt?.versionName ?? file.previousVersionName,
              updateHeld: previousReceipt?.updateHeld === true,
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
        await history.save(
          {
            jobId: job.id,
            kind: plan.files.some((file) => file.action === "replace")
              ? "update"
              : "install",
            title: plan.title,
            createdAt: job.createdAt,
            written: plan.files.map(({ path, sha512 }) => ({ path, sha512 })),
            recycled: recovered,
            receipts: previousReceipts,
            afterReceipts: receipts,
          },
          recovery.get(),
        );
        job.undoAvailable = true;
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
      await prepareCleanSettings(runtime, {
        ...ctx,
        preserveWorld: plan.input.preserveWorld !== false,
      });
      await recovery.begin({
        job: { ...job },
        planId: plan.id,
        wholeRoot: true,
        preservedPaths: runtime.preserveExistingPaths ?? [],
        files: await mapReview(
          runtime.files,
          async (file) => ({
            path: file.path,
            sha512: await fileHash(await safePath(runtime.stageDir, file.path)),
          }),
          lifetime.signal,
        ),
        receipts: previousReceipts,
        configuration: previousConfiguration,
      });
      let configured = false;
      const clearCaches = () => {
        fileCache.clear();
        identities.clear();
        metadataCache?.clear();
        updateCache.clear();
        updateFailures.clear();
      };
      const packRecovery = await cleanInstall(runtime, {
        ...ctx,
        preserveWorld: plan.input.preserveWorld !== false,
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
              authorLinks: plan.authorLinks,
              url: plan.url,
              versionName: plan.versionName,
              clientManifest: plan.clientManifest,
              clientManifestFormat: plan.clientManifestFormat,
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
      Object.assign(job, packRecovery);
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
    if (recoveryRequired)
      throw error(
        409,
        "Resolve the interrupted Launchpad installation before installing content.",
      );
    if (input?.confirmed !== true)
      throw error(
        400,
        "Review the exact file changes and confirm the installation first.",
      );
    if (active || preparingInstall || removal.busy || activation.busy)
      throw error(409, "Another Launchpad installation is already running.");
    if ((noOpReviews.get(input?.planId) ?? 0) > Date.now())
      throw error(
        409,
        "All reviewed files are already up to date. No installation is needed.",
      );
    const plan = plans.get(input?.planId);
    if (
      !plan ||
      plan.ownerId !== (input.ownerId ?? "local-owner") ||
      Date.parse(plan.expiresAt) < Date.now()
    ) {
      if (plan && plan.ownerId === (input.ownerId ?? "local-owner"))
        await cancelPreview(plan.id);
      throw error(
        409,
        "This review expired. Review the version again before installing.",
      );
    }
    if (plan.input.type === "modpack" && input.cleanInstall !== true)
      throw error(
        400,
        plan.input.preserveWorld !== false
          ? "Confirm the pack update: mods and pack settings will be replaced; your worlds and access settings will be preserved."
          : "Confirm the clean installation: current worlds, mods and pack configuration will be replaced.",
      );
    if (
      plan.unavailableDependencies?.length &&
      input.acknowledgedUnavailableDependencies !== true
    )
      throw error(
        400,
        "Review the unavailable required dependencies and confirm that you will manage them yourself before installing.",
      );
    if (
      plan.runtimeRequirements?.length &&
      input.acknowledgedRuntimeRequirements !== true &&
      input.acknowledgedUnavailableDependencies !== true
    )
      throw error(
        400,
        "Acknowledge the runtime requirements before installing anyway.",
      );
    plan.acknowledgedRuntimeRequirements =
      input.acknowledgedRuntimeRequirements === true ||
      input.acknowledgedUnavailableDependencies === true;
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
      planId: plan.id,
      status: "queued",
      cancellable: true,
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
          // Runs under the shared mutation lock on initial confirmation and
          // every download retry; promotion checks again after downloads.
          await assertReviewedInventory(plan);
          let downloaded = 0;
          let transferFailure = null,
            verifiedCount = 0;
          try {
            await parallelTransfers(
              plan.files,
              async (file, index, signal) => {
                let filePhase = "verify";
                try {
                  signal.throwIfAborted();
                  if (!file.stagedPath) {
                    filePhase = "download";
                    const destination = path.join(
                      plan.stage,
                      `download-${index}`,
                    );
                    await downloadVerified(
                      file,
                      destination,
                      file.hosts,
                      request,
                      {
                        signal,
                        curseforgeKey: key,
                      },
                    );
                    file.stagedPath = destination;
                  }
                  filePhase = "verify";
                  const verified = await verifyStaged(file, plan.stage, signal);
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
                  job.message = `Verified ${++verifiedCount} of ${plan.files.length} files…`;
                } catch (cause) {
                  transferFailure ??= { path: file.path, phase: filePhase };
                  throw cause;
                }
              },
              controller.signal,
            );
          } catch (cause) {
            failedFile = transferFailure?.path;
            phase = transferFailure?.phase ?? "verify";
            throw cause;
          }
          controller.signal.throwIfAborted();
          phase = "promote";
          job.cancellable = false;
          await promote(plan, job);
          await recovery.commit();
          await history.prune().catch(() => {});
          removal.invalidate();
          outcome = {
            status: "completed",
            message: `${plan.title} installed.${plan.files.some((file) => file.action === "replace") ? " Replaced files remain recoverable in Recycle Bin." : ""}`,
          };
        } catch (cause) {
          if (recovery.get()) {
            const restored = await reconcileInstallation({ publish: false });
            if (restored.ok) {
              cause.message = `${cause.message.replace(/Rollback needs attention[\s\S]*|Recovery needs attention[\s\S]*/, "").trim()} Previous files were restored automatically.`;
              job.message = cause.message;
              delete job.retainedRecoveryPath;
            }
            if (!restored.ok) {
              recoveryRequired = true;
              job.recoveryRequired = true;
              job.retainedRecoveryPath = restored.job.retainedRecoveryPath;
              cause.message += ` Recovery needs attention. ${restored.job.message}`;
            }
          }
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
            cancelled: controller.signal.aborted && !closing,
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
            if (!retained && !recoveryRequired)
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
    active = Promise.resolve(operation)
      .then(
        async (outcome) => {
          const final = {
            ...job,
            ...outcome,
            finishedAt: new Date().toISOString(),
            cancellable: false,
          };
          if (final.status === "failed")
            await ctx
              .audit?.("Content installation failed", final.error, "file")
              .catch(() => {});
          let saved = false;
          await terminal
            ?.save(final)
            .then(() => {
              saved = true;
            })
            .catch(() => {});
          recovery?.release();
          if (
            saved &&
            !recoveryRequired &&
            recovery?.get()?.state === "committed"
          )
            await recovery.clear().catch(() => {});
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
      )
      .catch((cause) => {
        Object.assign(job, {
          status: "failed",
          error: cause.message,
          message:
            "Installation finished, but its completion record could not be saved.",
          finishedAt: new Date().toISOString(),
          cancellable: false,
        });
      })
      .finally(() => {
        active = null;
        activeController = null;
        recovery?.release();
        notifyBusy();
      });
    preparingInstall = false;
    notifyBusy();
    return { job: publicJob(job) };
  }
  async function cancelPreview(id, ownerId) {
    const plan = plans.get(id);
    if (ownerId !== undefined && plan?.ownerId !== ownerId) return { ok: true };
    if (plan && !plan.reserved) {
      plans.delete(id);
      await fs.rm(await privatePath(id), { recursive: true, force: true });
    }
    noOpReviews.delete(id);
    return { ok: true };
  }
  async function dependencies(input = {}) {
    input = selection(input);
    if (
      typeof input.projectId !== "string" ||
      typeof input.versionId !== "string" ||
      !input.projectId ||
      !input.versionId
    )
      throw error(
        400,
        "Choose a project and release for its dependency summary.",
      );
    const found = await provider(input.platform);
    if (!found.types.includes(input.type))
      throw error(400, "This provider does not support this content type.");
    const warnings = [
      "Catalog declarations are advisory. This summary does not download files or validate bundled libraries, loader rules, or runtime compatibility; review installation before making changes.",
    ];
    if (!found.declaredDependencies)
      return {
        summaryIsAdvisory: true,
        declarationsAvailable: false,
        dependencies: [],
        warnings: [
          ...warnings,
          "This provider does not expose a dependency summary for this release.",
        ],
      };
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(12000)]);
    const declared = await abortable(
      found.declaredDependencies({ ...input, signal }),
      signal,
    );
    if (!Array.isArray(declared))
      throw error(502, "The provider returned an invalid dependency summary.");
    if (declared.length > 100)
      warnings.push(
        "Only the first 100 direct catalog dependencies are shown. Installation review checks the complete selection.",
      );
    const inventory =
      ctx.catalogOnly || input.type === "modpack"
        ? { items: [], warnings: [] }
        : await installed({ ...input, local: true, signal });
    warnings.push(...inventory.warnings);
    const rows = await mapReview(
      declared.slice(0, 100),
      async (dependency) => {
        signal.throwIfAborted();
        const row = {
          ...dependency,
          platform: found.id,
          requiredBy: [String(input.projectId)],
          status: "not-identified",
        };
        row.title =
          typeof row.title === "string"
            ? row.title.trim().slice(0, 500)
            : undefined;
        row.relation = [
          "required",
          "optional",
          "incompatible",
          "embedded",
          "tool",
        ].includes(row.relation)
          ? row.relation
          : "unknown";
        if (typeof row.projectId !== "string") delete row.projectId;
        if (typeof row.versionId !== "string") delete row.versionId;
        if (row.versionId && found.version) {
          try {
            const version = await abortable(
              found.version(row.versionId, signal),
              signal,
            );
            if (
              String(version?.id) !== row.versionId ||
              (row.projectId && String(version.project_id) !== row.projectId)
            )
              throw error(
                502,
                "The declared dependency release has a different identity.",
              );
            row.projectId = String(version.project_id);
            row.proposedVersion =
              version.version_number || version.name || row.versionId;
          } catch (cause) {
            signal.throwIfAborted();
            row.status = "unavailable";
            warnings.push(
              `${row.title || row.projectId || row.versionId}: the declared release could not be read (${cause.message}).`,
            );
          }
        }
        const installed = inventory.items.find(
          (item) =>
            item.platform === found.id &&
            row.projectId &&
            item.projectId === row.projectId,
        );
        if (installed) {
          row.status = installed.active === false ? "disabled" : "installed";
          row.installedVersion =
            installed.versionName || installed.versionId || "Unknown version";
          row.installedPath = installed.path;
          row.title = installed.title || row.title;
        }
        if (!row.projectId && !row.versionId) row.status = "unavailable";
        row.title ||= row.projectId || row.versionId || "External dependency";
        return row;
      },
      signal,
      6,
    );
    if (found.projectMetadata) {
      const ids = [
        ...new Set(rows.map((row) => row.projectId).filter(Boolean)),
      ];
      if (ids.length) {
        try {
          const metadata = await abortable(found.projectMetadata(ids), signal);
          for (const row of rows) {
            const project = metadata.projects?.find(
              (value) => String(value.id) === row.projectId,
            );
            if (project?.title) row.title = project.title;
          }
          warnings.push(...(metadata.warnings ?? []));
        } catch (cause) {
          signal.throwIfAborted();
          warnings.push(
            `Some dependency names could not be read: ${cause.message}`,
          );
        }
      }
    }
    return {
      summaryIsAdvisory: true,
      declarationsAvailable: true,
      dependencies: rows,
      warnings: [...new Set(warnings)],
    };
  }
  async function updatePolicy(input = {}) {
    if (typeof input.path !== "string" || typeof input.hold !== "boolean")
      throw error(
        400,
        "Choose an installed file and whether to hold its current version.",
      );
    const relative = safeInstallPath(input.path);
    if (
      active ||
      preparingInstall ||
      removal.busy ||
      activation.busy ||
      ctx.isContentMutationActive?.()
    )
      throw error(409, "Wait for the current content operation to finish.");
    return withMinecraftMutation(async () => {
      const target = await safePath(serverDir, relative),
        stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw error(400, "Choose a regular installed package.");
      const sha512 = await fileHash(target),
        previous = [...receipts];
      const old = receipts.find(
        (row) => row.path === relative && row.sha512 === sha512,
      );
      const type =
        old?.type ??
        (/^mods\/[^/]+\.jar(?:\.disabled)?$/i.test(relative)
          ? "mod"
          : /^plugins\/[^/]+\.jar(?:\.disabled)?$/i.test(relative)
            ? "plugin"
            : /\/datapacks\/[^/]+\.zip$/i.test(relative)
              ? "datapack"
              : null);
      if (!type)
        throw error(400, "Choose an installed mod, plugin, or datapack.");
      replaceReceipts([
        ...receipts.filter((row) => row.path !== relative),
        { ...old, path: relative, sha512, type, updateHeld: input.hold },
      ]);
      try {
        await saveReceipts();
      } catch (cause) {
        replaceReceipts(previous);
        throw cause;
      }
      invalidateCatalogCaches();
      return { ok: true, path: relative, updateHeld: input.hold };
    });
  }
  async function restoreRecycledReceipt(id, restoredPath) {
    for (const record of await history.list()) {
      const recycled = record.recycled.find((entry) => entry.id === id);
      if (!recycled) continue;
      const original = record.originals.find(
        (entry) => entry.path === recycled.path,
      );
      const relative = safeInstallPath(
        restoredPath ?? original?.path ?? recycled.path,
      );
      if (
        !original ||
        (await fileHash(await safePath(serverDir, relative))) !==
          original.sha512
      )
        return { ok: true, restored: false };
      const receipt = record.receipts.find(
        (entry) =>
          entry.path === original.path && entry.sha512 === original.sha512,
      );
      if (!receipt) return { ok: true, restored: false };
      const previous = [...receipts];
      replaceReceipts([
        ...receipts.filter((entry) => entry.path !== relative),
        { ...receipt, path: relative, updateHeld: true },
      ]);
      try {
        await saveReceipts();
      } catch (cause) {
        replaceReceipts(previous);
        throw cause;
      }
      fileCache.delete(relative);
      invalidateCatalogCaches();
      return { ok: true, restored: true };
    }
    return { ok: true, restored: false };
  }
  async function undoJob(id, input = {}) {
    if (input.confirmed !== true)
      throw error(
        400,
        "Confirm undoing this complete Launchpad operation, including its dependencies.",
      );
    if (
      closing ||
      active ||
      preparingInstall ||
      removal.busy ||
      activation.busy ||
      ctx.isContentMutationActive?.() ||
      recoveryRequired
    )
      throw error(
        409,
        "Finish the current content operation or recovery before undoing this change.",
      );
    preparingInstall = true;
    notifyBusy();
    const job = {
      id: randomUUID(),
      undoOf: id,
      status: "running",
      cancellable: false,
      message: "Undoing content changes…",
      createdAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    lastJob = job.id;
    try {
      const operation = withMinecraftMutation(async () => {
        if ((await getServer()).status !== "offline")
          throw error(409, "Stop the server before undoing content changes.");
        lifetime.signal.throwIfAborted();
        const record = await history.get(id);
        if (!record || record.undoneAt)
          throw error(409, "This operation is no longer available to undo.");
        const written = new Map(
          record.written.map((file) => [file.path, file]),
        );
        const verifyWritten = async (file) => {
          const target = await safePath(serverDir, file.path),
            stat = await statOrNull(target);
          if (
            !stat?.isFile() ||
            stat.isSymbolicLink() ||
            (await fileHash(target)) !== file.sha512
          )
            throw error(
              409,
              `${file.path} changed after this operation. Preserve or restore your changes before undoing it.`,
            );
        };
        for (const file of record.written) await verifyWritten(file);
        for (const original of record.originals) {
          if (
            !written.has(original.path) &&
            (await statOrNull(await safePath(serverDir, original.path)))
          )
            throw error(
              409,
              `${original.path} already exists. Move it aside before undoing this operation.`,
            );
          if (
            (await fileHash(await history.source(record, original))) !==
            original.sha512
          )
            throw error(
              409,
              `The saved previous copy of ${original.path} changed. Use Recycle Bin for manual recovery.`,
            );
        }
        const previous = [...receipts];
        try {
          await recovery.begin({
            job,
            originals: record.written.map((file) => file.path),
            files: record.originals.map(({ path, sha512 }) => ({
              path,
              sha512,
            })),
            receipts: previous,
          });
          const recycled = [];
          for (const file of record.written) {
            await verifyWritten(file);
            const entry = await recycle(file.path);
            recycled.push({ id: entry.id, path: file.path });
          }
          for (const original of record.originals) {
            const parent = path.posix.dirname(original.path);
            await fs.mkdir(
              await safePath(serverDir, parent === "." ? "" : parent),
              { recursive: true },
            );
            const target = await safePath(serverDir, original.path);
            await fs.copyFile(
              await history.source(record, original),
              target,
              1,
            );
            const restoredFile = await fs.open(target, "r+");
            try {
              await restoredFile.sync();
            } finally {
              await restoredFile.close();
            }
            if ((await fileHash(target)) !== original.sha512)
              throw error(
                409,
                `Restored ${original.path} failed verification.`,
              );
          }
          const affected = new Set(
            [...record.written, ...record.originals].map((file) => file.path),
          );
          const restored = record.originals.map((file) => {
            const old = record.receipts.find(
              (receipt) =>
                receipt.path === file.path && receipt.sha512 === file.sha512,
            ) ?? {
              path: file.path,
              sha512: file.sha512,
              type: /^mods\//.test(file.path)
                ? "mod"
                : /^plugins\//.test(file.path)
                  ? "plugin"
                  : "datapack",
            };
            const replaced = record.afterReceipts.find(
              (receipt) =>
                receipt.path === file.path ||
                (old.projectId &&
                  receipt.platform === old.platform &&
                  receipt.projectId === old.projectId),
            );
            return {
              ...old,
              updateHeld: true,
              previousVersionId: replaced?.versionId,
              previousVersionName: replaced?.versionName,
            };
          });
          replaceReceipts([
            ...receipts.filter((receipt) => !affected.has(receipt.path)),
            ...restored,
          ]);
          await saveReceipts();
          await recovery.commit();
          await history.markUndone(id);
          if (jobs.has(id)) jobs.get(id).undoAvailable = false;
          for (const relative of affected) fileCache.delete(relative);
          invalidateCatalogCaches();
          removal.invalidate();
          job.recoveryEntries = recycled;
          job.status = "completed";
          job.message =
            "Operation undone. Restored versions are held from automatic updates.";
          job.finishedAt = new Date().toISOString();
          await terminal.save(job);
          recovery.release();
          await recovery.clear();
          return { ok: true, job: publicJob(job) };
        } catch (cause) {
          if (recovery.get()) {
            const restored = await reconcileInstallation({ publish: false });
            if (!restored.ok) {
              job.recoveryRequired = true;
              throw error(409, `${cause.message} ${restored.job.message}`);
            }
            if (restored.job.status === "completed") {
              Object.assign(job, restored.job);
              if (jobs.has(id)) jobs.get(id).undoAvailable = false;
              await terminal.save(job).catch(() => {});
              invalidateCatalogCaches();
              fileCache.clear();
              return { ok: true, job: publicJob(job) };
            }
          }
          throw cause;
        }
      });
      active = Promise.resolve(operation);
      return await active;
    } catch (cause) {
      job.status = "failed";
      job.message = cause.message;
      job.error = cause.message;
      job.finishedAt = new Date().toISOString();
      await terminal?.save(job).catch(() => {});
      throw cause;
    } finally {
      active = null;
      preparingInstall = false;
      notifyBusy();
    }
  }
  const api = {
    dependencies,
    updatePolicy,
    undoJob,
    restoreRecycledReceipt,
    async history() {
      return {
        operations: (await history.list()).map(
          ({ jobId, kind, title, createdAt, undoneAt }) => ({
            jobId,
            kind,
            title,
            createdAt,
            undoneAt,
            undoAvailable: !undoneAt,
          }),
        ),
      };
    },
    isBusy: () =>
      Boolean(active || preparingInstall || removal.busy || activation.busy),
    isRecoveryRequired: () => recoveryRequired,
    resolveRecovery: (input = {}) =>
      withMinecraftMutation(async () => {
        if (input.keepCurrent !== true) return reconcileInstallation();
        if (input.confirmed !== true)
          throw error(
            400,
            "Confirm keeping the current files and abandoning automatic rollback.",
          );
        if ((await getServer()).status !== "offline")
          throw error(409, "Stop the server before resolving recovery.");
        await recovery.keepCurrent();
        recoveryRequired = false;
        const job = jobs.get(lastJob);
        if (job) {
          Object.assign(job, {
            recoveryRequired: false,
            retryable: false,
            message:
              "Current server files were kept. Recovery copies remain available in panel storage.",
          });
          delete job.retainedRecoveryPath;
          await terminal.save(job);
        }
        return { ok: true, ...(job ? { job: publicJob(job) } : {}) };
      }),
    async cancelInstall(id) {
      const job = jobs.get(id);
      if (!job || id !== lastJob || !activeController)
        throw error(404, "This installation is no longer running.");
      if (!job.cancellable)
        throw error(
          409,
          "Installation is committing server files and must finish safely.",
        );
      job.cancellable = false;
      activeController.abort(
        error(409, "Installation cancelled. No server files were changed."),
      );
      return { job: publicJob(job) };
    },
    config,
    invalidateCatalogCaches,
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
      if (!unsubscribeCatalogSettings) invalidateCatalogCaches();
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
      try {
        input.categories = categoryIds(input.categories);
      } catch (cause) {
        throw error(400, cause.message);
      }
      if (
        input.categories.length &&
        (input.type !== "mod" ||
          !["modrinth", "curseforge"].includes(input.platform))
      )
        throw error(
          400,
          "Category filters are available for Modrinth and CurseForge mods.",
        );
      const cacheKey = JSON.stringify([
        input.platform,
        input.type,
        input.query,
        input.gameVersion,
        input.loader,
        input.sort,
        input.categories.join(","),
        input.offset,
        input.limit,
      ]);
      return catalogCache.read(
        cacheKey,
        (signal) => found.search({ ...input, signal }),
        {
          signal: input.signal,
          refresh: enabled(input.refresh),
        },
      );
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
    activity: () => (active && lastJob ? publicJob(jobs.get(lastJob)) : null),
    waitForIdle: async () => {
      await active;
    },
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
    cancelPreview: (id, ownerId = "local-owner") => cancelPreview(id, ownerId),
    cancelRemovalPreview: removal.cancel,
    async dismissJob(id) {
      const job = jobs.get(id);
      if (job?.recoveryRequired)
        throw error(
          409,
          "Resolve installation recovery before dismissing its status.",
        );
      if (job && ["completed", "failed"].includes(job.status)) {
        job.dismissed = true;
        await terminal?.dismiss(id);
      }
      return { ok: true };
    },
    async duplicateCheck({
      path: originalPath,
      sha512,
      payloadPath,
      signal = lifetime.signal,
    }) {
      signal = AbortSignal.any([lifetime.signal, signal]);
      signal.throwIfAborted();
      if (
        !/^(?:mods|plugins)\/[^/\\]+\.jar(?:\.disabled)?$/i.test(
          originalPath ?? "",
        ) ||
        !sha512
      )
        return { duplicates: [], warnings: [] };
      const known =
        identities.get(sha512)?.value ??
        metadataCache?.identity(sha512) ??
        receipts.find((item) => item.sha512 === sha512 && item.platform);
      const current = await abortable(getServer(), signal);
      const warnings = [];
      const type = originalPath.startsWith("plugins/") ? "plugin" : "mod";
      const items = await scan(type, signal, warnings, true);
      await installedDetails(
        {
          type,
          loader: current.loader,
          gameVersion: current.gameVersion,
          identityOnly: true,
          signal,
        },
        items,
        warnings,
      );
      const offlineDuplicates = new Set();
      if (payloadPath) {
        try {
          // payloadPath is supplied by the recycle-bin service after containment
          // checks, never copied from an HTTP request.
          const inspect =
            type === "plugin" ? inspectPluginIdentity : inspectInstalledMod;
          const metadata = await inspect(payloadPath, {
            loader: current.loader,
            signal,
          });
          const ids = new Set(metadata.provided);
          await mapReview(
            items,
            async (item) => {
              try {
                const other = await inspect(
                  await safePath(serverDir, item.path),
                  { loader: current.loader, signal },
                );
                if (other.provided.some((id) => ids.has(id)))
                  offlineDuplicates.add(item.path);
              } catch {
                signal.throwIfAborted();
              }
            },
            signal,
          );
        } catch {
          signal.throwIfAborted();
          warnings.push(
            "The recycled JAR's mod identifiers could not be read.",
          );
        }
      }
      if (!known?.platform && !payloadPath)
        warnings.push(
          "The recycled file could not be identified, so duplicates could not be checked completely.",
        );
      signal.throwIfAborted();
      return {
        duplicates: items
          .filter(
            (item) =>
              item.path !== originalPath &&
              (offlineDuplicates.has(item.path) ||
                (known?.platform &&
                  item.platform === known.platform &&
                  item.projectId === known.projectId)),
          )
          .map(({ path, title }) => ({ path, title })),
        warnings,
      };
    },
    removalPreview: removal.preview,
    remove: removal.remove,
    setActive: activation.change,
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
      unsubscribeCatalogSettings?.();
      clearInterval(cleanupTimer);
      const stopped = error(
        503,
        "Launchpad closed before installation finished. No pending downloads will be installed.",
      );
      lifetime.abort(stopped);
      catalogCache.clear();
      activeController?.abort(stopped);
      await removal.close();
      await activation.close();
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
  unsubscribeCatalogSettings = await ctx.platformConfig?.subscribe?.(
    invalidateCatalogCaches,
  );
  if (ctx.catalogOnly)
    return {
      config: api.config,
      search: api.search,
      versions: api.versions,
      dependencies,
      settings: api.settings,
      invalidateCatalogCaches,
      close: api.close,
    };
  await pruneReceipts();
  return api;
}
