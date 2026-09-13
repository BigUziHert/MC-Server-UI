import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { inspectJavaArguments } from "./import.mjs";

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
const NEO = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const FORGE = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FABRIC = "https://meta.fabricmc.net/v2/versions";
const QUILT = "https://meta.quiltmc.org/v3/versions";
const VANILLA =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const PURPUR = "https://api.purpurmc.org/v2/purpur";
const hosts = new Set([
  "fill.papermc.io",
  "fill-data.papermc.io",
  "api.papermc.io",
  "maven.neoforged.net",
  "maven.minecraftforge.net",
  "meta.fabricmc.net",
  "maven.fabricmc.net",
  "meta.quiltmc.org",
  "maven.quiltmc.org",
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "launcher.mojang.com",
  "launchermeta.mojang.com",
  "api.purpurmc.org",
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
    "A Paper fork focused on large-server performance.",
    "https://pufferfish.host/downloads",
  ],
  [
    "spigot",
    "Spigot",
    "Build the established Bukkit-compatible server with BuildTools.",
    "https://www.spigotmc.org/wiki/buildtools/",
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
    false,
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
    false,
    "server",
    "Unmaintained",
  ],
  [
    "arclight",
    "Arclight",
    "A hybrid server supporting mods and Bukkit plugins.",
    "https://github.com/IzzelAliz/Arclight/releases",
  ],
  [
    "sponge",
    "Sponge",
    "Server software for the Sponge plugin platform.",
    "https://spongepowered.org/downloads/spongevanilla",
  ],
  [
    "leaves",
    "Leaves",
    "A Paper-based server focused on vanilla mechanics.",
    "https://leavesmc.org/downloads/leaves",
  ],
  [
    "canvas",
    "Canvas",
    "A server focused on performance and parallel processing.",
    "https://canvasmc.io/downloads",
  ],
  [
    "magma",
    "Magma",
    "A hybrid platform for mods and Bukkit plugins.",
    "https://magmafoundation.org/",
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
    if (previous && previous.expires > Date.now()) return previous.value;
    const value = Promise.resolve()
      .then(work)
      .catch((cause) => {
        cache.delete(key);
        throw cause;
      });
    cache.set(key, { value, expires: Date.now() + cacheMs });
    return value;
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
  async function versions(id) {
    const selected = provider(id);
    const entries = await cached(`versions:${id}`, async () => {
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
      if (["paper", "folia", "velocity"].includes(id)) {
        const data = await json(`${PAPER}/${id}`);
        if (!data.versions || typeof data.versions !== "object")
          throw fail(502, "The official service returned invalid versions.");
        return Object.values(data.versions)
          .flat()
          .filter(identifier)
          .sort(newest)
          .map((id) => ({ id, label: id, stable: stable(id) }));
      }
      if (id === "vanilla")
        return (await manifest()).versions
          .filter(
            (entry) =>
              catalogIdentifier(id, entry.id) &&
              ["release", "snapshot"].includes(entry.type),
          )
          .map((entry) => ({
            id: entry.id,
            label: entry.id,
            stable: entry.type === "release",
          }));
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
    return { provider: selected, versions: entries };
  }
  async function builds(id, version) {
    const selected = provider(id);
    if (
      !catalogIdentifier(id, version) ||
      !(await versions(id)).versions.some((item) => item.id === version)
    )
      throw fail(400, "Choose a Minecraft version from the official catalog.");
    const entries = await cached(`builds:${id}:${version}`, async () => {
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
      if (["paper", "folia", "velocity"].includes(id)) {
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
    return {
      provider: selected,
      version,
      builds: entries.map(({ artifact, ...entry }) => entry),
    };
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
    const listing = await builds(id, version);
    if (!listing.builds.some((entry) => entry.id === build))
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
    let jar = `${id}-${version}-${build}.jar`;
    const configuration = {
      launchType: "jar",
      launchScript: "",
      launchExecutable: "",
      launchArgs: [],
      software: selected.name,
      version:
        id === "vanilla" ||
        ["paper", "purpur", "folia", "velocity"].includes(id)
          ? version
          : build,
    };
    if (id === "neoforge" || id === "forge") {
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
      const stored = await cache.get(`builds:${id}:${version}`).value;
      const data = stored.find((entry) => entry.id === build).artifact;
      artifact = data.url;
      algorithm = id === "vanilla" ? "sha1" : "sha256";
      checksum = id === "vanilla" ? data.sha1 : data.checksums?.sha256;
    }
    const length = { sha256: 64, sha1: 40, md5: 32 }[algorithm];
    if (
      typeof checksum !== "string" ||
      !new RegExp(`^[a-f0-9]{${length}}$`, "i").test(checksum)
    )
      throw fail(
        502,
        "The official provider did not publish a usable checksum for this download.",
      );
    onProgress({
      phase: "download",
      message: `Downloading and verifying ${selected.name} ${build}…`,
    });
    const buffer = await bytes(artifact, 512 * 1024 ** 2, signal);
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
    if (installerArgs) {
      const installerFile = path.join(root, "installer.jar");
      await fs.writeFile(installerFile, buffer, { flag: "wx" });
      onProgress({
        phase: "install",
        message: `Preparing ${selected.name} in the private staging folder…`,
      });
      signal?.throwIfAborted();
      await runInstaller({
        javaPath,
        args: ["-jar", installerFile, ...installerArgs],
        cwd: runDirectory,
        signal,
        onProgress,
      });
      if (id === "neoforge" || id === "forge") {
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
          if (relative === "libraries" || relative.startsWith("libraries/"))
            await collect(target, `${relative}/`);
          continue;
        }
        const allowed =
          relative.startsWith("libraries/") ||
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
    stage,
  };
}
