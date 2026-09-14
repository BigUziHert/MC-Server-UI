import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createCoreProviders } from "./launchpad-providers.mjs";
import { safeInstallPath, unpackProviderZip } from "./launchpad-archives.mjs";
import { inspectBundledDependencies } from "./launchpad-bundled.mjs";
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
        await work(items[index]);
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
      ]
        .filter((key) => item[key] !== undefined)
        .map((key) => [key, item[key]]),
    );
  const updateKey = (input, item) =>
    JSON.stringify([
      input.type,
      input.gameVersion,
      input.loader,
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
  async function scan(type, signal = lifetime.signal, warnings = []) {
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
      signal.throwIfAborted();
      const relativePath = `${relative}/${safeInstallPath(file.name)}`;
      let target, stat, sha512;
      try {
        target = await safePath(serverDir, relativePath);
        stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const stamp = fileStamp(stat);
        const cached = fileCache.get(relativePath);
        if (cached?.stamp === stamp) sha512 = cached.sha512;
        else {
          const flightKey = `${relativePath}:${stamp}`;
          let task = hashFlights.get(flightKey);
          if (!task) {
            task = fileHash(target).then(async (hash) => {
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
        if (missing(cause)) continue;
        fileCache.delete(relativePath);
        warnings.push(`${file.name} could not be read: ${cause.message}`);
        rows.push({
          path: relativePath,
          name: file.name,
          size: stat?.size ?? 0,
          platform: null,
        });
        continue;
      }
      const receipt = receipts.find(
        (item) => item.path === relativePath && item.sha512 === sha512,
      );
      const known = identities.get(sha512);
      rows.push({
        path: relativePath,
        name: file.name,
        size: stat.size,
        sha512,
        platform: null,
        ...(known?.expiresAt > Date.now() ? known.value : {}),
        ...receipt,
      });
    }
    return rows;
  }
  async function enrichProjectMetadata(
    items,
    warnings,
    signal = lifetime.signal,
  ) {
    await Promise.all(
      providers.map(async (found) => {
        if (!found.projectMetadata) return;
        const known = items.filter(
          (item) => item.platform === found.id && item.projectId,
        );
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
            if (typeof project?.title === "string" && project.title.trim())
              item.title = project.title;
            if (project?.iconUrl) item.iconUrl = project.iconUrl;
            if (typeof project?.author === "string" && project.author.trim())
              item.author = project.author;
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
    if (!input.gameVersion || !input.loader) return;
    const fail = (found, cause) => {
      if (cause.cachedUpdateFailure) {
        warnings.push(cause.message);
        return;
      }
      const message = `${found.name} update checks: ${cause.message}`;
      warnings.push(message);
      if (cause.status !== 404)
        updateFailures.set(found.id, {
          message,
          until: Date.now() + (cause.status === 429 ? 60_000 : 30_000),
        });
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
          if (missing.length) warnings.push(cooldown.message);
          for (const item of missing) item.updateIssue = cooldown.message;
        } else if (missing.length && found.updates) {
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
              return { checked, issues: result.issues };
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
              const cooldown = updateFailures.get(found.id);
              if (cooldown?.until > Date.now()) {
                warnings.push(cooldown.message);
                item.updateIssue = cooldown.message;
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
                          const cooldown = updateFailures.get(found.id);
                          if (cooldown?.until > Date.now())
                            throw Object.assign(new Error(cooldown.message), {
                              cachedUpdateFailure: true,
                            });
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
                    const current = versions.find(
                        (value) => String(value.id) === item.versionId,
                      ),
                      newest = versions[0];
                    const value =
                      newest &&
                      String(newest.id) !== item.versionId &&
                      (!current ||
                        (newest.publishedAt ?? "") >
                          (current.publishedAt ?? ""))
                        ? publicVersion(newest)
                        : null;
                    remember(updateCache, key, {
                      value,
                      expiresAt: Date.now() + 5 * 60_000,
                    });
                    return { value };
                  } catch (cause) {
                    fail(found, cause);
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
              await work;
            },
            input.signal,
          );
        }
        await Promise.all(
          pending.map(async ({ item, work }) => {
            const result = await abortable(work, input.signal);
            if (result && Object.hasOwn(result, "value"))
              apply(item, result.value);
            else if (result?.issue) item.updateIssue = result.issue;
          }),
        );
      }),
    );
    input.signal.throwIfAborted();
  }
  async function installed(input) {
    input = selection(input);
    const scanWarnings = [];
    const items =
      input.type === "modpack"
        ? receipts
            .filter((item) => item.type === "modpack" && item.pack)
            .map((item) => ({ ...item, name: item.title }))
        : await scan(input.type, input.signal, scanWarnings);
    for (const item of items) {
      const cached = updateCache.get(updateKey(input, item));
      // Keep the last verified update visible if the provider is temporarily
      // unavailable. Its expiry controls rechecking, not erasing known updates.
      if (cached?.value) item.update = cached.value;
      item.updateCheck =
        !enabled(input.refresh) && cached?.expiresAt > Date.now()
          ? "checked"
          : "pending";
    }
    if (enabled(input.local)) return { items, warnings: scanWarnings };
    const flightKey = JSON.stringify([
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
          AbortSignal.timeout(30000),
        ]);
        try {
          await installedDetails({ ...input, signal }, items, warnings);
        } catch (cause) {
          warnings.push(
            signal.aborted
              ? "Some mod details or update checks took too long. Your installed files are still shown. Refresh to retry."
              : cause.message,
          );
        }
        for (const item of items) {
          if (item.updateCheck !== "checked") item.updateCheck = "unavailable";
          if (!item.sha512) continue;
          if (
            item.platform ||
            (!signal.aborted &&
              !warnings.some((message) => /identification:/i.test(message)))
          )
            remember(identities, item.sha512, {
              value: identityFields(item),
              expiresAt: Date.now() + (item.platform ? 10 * 60_000 : 60_000),
            });
        }
        return { items, warnings: [...new Set(warnings)] };
      })();
      inventoryFlights.set(flightKey, task);
      void task.then(
        () => inventoryFlights.delete(flightKey),
        () => inventoryFlights.delete(flightKey),
      );
    }
    return structuredClone(await abortable(task, input.signal));
  }
  async function installedDetails(input, items, warnings) {
    if (input.type === "modpack") {
      await enrichProjectMetadata(items, warnings, input.signal);
      for (const item of items) item.name = item.title;
      return;
    }
    const unknown = items.filter(
      (item) =>
        item.sha512 &&
        !item.platform &&
        !(identities.get(item.sha512)?.expiresAt > Date.now()),
    );
    const modrinth = providers.find((value) => value.id === "modrinth");
    if (unknown.length) {
      try {
        const matches = await abortable(
          modrinth.identify(
            unknown.map((item) => item.sha512),
            { signal: input.signal },
          ),
          input.signal,
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
          warnings.push(`CurseForge identification: ${cause.message}`);
        }
      }
    }
    input.signal.throwIfAborted();
    if (input.identityOnly) return;
    // Names and icons belong to the project, even with All loaders/versions.
    // Failed metadata requests must not suppress identification or updates.
    await enrichProjectMetadata(items, warnings, input.signal);
    input.signal.throwIfAborted();
    await checkUpdates(input, items, warnings);
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
      unavailableDependencies = [],
      attempted = new Set(),
      visited = new Map();
    let rootResult;
    async function visit(value, depth = 0, requiredBy) {
      const attemptKey = `${value.platform}:${value.projectId ?? ""}:${value.versionId ?? ""}`;
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
        if (visited.has(key)) {
          if (visited.get(key) !== String(value.versionId))
            throw error(
              409,
              "Required dependencies request conflicting versions of the same project. Resolve them manually before installing.",
            );
          return;
        }
        visited.set(key, String(value.versionId));
        result = await found.resolve(value);
      } catch (cause) {
        if (cause.status !== 404) throw cause;
        if (!depth)
          throw error(
            404,
            `${found.name} could not find the selected project or version. Refresh its versions and choose another release.`,
          );
        // A broken upstream requirement must be visible in the review. The
        // install endpoint requires a separate acknowledgement of this list.
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
          author: result.author,
          type: value.type,
          hosts: found.downloadHosts,
        });
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
    await enrichProjectMetadata([rootMetadata, ...files], warnings);
    return {
      ...rootResult,
      author: rootMetadata.author,
      files,
      warnings,
      unavailableDependencies,
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
            author: result.author,
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
      const unchanged = [];
      const local =
        input.type === "modpack"
          ? []
          : (await installed({ ...input, identityOnly: true })).items;
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
        files.push({
          ...file,
          author: file.author || matches[0]?.author,
          expected,
          previous,
          action: expected || previous ? "replace" : "install",
        });
      }
      result.files = [...files, ...unchanged];
      await inspectUnavailableDependencies(result, input, stage);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const plan = {
        id: planId,
        input,
        stage,
        files,
        unchanged,
        title: result.title,
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
        expiresAt,
      };
      lifetime.signal.throwIfAborted();
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
                  author: file.author,
                }),
            type: file.type,
            installedAt: new Date().toISOString(),
          });
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
            author: plan.author,
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
    if (
      plan.unavailableDependencies?.length &&
      input.acknowledgedUnavailableDependencies !== true
    )
      throw error(
        400,
        "Review the unavailable required dependencies and confirm that you will manage them yourself before installing.",
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
          const alreadyStaged = Boolean(file.stagedPath);
          if (!file.stagedPath) {
            file.stagedPath = path.join(plan.stage, `download-${index}`);
            await downloadVerified(file, file.stagedPath, file.hosts, request, {
              signal: controller.signal,
            });
          }
          const stagedSize = (await fs.stat(file.stagedPath)).size;
          const [algorithm, expectedHash] = strongestHash(file.hashes);
          const stagedHash = alreadyStaged
            ? await fileHash(file.stagedPath, algorithm)
            : null;
          if (
            alreadyStaged &&
            ((file.size != null && stagedSize !== file.size) ||
              stagedHash !== expectedHash)
          )
            throw error(
              502,
              "A staged download failed its size or checksum check. No server files were changed.",
            );
          downloaded += stagedSize;
          if (downloaded > (plan.input.type === "modpack" ? 4 : 2) * 1024 ** 3)
            throw error(
              400,
              `This installation exceeds the ${plan.input.type === "modpack" ? 4 : 2} GB total size limit.`,
            );
          file.sha512 =
            algorithm === "sha512" && stagedHash
              ? stagedHash
              : await fileHash(file.stagedPath);
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
      identities.clear();
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
      noOpReviews.clear();
    },
  };
}
