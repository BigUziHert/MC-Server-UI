import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanInstall, prepareCleanSettings } from "./clean-install.mjs";
import { createVersionsService } from "./versions.mjs";
import { createPropertiesService } from "./properties.mjs";
import { createLaunchpad, providerJson } from "./launchpad.mjs";
import { createExtraProviders } from "./launchpad-extra.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const missing = (cause) => cause.code === "ENOENT";
// Every runtime installation replaces the whole server folder. The registered
// name, port, memory and Java selection remain panel settings.
export async function promoteVersion(result, ctx) {
  const {
    status: _status,
    address: _address,
    ...previousConfiguration
  } = ctx.getConfiguration();
  const previousInstalled = ctx.snapshotInstalled?.();
  let configured = false;
  await prepareCleanSettings(result, ctx);
  return cleanInstall(result, {
    ...ctx,
    commit: async () => {
      configured = true;
      await ctx.applyConfiguration({
        ...result.configuration,
        mode: "live",
        minecraftVersion: result.summary.version,
      });
      await ctx.clearInstalled?.();
    },
    rollback: async () => {
      const failures = [];
      if (configured)
        try {
          await ctx.applyConfiguration(previousConfiguration);
        } catch (cause) {
          failures.push(cause);
        }
      if (previousInstalled)
        try {
          await ctx.restoreInstalled?.(previousInstalled);
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
}
export async function createMinecraft(ctx) {
  const catalogLifetime = new AbortController();
  const request = ctx.fetch ?? fetch;
  const catalogFetch = (url, options = {}) =>
    request(url, {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, catalogLifetime.signal])
        : catalogLifetime.signal,
    });
  const versions =
    ctx.versionsService ?? createVersionsService(ctx.versionsOptions);
  const properties = createPropertiesService({
    ...ctx,
    getServer: ctx.getConfiguration,
  });
  const jobs = new Map();
  let lastJob = null,
    closing = false;
  const operations = new Set();
  const platformConfig = {
    async get() {
      try {
        const value = JSON.parse(
          await fs.readFile(
            await ctx.safePath(ctx.dataDir, "catalog-settings.json"),
            "utf8",
          ),
        );
        return {
          curseforgeApiKey:
            typeof value.curseforgeApiKey === "string"
              ? value.curseforgeApiKey
              : null,
        };
      } catch (cause) {
        if (missing(cause)) return { curseforgeApiKey: null };
        throw cause;
      }
    },
    async set(value) {
      return ctx.withMinecraftMutation(
        async () => {
          const temporary = await ctx.safePath(
            ctx.dataDir,
            `catalog-settings.${randomUUID()}.tmp`,
          );
          try {
            await fs.writeFile(temporary, JSON.stringify(value), {
              flag: "wx",
              mode: 0o600,
            });
            await fs.rename(
              temporary,
              await ctx.safePath(ctx.dataDir, "catalog-settings.json"),
            );
          } finally {
            await fs.rm(temporary, { force: true });
          }
        },
        { requireStopped: false },
      );
    },
  };
  const extras =
    ctx.extraProviders ??
    (await createExtraProviders({
      json: (url, options) =>
        providerJson(url, { ...options, fetch: catalogFetch }),
      fetch: catalogFetch,
    }));
  const launchpad = await createLaunchpad({
    ...ctx,
    versionsService: versions,
    fetch: catalogFetch,
    platformConfig,
    extraProviders: extras,
    audit: (action, detail) => ctx.audit("server", action, detail),
  });
  const privateDir = await ctx.safePath(ctx.dataDir, "versions");
  await fs.mkdir(privateDir, { recursive: true });
  const identity = await fs.realpath(privateDir);
  const privatePath = async (id) => {
    const root = await ctx.safePath(ctx.dataDir, "versions");
    if ((await fs.realpath(root)) !== identity)
      throw fail(409, "Version staging storage changed. Restart the panel.");
    return ctx.safePath(root, id);
  };
  function install(input) {
    if (closing) throw fail(503, "Minecraft management is shutting down.");
    if (input?.confirmed !== true)
      throw fail(400, "Review and confirm the selected server build first.");
    if (input.cleanInstall !== true)
      throw fail(
        400,
        "Confirm the clean installation: all current server files, including worlds, mods and configuration, will be removed.",
      );
    const selection = {
      provider: input.provider,
      version: input.version,
      build: input.build,
    };
    const job = {
      id: randomUUID(),
      state: "queued",
      message: "Preparing installation…",
    };
    const controller = new AbortController();
    // Acquire synchronously before returning 202, so Start and other writes
    // cannot pass between job creation and its first asynchronous operation.
    const operation = ctx.withMinecraftMutation(async () => {
      job.state = "running";
      let staging;
      try {
        staging = await privatePath(job.id);
        await fs.mkdir(staging);
        const result = await versions.stage(selection, {
          stageDir: staging,
          javaPath: ctx.getConfiguration().javaPath,
          onProgress: (progress) => {
            job.message = progress.message;
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted)
          throw fail(
            409,
            "Installation cancelled while the panel was closing.",
          );
        const recovery = await promoteVersion(result, {
          ...ctx,
          signal: controller.signal,
          snapshotInstalled: launchpad.snapshotInstalled,
          clearInstalled: launchpad.clearInstalled,
          restoreInstalled: launchpad.restoreInstalled,
          onProgress: (progress) => {
            job.message = progress.message;
          },
        });
        Object.assign(job, recovery);
        await ctx
          .audit(
            "server",
            "Server version installed",
            `${result.summary.provider} ${result.summary.version}, build ${result.summary.build}. Clean installation; previous server files are retained in Recycle Bin.`,
          )
          .catch(() => {});
        return {
          state: "complete",
          message: `${result.configuration.software} ${result.configuration.version} installed. Start the server when ready.`,
        };
      } catch (cause) {
        return {
          state: "failed",
          error: cause.message,
          message: cause.message,
        };
      } finally {
        if (staging)
          await fs
            .rm(await privatePath(job.id), { recursive: true, force: true })
            .catch(() => {});
      }
    });
    jobs.set(job.id, job);
    lastJob = job.id;
    const active = { controller, operation };
    operations.add(active);
    // A terminal job enables Start and other edits in the UI. Publish it only
    // after staging cleanup and the mutation wrapper have released their lock.
    void operation
      .then(
        (outcome) => Object.assign(job, outcome),
        (cause) =>
          Object.assign(job, {
            state: "failed",
            error: cause.message,
            message: cause.message,
          }),
      )
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        operations.delete(active);
      });
    while (jobs.size > 30) {
      const oldest = [...jobs.keys()][0];
      if (jobs.get(oldest).state === "running") break;
      jobs.delete(oldest);
    }
    return { ...job };
  }
  function mount(app) {
    const endpoint = (work) => async (req, res, next) => {
      try {
        if (closing) throw fail(503, "Minecraft management is shutting down.");
        await work(req, res);
      } catch (cause) {
        if (cause.status && cause.status < 600)
          res.status(cause.status).json({ error: cause.message });
        else next(cause);
      }
    };
    app.get(
      "/api/versions",
      endpoint(async (_req, res) =>
        res.json({
          providers: versions.listProviders(),
          current: await ctx.getServer(),
          job: lastJob ? jobs.get(lastJob) : null,
          cleanInstall: true,
        }),
      ),
    );
    app.get(
      "/api/versions/jobs/:id",
      endpoint(async (req, res) => {
        const job = jobs.get(req.params.id);
        if (!job) throw fail(404, "This installation job was not found.");
        res.json(job);
      }),
    );
    app.post(
      "/api/versions/install",
      endpoint(async (req, res) => res.status(202).json(install(req.body))),
    );
    app.get(
      "/api/versions/:provider/:version",
      endpoint(async (req, res) =>
        res.json(
          await versions.builds(req.params.provider, req.params.version),
        ),
      ),
    );
    app.get(
      "/api/versions/:provider",
      endpoint(async (req, res) =>
        res.json(await versions.versions(req.params.provider)),
      ),
    );
    app.get(
      "/api/minecraft/properties",
      endpoint(async (_req, res) => res.json(await properties.list())),
    );
    app.get(
      "/api/minecraft/properties/file",
      endpoint(async (req, res) =>
        res.json(await properties.get(req.query.path)),
      ),
    );
    app.post(
      "/api/minecraft/properties/save",
      endpoint(async (req, res) => res.json(await properties.save(req.body))),
    );
    app.get(
      "/api/launchpad",
      endpoint(async (_req, res) => res.json(await launchpad.config())),
    );
    for (const method of ["search", "versions", "installed"])
      app.get(
        `/api/launchpad/${method}`,
        endpoint(async (req, res) => {
          const controller = new AbortController();
          const disconnected = () => {
            if (!res.writableEnded) controller.abort();
          };
          res.once("close", disconnected);
          try {
            const result = await launchpad[method]({
              ...req.query,
              signal: controller.signal,
            });
            if (!controller.signal.aborted) res.json(result);
          } finally {
            res.off("close", disconnected);
          }
        }),
      );
    app.put(
      "/api/launchpad/settings",
      endpoint(async (req, res) =>
        res.json(await launchpad.settings(req.body)),
      ),
    );
    app.post(
      "/api/launchpad/preview",
      endpoint(async (req, res) => res.json(await launchpad.preview(req.body))),
    );
    app.post(
      "/api/launchpad/removal-preview",
      endpoint(async (req, res) =>
        res.json(await launchpad.removalPreview(req.body)),
      ),
    );
    app.post(
      "/api/launchpad/remove",
      endpoint(async (req, res) => res.json(await launchpad.remove(req.body))),
    );
    app.post(
      "/api/launchpad/install",
      endpoint(async (req, res) =>
        res.status(202).json(await launchpad.install(req.body)),
      ),
    );
    app.get(
      "/api/launchpad/jobs/:id",
      endpoint(async (req, res) => res.json(launchpad.job(req.params.id))),
    );
  }
  return {
    mount,
    async close() {
      closing = true;
      catalogLifetime.abort(
        fail(503, "Minecraft management is shutting down."),
      );
      for (const active of operations) active.controller.abort();
      await Promise.allSettled([...operations].map((value) => value.operation));
      await launchpad.close();
    },
  };
}
