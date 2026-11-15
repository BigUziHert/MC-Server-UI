import fs from "node:fs/promises";
import { launchpadError as error } from "./launchpad-network.mjs";
import { inspectInstalledMod } from "./launchpad-mod-metadata.mjs";
import { inspectPluginIdentity } from "./launchpad-plugin-metadata.mjs";
import { updateDependencySatisfies } from "./launchpad-update-dependencies.mjs";
import { createHash } from "node:crypto";

const digest = async (target) => {
  const handle = await fs.open(target, "r");
  try {
    const hash = createHash("sha512");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

// A disabled JAR keeps its bytes and metadata beside its enabled filename.
// Hard links provide an exclusive destination on Windows and Unix, unlike
// rename(), which can overwrite a concurrently-created destination on Unix.
export function createModActivation(ctx) {
  let operation = null;
  const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev;
  const change = async (input) => {
    const plugin =
      typeof input?.path === "string" && input.path.startsWith("plugins/");
    const kind = plugin ? "plugin" : "mod",
      folder = plugin ? "plugins" : "mods";
    if (
      typeof input?.path !== "string" ||
      !/^(?:mods|plugins)\/[^/\\]+\.jar(?:\.disabled)?$/i.test(input.path) ||
      (input.type !== undefined && input.type !== kind) ||
      typeof input.active !== "boolean"
    )
      throw error(
        400,
        "Choose an installed mod or plugin and whether it is active.",
      );
    ctx.signal.throwIfAborted();
    if (operation || ctx.isBusy())
      throw error(409, "Wait for the current Launchpad operation to finish.");
    if (ctx.isRecoveryRequired())
      throw error(
        409,
        "Resolve installation recovery before changing content.",
      );
    operation = Promise.resolve().then(() =>
      ctx.withMinecraftMutation(async () => {
        ctx.signal.throwIfAborted();
        const current = await ctx.getServer();
        if (current.status !== "offline")
          throw error(
            409,
            `Stop the server before enabling or disabling ${kind}s.`,
          );
        if (
          !(
            plugin
              ? [
                  "paper",
                  "purpur",
                  "spigot",
                  "bukkit",
                  "folia",
                  "sponge",
                  "velocity",
                  "bungeecord",
                  "waterfall",
                ]
              : ["forge", "neoforge", "fabric", "quilt"]
          ).includes(current.loader)
        )
          throw error(400, `Choose a server with a supported ${kind} loader.`);
        const inspect = plugin ? inspectPluginIdentity : inspectInstalledMod;
        const satisfies = (version, range) =>
          plugin || updateDependencySatisfies(version, range, current.loader);
        const source = await ctx.safePath(ctx.serverDir, input.path);
        const before = await fs.lstat(source).catch((cause) => {
          if (cause.code === "ENOENT")
            throw error(
              404,
              `This ${kind} no longer exists. Refresh installed ${kind}s.`,
            );
          throw cause;
        });
        if (!before.isFile() || before.isSymbolicLink())
          throw error(
            400,
            `Only regular ${kind} files can be enabled or disabled.`,
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
        const warnings = [];
        try {
          const selected = await inspect(source, {
            loader: current.loader,
            signal: ctx.signal,
          });
          const entries = (
            await fs.readdir(await ctx.safePath(ctx.serverDir, folder))
          ).filter((name) => /\.jar$/i.test(name));
          if (entries.length > 1000)
            throw new Error(`Too many ${kind}s to check automatically.`);
          warnings.push(...(selected.warnings ?? []));
          const others = [];
          for (const name of entries) {
            if (`${folder}/${name}` === input.path) continue;
            try {
              others.push({
                ...(await inspect(
                  await ctx.safePath(ctx.serverDir, `${folder}/${name}`),
                  { loader: current.loader, signal: ctx.signal },
                )),
                path: `${folder}/${name}`,
              });
              warnings.push(
                ...(others.at(-1).warnings ?? []).map(
                  (warning) => `${name}: ${warning}`,
                ),
              );
            } catch (cause) {
              ctx.signal.throwIfAborted();
              warnings.push(
                `${name}: dependency metadata could not be checked.`,
              );
            }
          }
          const providers = others.flatMap((row) => row.providers ?? []);
          if (input.active) {
            for (const id of selected.provided)
              if (providers.some((provider) => provider.id === id))
                warnings.push(
                  `Another active ${kind} already provides ${id}. Enabling this copy can prevent startup.`,
                );
            for (const { id, range } of selected.requirements) {
              if (
                (plugin ||
                  ![
                    "minecraft",
                    "java",
                    "forge",
                    "neoforge",
                    "fabricloader",
                    "quilt_loader",
                    "javafml",
                  ].includes(id)) &&
                selected.required.includes(id) &&
                ![...providers, ...selected.providers].some(
                  (provider) =>
                    provider.id === id && satisfies(provider.version, range),
                )
              )
                warnings.push(
                  `This ${kind} needs ${id} ${JSON.stringify(range ?? "any version")}; an active compatible provider could not be verified.`,
                );
            }
          } else {
            for (const row of others)
              for (const { id, range } of row.requirements) {
                if (
                  row.required.includes(id) &&
                  selected.provided.includes(id) &&
                  !providers.some(
                    (provider) =>
                      provider.id === id && satisfies(provider.version, range),
                  )
                )
                  warnings.push(
                    `${row.title || row.path} requires ${id}; disabling this library may prevent startup.`,
                  );
              }
          }
        } catch (cause) {
          ctx.signal.throwIfAborted();
          warnings.push(
            `This ${kind}'s dependencies could not be checked: ${cause.message}`,
          );
        }
        if (warnings.length && input.acknowledgedDependencies !== true)
          return {
            ok: false,
            requiresAcknowledgement: true,
            warnings: [...new Set(warnings)],
            path: input.path,
            active: wasActive,
          };
        let linked = false,
          unlinked = false,
          copied = false,
          copiedHash,
          destinationIdentity;
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
            if (
              !["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS"].includes(
                cause.code,
              )
            )
              throw cause;
            copiedHash = await digest(source);
            await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
            copied = linked = true;
            await fs.utimes(target, before.atime, before.mtime);
            destinationIdentity = await fs.lstat(target);
            const handle = await fs.open(target, "r+");
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          const [sourceNow, targetNow] = await Promise.all([
            fs.lstat(source),
            fs.lstat(target),
          ]);
          if (
            !sameFile(before, sourceNow) ||
            (!copied && !sameFile(before, targetNow)) ||
            (copied &&
              ((await digest(target)) !== copiedHash ||
                (await digest(source)) !== copiedHash)) ||
            sourceNow.size !== before.size ||
            sourceNow.mtimeMs !== before.mtimeMs
          )
            throw error(
              409,
              `The ${kind} changed while its active state was being saved. Refresh and try again.`,
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
              if (
                !sameFile(copied ? destinationIdentity : before, remaining) ||
                (copied && (await digest(target)) !== copiedHash)
              )
                throw new Error("Destination changed");
              if (unlinked) {
                if (copied) {
                  await fs.copyFile(target, source, fs.constants.COPYFILE_EXCL);
                  await fs.utimes(source, before.atime, before.mtime);
                } else await fs.link(target, source);
              } else if (!sameFile(before, await fs.lstat(source)))
                throw new Error("Source changed");
              await fs.unlink(target);
            } catch {
              throw error(
                409,
                `The active state could not be saved. Check ${input.path} and ${relative} in File Manager; the ${kind}'s files have been retained.`,
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
