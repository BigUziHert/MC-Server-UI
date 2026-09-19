import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { inspectInstalledMod } from "./launchpad-mod-metadata.mjs";
import { launchpadError as error } from "./launchpad-network.mjs";

export function createModRemoval(ctx) {
  const plans = new Map(),
    pending = new Set();
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
  const inventory = async (loader, inspect, type = "mod", folder = "mods") => {
    const directory = await ctx.safePath(ctx.serverDir, folder);
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((cause) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      });
    const candidates = entries.filter((entry) =>
      (type === "datapack" ? /\.zip$/i : /\.jar$/i).test(entry.name),
    );
    if (candidates.length > 1000)
      throw error(
        400,
        "This folder has over 1,000 packages. Manage its files in File Manager.",
      );
    const rows = [];
    for (const entry of candidates.sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      ctx.signal.throwIfAborted();
      const relative = `${folder}/${entry.name}`;
      const target = await ctx.safePath(ctx.serverDir, relative);
      const before = await fs.lstat(target);
      if (!before.isFile() || before.isSymbolicLink())
        throw error(
          409,
          `${entry.name} is not a regular ${type} file. Review it in File Manager.`,
        );
      const sha512 = await ctx.fileHash(target);
      const row = {
        path: relative,
        title: entry.name,
        size: before.size,
        sha512,
      };
      if (inspect && type === "mod") {
        try {
          Object.assign(
            row,
            await inspectInstalledMod(target, { loader, signal: ctx.signal }),
          );
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
      rows.push(row);
    }
    return rows;
  };
  const snapshot = (rows) =>
    JSON.stringify(rows.map(({ path, sha512 }) => [path, sha512]));
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
          !(type === "datapack" ? /\.zip$/i : /\.jar$/i).test(input.path)
        )
          throw error(400, `Choose an installed ${type} to remove.`);
        const rows = await inventory(current.loader, true, type, folder);
        const selected = rows.find((row) => row.path === input.path);
        if (!selected)
          throw error(
            404,
            `This installed ${type} no longer exists. Refresh installed ${type}s.`,
          );
        const provided = new Set(selected.provided ?? []);
        const dependents = rows
          .filter(
            (row) =>
              row !== selected && row.required?.some((id) => provided.has(id)),
          )
          .map(({ path, title }) => ({ path, title }));
        const warnings = rows
          .filter((row) => row.issue)
          .map((row) => row.issue);
        const result = {
          title: selected.title || selected.path,
          files: [{ path: selected.path, size: selected.size }],
          dependents,
          warnings,
          blocked: dependents.length > 0 || warnings.length > 0,
        };
        if (result.blocked) return result;
        prune();
        if (plans.size >= 8) plans.delete(plans.keys().next().value);
        const planId = randomUUID(),
          expires = Date.now() + 15 * 60 * 1000;
        plans.set(planId, {
          type,
          folder,
          path: selected.path,
          loader: current.loader,
          snapshot: snapshot(rows),
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
        const planType = plans.get(input.planId)?.type ?? "mod";
        await available(planType);
        // Recheck after the async status read before claiming the operation.
        if (busy || ctx.isBusy())
          throw error(
            409,
            "Wait for the current Launchpad operation to finish.",
          );
        prune();
        const plan = plans.get(input.planId);
        if (!plan)
          throw error(
            409,
            "This removal review expired. Review the content again.",
          );
        busy = true;
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
                await inventory(plan.loader, false, plan.type, plan.folder),
              ) !== plan.snapshot
            )
              throw error(
                409,
                "Installed content changed after this review. Review removal again.",
              );
            plans.delete(input.planId);
            const recycled = await ctx.recycle(plan.path);
            try {
              await ctx.onRemoved(plan.path, plan.type);
            } catch (cause) {
              try {
                await ctx.restore(recycled.id);
              } catch {
                throw error(
                  409,
                  "Removal could not finish. The original file is preserved in Recycle Bin and needs restoring.",
                );
              }
              throw error(
                500,
                "Removal could not be saved. The original file was restored.",
              );
            }
            return { ok: true, path: plan.path, recycled };
          });
        } finally {
          busy = false;
        }
      });
    },
    cancel(id) {
      plans.delete(id);
      return { ok: true };
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending]);
      plans.clear();
    },
  };
}
