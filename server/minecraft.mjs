import { terminalJobs } from "./terminal-jobs.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { cleanInstall, prepareCleanSettings } from "./clean-install.mjs";
import { createVersionsService } from "./versions.mjs";
import { createPropertiesService } from "./properties.mjs";
import { createLaunchpad, providerJson } from "./launchpad.mjs";
import { createExtraProviders } from "./launchpad-extra.mjs";
import { runtimeUpdateFiles } from "./runtime-update.mjs";
import {
  inspectJavaLauncher,
  parseJavaScript,
  parseProperties,
} from "./import.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const missing = (cause) => cause.code === "ENOENT";
// A clean installation replaces the whole server folder. The registered
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

const runtimeArgument = (args) => {
  const matches = args
    .map((argument, index) => ({
      index,
      path: argument.startsWith("@")
        ? argument.slice(1).replace(/\\/g, "/").replace(/^\.\//, "")
        : "",
    }))
    .filter((entry) =>
      /^libraries\/(?:net\/neoforged\/neoforge|net\/minecraftforge\/forge)\/[^/]+\/(?:win|unix)_args\.txt$/.test(
        entry.path,
      ),
    );
  if (matches.length !== 1 || args.includes("--disable-@files"))
    throw fail(
      409,
      "The active launcher cannot be updated automatically. Use a clean installation or update this custom launcher manually.",
    );
  return matches[0];
};

async function runtimeLaunchState(ctx, current) {
  const configuration = ctx.getConfiguration();
  const provider = String(
    current.loader ?? current.software ?? "",
  ).toLowerCase();
  if (
    current.mode !== "live" ||
    ![
      "vanilla",
      "paper",
      "purpur",
      "folia",
      "velocity",
      "fabric",
      "quilt",
      "forge",
      "neoforge",
    ].includes(provider) ||
    !current.gameVersion
  )
    throw fail(
      409,
      "The installed software and Minecraft version must be identified before updating its runtime.",
    );
  let script = null,
    javaPath = configuration.javaPath,
    args = configuration.launchArgs;
  if (configuration.launchType === "script") {
    const inspected = await inspectJavaLauncher(
      ctx.serverDir,
      configuration.launchScript,
    );
    javaPath = inspected.javaPath;
    args = [...inspected.args, ...configuration.launchArgs];
    script = await fs.readFile(
      await ctx.safePath(ctx.serverDir, configuration.launchScript),
      "utf8",
    );
    // Parse the same bytes that will be used when constructing the new script.
    if (
      JSON.stringify(parseJavaScript(script).args) !==
      JSON.stringify(inspected.args)
    )
      throw fail(409, "The startup script changed. Review the build again.");
  } else if (configuration.launchType === "jar") {
    const selected = await fs.lstat(
      await ctx.safePath(ctx.serverDir, configuration.jar),
    );
    if (!selected.isFile() || selected.isSymbolicLink())
      throw fail(409, "The configured server JAR must be a regular file.");
  } else if (configuration.launchType !== "java-args")
    throw fail(
      409,
      "This custom launcher does not support automatic runtime updates.",
    );
  const argument =
    configuration.launchType === "jar" ? null : runtimeArgument(args);
  if (
    argument &&
    !argument.path.startsWith(
      provider === "neoforge"
        ? "libraries/net/neoforged/neoforge/"
        : provider === "forge"
          ? "libraries/net/minecraftforge/forge/"
          : "unsupported/",
    )
  )
    throw fail(
      409,
      "The active launcher does not match the installed server software.",
    );
  if (argument && argument.path.split("/").at(-2) !== current.version)
    throw fail(
      409,
      "The active launcher changed while its installed version was being checked. Refresh Versions and try again.",
    );
  return {
    provider,
    gameVersion: current.gameVersion,
    build: ["forge", "neoforge", "fabric", "quilt"].includes(provider)
      ? (current.version ?? null)
      : null,
    configuration,
    script,
    args,
    argument,
    javaPath,
  };
}

async function runtimeCapability(ctx, current) {
  try {
    const state = await runtimeLaunchState(ctx, current);
    return {
      available: true,
      provider: state.provider,
      gameVersion: state.gameVersion,
      build: state.build,
    };
  } catch (cause) {
    return {
      available: false,
      provider: null,
      gameVersion: null,
      build: null,
      reason: cause.message,
    };
  }
}

async function checkRuntimeSelection(ctx, selection, previous) {
  const state = await runtimeLaunchState(
    ctx,
    await ctx.getServer({ refresh: true }),
  );
  if (
    state.provider !== selection.provider ||
    state.gameVersion !== selection.version
  )
    throw fail(
      409,
      "Runtime updates must use the installed software and Minecraft version. Choose a clean installation to change either.",
    );
  if (
    previous &&
    (state.build !== previous.build ||
      state.script !== previous.script ||
      JSON.stringify(state.configuration) !==
        JSON.stringify(previous.configuration))
  )
    throw fail(
      409,
      "The installed runtime or startup settings changed while the update was preparing. Review the build again.",
    );
  return state;
}

// Retarget the one inspected Java invocation, leaving comments, line endings,
// quoting, Java selection, custom flags, and the batch argument suffix intact.
function retargetScript(script, oldPath, nextPath, expectedArgs) {
  let replacements = 0;
  const updated = script.replace(/[^\r\n]+/g, (line) => {
    if (/^\s*(?:@?rem(?:\s|$)|::|@?echo\s+off\s*$|@?pause\s*$)/i.test(line))
      return line;
    let quoted = false,
      start = -1;
    const tokens = [];
    for (let index = 0; index <= line.length; index++) {
      const char = line[index];
      if (char === '"') quoted = !quoted;
      if (index === line.length || (!quoted && /\s/.test(char))) {
        if (start !== -1)
          tokens.push({ start, end: index, raw: line.slice(start, index) });
        start = -1;
      } else if (start === -1) start = index;
    }
    for (const token of tokens.reverse()) {
      const normalized = token.raw
        .replace(/"/g, "")
        .replace(/\\/g, "/")
        .replace(/^@\.\//, "@");
      if (normalized !== `@${oldPath}`) continue;
      const replacement = token.raw.replace(
        /libraries[\\/](?:net[\\/]neoforged[\\/]neoforge|net[\\/]minecraftforge[\\/]forge)[\\/][^\\/"\s]+[\\/](?:win|unix)_args\.txt/,
        nextPath.replace(/\//g, token.raw.includes("\\") ? "\\" : "/"),
      );
      if (replacement === token.raw && oldPath !== nextPath)
        throw fail(
          409,
          "The runtime reference in this startup script could not be updated safely.",
        );
      line = line.slice(0, token.start) + replacement + line.slice(token.end);
      replacements++;
    }
    return line;
  });
  if (
    replacements !== 1 ||
    JSON.stringify(parseJavaScript(updated).args) !==
      JSON.stringify(expectedArgs)
  )
    throw fail(
      409,
      "The startup script cannot be updated without changing its custom arguments.",
    );
  return updated;
}

export async function promoteRuntimeVersion(result, ctx, state) {
  const {
    status: _status,
    address: _address,
    ...previousConfiguration
  } = ctx.getConfiguration();
  const patch = {
    software: result.configuration.software,
    version: result.configuration.version,
    minecraftVersion: result.summary.version,
  };
  const replacePaths = [],
    expectedHashes = {};
  if (state.configuration.launchType === "jar") {
    if (result.configuration.launchType !== "jar")
      throw fail(
        409,
        "This build changes the startup method. Choose a clean installation instead.",
      );
    patch.jar = result.configuration.jar;
  } else {
    if (result.configuration.launchType !== "java-args")
      throw fail(
        409,
        "This build changes the startup method. Choose a clean installation instead.",
      );
    const next = runtimeArgument(result.configuration.launchArgs);
    if (
      next.path.split("/").at(-2) !== result.summary.build ||
      !next.path.startsWith(
        state.provider === "neoforge"
          ? "libraries/net/neoforged/neoforge/"
          : "libraries/net/minecraftforge/forge/",
      )
    )
      throw fail(
        400,
        "The installer runtime reference does not match the selected build.",
      );
    if (!result.files.some((entry) => entry.path === next.path))
      throw fail(
        400,
        "The installer did not provide its runtime argument file.",
      );
    const args = [...state.args];
    const nextReference = state.args[state.argument.index]
      .replace(/\\/g, "/")
      .startsWith("@./")
      ? `@./${next.path}`
      : `@${next.path}`;
    args[state.argument.index] = nextReference;
    if (state.script !== null) {
      const scriptArgs = parseJavaScript(state.script).args;
      const expected = [...scriptArgs];
      if (state.argument.index >= expected.length)
        throw fail(
          409,
          "The runtime reference must be part of the inspected startup script.",
        );
      expected[state.argument.index] = nextReference;
      const script = retargetScript(
        state.script,
        state.argument.path,
        next.path,
        expected,
      );
      const target = await ctx.safePath(
        result.stageDir,
        state.configuration.launchScript,
      );
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, script);
      result.files = result.files.filter(
        (entry) =>
          entry.path.toLowerCase() !==
          state.configuration.launchScript.toLowerCase(),
      );
      result.files.push({ path: state.configuration.launchScript });
      replacePaths.push(state.configuration.launchScript);
      expectedHashes[state.configuration.launchScript.toLowerCase()] =
        createHash("sha512").update(state.script).digest("hex");
    } else patch.launchArgs = args;
  }
  // Loader launchers may store runtime references in properties. Retain custom
  // settings/comments and append only changed installer-provided runtime values.
  const escapeProperty = (value) =>
    String(value).replace(
      /[\\\n\r\t=:#! ]/g,
      (char) =>
        ({ "\n": "\\n", "\r": "\\r", "\t": "\\t" })[char] ?? `\\${char}`,
    );
  for (const filename of [
    "fabric-server-launcher.properties",
    "quilt-server-launcher.properties",
  ]) {
    if (!result.files.some((entry) => entry.path === filename)) continue;
    const existing = await fs
      .readFile(await ctx.safePath(ctx.serverDir, filename), "utf8")
      .catch((cause) => {
        if (missing(cause)) return null;
        throw cause;
      });
    if (existing === null) continue;
    const target = await ctx.safePath(result.stageDir, filename);
    const oldValues = parseProperties(existing),
      newValues = parseProperties(await fs.readFile(target, "utf8"));
    const changed = [...newValues].filter(
      ([key, value]) => oldValues.get(key) !== value,
    );
    if (!changed.length) continue;
    const newline = existing.includes("\r\n") ? "\r\n" : "\n";
    await fs.writeFile(
      target,
      `${existing}${existing.endsWith("\n") ? "" : newline}# Updated loader runtime${newline}${changed.map(([key, value]) => `${escapeProperty(key)}=${escapeProperty(value)}`).join(newline)}${newline}`,
    );
    replacePaths.push(filename);
    expectedHashes[filename] = createHash("sha512")
      .update(existing)
      .digest("hex");
  }
  return runtimeUpdateFiles(result, {
    ...ctx,
    replacePaths,
    expectedHashes,
    commit: () => ctx.applyConfiguration(patch),
    rollback: () => ctx.applyConfiguration(previousConfiguration),
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
    isContentMutationActive: () =>
      operations.size > 0 || ctx.isContentMutationActive?.(),
    fetch: catalogFetch,
    // Public recovery transport is shared across servers. Its subscribers carry
    // their own lifetime, so closing this runtime cannot abort another server.
    recoveryFetch: request,
    platformConfig,
    extraProviders: extras,
    audit: (action, detail, category = "file", actor) =>
      ctx.audit(category, action, detail, actor),
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
  const terminal = await terminalJobs(await privatePath("last-job.json"));
  if (terminal.get()) {
    const job = terminal.get();
    jobs.set(job.id, job);
    lastJob = job.id;
  }
  const publicJob = (job) =>
    job
      ? {
          ...job,
          status:
            job.status ?? (job.state === "complete" ? "completed" : job.state),
        }
      : null;
  function install(input) {
    if (closing) throw fail(503, "Minecraft management is shutting down.");
    if (input?.confirmed !== true)
      throw fail(400, "Review and confirm the selected server build first.");
    if (input.cleanInstall === true && input.updateRuntime === true)
      throw fail(
        400,
        "Choose either a runtime update or a clean installation.",
      );
    if (input.cleanInstall !== true && input.updateRuntime !== true)
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
      status: "queued",
      message: "Preparing installation…",
    };
    const controller = new AbortController();
    // Acquire synchronously before returning 202, so Start and other writes
    // cannot pass between job creation and its first asynchronous operation.
    const operation = ctx.withMinecraftMutation(async () => {
      job.state = "running";
      job.status = "running";
      let staging;
      try {
        const original =
          input.updateRuntime === true
            ? await checkRuntimeSelection(ctx, selection)
            : null;
        staging = await privatePath(job.id);
        await fs.mkdir(staging);
        const result = await versions.stage(selection, {
          stageDir: staging,
          javaPath: original?.javaPath ?? ctx.getConfiguration().javaPath,
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
        if (original) {
          if (
            result.summary.provider !== selection.provider ||
            result.summary.version !== selection.version ||
            result.summary.build !== selection.build
          )
            throw fail(
              400,
              "The staged runtime does not match the selected build.",
            );
          await checkRuntimeSelection(ctx, selection, original);
        }
        const promotionContext = {
          ...ctx,
          signal: controller.signal,
          snapshotInstalled: launchpad.snapshotInstalled,
          clearInstalled: launchpad.clearInstalled,
          restoreInstalled: launchpad.restoreInstalled,
          onProgress: (progress) => {
            job.message = progress.message;
          },
        };
        const recovery = original
          ? await promoteRuntimeVersion(result, promotionContext, original)
          : await promoteVersion(result, promotionContext);
        Object.assign(job, recovery);
        await ctx
          .audit(
            "server",
            original ? "Server version updated" : "Server version installed",
            `${result.summary.provider} ${result.summary.version}, build ${result.summary.build}. ${original ? "Runtime updated; worlds, content and settings were preserved." : "Clean installation; previous server files are retained in Recycle Bin."}`,
          )
          .catch(() => {});
        return {
          state: "complete",
          status: "completed",
          message: `${result.configuration.software} ${result.configuration.version} ${original ? "updated. Your worlds, content and settings were preserved." : "installed."} Start the server when ready.`,
        };
      } catch (cause) {
        return {
          state: "failed",
          status: "failed",
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
    active.operation = operation
      .then(
        (outcome) => Object.assign(job, outcome),
        (cause) =>
          Object.assign(job, {
            state: "failed",
            status: "failed",
            error: cause.message,
            message: cause.message,
          }),
      )
      .finally(async () => {
        job.finishedAt = new Date().toISOString();
        if (job.status === "failed")
          await ctx
            .audit("server", "Installation failed", job.error)
            .catch(() => {});
        await terminal.save(publicJob(job)).catch(() => {});
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
      endpoint(async (_req, res) => {
        const current = await ctx.getServer({ refresh: true });
        res.json({
          providers: versions.listProviders(),
          current,
          runtimeUpdate: await runtimeCapability(ctx, current),
          job:
            lastJob && terminal.visible(publicJob(jobs.get(lastJob)))
              ? publicJob(jobs.get(lastJob))
              : null,
          cleanInstall: true,
        });
      }),
    );
    app.get(
      "/api/versions/jobs/:id",
      endpoint(async (req, res) => {
        const job = jobs.get(req.params.id);
        if (!job) throw fail(404, "This installation job was not found.");
        res.json({ ...publicJob(job), job: publicJob(job) });
      }),
    );
    app.post(
      "/api/versions/install",
      endpoint(async (req, res) => {
        const job = publicJob(install(req.body));
        res.status(202).json({ ...job, job });
      }),
    );
    app.get(
      "/api/versions/:provider/:version",
      endpoint(async (req, res) =>
        res.json(
          await versions.builds(req.params.provider, req.params.version, {
            refresh: ["1", "true"].includes(req.query.refresh),
          }),
        ),
      ),
    );
    app.get(
      "/api/versions/:provider",
      endpoint(async (req, res) =>
        res.json(
          await versions.versions(req.params.provider, {
            refresh: ["1", "true"].includes(req.query.refresh),
          }),
        ),
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
      endpoint(async (req, res) => res.json(await launchpad.config(req.query))),
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
      "/api/launchpad/updates/preview",
      endpoint(async (req, res) =>
        res.json(await launchpad.previewUpdates(req.body)),
      ),
    );
    app.post(
      "/api/launchpad/preview/:id/cancel",
      endpoint(async (req, res) =>
        res.json(await launchpad.cancelPreview(req.params.id)),
      ),
    );
    app.post(
      "/api/launchpad/removal-preview/:id/cancel",
      endpoint(async (req, res) =>
        res.json(await launchpad.cancelRemovalPreview(req.params.id)),
      ),
    );
    app.post(
      "/api/launchpad/jobs/:id/dismiss",
      endpoint(async (req, res) =>
        res.json(await launchpad.dismissJob(req.params.id)),
      ),
    );
    app.post(
      "/api/versions/jobs/:id/dismiss",
      endpoint(async (req, res) => {
        const job = jobs.get(req.params.id);
        if (job && ["completed", "failed"].includes(publicJob(job).status)) {
          job.dismissed = true;
          await terminal.dismiss(job.id);
        }
        res.json({ ok: true });
      }),
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
    duplicateCheck: launchpad.duplicateCheck,
    mount,
    async close() {
      closing = true;
      catalogLifetime.abort(
        fail(503, "Minecraft management is shutting down."),
      );
      for (const active of operations) active.controller.abort();
      await Promise.allSettled([...operations].map((value) => value.operation));
      await launchpad.close();
      await terminal.flush();
    },
  };
}
