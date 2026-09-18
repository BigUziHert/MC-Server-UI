import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { safeInstallPath } from "./launchpad-archives.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const hash = async (target) => {
  const digest = createHash("sha512");
  const handle = await fs.open(target, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      digest.update(chunk);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
};
const statOrNull = async (target) => {
  try {
    return await fs.lstat(target);
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    throw cause;
  }
};
const preservedNames = new Set([
  "user_jvm_args.txt",
  "run.bat",
  "run.sh",
  "fabric-server-launcher.properties",
  "quilt-server-launcher.properties",
]);

// Promote only installer runtime artifacts. Existing configuration and launcher
// templates are never overwritten, and files outside this manifest stay intact.
export async function runtimeUpdateFiles(result, ctx) {
  const root = await fs.realpath(ctx.serverDir);
  const data = await fs.realpath(ctx.dataDir);
  const relativeData = path.relative(root, data);
  const rootStat = await fs.lstat(ctx.serverDir);
  if (
    root !== path.resolve(ctx.serverDir) ||
    root === path.parse(root).root ||
    root === path.resolve(os.homedir()) ||
    !relativeData ||
    (!relativeData.startsWith(`..${path.sep}`) &&
      relativeData !== ".." &&
      !path.isAbsolute(relativeData)) ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink()
  )
    throw fail(
      400,
      "Runtime updates require a regular server folder with recovery storage outside it.",
    );
  const checkRoot = async () => {
    const stat = await fs.lstat(ctx.serverDir);
    if (
      stat.isSymbolicLink() ||
      identity(stat) !== identity(rootStat) ||
      (await fs.realpath(ctx.serverDir)) !== root
    )
      throw fail(
        409,
        "The server folder changed during the runtime update. Recovery files were retained.",
      );
  };
  // Only the caller's inspected active launcher may extend the runtime manifest.
  const replacements = new Set(
    (ctx.replacePaths ?? []).map((value) =>
      safeInstallPath(value).toLowerCase(),
    ),
  );
  const entries = [],
    seen = new Set(),
    parents = new Set();
  for (const file of result.files) {
    const relative = safeInstallPath(file.path);
    const key = relative.toLowerCase();
    if (seen.has(key))
      throw fail(400, "The runtime installer returned conflicting files.");
    seen.add(key);
    const preserve =
      !replacements.has(key) &&
      (file.preserveExisting === true || preservedNames.has(key));
    if (
      !preservedNames.has(key) &&
      !replacements.has(key) &&
      !/^libraries\/.+/i.test(relative) &&
      !/^[^/]+\.jar$/i.test(relative)
    )
      throw fail(
        400,
        "The runtime installer returned a file outside its runtime artifacts.",
      );
    const source = await ctx.safePath(result.stageDir, relative);
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
      throw fail(400, "Runtime artifacts must be regular files.");
    await checkRoot();
    const target = await ctx.safePath(root, relative);
    const existing = await statOrNull(target);
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw fail(409, `${relative} is not a regular file.`);
    if (preserve && existing) continue;
    const sha512 = await hash(source);
    const beforeHash = existing ? await hash(target) : null;
    if (
      Object.hasOwn(ctx.expectedHashes ?? {}, key) &&
      ctx.expectedHashes[key] !== beforeHash
    )
      throw fail(
        409,
        `${relative} changed after its launcher settings were inspected. Review the build again.`,
      );
    if (beforeHash === sha512) continue;
    entries.push({
      path: relative,
      source,
      sha512,
      mode: sourceStat.mode,
      before: existing ? identity(existing) : null,
      beforeHash,
    });
    let parent = path.posix.dirname(relative);
    while (parent !== ".") {
      parents.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  if ([...parents].some((parent) => seen.has(parent.toLowerCase())))
    throw fail(400, "The runtime installer returned conflicting paths.");
  const originals = [],
    written = [],
    createdDirectories = [];
  let configured = false;
  try {
    // Validate the complete destination snapshot before the first replacement.
    for (const file of entries) {
      await checkRoot();
      const target = await ctx.safePath(root, file.path),
        current = await statOrNull(target);
      if (
        (current ? identity(current) : null) !== file.before ||
        (current ? await hash(target) : null) !== file.beforeHash
      )
        throw fail(
          409,
          `${file.path} changed before the runtime update. Review the build again.`,
        );
    }
    for (const file of entries) {
      ctx.signal?.throwIfAborted();
      ctx.onProgress?.({ message: `Updating ${file.path}…` });
      await checkRoot();
      const target = await ctx.safePath(root, file.path),
        current = await statOrNull(target);
      if (
        (current ? identity(current) : null) !== file.before ||
        (current ? await hash(target) : null) !== file.beforeHash
      )
        throw fail(409, `${file.path} changed during the runtime update.`);
      if (current) {
        try {
          originals.push({
            path: file.path,
            ...(await ctx.recycle(file.path)),
          });
        } catch (cause) {
          if (cause.recoveryId)
            originals.push({ path: file.path, id: cause.recoveryId });
          throw cause;
        }
      }
      const segments = file.path.split("/").slice(0, -1);
      for (let depth = 1; depth <= segments.length; depth++) {
        await checkRoot();
        const relative = segments.slice(0, depth).join("/");
        const directory = await ctx.safePath(root, relative);
        const present = await statOrNull(directory);
        if (present && (!present.isDirectory() || present.isSymbolicLink()))
          throw fail(409, `${relative} is not a regular directory.`);
        if (!present) {
          await fs.mkdir(directory);
          createdDirectories.push({
            path: relative,
            identity: identity(await fs.lstat(directory)),
          });
        }
      }
      await checkRoot();
      const output = await fs.open(await ctx.safePath(root, file.path), "wx");
      const created = {
        path: file.path,
        identity: identity(await output.stat()),
        sha512: file.sha512,
      };
      written.push(created);
      try {
        const input = await fs.open(
          await ctx.safePath(result.stageDir, file.path),
          "r",
        );
        try {
          for await (const chunk of input.createReadStream({
            autoClose: false,
          })) {
            ctx.signal?.throwIfAborted();
            await output.writeFile(chunk);
          }
          await output.sync();
          if (process.platform !== "win32")
            await output.chmod(file.mode & 0o777);
        } finally {
          await input.close();
        }
      } finally {
        await output.close();
      }
      if ((await hash(await ctx.safePath(root, file.path))) !== file.sha512)
        throw fail(409, `${file.path} failed runtime verification.`);
    }
    for (const file of written) {
      await checkRoot();
      const target = await ctx.safePath(root, file.path);
      if (
        identity(await fs.lstat(target)) !== file.identity ||
        (await hash(target)) !== file.sha512
      )
        throw fail(409, `${file.path} changed during the runtime update.`);
    }
    ctx.signal?.throwIfAborted();
    await checkRoot();
    configured = true;
    await ctx.commit();
    return {
      backupPath: await ctx.safePath(data, "recycle-bin"),
      recoveryEntries: originals.map(({ id, path }) => ({ id, path })),
      updatedFiles: entries.map((file) => file.path),
    };
  } catch (cause) {
    const failures = [];
    for (const file of written.reverse())
      try {
        await checkRoot();
        const target = await ctx.safePath(root, file.path);
        if (identity(await fs.lstat(target)) !== file.identity)
          throw new Error("External replacement");
        await ctx.recycle(file.path);
      } catch {
        failures.push(file.path);
      }
    for (const directory of createdDirectories.reverse())
      try {
        await checkRoot();
        const target = await ctx.safePath(root, directory.path);
        if (identity(await fs.lstat(target)) !== directory.identity)
          throw new Error("External replacement");
        await fs.rmdir(target);
      } catch {
        failures.push(directory.path);
      }
    for (const original of originals.reverse())
      try {
        await checkRoot();
        await ctx.restore(original.id);
      } catch {
        failures.push(original.path);
      }
    if (configured)
      try {
        await ctx.rollback?.();
      } catch {
        failures.push("server settings");
      }
    throw fail(
      cause.status ?? 500,
      `${cause.message} ${failures.length ? `Recovery needs attention for ${[...new Set(failures)].join(", ")}. Previous runtime files remain in Recycle Bin.` : "Previous runtime files were restored; other server files were left unchanged."}`,
    );
  }
}
