import fs from "node:fs/promises";
import { launchpadError as error } from "./launchpad-network.mjs";

// A disabled JAR keeps its bytes and metadata beside its enabled filename.
// Hard links provide an exclusive destination on Windows and Unix, unlike
// rename(), which can overwrite a concurrently-created destination on Unix.
export function createModActivation(ctx) {
  let operation = null;
  const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev;
  const change = async (input) => {
    if (
      typeof input?.path !== "string" ||
      !/^mods\/[^/\\]+\.jar(?:\.disabled)?$/i.test(input.path) ||
      typeof input.active !== "boolean"
    )
      throw error(400, "Choose an installed mod and whether it is active.");
    ctx.signal.throwIfAborted();
    if (operation || ctx.isBusy())
      throw error(409, "Wait for the current Launchpad operation to finish.");
    if (ctx.isRecoveryRequired())
      throw error(409, "Resolve installation recovery before changing mods.");
    operation = Promise.resolve().then(() =>
      ctx.withMinecraftMutation(async () => {
        ctx.signal.throwIfAborted();
        const current = await ctx.getServer();
        if (current.status !== "offline")
          throw error(
            409,
            "Stop the server before enabling or disabling mods.",
          );
        if (!["forge", "neoforge", "fabric", "quilt"].includes(current.loader))
          throw error(400, "Choose a server with a supported mod loader.");
        const source = await ctx.safePath(ctx.serverDir, input.path);
        const before = await fs.lstat(source).catch((cause) => {
          if (cause.code === "ENOENT")
            throw error(
              404,
              "This mod no longer exists. Refresh installed mods.",
            );
          throw cause;
        });
        if (!before.isFile() || before.isSymbolicLink())
          throw error(
            400,
            "Only regular mod files can be enabled or disabled.",
          );
        const wasActive = !/\.disabled$/i.test(input.path);
        const relative = input.active
          ? input.path.replace(/\.disabled$/i, "")
          : wasActive
            ? `${input.path}.disabled`
            : input.path;
        if (wasActive === input.active)
          return {
            ok: true,
            path: relative,
            active: input.active,
            modifiedAt: before.mtime.toISOString(),
            addedAt: ctx.fileAddedAt(before),
          };
        const target = await ctx.safePath(ctx.serverDir, relative);
        let linked = false,
          unlinked = false;
        try {
          try {
            await fs.link(source, target);
            linked = true;
          } catch (cause) {
            if (cause.code === "EEXIST")
              throw error(
                409,
                `${relative} already exists. Resolve the duplicate in File Manager first.`,
              );
            throw cause;
          }
          const [sourceNow, targetNow] = await Promise.all([
            fs.lstat(source),
            fs.lstat(target),
          ]);
          if (
            !sameFile(before, sourceNow) ||
            !sameFile(before, targetNow) ||
            sourceNow.size !== before.size ||
            sourceNow.mtimeMs !== before.mtimeMs
          )
            throw error(
              409,
              "The mod changed while its active state was being saved. Refresh and try again.",
            );
          await fs.unlink(source);
          unlinked = true;
          await ctx.onChanged(input.path, relative, input.active);
          return {
            ok: true,
            path: relative,
            active: input.active,
            modifiedAt: sourceNow.mtime.toISOString(),
            addedAt: ctx.fileAddedAt(sourceNow),
          };
        } catch (cause) {
          if (linked) {
            try {
              const remaining = await fs.lstat(target);
              if (!sameFile(before, remaining))
                throw new Error("Destination changed");
              if (unlinked) await fs.link(target, source);
              else if (!sameFile(before, await fs.lstat(source)))
                throw new Error("Source changed");
              await fs.unlink(target);
            } catch {
              throw error(
                409,
                `The active state could not be saved. Check ${input.path} and ${relative} in File Manager; the mod's files have been retained.`,
              );
            }
          }
          throw cause;
        }
      }),
    );
    ctx.onBusyChange();
    try {
      return await operation;
    } finally {
      operation = null;
      ctx.onBusyChange();
    }
  };
  return {
    get busy() {
      return Boolean(operation);
    },
    change,
    close: async () => {
      await operation?.catch(() => {});
    },
  };
}
