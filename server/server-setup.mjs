import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { totalmem, freemem } from "node:os";
import { createVersionsService } from "./versions.mjs";
import { createLaunchpad, providerJson } from "./launchpad.mjs";
import { createExtraProviders } from "./launchpad-extra.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const emptyServer = async () => ({
  status: "offline",
  gameVersion: null,
  loader: null,
});

export function probeJava(
  javaPath = "java",
  { spawnProcess = spawn, timeoutMs = 5000 } = {},
) {
  if (
    typeof javaPath !== "string" ||
    !javaPath.trim() ||
    javaPath.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(javaPath)
  )
    throw fail(400, "Enter java or the path to a Java executable.");
  return new Promise((resolve) => {
    let child,
      timer,
      done = false,
      output = "";
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const match =
        /(?:openjdk|java)\s+(?:version\s+)?["']?([\d][\w.+-]*)/i.exec(output);
      const version = match?.[1] ?? null;
      const majorVersion = version
        ? Number(
            version.startsWith("1.")
              ? version.split(".")[1]
              : version.split(/[.+-]/)[0],
          )
        : null;
      resolve({
        path: javaPath,
        available: !error && !!majorVersion,
        version,
        majorVersion,
        ...(error || !majorVersion
          ? { error: error || "Java did not report a recognizable version." }
          : {}),
      });
    };
    try {
      child = spawnProcess(javaPath, ["-version"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (data) => {
        output = (output + data.toString()).slice(0, 65536);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", (cause) =>
        finish(
          cause.code === "ENOENT"
            ? "Java was not found. Install a compatible Java runtime or choose its executable."
            : `Could not check Java: ${cause.message}`,
        ),
      );
      child.once("close", (code) =>
        finish(
          code === 0 ? null : `Java version check exited with code ${code}.`,
        ),
      );
      timer = setTimeout(() => {
        finish(
          "Java version check timed out. Check the executable path and try again.",
        );
        child.kill();
      }, timeoutMs);
    } catch (cause) {
      finish(`Could not check Java: ${cause.message}`);
    }
  });
}

// Catalog reads have no selected server. Pack reviews use a disposable empty
// workspace and the same checksum/path/dependency checks as scoped installs.
export async function createServerSetup({ dataDir, safePath, ...options }) {
  const lifetime = new AbortController();
  const request = options.catalogFetch ?? fetch;
  const catalogFetch = (url, init = {}) =>
    request(url, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([lifetime.signal, init.signal])
        : lifetime.signal,
    });
  const versions =
    options.versionsService ?? createVersionsService(options.versionsOptions);
  const settingsPath = () => safePath(dataDir, "setup-catalog-settings.json");
  const platformConfig = {
    async get() {
      try {
        const value = JSON.parse(
          await fs.readFile(await settingsPath(), "utf8"),
        );
        return {
          curseforgeApiKey:
            typeof value.curseforgeApiKey === "string"
              ? value.curseforgeApiKey
              : null,
        };
      } catch (cause) {
        if (cause.code === "ENOENT") return { curseforgeApiKey: null };
        throw cause;
      }
    },
    async set(value) {
      const temporary = await safePath(
        dataDir,
        `setup-catalog-${randomUUID()}.tmp`,
      );
      try {
        await fs.writeFile(temporary, JSON.stringify(value), {
          flag: "wx",
          mode: 0o600,
        });
        await fs.rename(temporary, await settingsPath());
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
  };
  const extraProviders =
    options.extraProviders ??
    (await createExtraProviders({
      json: (url, init) => providerJson(url, { ...init, fetch: catalogFetch }),
      fetch: catalogFetch,
    }));
  const common = {
    safePath,
    fetch: catalogFetch,
    extraProviders,
    platformConfig,
    getServer: emptyServer,
  };
  const catalog = await createLaunchpad({ ...common, catalogOnly: true });
  const activeReviews = new Set();
  const pendingReviews = new Set();
  const host = () => {
    const hostMemoryMB = Math.floor(
      (options.totalMemory?.() ?? totalmem()) / 1024 ** 2,
    );
    return {
      hostMemoryMB,
      freeMemoryMB: Math.floor(
        (options.freeMemory?.() ?? freemem()) / 1024 ** 2,
      ),
      suggestedMemoryMB: Math.max(
        256,
        Math.min(
          8192,
          Math.floor(Math.max(256, hostMemoryMB - 2048) / 512) * 512,
          Math.floor((hostMemoryMB * 0.4) / 256) * 256,
        ),
      ),
    };
  };
  const javaProbe = options.javaProbe ?? probeJava;
  async function preflight(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw fail(400, "Provide the new server's memory and Java settings.");
    const memoryLimitMB = input.memoryLimitMB ?? host().suggestedMemoryMB;
    if (
      !Number.isInteger(memoryLimitMB) ||
      memoryLimitMB < 256 ||
      memoryLimitMB > 262144
    )
      throw fail(400, "Memory must be an integer between 256 and 262144 MB.");
    if (
      input.requiredJavaVersion !== undefined &&
      (!Number.isInteger(input.requiredJavaVersion) ||
        input.requiredJavaVersion < 8 ||
        input.requiredJavaVersion > 100)
    )
      throw fail(400, "Choose a valid required Java version.");
    const java = await javaProbe(input.javaPath ?? options.javaPath ?? "java");
    let requiredJavaVersion = input.requiredJavaVersion ?? null;
    const warnings = [];
    if (!requiredJavaVersion && input.gameVersion) {
      try {
        const official = await versions.builds("vanilla", input.gameVersion);
        requiredJavaVersion =
          official.builds.find((build) => Number.isInteger(build.javaVersion))
            ?.javaVersion ?? null;
      } catch {
        warnings.push(
          "The official catalog could not confirm this release's Java requirement. Check its release notes before starting.",
        );
      }
    }
    const memory = host();
    if (!java.available) warnings.push(java.error ?? "Java is unavailable.");
    if (
      requiredJavaVersion &&
      java.available &&
      java.majorVersion < requiredJavaVersion
    )
      warnings.push(
        `This release requires Java ${requiredJavaVersion} or newer; the selected executable is Java ${java.majorVersion}.`,
      );
    if (memoryLimitMB >= memory.hostMemoryMB)
      warnings.push(
        "The selected server memory leaves no RAM for your operating system. Choose a smaller allocation.",
      );
    else if (memory.hostMemoryMB - memoryLimitMB < 2048)
      warnings.push(
        "Less than 2 GB of host RAM would remain for the operating system and other applications.",
      );
    if (memoryLimitMB > memory.freeMemoryMB)
      warnings.push(
        "The selected allocation is above currently available RAM. Close other applications or lower the allocation before starting.",
      );
    const compatible =
      java.available &&
      (!requiredJavaVersion || java.majorVersion >= requiredJavaVersion);
    return {
      ...memory,
      java,
      requiredJavaVersion,
      memoryLimitMB,
      warnings,
      compatible,
      ready: compatible && memoryLimitMB < memory.hostMemoryMB,
    };
  }
  async function reviewPack(input, signal) {
    if (input?.type !== "modpack")
      throw fail(400, "Choose a modpack to review for the new server.");
    const reviewSignal = signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    reviewSignal.throwIfAborted();
    if (pendingReviews.size >= 2)
      throw fail(
        409,
        "Wait for the current modpack review to finish before preparing another.",
      );
    const pending = (async () => {
      const id = randomUUID();
      const root = await safePath(dataDir, `setup-preview-${id}`);
      let preview, closePromise;
      const stopPreview = () => {
        if (preview) closePromise ??= preview.close();
        return closePromise ?? Promise.resolve();
      };
      const cancelled = () => {
        void stopPreview().catch(() => {});
      };
      reviewSignal.addEventListener("abort", cancelled, { once: true });
      try {
        reviewSignal.throwIfAborted();
        await fs.mkdir(root);
        const serverDir = await safePath(root, "server");
        await fs.mkdir(serverDir);
        preview = await createLaunchpad({
          ...common,
          dataDir: root,
          serverDir,
        });
        activeReviews.add(stopPreview);
        reviewSignal.throwIfAborted();
        return await preview.preview({ ...input, signal: reviewSignal });
      } finally {
        reviewSignal.removeEventListener("abort", cancelled);
        await stopPreview();
        activeReviews.delete(stopPreview);
        // Resolve containment and reject replaced symlinks immediately before removal.
        await fs.rm(await safePath(dataDir, `setup-preview-${id}`), {
          recursive: true,
          force: true,
        });
      }
    })();
    pendingReviews.add(pending);
    try {
      return await pending;
    } finally {
      pendingReviews.delete(pending);
    }
  }
  function mount(app) {
    const endpoint = (handler) => async (req, res, next) => {
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", disconnect);
      try {
        await handler(req, res, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted || res.destroyed) return;
        if (cause.status)
          res.status(cause.status).json({ error: cause.message });
        else next(cause);
      } finally {
        res.off("close", disconnect);
      }
    };
    app.get(
      "/api/server-setup",
      endpoint(async (_req, res) => {
        const [listing, checks] = await Promise.all([
          catalog.config(),
          preflight(),
        ]);
        res.json({
          ...listing,
          ...checks,
          warnings: [...listing.warnings, ...checks.warnings],
          providers: versions.listProviders(),
          managedServersDir: path.join(dataDir, "instances"),
        });
      }),
    );
    app.post(
      "/api/server-setup/preflight",
      endpoint(async (req, res) => res.json(await preflight(req.body))),
    );
    app.get(
      "/api/server-setup/versions",
      endpoint(async (_req, res) =>
        res.json({
          providers: versions.listProviders(),
          current: null,
          job: null,
        }),
      ),
    );
    app.get(
      "/api/server-setup/versions/:provider/:version",
      endpoint(async (req, res) =>
        res.json(
          await versions.builds(req.params.provider, req.params.version),
        ),
      ),
    );
    app.get(
      "/api/server-setup/versions/:provider",
      endpoint(async (req, res) =>
        res.json(await versions.versions(req.params.provider)),
      ),
    );
    app.get(
      "/api/server-setup/launchpad",
      endpoint(async (_req, res) => res.json(await catalog.config())),
    );
    for (const method of ["search", "versions"])
      app.get(
        `/api/server-setup/launchpad/${method}`,
        endpoint(async (req, res, signal) =>
          res.json(await catalog[method]({ ...req.query, signal })),
        ),
      );
    app.put(
      "/api/server-setup/launchpad/settings",
      endpoint(async (req, res) => res.json(await catalog.settings(req.body))),
    );
    app.post(
      "/api/server-setup/modpack-preview",
      endpoint(async (req, res, signal) =>
        res.json(await reviewPack(req.body, signal)),
      ),
    );
  }
  return {
    mount,
    async copySettings(instanceDir) {
      const settings = await platformConfig.get();
      if (settings.curseforgeApiKey)
        await fs.writeFile(
          await safePath(instanceDir, "catalog-settings.json"),
          JSON.stringify(settings),
          { flag: "wx", mode: 0o600 },
        );
    },
    async close() {
      lifetime.abort(fail(503, "Server setup is shutting down."));
      await Promise.allSettled(
        [...activeReviews].map((closeReview) => closeReview()),
      );
      await Promise.allSettled([...pendingReviews]);
      await catalog.close();
    },
  };
}
