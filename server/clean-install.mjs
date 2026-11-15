import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { parseProperties } from "./import.mjs";
import { updateProperties } from "./properties.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};
const stamp = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const hash = async (file) => {
  const digest = createHash("sha512");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      digest.update(chunk);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
};

// Keep registration settings outside the folder, but create entirely new startup
// files. EULA acceptance is an existing explicit user decision, not pack input.
export async function prepareCleanSettings(result, ctx) {
  const config = ctx.getConfiguration();
  let accepted = false;
  try {
    accepted =
      parseProperties(
        await fs.readFile(
          await ctx.safePath(ctx.serverDir, "eula.txt"),
          "utf8",
        ),
      )
        .get("eula")
        ?.toLowerCase() === "true";
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  let previousProperties = "";
  try {
    previousProperties = await fs.readFile(
      await ctx.safePath(ctx.serverDir, "server.properties"),
      "utf8",
    );
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  const previousValues = parseProperties(previousProperties);
  const securityDefaults = {
    "online-mode": "true",
    "white-list": "false",
    "enforce-whitelist": "false",
    "enable-rcon": "false",
    "enable-query": "false",
    "rcon.password": "",
    "server-ip": "",
  };
  const retainedSettings = ctx.preserveWorld
    ? Object.fromEntries(previousValues)
    : {};
  for (const [key, fallback] of Object.entries(securityDefaults))
    retainedSettings[key] = previousValues.get(key) ?? fallback;
  let properties = "level-name=world\nmotd=A Minecraft Server\n";
  try {
    properties = await fs.readFile(
      await ctx.safePath(result.stageDir, "server.properties"),
      "utf8",
    );
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  properties = updateProperties(
    properties,
    new Map(Object.entries(retainedSettings)),
    { appendMissing: true },
  );
  const preserved = new Set();
  const actualNames = await fs.readdir(ctx.serverDir);
  const actualName = (relative) =>
    actualNames.find((name) => name === relative) ??
    (process.platform === "win32"
      ? actualNames.find(
          (name) => name.toLowerCase() === relative.toLowerCase(),
        )
      : undefined) ??
    relative;
  const protectedFiles = [
    "whitelist.json",
    "ops.json",
    "banned-players.json",
    "banned-ips.json",
  ];
  for (const relative of protectedFiles) {
    // Pack authors must never supply the host's player access policy.
    result.files = result.files.filter(
      (file) => file.path.toLowerCase() !== relative,
    );
    const stat = await fs
      .lstat(await ctx.safePath(ctx.serverDir, relative))
      .catch((cause) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink())
        throw fail(
          409,
          `${relative} must be a regular file before installation.`,
        );
      preserved.add(actualName(relative));
    }
  }
  if (ctx.preserveWorld) {
    const level = previousValues.get("level-name") || "world";
    const candidates = new Set([level, `${level}_nether`, `${level}_the_end`]);
    for (const entry of await fs.readdir(ctx.serverDir, {
      withFileTypes: true,
    })) {
      if (
        entry.isDirectory() &&
        (await fs.stat(path.join(ctx.serverDir, entry.name, "level.dat")).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
        candidates.add(entry.name);
    }
    for (const relative of candidates) {
      if (
        !relative ||
        relative.includes("/") ||
        relative.includes("\\") ||
        relative === "." ||
        relative === ".."
      )
        throw fail(
          400,
          "The existing world must use a direct child folder before it can be preserved.",
        );
      const stat = await fs
        .lstat(await ctx.safePath(ctx.serverDir, relative))
        .catch((cause) => {
          if (cause.code === "ENOENT") return null;
          throw cause;
        });
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw fail(409, `${relative} must be a regular world folder.`);
        preserved.add(actualName(relative));
      }
    }
  }
  result.files = result.files.filter(
    (file) =>
      ![...preserved].some(
        (relative) =>
          file.path.toLowerCase() === relative.toLowerCase() ||
          file.path.toLowerCase().startsWith(`${relative.toLowerCase()}/`),
      ),
  );
  result.preserveExistingPaths = [...preserved];
  const values = parseProperties(properties);
  const maxPlayers = Number(values.get("max-players") ?? 20);
  const motd = (values.get("motd") ?? "A Minecraft Server")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 256);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 100000)
    throw fail(400, "The pack has an invalid max-players setting.");
  result.configuration = { ...result.configuration, motd, maxPlayers };
  properties = properties
    .split(/\r?\n/)
    .filter((line) => !/^\s*server-port\s*[=:]/.test(line))
    .join("\n");
  if (!values.has("max-players")) properties += `\nmax-players=${maxPlayers}`;
  if (!values.has("motd")) properties += `\nmotd=${motd}`;
  const settings = {
    "server.properties": `${properties.trimEnd()}\nserver-port=${config.port ?? 25565}\n`,
    "eula.txt": `# Minecraft EULA: https://aka.ms/MinecraftEULA\neula=${accepted}\n`,
  };
  if (result.configuration.launchType === "java-args") {
    settings["user_jvm_args.txt"] =
      `-Xms${Math.min(1024, config.memoryLimitMB)}M\n-Xmx${config.memoryLimitMB}M\n`;
    try {
      settings["user_jvm_args.txt"] = await fs.readFile(
        await ctx.safePath(ctx.serverDir, "user_jvm_args.txt"),
        "utf8",
      );
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }
  for (const [relative, content] of Object.entries(settings)) {
    await fs.writeFile(await ctx.safePath(result.stageDir, relative), content);
    if (!result.files.some((file) => file.path === relative))
      result.files.push({ path: relative });
  }
  return result;
}

// Existing recovery storage journals each move and verifies cross-drive copies.
// The selected canonical root remains in place; neither its parent nor siblings
// are moved. A rollback only removes files/empty directories this transaction
// created, so unrelated concurrent external files are never deleted.
export async function cleanInstall(result, ctx) {
  const root = await fs.realpath(ctx.serverDir);
  const data = await fs.realpath(ctx.dataDir);
  if (
    root !== path.resolve(ctx.serverDir) ||
    root === path.parse(root).root ||
    root === path.resolve(os.homedir()) ||
    inside(root, data)
  )
    throw fail(
      400,
      "Clean installation requires a dedicated server folder with recovery storage outside it.",
    );
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw fail(400, "Choose a regular server folder for clean installation.");
  const checkRoot = async () => {
    if (
      (await fs.realpath(ctx.serverDir)) !== root ||
      stamp(await fs.lstat(ctx.serverDir)) !== stamp(rootStat)
    )
      throw fail(
        409,
        "The server folder changed during installation. Recovery files have been retained.",
      );
    await ctx.safePath(root, "");
  };
  const sources = [],
    seen = new Set(),
    expectedDirectories = new Set();
  for (const entry of result.files) {
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.includes("\\") ||
      entry.path
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || /[:\x00-\x1f]/.test(part),
        ) ||
      path.isAbsolute(entry.path)
    )
      throw fail(400, "The installer returned an invalid file path.");
    const key = entry.path.toLowerCase();
    if (seen.has(key))
      throw fail(400, "The installer returned conflicting file paths.");
    seen.add(key);
    const source = await ctx.safePath(result.stageDir, entry.path);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw fail(400, "Only verified regular files can be installed.");
    sources.push({
      path: entry.path,
      source,
      sha512: await hash(source),
      mode: stat.mode,
    });
    let parent = path.posix.dirname(entry.path);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  if (
    [...expectedDirectories].some((relative) =>
      seen.has(relative.toLowerCase()),
    )
  )
    throw fail(400, "The installer returned conflicting file paths.");
  if (!sources.length)
    throw fail(400, "The installation contains no server files.");
  const originals = [],
    written = [],
    directories = [];
  let pendingOriginal;
  const preserved = new Set(result.preserveExistingPaths ?? []);
  for (const name of preserved)
    if (
      typeof name !== "string" ||
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".."
    )
      throw fail(400, "Invalid preserved server path.");
  const preservedKeys = new Set(
    [...preserved].map((name) => name.toLowerCase()),
  );
  if (
    sources.some((file) =>
      preservedKeys.has(file.path.split("/")[0].toLowerCase()),
    )
  )
    throw fail(400, "Installer files overlap a preserved server path.");
  const allOriginalNames = await fs.readdir(root);
  const originalNames = allOriginalNames.filter(
    (name) => !preservedKeys.has(name.toLowerCase()),
  );
  const preservedStats = new Map();
  for (const name of preserved) {
    const stat = await fs.lstat(await ctx.safePath(root, name));
    if (stat.isSymbolicLink())
      throw fail(409, "Preserved server paths must not be symbolic links.");
    preservedStats.set(name, stamp(stat));
  }
  const originalStats = new Map();
  for (const name of originalNames)
    originalStats.set(
      name,
      stamp(await fs.lstat(await ctx.safePath(root, name))),
    );
  ctx.signal?.throwIfAborted();
  try {
    for (const name of originalNames) {
      await checkRoot();
      if (
        stamp(await fs.lstat(await ctx.safePath(root, name))) !==
        originalStats.get(name)
      )
        throw fail(
          409,
          `${name} changed before clean installation. Review again.`,
        );
      ctx.onProgress?.({ message: `Saving previous ${name} in Recycle Bin…` });
      await checkRoot();
      pendingOriginal = name;
      try {
        originals.push({ path: name, ...(await ctx.recycle(name)) });
        pendingOriginal = null;
      } catch (cause) {
        if (cause.recoveryId) {
          originals.push({ path: name, id: cause.recoveryId });
          pendingOriginal = null;
        }
        throw cause;
      }
    }
    await checkRoot();
    if (
      (await fs.readdir(root)).some(
        (name) => !preservedKeys.has(name.toLowerCase()),
      )
    )
      throw fail(
        409,
        "New files appeared in the server folder. They were left untouched; retry after external edits finish.",
      );
    for (const relative of [...expectedDirectories].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    )) {
      await checkRoot();
      const target = await ctx.safePath(root, relative);
      await fs.mkdir(target);
      directories.push({
        path: relative,
        identity: stamp(await fs.lstat(target)),
      });
    }
    for (const file of sources) {
      await checkRoot();
      ctx.signal?.throwIfAborted();
      ctx.onProgress?.({ message: `Installing ${file.path}…` });
      await checkRoot();
      const target = await ctx.safePath(root, file.path);
      const output = await fs.open(target, "wx");
      file.identity = stamp(await output.stat());
      written.push({ path: file.path, identity: file.identity });
      try {
        const input = await fs.open(file.source, "r");
        try {
          for await (const chunk of input.createReadStream({
            autoClose: false,
          }))
            await output.writeFile(chunk);
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
        throw fail(409, `${file.path} failed installed-file verification.`);
    }
    const actual = [];
    const inspect = async (directory, prefix = "") => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const relative = prefix + entry.name;
        if (!prefix && preservedKeys.has(entry.name.toLowerCase())) continue;
        if (entry.isSymbolicLink())
          throw fail(409, "An external link appeared during installation.");
        if (entry.isDirectory()) {
          if (!expectedDirectories.has(relative))
            throw fail(409, "External files appeared during installation.");
          await inspect(await ctx.safePath(root, relative), relative + "/");
        } else actual.push(relative.toLowerCase());
      }
    };
    await inspect(root);
    if (
      actual.length !== sources.length ||
      actual.some((name) => !seen.has(name))
    )
      throw fail(
        409,
        "External files appeared during installation. They have been left untouched.",
      );
    for (const file of sources) {
      await checkRoot();
      const target = await ctx.safePath(root, file.path);
      if (
        stamp(await fs.lstat(target)) !== file.identity ||
        (await hash(target)) !== file.sha512
      )
        throw fail(
          409,
          `${file.path} changed during installation. Previous files will be restored.`,
        );
    }
    await checkRoot();
    for (const [name, identity] of preservedStats)
      if (stamp(await fs.lstat(await ctx.safePath(root, name))) !== identity)
        throw fail(409, `${name} changed during installation. Review again.`);
    await ctx.commit();
    return {
      backupPath: await ctx.safePath(data, "recycle-bin"),
      recoveryEntries: originals.map(({ id, path }) => ({ id, path })),
    };
  } catch (cause) {
    const failures = pendingOriginal ? [pendingOriginal] : [];
    for (const file of written.reverse())
      try {
        await checkRoot();
        const target = await ctx.safePath(root, file.path);
        if (stamp(await fs.lstat(target)) !== file.identity)
          throw new Error("External replacement");
        const source = sources.find((entry) => entry.path === file.path);
        if (source && (await hash(target)) === source.sha512)
          await fs.unlink(target);
        else await ctx.recycle(file.path);
      } catch {
        failures.push(file.path);
      }
    for (const directory of directories.reverse())
      try {
        await checkRoot();
        const target = await ctx.safePath(root, directory.path);
        if (stamp(await fs.lstat(target)) !== directory.identity)
          throw new Error("External replacement");
        await fs.rmdir(target);
      } catch {
        failures.push(directory.path);
      }
    for (const entry of originals.reverse())
      try {
        await checkRoot();
        await ctx.restore(entry.id);
      } catch {
        failures.push(entry.path);
      }
    try {
      await ctx.rollback?.();
    } catch {
      failures.push("server settings");
    }
    throw fail(
      cause.status ?? 500,
      `${cause.message} ${failures.length ? `Recovery needs attention for ${[...new Set(failures)].join(", ")}. Previous files remain in File Manager → Recycle Bin.` : "Previous server files were restored."}`,
    );
  }
}
