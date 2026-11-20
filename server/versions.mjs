import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { inspectJavaArguments } from "./import.mjs";
import { createCanvasProvider } from "./versions-canvas.mjs";
import { createForkProviders } from "./versions-forks.mjs";
import { createHybridProviders } from "./versions-hybrid.mjs";
import { createPufferfishProvider } from "./versions-pufferfish.mjs";
import { createSpigotProvider, spigotBuildTools } from "./versions-spigot.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const agent = "MC-Server-UI/0.1 (https://github.com/BigUziHert/MC-Server-UI)";
const identifier = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._+\-]{0,100}$/i.test(value);
// Mojang's older prerelease IDs contain spaces (for example, 1.14.2 Pre-Release 4).
// They still must be plain filename components and match an official catalog entry.
const catalogIdentifier = (provider, value) =>
  identifier(value) ||
  (provider === "vanilla" &&
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9._+\- ]{0,99}[a-z0-9]$/i.test(value));
const stable = (version) => !/alpha|beta|snapshot|pre|rc/i.test(version);
const newest = (a, b) => b.localeCompare(a, "en", { numeric: true });
const PAPER = "https://fill.papermc.io/v3/projects";
const paperProjects = new Set(["paper", "folia", "velocity", "waterfall"]);
const waterfallModuleName =
  /^(?:cmd_(?:alert|find|kick|list|send|server)|reconnect_yaml)$/;
const NEO = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const FORGE = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FORGE_DOWNLOADS =
  "https://files.minecraftforge.net/net/minecraftforge/forge";
const FABRIC = "https://meta.fabricmc.net/v2/versions";
const QUILT = "https://meta.quiltmc.org/v3/versions";
const VANILLA =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const JAVA_NOTES = "https://launchercontent.mojang.com/v2/";
const JAVA_FEEDBACK =
  "https://feedback.minecraft.net/api/v2/help_center/articles/search.json";
const PURPUR = "https://api.purpurmc.org/v2/purpur";
const hosts = new Set([
  "fill.papermc.io",
  "fill-data.papermc.io",
  "api.papermc.io",
  "maven.neoforged.net",
  "maven.minecraftforge.net",
  "files.minecraftforge.net",
  "meta.fabricmc.net",
  "maven.fabricmc.net",
  "meta.quiltmc.org",
  "maven.quiltmc.org",
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "launcher.mojang.com",
  "launchercontent.mojang.com",
  "launchermeta.mojang.com",
  "feedback.minecraft.net",
  "api.purpurmc.org",
  "api.leavesmc.org",
  "github.com",
  "release-assets.githubusercontent.com",
  "magmafoundation.org",
  "repo.magmafoundation.org",
  "api.mohistmc.com",
  "mohistmc.com",
  "dl-api.spongepowered.org",
  "repo.spongepowered.org",
  "files.hypoglycemia.icu",
  "files.hypertention.cn",
  "hub.spigotmc.org",
  "ci.pufferfish.host",
  "jenkins.canvasmc.io",
]);
const definitions = [
  [
    "vanilla",
    "Vanilla",
    "The original Minecraft Java server.",
    "https://www.minecraft.net/en-us/download/server",
    true,
  ],
  [
    "paper",
    "Paper",
    "A performance-focused server with Bukkit and Spigot plugins.",
    "https://papermc.io/downloads/paper",
    true,
  ],
  [
    "pufferfish",
    "Pufferfish",
    "A Paper fork focused on large-server performance. Selected official builds.",
    "https://pufferfish.host/downloads",
    true,
  ],
  [
    "spigot",
    "Spigot",
    "Build the established Bukkit-compatible server with BuildTools.",
    "https://www.spigotmc.org/wiki/buildtools/",
    true,
  ],
  [
    "purpur",
    "Purpur",
    "Paper compatibility with additional gameplay controls.",
    "https://purpurmc.org/downloads",
    true,
  ],
  [
    "waterfall",
    "Waterfall",
    "A discontinued BungeeCord-based proxy.",
    "https://papermc.io/downloads/waterfall",
    true,
    "proxy",
    "Deprecated",
  ],
  [
    "velocity",
    "Velocity",
    "Connect multiple servers through a modern proxy.",
    "https://papermc.io/downloads/velocity",
    true,
    "proxy",
  ],
  [
    "fabric",
    "Fabric",
    "A lightweight loader for Fabric server mods.",
    "https://fabricmc.net/use/server/",
    true,
  ],
  [
    "quilt",
    "Quilt",
    "A community-driven loader for Quilt-compatible mods.",
    "https://quiltmc.org/en/install/server/",
    true,
    "server",
    "Experimental",
  ],
  [
    "forge",
    "Forge",
    "The established Minecraft mod loader.",
    "https://files.minecraftforge.net/",
    true,
  ],
  [
    "neoforge",
    "NeoForge",
    "Modern modded Minecraft, including existing NeoForge worlds.",
    "https://neoforged.net/",
    true,
  ],
  [
    "mohist",
    "Mohist",
    "A Forge and Bukkit hybrid; upstream maintenance is paused.",
    "https://www.mohistmc.com/downloadSoftware?project=mohist",
    true,
    "server",
    "Unmaintained",
  ],
  [
    "arclight",
    "Arclight",
    "A hybrid server supporting mods and Bukkit plugins.",
    "https://github.com/IzzelAliz/Arclight/releases",
    true,
  ],
  [
    "sponge",
    "Sponge",
    "Standalone SpongeVanilla server software for Sponge plugins.",
    "https://spongepowered.org/downloads/spongevanilla",
    true,
  ],
  [
    "leaves",
    "Leaves",
    "A Paper-based server focused on vanilla mechanics.",
    "https://leavesmc.org/downloads/leaves",
    true,
  ],
  [
    "canvas",
    "Canvas",
    "A server focused on performance and parallel processing. Selected official builds.",
    "https://canvasmc.io/downloads/canvas",
    true,
  ],
  [
    "magma",
    "Magma",
    "A hybrid platform for mods and Bukkit plugins.",
    "https://magmafoundation.org/",
    true,
  ],
  [
    "folia",
    "Folia",
    "Paper's region-based multithreaded server; plugins must support it.",
    "https://papermc.io/downloads/folia",
    true,
  ],
];
export const versionProviders = definitions.map(
  ([
    id,
    name,
    description,
    website,
    installable = false,
    kind = "server",
    badge,
  ]) => ({
    id,
    name,
    description,
    website,
    installable,
    kind,
    ...(badge ? { badge } : {}),
  }),
);

export function installedJarBuild(provider, version, jar) {
  if (!catalogIdentifier(provider, version) || typeof jar !== "string") return;
  const prefix = `${provider}-${version}-`;
  const name = path.basename(jar);
  if (!name.startsWith(prefix) || !name.endsWith(".jar")) return;
  const build = name.slice(prefix.length, -4);
  if (identifier(build)) return build;
}

export const isWaterfallModule = (relative) =>
  /^modules\/.+\.jar$/.test(relative) &&
  waterfallModuleName.test(relative.slice("modules/".length, -4));

function forgeReleasePage(version) {
  return `${FORGE_DOWNLOADS}/index_${encodeURIComponent(version)}.html`;
}

function forgeChangelogPage(build) {
  const id = encodeURIComponent(build);
  return `${FORGE}/${id}/forge-${id}-changelog.txt`;
}

function versionPage(provider, version, build) {
  const { id, website } = provider;
  const release = catalogIdentifier(id, version)
    ? encodeURIComponent(version)
    : "";
  const buildId = identifier(build) ? encodeURIComponent(build) : "";
  switch (id) {
    case "paper":
    case "folia":
    case "velocity":
    case "waterfall":
      return release
        ? `https://fill-ui.papermc.io/projects/${id}/version/${release}${/^\d+$/.test(buildId) ? `?build=${buildId}` : ""}`
        : website;
    case "purpur":
      return release
        ? `https://purpurmc.org/download/purpur/${release}${/^\d+$/.test(buildId) ? `#:~:text=${buildId}` : ""}`
        : website;
    case "neoforge": {
      if (!buildId) return website;
      const archive = `${NEO}/${buildId}/`;
      // Early 20.2 and experimental builds can omit the changelog artifact.
      return !stable(build) || build.startsWith("20.2.")
        ? archive
        : `${archive}neoforge-${buildId}-changelog.txt`;
    }
    case "forge": {
      if (!release) return website;
      const buildLabel =
        buildId && build.startsWith(`${version}-`)
          ? encodeURIComponent(build.slice(version.length + 1))
          : "";
      return `${forgeReleasePage(version)}${buildLabel ? `#:~:text=${buildLabel}` : ""}`;
    }
    case "fabric":
      if (!buildId) return website;
      return /^0\.(?:[0-9]|1[0-4])(?:\.|$)/.test(build)
        ? `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${buildId}/`
        : `https://github.com/FabricMC/fabric-loader/releases/tag/${buildId}`;
    case "quilt":
      if (!buildId) return website;
      return stable(build) && !/^0\.(?:[0-9]|1\d|2[0-8])(?:\.|$)/.test(build)
        ? `https://quiltmc.org/en/changelog/quilt-loader/${buildId}/`
        : `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/${buildId}/`;
    default:
      return website;
  }
}

function vanillaMetadataPage(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      ["piston-meta.mojang.com", "launchermeta.mojang.com"].includes(
        url.hostname,
      ) &&
      /^\/v1\/packages\/[a-f0-9]{40}\/[a-z0-9](?:[a-z0-9._+-]|%20|%2B){0,100}\.json$/i.test(
        url.pathname,
      )
    )
      return url.href;
  } catch {
    // An unrecognized address can fall back to the official project page.
  }
}

function javaReleaseKey(value) {
  return value
    .toLowerCase()
    .replace(/^snapshot\s+(?=\d{2}w\d{2})/, "")
    .replace(/release[ -]+candidate/g, "rc")
    .replace(/pre[ -]+release/g, "pre")
    .replace(/[^a-z0-9.]/g, "");
}

function officialUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail(502, "The provider returned an invalid download address.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.has(url.hostname)
  )
    throw fail(
      502,
      "The provider returned a download outside its approved official hosts.",
    );
  return url.href;
}

function neoforgeMinecraft(version) {
  const numbers = version.split("-")[0].split(".").map(Number);
  if (numbers.length === 3 && numbers[0] >= 20 && numbers[0] < 26)
    return `1.${numbers[0]}${numbers[1] ? `.${numbers[1]}` : ""}`;
  if (numbers.length === 4 && numbers[0] >= 26)
    return `${numbers[0]}.${numbers[1]}${numbers[2] ? `.${numbers[2]}` : ""}`;
  return null;
}

export function runVersionInstaller({
  javaPath,
  args,
  cwd,
  env,
  signal,
  onProgress,
  timeoutMs = 10 * 60 * 1000,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(fail(408, "The installation was cancelled."));
      return;
    }
    const child = spawn(javaPath, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stopped;
    let termination = Promise.resolve();
    const stop = () => {
      if (stopped || child.exitCode !== null) return;
      stopped = fail(
        408,
        signal?.aborted
          ? "The installation was cancelled."
          : "The installer timed out. Check the selected Java version and try again.",
      );
      if (Number.isInteger(child.pid)) {
        if (process.platform === "win32") {
          const killer = spawn(
            path.win32.join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          termination = new Promise((resolve) => {
            killer.once("error", () => {
              child.kill();
              resolve();
            });
            killer.once("close", () => resolve());
          });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-12000);
        const line = chunk
          .toString()
          .trim()
          .split(/\r?\n/)
          .at(-1)
          ?.slice(0, 240);
        if (line) onProgress?.({ phase: "install", message: line });
      });
    child.once("error", (cause) => {
      finish();
      reject(fail(400, `Java could not run the installer: ${cause.message}`));
    });
    child.once("close", async (code) => {
      finish();
      await termination;
      if (stopped) reject(stopped);
      else if (code !== 0)
        reject(
          fail(
            400,
            `Installer exited with code ${code ?? "unknown"}. ${output.trim().slice(-1500)}`,
          ),
        );
      else resolve();
    });
  });
}

export function createVersionsService({
  fetch: fetchImpl = globalThis.fetch,
  runInstaller = runVersionInstaller,
  cacheMs = 300000,
} = {}) {
  const cache = new Map();
  const adapterOptions = { json, text, cached };
  const adapters = {
    canvas: createCanvasProvider(),
    ...createForkProviders(adapterOptions),
    ...createHybridProviders(adapterOptions),
    pufferfish: createPufferfishProvider(),
    spigot: createSpigotProvider(adapterOptions),
  };
  async function response(url, signal, timeoutMs = 20000) {
    let current = officialUrl(url);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let count = 0; count < 5; count++) {
      let result;
      try {
        result = await fetchImpl(current, {
          headers: { "User-Agent": agent },
          redirect: "manual",
          signal: combined,
        });
      } catch (cause) {
        throw fail(
          502,
          `The official download service could not be reached: ${cause.message}`,
        );
      }
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers.get("location");
        if (!location)
          throw fail(
            502,
            "The official download service returned an empty redirect.",
          );
        current = officialUrl(new URL(location, current).href);
        await result.body?.cancel();
        continue;
      }
      if (!result.ok)
        throw fail(
          502,
          `The official download service returned HTTP ${result.status}. Try again later.`,
        );
      return result;
    }
    throw fail(502, "The official download service redirected too many times.");
  }
  async function bytes(url, limit, signal) {
    const result = await response(
      url,
      signal,
      limit > 8 * 1024 ** 2 ? 180000 : 20000,
    );
    if (Number(result.headers.get("content-length")) > limit) {
      await result.body?.cancel();
      throw fail(502, "The official download exceeds the supported size.");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of result.body ?? []) {
      size += chunk.length;
      if (size > limit)
        throw fail(502, "The official download exceeds the supported size.");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async function text(url) {
    return (await bytes(url, 8 * 1024 ** 2)).toString("utf8");
  }
  async function json(url) {
    try {
      return JSON.parse(await text(url));
    } catch (cause) {
      if (cause.status) throw cause;
      throw fail(
        502,
        "The official service returned invalid release metadata.",
      );
    }
  }
  function cached(key, work) {
    const previous = cache.get(key);
    if (previous && (previous.pending || previous.expires > Date.now()))
      return previous.value;
    const entry = { pending: true, expires: 0, value: null };
    entry.value = Promise.resolve()
      .then(work)
      .then((result) => {
        entry.pending = false;
        entry.expires = Date.now() + cacheMs;
        return result;
      })
      .catch((cause) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw cause;
      });
    cache.set(key, entry);
    return entry.value;
  }
  function provider(id) {
    const found = versionProviders.find((entry) => entry.id === id);
    if (!found) throw fail(400, "Choose a supported server software provider.");
    if (!found.installable)
      throw fail(
        400,
        `${found.name} is available through its official download page.`,
      );
    return found;
  }
  const manifest = () => cached("vanilla", () => json(VANILLA));
  const releaseIndex = async (url) =>
    (await bytes(url, 4 * 1024 ** 2, AbortSignal.timeout(3500))).toString(
      "utf8",
    );
  const forgeChangelogs = (version) =>
    cached(`forge:changelogs:${version}`, async () => {
      try {
        const downloads = await releaseIndex(forgeReleasePage(version));
        return new Set(
          [
            ...downloads.matchAll(
              /forge-([a-z0-9][a-z0-9._+-]{0,100})-changelog\.txt/gi,
            ),
          ].map(([, build]) => build),
        );
      } catch {
        return new Set();
      }
    });
  const vanillaNotes = () =>
    cached("vanilla:notes", async () => {
      const notes = new Map();
      try {
        const index = await releaseIndex(`${JAVA_NOTES}javaPatchNotes.json`);
        for (const entry of JSON.parse(index).entries) {
          if (
            catalogIdentifier("vanilla", entry?.version) &&
            typeof entry.contentPath === "string" &&
            /^javaPatchNotes\/[a-z0-9-]{1,101}\.json$/i.test(entry.contentPath)
          )
            notes.set(entry.version, `${JAVA_NOTES}${entry.contentPath}`);
        }
      } catch {
        // Release notes are optional. The official manifest is still usable.
      }
      return notes;
    });
  const vanillaArticle = (version) =>
    cached(`vanilla:article:${version}`, async () => {
      if (/^\d+\.\d+(?:\.\d+)?$/.test(version)) {
        const page = `https://www.minecraft.net/en-us/article/minecraft-java-edition-${version.replaceAll(".", "-")}`;
        try {
          const article = await fetchImpl(page, {
            method: "HEAD",
            redirect: "manual",
            signal: AbortSignal.timeout(1500),
          });
          if (
            article.ok &&
            article.headers.get("content-type")?.startsWith("text/html")
          )
            return page;
        } catch {
          // Minecraft uses different article slugs for some releases.
        }
      }
      try {
        const query = new URLSearchParams({
          query: `"${version}"`,
          locale: "en-us",
        });
        const index = await releaseIndex(`${JAVA_FEEDBACK}?${query}`);
        const wanted = javaReleaseKey(version);
        for (const article of JSON.parse(index).results) {
          const title = article.title?.match(
            /^Minecraft:? Java Edition\s*[-–—]?\s+(.+)$/i,
          )?.[1];
          if (
            title &&
            javaReleaseKey(title.split(/\s+[-–—]\s+/)[0]) === wanted &&
            /^https:\/\/feedback\.minecraft\.net\/hc\/en-us\/articles\/\d+(?:-[a-z0-9_-]+)?$/i.test(
              article.html_url,
            )
          )
            return article.html_url;
        }
      } catch {
        // Some versions have launcher notes without a separate web article.
      }
    });
  const maven = (id) =>
    cached(id, async () => {
      const xml = await text(
        `${id === "neoforge" ? NEO : FORGE}/maven-metadata.xml`,
      );
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
        .map((entry) => entry[1])
        .filter(identifier);
      if (!versions.length)
        throw fail(502, "The official Maven repository returned no versions.");
      return versions.sort(newest);
    });
  const refreshProvider = (id) => {
    // Release and build refreshes run together in Versions. Invalidate stored
    // results once while sharing any request already fetching current metadata.
    for (const [key, entry] of cache)
      if (
        !entry.pending &&
        (key === id ||
          key.startsWith(`${id}:`) ||
          key === `versions:${id}` ||
          key.startsWith(`builds:${id}:`))
      )
        cache.delete(key);
  };
  async function versions(id, { refresh = false } = {}) {
    if (refresh) refreshProvider(id);
    const selected = provider(id);
    const entries = await cached(`versions:${id}`, async () => {
      if (adapters[id]) return adapters[id].versions();
      if (id === "neoforge" || id === "forge") {
        const builds = await maven(id);
        const groups = new Map();
        for (const build of builds) {
          const version =
            id === "neoforge" ? neoforgeMinecraft(build) : build.split("-")[0];
          if (version)
            groups.set(
              version,
              (groups.get(version) ?? false) || stable(build),
            );
        }
        return [...groups]
          .sort(([a], [b]) => newest(a, b))
          .map(([id, stable]) => ({ id, label: id, stable }));
      }
      if (paperProjects.has(id)) {
        const data = await json(`${PAPER}/${id}`);
        if (!data.versions || typeof data.versions !== "object")
          throw fail(502, "The official service returned invalid versions.");
        return Object.values(data.versions)
          .flat()
          .filter(identifier)
          .sort(newest)
          .map((id) => ({ id, label: id, stable: stable(id) }));
      }
      if (id === "vanilla") {
        const [releases, notes] = await Promise.all([
          manifest(),
          vanillaNotes(),
        ]);
        return releases.versions
          .filter(
            (entry) =>
              catalogIdentifier(id, entry.id) &&
              ["release", "snapshot"].includes(entry.type),
          )
          .map((entry) => ({
            id: entry.id,
            label: entry.id,
            stable: entry.type === "release",
            url: notes.get(entry.id) ?? vanillaMetadataPage(entry.url),
          }));
      }
      if (id === "purpur")
        return (await json(PURPUR)).versions
          .filter(identifier)
          .sort(newest)
          .map((id) => ({ id, label: id, stable: stable(id) }));
      const data = await json(`${id === "fabric" ? FABRIC : QUILT}/game`);
      if (!Array.isArray(data))
        throw fail(
          502,
          "The official loader service returned invalid versions.",
        );
      return data
        .filter((entry) => identifier(entry.version))
        .map((entry) => ({
          id: entry.version,
          label: entry.version,
          stable: entry.stable === true,
        }));
    });
    return {
      provider: selected,
      versions: entries.map((entry) => ({
        ...entry,
        url: entry.url ?? versionPage(selected, entry.id),
      })),
    };
  }
  async function catalogBuilds(id, version, refresh = false) {
    if (refresh) refreshProvider(id);
    const selected = provider(id);
    const release = catalogIdentifier(id, version)
      ? (await versions(id)).versions.find((item) => item.id === version)
      : null;
    if (!release)
      throw fail(400, "Choose a Minecraft version from the official catalog.");
    const entries = await cached(`builds:${id}:${version}`, async () => {
      if (adapters[id]) return adapters[id].builds(version);
      if (id === "neoforge" || id === "forge")
        return (await maven(id))
          .filter((build) =>
            id === "neoforge"
              ? neoforgeMinecraft(build) === version
              : build.startsWith(`${version}-`),
          )
          .map((build) => ({
            id: build,
            label: id === "forge" ? build.slice(version.length + 1) : build,
            stable: stable(build),
          }));
      if (paperProjects.has(id)) {
        const data = await json(
          `${PAPER}/${id}/versions/${encodeURIComponent(version)}/builds`,
        );
        if (!Array.isArray(data))
          throw fail(502, "The official service returned invalid builds.");
        return data
          .filter((build) => build.downloads?.["server:default"])
          .map((build) => ({
            id: String(build.id),
            label: `Build ${build.id}`,
            stable: build.channel === "STABLE",
            publishedAt: build.time,
            ...(id === "waterfall" && version === "1.21"
              ? { javaVersion: 17 }
              : {}),
            ...(id === "waterfall"
              ? {
                  modules: Object.entries(build.downloads).flatMap(
                    ([key, value]) => {
                      const name = key.slice("module:".length);
                      return key.startsWith("module:") &&
                        waterfallModuleName.test(name)
                        ? [{ name, artifact: value }]
                        : [];
                    },
                  ),
                }
              : {}),
            artifact: build.downloads["server:default"],
          }));
      }
      if (id === "vanilla") {
        const entry = (await manifest()).versions.find(
          (item) => item.id === version,
        );
        const metadata = await bytes(entry.url, 8 * 1024 ** 2);
        if (
          !/^[a-f0-9]{40}$/i.test(entry.sha1) ||
          createHash("sha1").update(metadata).digest("hex") !==
            entry.sha1.toLowerCase()
        )
          throw fail(
            502,
            "Minecraft version metadata failed checksum verification.",
          );
        const data = JSON.parse(metadata.toString("utf8"));
        return data.downloads?.server
          ? [
              {
                id: version,
                label: "Official server",
                stable: entry.type === "release",
                javaVersion: data.javaVersion?.majorVersion,
                artifact: data.downloads.server,
              },
            ]
          : [];
      }
      if (id === "purpur")
        return (
          await json(`${PURPUR}/${encodeURIComponent(version)}`)
        ).builds.all
          .map((id) => ({ id: String(id), label: `Build ${id}`, stable: true }))
          .sort((a, b) => newest(a.id, b.id));
      const data = await json(
        `${id === "fabric" ? FABRIC : QUILT}/loader/${encodeURIComponent(version)}`,
      );
      if (!Array.isArray(data))
        throw fail(502, "The official loader service returned invalid builds.");
      return data
        .filter((entry) => identifier(entry.loader?.version))
        .map((entry) => ({
          id: entry.loader.version,
          label: entry.loader.version,
          // Fabric marks only its preferred public loader stable; older releases
          // have false here too. This is a recommendation, not a prerelease flag.
          stable:
            id === "fabric"
              ? stable(entry.loader.version)
              : (entry.loader.stable ?? stable(entry.loader.version)),
          ...(id === "fabric"
            ? { recommended: entry.loader.stable === true }
            : {}),
        }))
        .sort((a, b) => newest(a.id, b.id));
    });
    return { selected, release, entries };
  }
  async function builds(id, version, { refresh = false } = {}) {
    const { selected, release, entries } = await catalogBuilds(
      id,
      version,
      refresh,
    );
    const forgeNotes = id === "forge" ? await forgeChangelogs(version) : null;
    const article = id === "vanilla" ? await vanillaArticle(version) : null;
    return {
      provider: selected,
      version,
      builds: entries.map(({ artifact, modules, ...entry }) => ({
        ...entry,
        url:
          id === "vanilla"
            ? (article ?? release.url)
            : (entry.url ??
              (forgeNotes?.has(entry.id)
                ? forgeChangelogPage(entry.id)
                : versionPage(selected, version, entry.id))),
      })),
    };
  }
  async function currentUrl(current) {
    const provider = versionProviders.find(
      ({ id, name }) =>
        [id, name.toLowerCase()].includes(
          String(current.software).toLowerCase(),
        ) || id === current.loader,
    );
    if (!provider) return undefined;
    const installed = current.version;
    const release = current.gameVersion || installed;
    if (!release || /^unknown$/i.test(release)) return provider.website;
    if (provider.id === "vanilla" && catalogIdentifier("vanilla", release)) {
      const [article, notes] = await Promise.all([
        vanillaArticle(release),
        vanillaNotes(),
      ]);
      const note = article ?? notes.get(release);
      if (note) return note;
      const releases = await manifest().catch(() => null);
      const entry = Array.isArray(releases?.versions)
        ? releases.versions.find((item) => item.id === release)
        : null;
      return vanillaMetadataPage(entry?.url) ?? provider.website;
    }
    if (["neoforge", "forge", "fabric", "quilt"].includes(provider.id)) {
      if (provider.id !== "forge")
        return versionPage(provider, current.gameVersion, installed);
      const game = current.gameVersion || installed?.split("-")[0];
      const build =
        identifier(installed) && game && installed !== game
          ? installed.startsWith(`${game}-`)
            ? installed
            : `${game}-${installed}`
          : undefined;
      return build &&
        catalogIdentifier(provider.id, game) &&
        (await forgeChangelogs(game)).has(build)
        ? forgeChangelogPage(build)
        : versionPage(provider, game, build);
    }
    const version = provider.kind === "proxy" ? installed : release;
    const build = installedJarBuild(provider.id, version, current.jar);
    const page = build && adapters[provider.id]?.page?.(version, build);
    if (page) return page;
    return versionPage(provider, version, build);
  }
  async function verifiedJar(
    url,
    algorithm,
    checksum,
    signal,
    limit = 512 * 1024 ** 2,
  ) {
    const length = { sha256: 64, sha1: 40, md5: 32 }[algorithm];
    if (
      typeof checksum !== "string" ||
      !new RegExp(`^[a-f0-9]{${length}}$`, "i").test(checksum)
    )
      throw fail(
        502,
        "The official provider did not publish a usable checksum for this download.",
      );
    const buffer = await bytes(url, limit, signal);
    if (
      createHash(algorithm).update(buffer).digest("hex") !==
      checksum.toLowerCase()
    )
      throw fail(
        502,
        "Download checksum verification failed. No server files were changed.",
      );
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b)
      throw fail(502, "The verified download is not a JAR archive.");
    return buffer;
  }
  async function stage(
    selection,
    { stageDir, javaPath = "java", onProgress = () => {}, signal } = {},
  ) {
    signal?.throwIfAborted();
    const { provider: id, version, build } = selection ?? {};
    const selected = provider(id);
    if (!catalogIdentifier(id, build))
      throw fail(400, "Choose an official build.");
    const { entries } = await catalogBuilds(id, version);
    const entry = entries.find((entry) => entry.id === build);
    if (!entry)
      throw fail(
        400,
        "The selected build is not in the official catalog. Refresh and try again.",
      );
    if (
      !path.isAbsolute(stageDir ?? "") ||
      (await fs.lstat(stageDir)).isSymbolicLink() ||
      (await fs.readdir(stageDir)).length
    )
      throw fail(
        400,
        "Version installation requires an empty private staging directory.",
      );
    const root = await fs.realpath(stageDir);
    const output = path.join(root, "server");
    await fs.mkdir(output);
    let artifact;
    let algorithm;
    let checksum;
    let installerArgs;
    let runDirectory = output;
    let javaArgs = [];
    let installerEnvironment, installerTimeout;
    let jar = `${id}-${version}-${build}.jar`;
    const configuration = {
      launchType: "jar",
      launchScript: "",
      launchExecutable: "",
      launchArgs: [],
      software: selected.name,
      version:
        id === "vanilla" ||
        paperProjects.has(id) ||
        [
          "purpur",
          "leaves",
          "mohist",
          "sponge",
          "spigot",
          "pufferfish",
          "canvas",
        ].includes(id)
          ? version
          : build,
    };
    if (id === "spigot") {
      const installer = await adapters.spigot.installer({
        version,
        build,
        root,
        output,
        javaPath,
        signal,
      });
      artifact = spigotBuildTools.url;
      algorithm = "sha256";
      checksum = spigotBuildTools.sha256;
      installerArgs = installer.args;
      javaArgs = installer.javaArgs;
      runDirectory = installer.cwd;
      installerEnvironment = installer.env;
      installerTimeout = installer.timeoutMs;
      if (installer.jar !== jar)
        throw fail(
          400,
          "BuildTools output does not match the selected Spigot build.",
        );
    } else if (id === "neoforge" || id === "forge") {
      artifact = `${id === "neoforge" ? NEO : FORGE}/${build}/${id}-${build}-installer.jar`;
      algorithm = id === "neoforge" ? "sha256" : "sha1";
      checksum = (await text(`${artifact}.${algorithm}`)).trim();
      installerArgs = ["--installServer"];
    } else if (id === "fabric" || id === "quilt") {
      const installers = await json(
        `${id === "fabric" ? FABRIC : QUILT}/installer`,
      );
      const installer =
        installers.find((entry) => entry.stable === true) ??
        installers.find((entry) => stable(entry.version));
      if (!installer)
        throw fail(502, "The official loader service has no stable installer.");
      artifact = installer.url;
      algorithm = "sha256";
      checksum =
        installer.hashes?.sha256 ??
        (await text(`${officialUrl(artifact)}.sha256`)).trim();
      jar = `${id}-server-launch.jar`;
      if (id === "fabric")
        installerArgs = [
          "server",
          "-mcversion",
          version,
          "-loader",
          build,
          "-downloadMinecraft",
          "-dir",
          output,
        ];
      else {
        runDirectory = root;
        installerArgs = [
          "install",
          "server",
          version,
          build,
          "--download-server",
        ];
      }
    } else if (id === "purpur") {
      const data = await json(
        `${PURPUR}/${encodeURIComponent(version)}/${build}`,
      );
      if (data.result !== "SUCCESS")
        throw fail(
          400,
          "This Purpur build did not complete successfully. Choose another build.",
        );
      artifact = `${PURPUR}/${encodeURIComponent(version)}/${build}/download`;
      algorithm = "md5";
      checksum = data.md5;
    } else {
      const data = adapters[id]?.artifact
        ? await adapters[id].artifact(version, entry)
        : entry.artifact;
      artifact = data?.url;
      algorithm =
        id === "vanilla" || (!data?.checksums?.sha256 && data?.checksums?.sha1)
          ? "sha1"
          : "sha256";
      checksum = id === "vanilla" ? data?.sha1 : data?.checksums?.[algorithm];
    }
    onProgress({
      phase: "download",
      message: `Downloading and verifying ${selected.name} ${build}…`,
    });
    const buffer = await verifiedJar(artifact, algorithm, checksum, signal);
    if (installerArgs) {
      const installerFile = path.join(root, "installer.jar");
      await fs.writeFile(installerFile, buffer, { flag: "wx" });
      onProgress({
        phase: "install",
        message:
          id === "spigot"
            ? "Building Spigot locally with BuildTools. This can take several minutes…"
            : `Preparing ${selected.name} in the private staging folder…`,
      });
      signal?.throwIfAborted();
      await runInstaller({
        javaPath,
        args: [...javaArgs, "-jar", installerFile, ...installerArgs],
        cwd: runDirectory,
        env: installerEnvironment,
        timeoutMs: installerTimeout,
        signal,
        onProgress,
      });
      if (id === "spigot") {
        const from = path.join(output, jar);
        if (
          (await fs.realpath(output)) !== output ||
          !(await fs.lstat(from).catch(() => null))?.isFile()
        )
          throw fail(
            400,
            "BuildTools did not create the expected Spigot server JAR.",
          );
        const handle = await fs.open(from, "r");
        try {
          const header = Buffer.alloc(4);
          const { bytesRead } = await handle.read(header);
          if (bytesRead !== 4 || header[0] !== 0x50 || header[1] !== 0x4b)
            throw fail(400, "The Spigot build output is not a JAR archive.");
        } finally {
          await handle.close();
        }
      } else if (id === "neoforge" || id === "forge") {
        const family =
          id === "neoforge"
            ? "net/neoforged/neoforge"
            : "net/minecraftforge/forge";
        const argumentFile = `libraries/${family}/${build}/${process.platform === "win32" ? "win" : "unix"}_args.txt`;
        try {
          await inspectJavaArguments(output, [
            "@user_jvm_args.txt",
            `@${argumentFile}`,
            "nogui",
          ]);
          Object.assign(configuration, {
            launchType: "java-args",
            jar: "",
            launchArgs: ["@user_jvm_args.txt", `@${argumentFile}`, "nogui"],
          });
        } catch (cause) {
          const oldJar = `forge-${build}.jar`;
          if (
            id !== "forge" ||
            !(
              await fs.stat(path.join(output, oldJar)).catch(() => null)
            )?.isFile()
          )
            throw fail(
              400,
              `The installer did not create its expected server launch files. ${cause.message}`,
            );
          jar = oldJar;
        }
      }
    } else await fs.writeFile(path.join(output, jar), buffer, { flag: "wx" });
    if (id === "waterfall" && entry.modules?.length) {
      const directory = path.join(output, "modules");
      await fs.mkdir(directory);
      for (const module of entry.modules) {
        const data = await verifiedJar(
          module.artifact?.url,
          "sha256",
          module.artifact?.checksums?.sha256,
          signal,
          8 * 1024 ** 2,
        );
        await fs.writeFile(path.join(directory, `${module.name}.jar`), data, {
          flag: "wx",
        });
      }
    }
    if (configuration.launchType === "jar") configuration.jar = jar;
    if (
      (await fs.lstat(output)).isSymbolicLink() ||
      (await fs.realpath(output)) !== output
    )
      throw fail(
        400,
        "The installer changed the staging directory. Installation was not promoted.",
      );
    const files = [];
    let total = 0;
    async function collect(directory, prefix = "") {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const relative = `${prefix}${entry.name}`;
        const target = path.join(directory, entry.name);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink())
          throw fail(
            400,
            "The installer created a symbolic link. Installation was not promoted.",
          );
        if (stat.isDirectory()) {
          if (
            relative === "libraries" ||
            relative.startsWith("libraries/") ||
            (id === "waterfall" && relative === "modules")
          )
            await collect(target, `${relative}/`);
          continue;
        }
        const allowed =
          relative.startsWith("libraries/") ||
          (id === "waterfall" && isWaterfallModule(relative)) ||
          [
            jar,
            "server.jar",
            "user_jvm_args.txt",
            "run.bat",
            "run.sh",
            "fabric-server-launcher.properties",
            "quilt-server-launcher.properties",
          ].includes(relative);
        if (!allowed) continue;
        if (!stat.isFile())
          throw fail(400, "The installer output contains a non-regular file.");
        total += stat.size;
        if (files.length >= 100000 || total > 8 * 1024 ** 3)
          throw fail(400, "The installer output exceeds the supported size.");
        files.push({
          path: relative,
          ...(["user_jvm_args.txt", "run.bat", "run.sh"].includes(relative)
            ? { preserveExisting: true }
            : {}),
        });
      }
    }
    await collect(output);
    if (
      configuration.jar &&
      !files.some((entry) => entry.path === configuration.jar)
    )
      throw fail(400, "The installer did not create the selected server JAR.");
    onProgress({
      phase: "ready",
      message: "Verified server files are ready to install.",
    });
    return {
      stageDir: output,
      files,
      configuration,
      summary: {
        provider: id,
        version,
        build,
        checksumAlgorithm: algorithm,
        checksum,
      },
    };
  }
  return {
    listProviders: () => versionProviders.map((provider) => ({ ...provider })),
    versions,
    builds,
    currentUrl,
    stage,
  };
}
