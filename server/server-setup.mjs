import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  probeJava,
  createJavaDiscovery,
  compatibleJava,
} from "./java-discovery.mjs";
export { probeJava } from "./java-discovery.mjs";
import { totalmem, freemem } from "node:os";
import { createVersionsService } from "./versions.mjs";
import { createLaunchpad, providerJson } from "./launchpad.mjs";
import { createExtraProviders } from "./launchpad-extra.mjs";
import { createJavaInstallation } from "./java-installation.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const emptyServer = async () => ({
  status: "offline",
  gameVersion: null,
  loader: null,
});

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
    versionsService: versions,
    fetch: catalogFetch,
    extraProviders,
    platformConfig,
    getServer: emptyServer,
    audit: (
      action,
      detail,
      category = "server",
      actor = "Local administrator",
    ) => Promise.resolve(options.audit?.(category, action, detail, actor)),
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
  // Unit fixtures can inject just a probe without scanning the developer's PC.
  const discoverJava =
    options.javaDiscovery ??
    (options.javaProbe
      ? async () => {
          const java = await javaProbe(options.javaPath ?? "java");
          return java.available ? [java] : [];
        }
      : createJavaDiscovery({
          preferredPath: options.javaPath,
          ...options.javaDiscoveryOptions,
        }));
  const managedJava = createJavaDiscovery({
    env: {},
    roots: [],
    managedDir: path.join(dataDir, "java-runtimes"),
    probe: javaProbe,
  });
  async function allJava(refresh = false) {
    const [managed, detected] = await Promise.all([
      managedJava({ refresh }),
      discoverJava({ refresh }),
    ]);
    const unique = new Map();
    for (const java of [...managed, ...detected])
      if (java.path)
        unique.set(
          process.platform === "win32" ? java.path.toLowerCase() : java.path,
          java,
        );
    return [...unique.values()];
  }
  async function javaRequirement(input = {}, { officialOnly = false } = {}) {
    const required = officialOnly ? undefined : input.requiredJavaVersion;
    if (
      required !== undefined &&
      (!Number.isInteger(required) || required < 8 || required > 100)
    )
      throw fail(400, "Choose a valid required Java version.");
    if (
      input.gameVersion !== undefined &&
      (typeof input.gameVersion !== "string" || input.gameVersion.length > 128)
    )
      throw fail(400, "Choose a Minecraft release.");
    if (
      input.build !== undefined &&
      (typeof input.build !== "string" || input.build.length > 128)
    )
      throw fail(400, "Choose a Minecraft build.");
    let requiredJavaVersion = required ?? null;
    const warnings = [];
    if (!requiredJavaVersion && input.gameVersion) {
      if (input.provider && input.provider !== "vanilla") {
        try {
          const catalog = await versions.builds(
            input.provider,
            input.gameVersion,
          );
          const selected = input.build
            ? catalog.builds.find((build) => build.id === input.build)
            : null;
          if (input.build && !selected)
            throw fail(
              400,
              "This Minecraft build is no longer available. Choose it again.",
            );
          requiredJavaVersion =
            selected?.javaVersion ??
            (input.build
              ? null
              : catalog.builds.find((build) =>
                  Number.isInteger(build.javaVersion),
                )?.javaVersion) ??
            null;
        } catch (cause) {
          if (officialOnly && input.build) throw cause;
        }
      }
      if (!requiredJavaVersion)
        try {
          const official = await versions.builds("vanilla", input.gameVersion);
          requiredJavaVersion =
            official.builds.find((build) => Number.isInteger(build.javaVersion))
              ?.javaVersion ?? null;
        } catch {}
      // Official older manifests omit the Java metadata. These release-era
      // requirements are bounded; new/experimental releases require metadata.
      if (
        !requiredJavaVersion &&
        /^1\.(?:[0-9]|1[0-6])(?:\.\d+)?$/.test(input.gameVersion)
      )
        requiredJavaVersion = 8;
      if (!requiredJavaVersion)
        warnings.push(
          "The official catalog could not confirm this release's Java requirement. Refresh the list when the catalog is available.",
        );
    }
    return {
      requiredJavaVersion,
      requirement: requiredJavaVersion
        ? `Java ${requiredJavaVersion} (64-bit)`
        : input.gameVersion
          ? "Java requirement unavailable"
          : "Choose a Minecraft version to filter installed Java",
      warnings,
    };
  }
  const javaInstaller = createJavaInstallation({
    dataDir,
    safePath,
    probe: javaProbe,
    signal: lifetime.signal,
    ...options.javaInstallationOptions,
    requirement: async (input) => {
      if (
        !versions
          .listProviders()
          .some((provider) => provider.id === input.provider) &&
        input.provider !== "vanilla"
      )
        throw fail(400, "Choose an available Minecraft server software.");
      return javaRequirement(input, { officialOnly: true });
    },
    onInstalled: async () => {
      await managedJava({ refresh: true });
    },
  });
  async function javaInstallations(input = {}) {
    const [detected, requirement] = await Promise.all([
      allJava(input.refresh === true),
      javaRequirement(input),
    ]);
    const validated = detected.filter(
      (java) =>
        java.available && Number.isInteger(java.majorVersion) && java.path,
    );
    const installations = (
      input.gameVersion && !requirement.requiredJavaVersion
        ? []
        : validated.filter((java) =>
            compatibleJava(java, requirement.requiredJavaVersion),
          )
    ).map(({ path, version, majorVersion, vendor, architecture }) => ({
      path,
      version,
      majorVersion,
      ...(vendor ? { vendor } : {}),
      ...(architecture ? { architecture } : {}),
    }));
    return {
      ...requirement,
      ...javaInstaller.support(),
      installations,
      recommendedPath: installations[0]?.path ?? null,
      detectedCount: validated.length,
    };
  }
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
    const { requiredJavaVersion, requirement, warnings } =
      await javaRequirement(input);
    let java;
    if (input.javaPath !== undefined) java = await javaProbe(input.javaPath);
    else {
      const detected = await allJava();
      java = detected.find((entry) =>
        compatibleJava(entry, requiredJavaVersion),
      ) ?? {
        path: null,
        available: false,
        version: null,
        majorVersion: null,
        error: `Java was not found${requiredJavaVersion ? ` for ${requirement}` : ""}. Install a compatible runtime, then refresh the Java list.`,
      };
    }
    const memory = host();
    if (!java.available) warnings.push(java.error ?? "Java is unavailable.");
    if (
      requiredJavaVersion &&
      java.available &&
      !compatibleJava(java, requiredJavaVersion)
    )
      warnings.push(
        `This release requires Java ${requiredJavaVersion} (64-bit); the selected executable is Java ${java.majorVersion}${java.architecture ? ` (${java.architecture})` : ""}. Choose a compatible runtime from the list.`,
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
      compatibleJava(java, requiredJavaVersion) &&
      (!input.gameVersion || !!requiredJavaVersion);
    return {
      ...memory,
      java,
      requiredJavaVersion,
      requirement,
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
      "/api/server-setup/java",
      endpoint(async (req, res) =>
        res.json(
          await javaInstallations({
            gameVersion: req.query.gameVersion || undefined,
            provider: req.query.provider || undefined,
            build: req.query.build || undefined,
            requiredJavaVersion:
              req.query.requiredJavaVersion === undefined
                ? undefined
                : Number(req.query.requiredJavaVersion),
            refresh: req.query.refresh === "1",
          }),
        ),
      ),
    );
    app.post(
      "/api/server-setup/java/install",
      endpoint(async (req, res) =>
        res.status(202).json({ job: javaInstaller.install(req.body) }),
      ),
    );
    app.get(
      "/api/server-setup/java/jobs/:id",
      endpoint(async (req, res) =>
        res.json({ job: javaInstaller.job(req.params.id) }),
      ),
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
      await javaInstaller.close();
      await Promise.allSettled(
        [...activeReviews].map((closeReview) => closeReview()),
      );
      await Promise.allSettled([...pendingReviews]);
      await catalog.close();
    },
  };
}
