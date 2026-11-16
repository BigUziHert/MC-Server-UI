import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { unpackProviderZip } from "./launchpad-archives.mjs";
import { checkedProviderUrl, USER_AGENT } from "./launchpad-network.mjs";
import { compatibleJava, probeJava } from "./java-discovery.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_DOWNLOAD = 512 * 1024 ** 2;
const downloadHosts = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

// Only the official metadata endpoint chooses the package. Every redirect is
// checked before fetching it, and the archive must match the published SHA-256.
async function responseFor(address, { request, signal, hosts }) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    address = checkedProviderUrl(address, hosts);
    const response = await request(address, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      address = new URL(response.headers.get("location") ?? "", address).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw fail(
        502,
        response.status === 404
          ? "Temurin does not offer this Java version for this computer. Install a compatible runtime manually, then refresh Java."
          : `Java download service returned ${response.status}. Try again shortly.`,
      );
    }
    return response;
  }
  throw fail(502, "The Java download service redirected too many times.");
}

async function temurinPackage(
  major,
  { architecture, request = fetch, signal },
) {
  const url = new URL(
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot`,
  );
  url.search = new URLSearchParams({
    architecture,
    image_type: "jdk",
    os: "windows",
    vendor: "eclipse",
  }).toString();
  const response = await responseFor(url.href, {
    request,
    signal: AbortSignal.any(
      [signal, AbortSignal.timeout(30000)].filter(Boolean),
    ),
    hosts: ["api.adoptium.net"],
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 ** 2)
      throw fail(502, "Java download metadata exceeded its size limit.");
    chunks.push(chunk);
  }
  let assets;
  try {
    assets = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(502, "Java download service returned invalid metadata.");
  }
  const asset =
    Array.isArray(assets) &&
    assets.find(
      (item) =>
        item?.version?.major === major &&
        item.vendor === "eclipse" &&
        item.binary?.os === "windows" &&
        item.binary.architecture === architecture &&
        item.binary.image_type === "jdk" &&
        item.binary.jvm_impl === "hotspot" &&
        item.binary.heap_size === "normal" &&
        item.binary.project === "jdk",
    );
  const pkg = asset?.binary?.package;
  if (
    !pkg ||
    !/^[a-f0-9]{64}$/i.test(pkg.checksum) ||
    !Number.isSafeInteger(pkg.size) ||
    pkg.size <= 0 ||
    pkg.size > MAX_DOWNLOAD ||
    typeof pkg.name !== "string" ||
    !pkg.name.endsWith(".zip")
  )
    throw fail(
      502,
      "A verified Temurin ZIP for the required Java version is unavailable.",
    );
  const address = new URL(checkedProviderUrl(pkg.link, ["github.com"]));
  if (
    !address.pathname.startsWith(
      `/adoptium/temurin${major}-binaries/releases/download/`,
    ) ||
    !address.pathname.endsWith(".zip")
  )
    throw fail(
      502,
      "Java package did not come from the official Temurin release repository.",
    );
  return {
    url: address.href,
    size: pkg.size,
    sha256: pkg.checksum.toLowerCase(),
    version: asset.version.openjdk_version,
  };
}

export function createJavaInstallation({
  dataDir,
  safePath,
  requirement,
  probe = probeJava,
  request = fetch,
  platform = process.platform,
  arch = process.arch,
  signal: parentSignal,
  onInstalled = async () => {},
}) {
  const architecture =
    arch === "x64" ? "x64" : arch === "arm64" ? "aarch64" : null;
  const supported = platform === "win32" && !!architecture;
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const jobs = new Map();
  let active, latest, rootIdentity;
  const root = async () => {
    const directory = await safePath(dataDir, "java-runtimes");
    await fs.mkdir(directory, { recursive: true });
    const identity = await fs.realpath(directory);
    const stat = await fs.lstat(directory);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (rootIdentity &&
        (rootIdentity.path !== identity ||
          rootIdentity.ino !== stat.ino ||
          rootIdentity.dev !== stat.dev ||
          rootIdentity.birthtimeMs !== stat.birthtimeMs))
    )
      throw fail(409, "Managed Java storage changed. Restart MC Panel.");
    rootIdentity ??= {
      path: identity,
      ino: stat.ino,
      dev: stat.dev,
      birthtimeMs: stat.birthtimeMs,
    };
    return identity;
  };
  const snapshot = (job) => (job ? structuredClone(job) : null);
  const support = () => ({
    installSupported: supported,
    ...(!supported
      ? {
          installMessage:
            "Automatic Java installation is available on 64-bit Windows. Install Java manually, then refresh.",
        }
      : {}),
    installJob: snapshot(latest),
  });
  async function execute(job, input) {
    let stage;
    let installed = false;
    let destination;
    let damaged, quarantine;
    const stagePath = async (relative) =>
      safePath(await root(), `${stage}/${relative}`);
    try {
      signal.throwIfAborted();
      job.status = "running";
      job.phase = "resolving";
      job.message = "Checking the required Java version…";
      const { requiredJavaVersion: major } = await requirement(input);
      if (!Number.isInteger(major) || major < 8 || major > 100)
        throw fail(
          409,
          "The official catalog could not confirm which Java version is required. Refresh the Minecraft version and try again.",
        );
      job.majorVersion = major;
      const timeout = AbortSignal.any([
        signal,
        AbortSignal.timeout(10 * 60_000),
      ]);
      const pkg = await temurinPackage(major, {
        architecture,
        request,
        signal: timeout,
      });
      const directory = await root();
      const finalName = `temurin-${major}-windows-${architecture}-${pkg.sha256.slice(0, 16)}`;
      destination = await safePath(directory, finalName);
      const existing = await fs.lstat(destination).catch((cause) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
        throw fail(409, "Managed Java storage changed. Restart MC Panel.");
      if (existing) {
        let saved;
        try {
          saved = JSON.parse(
            await fs.readFile(
              await safePath(destination, "mc-panel-runtime.json"),
              "utf8",
            ),
          );
        } catch (cause) {
          if (cause.code !== "ENOENT" && !(cause instanceof SyntaxError))
            throw cause;
        }
        if (
          saved?.sha256 === pkg.sha256 &&
          saved.majorVersion === major &&
          typeof saved.executable === "string" &&
          /^(?!\.{1,2}\/)[^/\\]+\/bin\/java\.exe$/i.test(saved.executable)
        ) {
          try {
            const executable = await safePath(destination, saved.executable);
            const java = await probe(executable);
            if (compatibleJava(java, major)) {
              job.java = { ...java, path: executable };
              job.message = `Java ${major} is ready.`;
              job.phase = "completed";
              job.status = "completed";
              await onInstalled();
              return;
            }
          } catch (cause) {
            if (cause.code !== "ENOENT") throw cause;
          }
        }
        // Download and verify the replacement before moving the damaged runtime.
        // A network/checksum failure leaves its original files untouched.
        damaged = existing;
      }
      stage = `.install-${job.id}`;
      const stageDir = await safePath(directory, stage);
      await fs.mkdir(stageDir);
      job.phase = "downloading";
      job.message = `Downloading Java ${major}…`;
      job.totalBytes = pkg.size;
      const response = await responseFor(pkg.url, {
        request,
        signal: timeout,
        hosts: downloadHosts,
      });
      const handle = await fs.open(await stagePath("java.zip"), "wx");
      const hash = createHash("sha256");
      try {
        for await (const chunk of response.body) {
          timeout.throwIfAborted();
          job.downloadedBytes += chunk.length;
          if (
            job.downloadedBytes > pkg.size ||
            job.downloadedBytes > MAX_DOWNLOAD
          )
            throw fail(502, "Java download exceeded its verified size.");
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        job.phase = "verifying";
        job.message = "Verifying the Java download…";
        if (
          job.downloadedBytes !== pkg.size ||
          hash.digest("hex") !== pkg.sha256
        )
          throw fail(
            502,
            "Java download failed its checksum check. Try again; no runtime was installed.",
          );
        await handle.sync();
      } finally {
        await handle.close();
      }
      timeout.throwIfAborted();
      const unpacked = await stagePath("runtime");
      await fs.mkdir(unpacked);
      job.phase = "extracting";
      job.message = `Installing Java ${major}…`;
      const files = await unpackProviderZip(
        await stagePath("java.zip"),
        unpacked,
        undefined,
        {
          signal: timeout,
        },
      );
      const executables = files.filter((file) =>
        /^[^/]+\/bin\/java\.exe$/i.test(file.path),
      );
      if (executables.length !== 1)
        throw fail(
          502,
          "The Java archive did not contain a single Java executable.",
        );
      const executable = executables[0].path;
      job.phase = "checking";
      job.message = `Checking Java ${major}…`;
      const java = await probe(await stagePath(`runtime/${executable}`));
      if (!compatibleJava(java, major))
        throw fail(
          502,
          `The downloaded runtime did not pass its Java ${major} check.`,
        );
      const actualArchitecture = java.architecture?.toLowerCase();
      if (
        actualArchitecture &&
        !(
          architecture === "x64"
            ? ["x64", "amd64", "x86_64"]
            : ["aarch64", "arm64"]
        ).includes(actualArchitecture)
      )
        throw fail(
          502,
          "The downloaded Java runtime has the wrong architecture for this computer.",
        );
      await fs.writeFile(
        await stagePath("runtime/mc-panel-runtime.json"),
        JSON.stringify({ executable, sha256: pkg.sha256, majorVersion: major }),
        { flag: "wx" },
      );
      timeout.throwIfAborted();
      // Re-resolve containment immediately before the one atomic promotion.
      await root();
      if (damaged) {
        const current = await fs.lstat(await safePath(directory, finalName));
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.ino !== damaged.ino ||
          current.dev !== damaged.dev ||
          current.birthtimeMs !== damaged.birthtimeMs
        )
          throw fail(
            409,
            "Managed Java storage changed during repair. Try again.",
          );
        const staleName = `.stale-${job.id}`;
        try {
          await fs.rename(
            await safePath(directory, finalName),
            await safePath(directory, staleName),
          );
          quarantine = staleName;
        } catch (cause) {
          if (["EPERM", "EACCES", "EBUSY"].includes(cause.code))
            throw fail(
              409,
              "Close any servers using this Java runtime, then retry its repair.",
            );
          throw cause;
        }
      }
      await fs.rename(
        await stagePath("runtime"),
        await safePath(directory, finalName),
      );
      installed = true;
      job.java = { ...java, path: await safePath(destination, executable) };
      delete job.java.home;
      await onInstalled();
      job.status = "completed";
      job.phase = "completed";
      job.message = `Java ${major} installed and ready.`;
    } catch (cause) {
      if (quarantine && !installed) {
        try {
          const directory = await root();
          const target = await safePath(directory, path.basename(destination));
          const exists = await fs.lstat(target).catch((failure) => {
            if (failure.code === "ENOENT") return null;
            throw failure;
          });
          if (!exists) {
            await fs.rename(await safePath(directory, quarantine), target);
            quarantine = undefined;
          }
        } catch {
          // Retain the quarantined files if their original path changed.
        }
      }
      job.status = "failed";
      job.message = "Java installation could not be completed.";
      job.error = signal.aborted
        ? "Java installation was interrupted. Try again after reopening MC Panel."
        : cause.message;
      // Never delete a promoted runtime: another server may already use it.
      if (installed)
        job.error +=
          " The verified Java files were retained; refresh Java to use them.";
    } finally {
      if (quarantine && installed) {
        try {
          await fs.rm(await safePath(await root(), quarantine), {
            recursive: true,
            force: true,
          });
        } catch {
          // A verified replacement remains usable even if old files are locked.
        }
      }
      if (stage) {
        try {
          await fs.rm(await safePath(await root(), stage), {
            recursive: true,
            force: true,
          });
        } catch {
          /* Do not follow a changed storage path for cleanup. */
        }
      }
      job.finishedAt = new Date().toISOString();
    }
  }
  return {
    support,
    install(input = {}) {
      if (signal.aborted)
        throw fail(503, "Java installation is shutting down.");
      if (!supported) throw fail(400, support().installMessage);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof input.gameVersion !== "string" ||
        !input.gameVersion.trim() ||
        input.gameVersion.length > 128 ||
        (input.provider !== undefined &&
          (typeof input.provider !== "string" || input.provider.length > 64)) ||
        (input.build !== undefined &&
          (typeof input.build !== "string" || input.build.length > 128))
      )
        throw fail(400, "Choose a Minecraft release before installing Java.");
      const selection = {
        gameVersion: input.gameVersion.trim(),
        provider: input.provider || "vanilla",
        ...(input.build ? { build: input.build } : {}),
      };
      const key = JSON.stringify(selection);
      if (active) {
        if (active.key === key) return snapshot(latest);
        throw fail(409, "Wait for the current Java installation to finish.");
      }
      latest = {
        id: randomUUID(),
        status: "queued",
        phase: "resolving",
        message: "Preparing Java installation…",
        majorVersion: null,
        downloadedBytes: 0,
        totalBytes: null,
        createdAt: new Date().toISOString(),
      };
      jobs.set(latest.id, latest);
      while (jobs.size > 10) jobs.delete(jobs.keys().next().value);
      const pending = Promise.resolve().then(() => execute(latest, selection));
      active = { key, pending };
      pending.finally(() => {
        active = null;
      });
      return snapshot(latest);
    },
    job(id) {
      if (!jobs.has(id))
        throw fail(
          404,
          "This Java installation job was not found. Refresh Java to check installed runtimes.",
        );
      return snapshot(jobs.get(id));
    },
    async close() {
      controller.abort(fail(503, "Java installation is shutting down."));
      await active?.pending;
    },
  };
}
