import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { inspectInstalledMod } from "./launchpad-mod-metadata.mjs";
import { inspectPluginIdentity } from "./launchpad-plugin-metadata.mjs";
import { updateDependencySatisfies } from "./launchpad-update-dependencies.mjs";
import { launchpadError as error } from "./launchpad-network.mjs";
import { mapReview } from "./launchpad-transfers.mjs";

export function createModRemoval(ctx) {
  const plans = new Map(),
    pending = new Set(),
    metadata = new Map();
  let busy = false,
    closing = false;
  const track = (work) => {
    const task = Promise.resolve().then(work);
    pending.add(task);
    task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const available = async (type = "mod") => {
    if (closing) throw error(503, "Launchpad is shutting down.");
    if (ctx.isBusy() || busy)
      throw error(409, "Wait for the current Launchpad operation to finish.");
    if (ctx.isRecoveryRequired?.())
      throw error(
        409,
        "Resolve installation recovery before removing content.",
      );
    const current = await ctx.getServer();
    if (current.status !== "offline")
      throw error(409, "Stop the server before removing content.");
    if (
      type === "mod" &&
      !["neoforge", "forge", "fabric", "quilt"].includes(current.loader)
    )
      throw error(
        400,
        "Choose a server with a supported mod loader before removing mods.",
      );
    return current;
  };
  const inventory = async (
    loader,
    inspect,
    type = "mod",
    folder = "mods",
    selectedPath,
  ) => {
    const directory = await ctx.safePath(ctx.serverDir, folder);
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((cause) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      });
    const candidates = entries.filter((entry) =>
      (type === "datapack"
        ? /\.zip$/i
        : type === "mod"
          ? /\.jar(?:\.disabled)?$/i
          : /\.jar(?:\.disabled)?$/i
      ).test(entry.name),
    );
    if (candidates.length > 1000)
      throw error(
        400,
        "This folder has over 1,000 packages. Manage its files in File Manager.",
      );
    const rows = await mapReview(
      candidates.sort((a, b) => a.name.localeCompare(b.name)),
      async (entry) => {
        ctx.signal.throwIfAborted();
        const relative = `${folder}/${entry.name}`;
        let target, before;
        try {
          target = await ctx.safePath(ctx.serverDir, relative);
          before = await fs.lstat(target);
          if (!before.isFile() || before.isSymbolicLink())
            throw error(409, "not a regular file");
        } catch (cause) {
          const issue = `${entry.name}: ${cause.message}`;
          if (
            relative === selectedPath ||
            (selectedPath instanceof Set && selectedPath.has(relative))
          )
            throw error(409, issue);
          return {
            path: relative,
            title: entry.name,
            stamp: "unreadable",
            size: 0,
            sha512: null,
            issue,
          };
        }
        const stamp = ctx.fileStamp(before);
        // The selected file is always hashed afresh; other files use their full
        // identity/timestamps to invalidate the reviewed dependency snapshot.
        const sha512 =
          relative === selectedPath ||
          (selectedPath instanceof Set && selectedPath.has(relative))
            ? await ctx.fileHash(target)
            : null;
        const row = {
          path: relative,
          title: entry.name,
          size: before.size,
          sha512,
          stamp,
          active: !/\.disabled$/i.test(entry.name),
        };
        if (inspect && ["mod", "plugin"].includes(type)) {
          try {
            const key = `${loader}:${relative}:${stamp}`;
            let cached = metadata.get(key);
            if (!cached) {
              cached = await (
                type === "plugin" ? inspectPluginIdentity : inspectInstalledMod
              )(target, {
                loader,
                signal: ctx.signal,
              });
              metadata.set(key, cached);
              while (metadata.size > 1000)
                metadata.delete(metadata.keys().next().value);
            }
            Object.assign(row, cached);
            if (cached.warnings?.length)
              row.issue = `${entry.name}: ${cached.warnings.join(" ")}`;
            row.allProvided = row.provided;
            if (!row.active) {
              row.providers = [];
              row.provided = [];
            }
          } catch (cause) {
            ctx.signal.throwIfAborted();
            row.issue = `${entry.name}: ${cause.message}`;
          }
        }
        if (ctx.fileStamp(before) !== ctx.fileStamp(await fs.lstat(target)))
          throw error(
            409,
            "Installed content changed while its dependencies were being checked. Review removal again.",
          );
        return row;
      },
      ctx.signal,
    );
    return rows;
  };
  const snapshot = (rows) =>
    JSON.stringify(
      rows.map(({ path, sha512, stamp }) => [path, sha512, stamp]),
    );
  const prune = () => {
    for (const [id, plan] of plans)
      if (plan.expires <= Date.now()) plans.delete(id);
  };
  return {
    get busy() {
      return busy;
    },
    preview(input = {}) {
      return track(async () => {
        const type = input.type ?? "mod";
        if (!["mod", "plugin", "datapack"].includes(type))
          throw error(400, "Choose installed content to remove.");
        const current = await available(type);
        const folder =
          type === "mod"
            ? "mods"
            : type === "plugin"
              ? "plugins"
              : `${current.world || "world"}/datapacks`;
        if (
          typeof input.path !== "string" ||
          !input.path.startsWith(`${folder}/`) ||
          input.path.slice(folder.length + 1).includes("/") ||
          input.path.includes("\\") ||
          !(
            type === "datapack"
              ? /\.zip$/i
              : type === "mod"
                ? /\.jar(?:\.disabled)?$/i
                : /\.jar(?:\.disabled)?$/i
          ).test(input.path)
        )
          throw error(400, `Choose an installed ${type} to remove.`);
        const rows = await inventory(
          current.loader,
          true,
          type,
          folder,
          input.path,
        );
        const selected = rows.find((row) => row.path === input.path);
        if (!selected)
          throw error(
            404,
            `This installed ${type} no longer exists. Refresh installed ${type}s.`,
          );
        const selectedPaths = new Set([selected.path]);
        const dependentRows = (removed) => {
          const provided = new Set(
            rows
              .filter((row) => removed.has(row.path))
              .flatMap((row) => row.provided ?? []),
          );
          const remaining = rows.filter(
            (row) => !removed.has(row.path) && row.active !== false,
          );
          return remaining.filter((row) =>
            row.required?.some((id) => {
              if (!provided.has(id)) return false;
              const ranges = remaining
                .flatMap((value) => value.requirements ?? [])
                .filter((requirement) => requirement.id === id);
              const removedVersions = rows
                .filter((value) => removed.has(value.path))
                .flatMap((value) => value.providers ?? [])
                .filter((value) => value.id === id);
              return !remaining
                .flatMap((value) => value.providers ?? [])
                .some(
                  (provider) =>
                    provider.id === id &&
                    (type === "plugin" ||
                      ranges.every(({ range }) =>
                        updateDependencySatisfies(
                          provider.version,
                          range,
                          current.loader,
                        ),
                      ) ||
                      (typeof provider.version === "string" &&
                        removedVersions.length > 0 &&
                        removedVersions.every(
                          (value) => value.version === provider.version,
                        ))),
                );
            }),
          );
        };
        const initialDependents =
          selected.active === false ? [] : dependentRows(selectedPaths);
        const allDependents = new Map(
          initialDependents.map((row) => [row.path, row]),
        );
        const closure = new Set(selectedPaths);
        while (true) {
          const additional = dependentRows(closure).filter(
            (row) => !closure.has(row.path),
          );
          if (!additional.length) break;
          for (const row of additional) {
            closure.add(row.path);
            allDependents.set(row.path, row);
          }
        }
        if (input.includeDependents === true)
          for (const relative of closure) selectedPaths.add(relative);
        const receipts = ctx.getReceipts?.() ?? [];
        const needed = new Set(
          rows
            .filter((row) => !selectedPaths.has(row.path))
            .flatMap((row) => row.required ?? []),
        );
        const orphanCandidates = rows
          .filter(
            (row) =>
              !selectedPaths.has(row.path) &&
              receipts.some(
                (receipt) =>
                  receipt.path === row.path &&
                  receipt.installReason === "dependency",
              ) &&
              row.allProvided?.length &&
              !row.allProvided.some((id) => needed.has(id)) &&
              !row.issue,
          )
          .map(({ path, title, size }) => ({ path, title, size }));
        if (
          input.cleanupPaths !== undefined &&
          (!Array.isArray(input.cleanupPaths) ||
            input.cleanupPaths.some(
              (relative) =>
                !orphanCandidates.some((row) => row.path === relative),
            ))
        )
          throw error(400, "Choose unused libraries from this removal review.");
        for (const relative of input.cleanupPaths ?? [])
          selectedPaths.add(relative);
        const dependents = [...allDependents.values()].map(
          ({ path, title }) => ({ path, title }),
        );
        const warnings =
          selected.active === false
            ? []
            : rows.filter((row) => row.issue).map((row) => row.issue);
        const result = {
          title: selected.title || selected.path,
          files: rows
            .filter((row) => selectedPaths.has(row.path))
            .map(({ path, size }) => ({ path, size })),
          dependents,
          orphanCandidates,
          warnings,
          blocked:
            initialDependents.length > 0 && input.includeDependents !== true,
          includesDependents: input.includeDependents === true,
          requiresAcknowledgement: warnings.length > 0,
        };
        const reviewed = await inventory(
          current.loader,
          false,
          type,
          folder,
          selectedPaths,
        );
        prune();
        const ownerId = input.ownerId ?? "local-owner";
        if (
          [...plans.values()].filter((plan) => plan.ownerId === ownerId)
            .length >= 8
        )
          throw error(
            429,
            "You have eight open removal reviews. Close an earlier review before creating another.",
          );
        if (plans.size >= 64)
          throw error(
            429,
            "Too many removal reviews are open. Try again after another review finishes.",
          );
        const planId = randomUUID(),
          expires = Date.now() + 15 * 60 * 1000;
        plans.set(planId, {
          ownerId,
          type,
          folder,
          path: selected.path,
          loader: current.loader,
          paths: [...selectedPaths],
          snapshot: snapshot(reviewed),
          blocked: result.blocked,
          requiresAcknowledgement: result.requiresAcknowledgement,
          expires,
        });
        return {
          ...result,
          planId,
          expiresAt: new Date(expires).toISOString(),
        };
      });
    },
    remove(input = {}) {
      return track(async () => {
        if (input.confirmed !== true)
          throw error(400, "Review the removal and confirm it first.");
        prune();
        const plan = plans.get(input.planId);
        if (!plan || plan.ownerId !== (input.ownerId ?? "local-owner"))
          throw error(
            409,
            "This removal review expired. Review the content again.",
          );
        await available(plan.type);
        if (busy || ctx.isBusy())
          throw error(
            409,
            "Wait for the current Launchpad operation to finish.",
          );
        if (plan.blocked && input.acknowledgedDependents !== true)
          throw error(
            400,
            "Acknowledge that remaining mods depend on this library, or review removing its dependents too.",
          );
        if (
          plan.requiresAcknowledgement &&
          input.acknowledgedUnreadableDependencies !== true
        )
          throw error(
            400,
            "Acknowledge that unreadable mod metadata prevents a complete dependency check, or repair the listed files in File Manager first.",
          );
        busy = true;
        ctx.onBusyChange?.();
        try {
          return await ctx.withMinecraftMutation(async () => {
            const current = await ctx.getServer();
            if (current.status !== "offline" || current.loader !== plan.loader)
              throw error(
                409,
                "The server changed after this review. Stop it and review removal again.",
              );
            if (
              snapshot(
                await inventory(
                  plan.loader,
                  false,
                  plan.type,
                  plan.folder,
                  new Set(plan.paths),
                ),
              ) !== plan.snapshot
            )
              throw error(
                409,
                "Installed content changed after this review. Review removal again.",
              );
            plans.delete(input.planId);
            const recycled = [];
            const undoJobId = ctx.beginRemoval ? randomUUID() : null;
            try {
              await ctx.beginRemoval?.({
                jobId: undoJobId,
                paths: plan.paths,
                type: plan.type,
              });
              for (const relative of plan.paths)
                recycled.push({
                  path: relative,
                  entry: await ctx.recycle(relative),
                });
              if (ctx.onRemovedMany)
                await ctx.onRemovedMany(
                  plan.paths,
                  plan.type,
                  recycled,
                  undoJobId,
                );
              else
                for (const relative of plan.paths)
                  await ctx.onRemoved(relative, plan.type);
              await ctx.commitRemoval?.(undoJobId);
            } catch (cause) {
              const failures = [];
              for (const { entry } of [...recycled].reverse()) {
                try {
                  await ctx.restore(entry.id);
                } catch (failure) {
                  failures.push(failure);
                }
              }
              await ctx.onRemovalFailed?.(cause);
              if (failures.length)
                throw error(
                  409,
                  "Removal could not finish. Original files remain in Recycle Bin; restore them before continuing.",
                );
              throw error(
                500,
                `Removal could not be saved. ${plan.paths.length === 1 ? "The original file was restored." : "The original files were restored."} ${cause.message}`,
              );
            }
            return {
              ok: true,
              path: plan.path,
              paths: plan.paths,
              recycled: recycled[0]?.entry,
              recycledEntries: recycled.map(({ entry }) => entry),
              ...(undoJobId ? { undoJobId } : {}),
            };
          });
        } finally {
          busy = false;
          ctx.onBusyChange?.();
        }
      });
    },
    cancel(id, ownerId = "local-owner") {
      if (plans.get(id)?.ownerId !== ownerId) return { ok: true };
      plans.delete(id);
      return { ok: true };
    },
    invalidate(relative) {
      if (relative)
        for (const key of metadata.keys())
          if (key.includes(`:${relative}:`)) metadata.delete(key);
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending]);
      plans.clear();
      metadata.clear();
    },
  };
}
