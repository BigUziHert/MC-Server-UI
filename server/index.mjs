import express from "express";
import multer from "multer";
import * as tar from "tar";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { availableParallelism } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import permissionsCatalog from "../shared/subuser-permissions.json" with { type: "json" };
import { createProcessTelemetry } from "./telemetry.mjs";
import {
  advertisedConnection,
  createPublicAddressResolver,
  validateConnectionHost,
  legacyConnectionHost,
} from "./connection.mjs";
import { decodeIcon, readServerIcon, writeServerIcon } from "./server-icon.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { createMinecraft } from "./minecraft.mjs";
import { createServerSetup } from "./server-setup.mjs";
import { createLauncherStop } from "./launcher-stop.mjs";
import {
  createPlayerHistory,
  readPlayerRecords,
  moderationCommand,
  playerCommandAudit,
  validPlayerUuid,
  whitelistCommand,
  readWhitelistSettings,
  samePlayer,
} from "./player-history.mjs";
import {
  canonicalExternalDirectory,
  containedSourcePath,
  inspectServerDirectory,
  validateStartupFiles,
  buildScriptInvocation,
  parseProperties,
} from "./import.mjs";

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const roles = new Set(["admin", "operator", "viewer", "custom"]);
const permissionIds = new Set(
  permissionsCatalog.groups.flatMap((group) =>
    group.permissions.map((permission) => permission.id),
  ),
);
const userWithPermissions = (user) => ({
  ...user,
  permissions:
    user.permissions ?? permissionsCatalog.roleDefaults[user.role] ?? [],
});
function validatePermissions(value) {
  if (
    !Array.isArray(value) ||
    value.length > permissionIds.size ||
    value.some((id) => !permissionIds.has(id))
  )
    throw error(400, "Choose permissions from the available list.");
  return [...new Set(value)];
}
const defaultSchedule = {
  enabled: false,
  type: "interval",
  intervalHours: 6,
  time: "03:00",
  dayOfWeek: 0,
  retention: 7,
  nextRun: null,
};
const error = (status, message) =>
  Object.assign(new Error(message), { status });
const exists = async (target) => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

export async function terminateProcessTree(
  child,
  { tree = false, platform = process.platform, spawnProcess = spawn } = {},
) {
  if (!tree || !Number.isInteger(child.pid) || child.pid <= 0) {
    child.kill();
    return;
  }
  if (platform === "win32") {
    await new Promise((resolve, reject) => {
      const killer = spawnProcess(
        path.win32.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", reject);
      killer.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Could not stop the server process tree (taskkill ${code}). Check the server before starting another copy.`,
              ),
            ),
      );
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (cause) {
      if (cause.code !== "ESRCH") throw cause;
      child.kill("SIGKILL");
    }
  }
}

const escapeProperty = (value) =>
  String(value)
    .replace(/\\/g, "\\\\")
    .replace(
      /[^\x20-\x7e]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );

export function validatePlayerName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_]{3,16}$/.test(name))
    throw error(
      400,
      "Use a Minecraft Java username with 3–16 letters, numbers, or underscores.",
    );
  return name;
}

export function validateServerConfiguration(
  input,
  previous = {},
  preserveExistingMotd = false,
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw error(400, "Provide server settings.");
  const allowed = new Set([
    "name",
    "mode",
    "port",
    "memoryLimitMB",
    "jar",
    "launchType",
    "launchScript",
    "launchArgs",
    "launchExecutable",
    "javaPath",
    "motd",
    "connectionHost",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw error(400, "Unknown server setting.");
  const result = {
    name: "New server",
    mode: "live",
    port: 25565,
    memoryLimitMB: 4096,
    jar: "server.jar",
    launchType: "jar",
    launchScript: "",
    launchArgs: [],
    launchExecutable: "",
    javaPath: "java",
    motd: "Welcome to the Overworld",
    connectionHost: "",
    ...previous,
    ...input,
  };
  if (
    typeof result.name !== "string" ||
    !result.name.trim() ||
    result.name.length > 64 ||
    /[\x00-\x1f\x7f]/.test(result.name)
  )
    throw error(
      400,
      "Server names must contain 1–64 characters without control characters.",
    );
  result.name = result.name.trim();
  try {
    result.connectionHost = validateConnectionHost(result.connectionHost);
  } catch (cause) {
    throw error(400, cause.message);
  }
  if (!["demo", "live"].includes(result.mode))
    throw error(400, "Choose demo or live mode.");
  if (
    !Number.isInteger(result.port) ||
    result.port < 1024 ||
    result.port > 65535
  )
    throw error(400, "Use a Minecraft port between 1024 and 65535.");
  if (
    !Number.isInteger(result.memoryLimitMB) ||
    result.memoryLimitMB < 256 ||
    result.memoryLimitMB > 262144
  )
    throw error(400, "Memory must be an integer between 256 and 262144 MB.");
  if (!["jar", "java-args", "script", "executable"].includes(result.launchType))
    throw error(
      400,
      "Choose a server JAR, Java arguments, startup script, or executable.",
    );
  if (
    !Array.isArray(result.launchArgs) ||
    result.launchArgs.length > 128 ||
    result.launchArgs.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 8192 ||
        /[\x00-\x1f\x7f]/.test(value),
    )
  )
    throw error(
      400,
      "Provide up to 128 startup arguments as separate text values without control characters.",
    );
  if (result.launchType !== "jar") {
    result.jar = "";
    if (result.launchType === "java-args" && !result.launchArgs.length)
      throw error(
        400,
        "Enter the Java startup arguments, including its JAR, main class, or argument files.",
      );
    if (result.launchType === "script") {
      if (
        typeof result.launchScript !== "string" ||
        !/\.(bat|cmd|sh|ps1)$/i.test(result.launchScript) ||
        result.launchScript.length > 1024
      )
        throw error(
          400,
          "Choose a relative .bat, .cmd, .sh, or .ps1 startup script inside the server folder.",
        );
      for (const part of result.launchScript.split("/")) validateName(part);
    } else result.launchScript = "";
    if (result.launchType === "executable") {
      if (
        typeof result.launchExecutable !== "string" ||
        !result.launchExecutable.trim() ||
        result.launchExecutable.length > 1024 ||
        /["\x00-\x1f\x7f]/.test(result.launchExecutable) ||
        /\.(bat|cmd|sh|ps1)$/i.test(result.launchExecutable)
      )
        throw error(
          400,
          "Enter an executable name or path without surrounding quotes; select Startup script for script files.",
        );
    } else result.launchExecutable = "";
  } else {
    result.launchScript = "";
    result.launchExecutable = "";
    result.launchArgs = [];
    if (
      typeof result.jar !== "string" ||
      !/\.jar$/i.test(result.jar) ||
      result.jar.length > 180 ||
      result.jar
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw error(
        400,
        "Choose a relative .jar path inside this server's files.",
      );
    for (const part of result.jar.split("/")) validateName(part);
  }
  if (
    typeof result.javaPath !== "string" ||
    !result.javaPath.trim() ||
    result.javaPath.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(result.javaPath)
  )
    throw error(400, "Enter java or the path to a Java executable.");
  const unchangedImportedMotd =
    preserveExistingMotd &&
    (input.motd === undefined || input.motd === previous.motd);
  if (
    typeof result.motd !== "string" ||
    (!unchangedImportedMotd &&
      (result.motd.length > 256 || /[\x00-\x1f\x7f]/.test(result.motd)))
  )
    throw error(
      400,
      "The server list description must be one line, up to 256 characters.",
    );
  return result;
}

export function validateName(name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 180 ||
    name !== name.trim() ||
    /[\x00-\x1f<>:"/\\|?*]/.test(name) ||
    /[. ]$/.test(name) ||
    /^\.{1,2}$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw error(
      400,
      "Use a valid name without slashes, reserved characters, or trailing periods.",
    );
  }
  return name;
}

export function validateSchedule(input) {
  if (
    !input ||
    typeof input.enabled !== "boolean" ||
    !["interval", "daily", "weekly"].includes(input.type)
  )
    throw error(400, "Choose an interval, daily, or weekly schedule.");
  const intervalHours = Number(input.intervalHours ?? 6);
  const retention = Number(input.retention ?? 7);
  const dayOfWeek = Number(input.dayOfWeek ?? 0);
  if (
    !Number.isFinite(intervalHours) ||
    intervalHours < 1 ||
    intervalHours > 720
  )
    throw error(400, "Backup intervals must be between 1 and 720 hours.");
  if (!Number.isInteger(retention) || retention < 1 || retention > 100)
    throw error(400, "Keep between 1 and 100 scheduled backups.");
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)
    throw error(400, "Choose a valid day of the week.");
  const time = input.time ?? "03:00";
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw error(400, "Enter a valid 24-hour backup time.");
  return {
    enabled: input.enabled,
    type: input.type,
    intervalHours,
    time,
    dayOfWeek,
    retention,
  };
}

export function nextRunFor(schedule, now = new Date()) {
  if (!schedule.enabled) return null;
  if (schedule.type === "interval")
    return new Date(
      now.getTime() + schedule.intervalHours * 3_600_000,
    ).toISOString();
  const next = new Date(now);
  const [hours, minutes] = schedule.time.split(":").map(Number);
  next.setHours(hours, minutes, 0, 0);
  if (schedule.type === "weekly")
    next.setDate(
      next.getDate() + ((schedule.dayOfWeek - next.getDay() + 7) % 7),
    );
  if (next <= now)
    next.setDate(next.getDate() + (schedule.type === "weekly" ? 7 : 1));
  return next.toISOString();
}

// Reject symlinks at every path segment, including paths to files that do not exist yet.
export async function safePath(root, relative = "") {
  if (
    typeof relative !== "string" ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    path.isAbsolute(relative) ||
    relative
      .split("/")
      .some((part) => part === ".." || part === "." || /:/.test(part))
  )
    throw error(400, "Path must stay inside the server directory.");
  const base = await fs.realpath(root);
  const parts = relative.split("/").filter(Boolean);
  let current = base;
  for (const part of parts) {
    validateName(part);
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw error(
          400,
          "Symbolic links cannot be accessed through the panel.",
        );
      const real = await fs.realpath(current);
      const rel = path.relative(base, real);
      if (rel.startsWith("..") || path.isAbsolute(rel))
        throw error(400, "Path must stay inside the server directory.");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }
  return current;
}

async function directorySize(root) {
  let total = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    try {
      total += entry.isDirectory()
        ? await directorySize(target)
        : (await fs.stat(target)).size;
    } catch {
      /* Files can change while the server runs. */
    }
  }
  return total;
}

export async function createPanel(options = {}) {
  const telemetry = options.telemetry ?? createProcessTelemetry();
  const publicAddress = options.publicAddress ?? createPublicAddressResolver();
  // A fleet passes every setting explicitly. Legacy callers may still use .env.
  const env = options.useEnvironment === false ? {} : process.env;
  const dataDir = path.resolve(
    options.dataDir ?? env.PANEL_DATA_DIR ?? path.join(projectDir, "data"),
  );
  const serverDir = path.resolve(
    options.serverDir ?? env.MC_SERVER_DIR ?? path.join(dataDir, "server"),
  );
  let configuredJar =
    options.launchType && options.launchType !== "jar"
      ? ""
      : (options.jar ?? env.MC_SERVER_JAR) || "server.jar";
  let mode =
    options.mode ?? (options.jar || env.MC_SERVER_JAR ? "live" : "demo");
  let memoryLimit = Number(options.memoryLimit ?? env.MC_MEMORY_MB ?? 4096);
  let configuration = {
    name: options.name ?? env.MC_SERVER_NAME ?? "The Overworld",
    mode,
    port: Number(options.port ?? env.MC_PORT ?? 25565),
    memoryLimitMB: memoryLimit,
    jar: configuredJar,
    launchType: options.launchType ?? "jar",
    launchScript: options.launchScript ?? "",
    launchArgs: options.launchArgs ?? [],
    launchExecutable: options.launchExecutable ?? "",
    javaPath: options.javaPath ?? env.JAVA_PATH ?? "java",
    connectionHost:
      options.connectionHost ??
      legacyConnectionHost(options.address ?? env.MC_SERVER_ADDRESS),
    address:
      options.address ??
      env.MC_SERVER_ADDRESS ??
      `localhost:${options.port ?? env.MC_PORT ?? 25565}`,
    version:
      options.version ??
      env.MC_VERSION ??
      (mode === "demo" ? "1.21.4" : "Configured JAR"),
    software:
      options.software ??
      env.MC_SOFTWARE ??
      (mode === "demo" ? "Paper" : "Java"),
    maxPlayers: Number(options.maxPlayers ?? env.MC_MAX_PLAYERS ?? 20),
    minecraftVersion: options.minecraftVersion ?? null,
    motd: options.motd ?? "Welcome to the Overworld",
  };
  if (
    !Number.isInteger(memoryLimit) ||
    memoryLimit < 256 ||
    memoryLimit > 262144
  )
    throw new Error("MC_MEMORY_MB must be an integer between 256 and 262144.");
  await fs.mkdir(dataDir, { recursive: true });
  const backupDir = await safePath(dataDir, "backups");
  const databaseDir = await safePath(dataDir, "databases");
  const uploadDir = await safePath(dataDir, "uploads");
  const statePath = await safePath(dataDir, "panel.json");
  if (options.existingServerDir)
    await canonicalExternalDirectory(serverDir, { requireCanonical: true });
  for (const dir of [
    dataDir,
    ...(options.existingServerDir ? [] : [serverDir]),
    backupDir,
    databaseDir,
    uploadDir,
  ])
    await fs.mkdir(dir, { recursive: true });
  const relativeBackup = path.relative(
    await fs.realpath(serverDir),
    await fs.realpath(backupDir),
  );
  if (
    !path.isAbsolute(relativeBackup) &&
    relativeBackup !== ".." &&
    !relativeBackup.startsWith(`..${path.sep}`)
  )
    throw new Error(
      "The panel data and backup directories must be outside MC_SERVER_DIR.",
    );
  const recycleBin = await createRecycleBin({
    dataDir,
    serverDir,
    safePath,
  });
  let state = {
    users: [],
    databases: [],
    backups: [],
    audit: [],
    demoOperators: [],
    playerHistory: [],
    demoPlayerBans: [],
    demoWhitelist: [],
    demoWhitelistEnabled: null,
    iconPreference: "server",
    schedule: { ...defaultSchedule },
  };
  if (await exists(statePath))
    state = { ...state, ...JSON.parse(await fs.readFile(statePath, "utf8")) };
  state.iconPreference =
    state.iconPreference === "default" ? "default" : "server";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  state.schedule = { ...defaultSchedule, ...state.schedule, timezone };
  const events = new EventEmitter();
  let saveChain = Promise.resolve();
  const save = () => {
    const serialized = JSON.stringify(state, null, 2);
    saveChain = saveChain
      .catch(() => {})
      .then(async () => {
        const temp = `${statePath}.${randomUUID()}.tmp`;
        await fs.writeFile(temp, serialized);
        await fs.rename(temp, statePath);
      });
    return saveChain;
  };
  const audit = async (category, action, detail) => {
    state.audit.unshift({
      id: randomUUID(),
      category,
      action,
      detail,
      actor: "Local administrator",
      createdAt: new Date().toISOString(),
    });
    state.audit = state.audit.slice(0, 2000);
    await save();
  };

  if (
    mode === "demo" &&
    serverDir === path.resolve(dataDir, "server") &&
    !(await exists(path.join(dataDir, ".seeded")))
  ) {
    for (const dir of ["world", "plugins", "config", "logs"])
      await fs.mkdir(path.join(serverDir, dir), { recursive: true });
    const seed = {
      "server.properties": `# Local demo configuration\nmotd=${escapeProperty(configuration.motd)}\nserver-port=${configuration.port}\nmax-players=20\ndifficulty=normal\ngamemode=survival\nonline-mode=true\nview-distance=10\n`,
      "eula.txt":
        "# Set eula=true yourself after reading https://aka.ms/MinecraftEULA.\neula=false\n",
      "whitelist.json": "[]\n",
      "ops.json": "[]\n",
      "config/paper-global.yml":
        "# Example configuration for the demo workspace\n_version: 29\n",
      "plugins/README.txt":
        "Upload your server plugins here. The demo does not execute plugins.\n",
      "world/README.txt":
        "This is an example world directory. No Minecraft world has been generated.\n",
      "logs/latest.log":
        "[Server thread/INFO]: Demonstration workspace initialized.\n",
    };
    for (const [name, content] of Object.entries(seed))
      await fs
        .writeFile(path.join(serverDir, name), content, { flag: "wx" })
        .catch((cause) => {
          if (cause.code !== "EEXIST") throw cause;
        });
    await fs.writeFile(
      path.join(dataDir, ".seeded"),
      "Demo data initialized.\n",
    );
  }

  let status = mode === "demo" ? "running" : "offline";
  let configBusy = false;
  let startedAt = mode === "demo" ? Date.now() - 3_600_000 : null;
  let processHandle = null;
  let processStop;
  let stopTimer;
  let terminationPromise;
  let restartRequested = false;
  let closed = false;
  let closePromise;
  let startupMetadata = {};
  let startupMetadataAt = 0;
  let startupMetadataRead;
  const metadataFor = (config, detected = {}) =>
    config.mode === "demo" || config.launchType === "jar"
      ? {
          memoryLimitMB: config.memoryLimitMB,
          software: config.software,
          version: config.version,
          memoryLimitSource: "panel",
        }
      : {
          memoryLimitMB: detected.memoryLimitMB ?? null,
          software:
            detected.software ??
            (config.launchType === "executable" ? "Custom" : "Java"),
          version: detected.version ?? "Unknown",
          memoryLimitSource:
            detected.memoryLimitMB == null ? "unknown" : "launch",
        };
  async function refreshStartupMetadata(force = false) {
    // Once launched, these values describe that process. Editing @files while it
    // runs changes the next launch, not the heap/version of the running JVM.
    if (processHandle || (mode === "live" && status !== "offline")) return;
    if (
      !force &&
      Date.now() - startupMetadataAt < (options.startupMetadataTtlMs ?? 3000)
    )
      return;
    if (startupMetadataRead) return startupMetadataRead;
    const current = configuration;
    startupMetadataRead = (async () => {
      let detected = {};
      if (current.mode === "live" && current.launchType !== "jar") {
        try {
          detected = await validateStartupFiles(serverDir, current);
        } catch {
          /* Missing startup files are reported on Start; metadata stays unknown. */
        }
      }
      if (
        configuration === current &&
        !processHandle &&
        (mode === "demo" || status === "offline")
      ) {
        startupMetadata = metadataFor(current, detected);
        startupMetadataAt = Date.now();
      }
    })();
    try {
      await startupMetadataRead;
    } finally {
      startupMetadataRead = undefined;
    }
  }
  await refreshStartupMetadata(true);
  const inFlightTasks = new Set();
  const trackTask = (work) => {
    const task = Promise.resolve().then(work);
    inFlightTasks.add(task);
    const finished = () => inFlightTasks.delete(task);
    task.then(finished, finished);
    return task;
  };
  const trackOperation = (handler) => async (req, res, next) => {
    req.panelMutationStarted = true;
    try {
      if (closed) {
        // Multer may have completed just as shutdown began. Its temporary files
        // are outside the server tree and must not become a new file mutation.
        for (const file of req.files ?? [])
          await fs.rm(file.path, { force: true });
        throw error(503, "The panel is shutting down.");
      }
      await trackTask(() => handler(req, res, next));
    } finally {
      req.panelMutationDone?.();
    }
  };
  let demoTimer = null;
  let lineId = 0;
  const lines = [];
  const onlinePlayers = new Map();
  const playerUuids = new Map();
  const playerHistory = createPlayerHistory({
    records: state.playerHistory,
    persist: async (records) => {
      state.playerHistory = records;
      await save();
    },
  });
  const clearPlayers = () => {
    for (const player of onlinePlayers.values()) playerHistory.observe(player);
    onlinePlayers.clear();
    playerUuids.clear();
  };
  const trackPlayerOutput = (text, child) => {
    // Only inspect the managed process's logger output, never panel echoes or chat.
    if (
      closed ||
      child !== processHandle ||
      !["starting", "running"].includes(status)
    )
      return;
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
    if (clean.length > 2048) return;
    const vanilla = clean.match(
      /^(?:\[\d{2}:\d{2}:\d{2}\] )?\[(Server thread|User Authenticator #\d+)\/INFO\](?: \[[^\]\r\n]{1,120}\])?: (.+)$/,
    );
    const paper = clean.match(/^\[\d{2}:\d{2}:\d{2} INFO\]: (.+)$/);
    if (!vanilla && !paper) return;
    const message = vanilla ? vanilla[2] : paper[1];
    const uuid = message.match(
      /^UUID of player ([A-Za-z0-9_]{3,16}) is ([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/,
    );
    if (uuid) {
      const key = uuid[1].toLowerCase();
      const value = uuid[2].toLowerCase();
      playerUuids.delete(key);
      playerUuids.set(key, value);
      // Failed authentication attempts need not accumulate indefinitely.
      if (playerUuids.size > 4096)
        playerUuids.delete(playerUuids.keys().next().value);
      const player = onlinePlayers.get(key);
      if (player) {
        player.uuid = value;
        playerHistory.identify(player);
      }
      return;
    }
    if (vanilla && vanilla[1] !== "Server thread") return;
    const event = message.match(
      /^([A-Za-z0-9_]{3,16}) (joined|left) the game$/,
    );
    if (!event) return;
    const key = event[1].toLowerCase();
    if (event[2] === "left") {
      const player = onlinePlayers.get(key);
      if (player) playerHistory.observe(player);
      onlinePlayers.delete(key);
    } else {
      const uuid = playerUuids.get(key);
      const player = { name: event[1], ...(uuid ? { uuid } : {}) };
      onlinePlayers.set(key, player);
      playerHistory.observe(player);
    }
  };
  const append = (message, level = "info") => {
    const line = {
      id: String(++lineId),
      time: new Date().toISOString(),
      level,
      message: String(message)
        .replace(/\x1b\[[0-9;]*m/g, "")
        .slice(0, 16384),
    };
    lines.push(line);
    if (lines.length > 1500) lines.splice(0, lines.length - 1500);
    events.emit("line", line);
  };
  if (mode === "demo") {
    append(
      "[Panel] Demo mode — server activity and resource metrics are simulated.",
      "warn",
    );
    append("[Server thread/INFO]: Starting minecraft server version 1.21.4");
    append("[Server thread/INFO]: Loading properties");
    append("[Server thread/INFO]: This server is running Paper");
    append('[Server thread/INFO]: Preparing level "world"');
    append(
      "[Server thread/INFO]: Preparing start region for dimension minecraft:overworld",
    );
    append("[Server thread/INFO]: Time elapsed: 1428 ms");
    append(
      '[Server thread/INFO]: Done (2.314s)! For help, type "help"',
      "success",
    );
  } else
    append(
      "[Panel] Live mode configured. Start the server when your JAR and EULA are ready.",
    );

  async function writeProperties(updates) {
    const target = await safePath(serverDir, "server.properties");
    let content = "";
    try {
      content = await fs.readFile(target, "utf8");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    for (const [key, value] of Object.entries(updates)) {
      const line = `${key}=${escapeProperty(value)}`;
      const pattern = new RegExp(`^\\s*${key}\\s*[=:].*$`, "gm");
      content = pattern.test(content)
        ? content.replace(pattern, () => line)
        : `${content}${content.endsWith("\n") || !content ? "" : "\n"}${line}\n`;
    }
    const temp = path.join(serverDir, `.panel-properties-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, content, { flag: "wx" });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  async function updateConfiguration(next, persist = async () => {}) {
    if (configBusy || backupBusy || activeMutations)
      throw error(
        409,
        "Wait for the current backup, file change, or server command to finish.",
      );
    const restartFields = [
      "mode",
      "port",
      "memoryLimitMB",
      "jar",
      "launchType",
      "launchScript",
      "launchArgs",
      "launchExecutable",
      "javaPath",
      "motd",
    ];
    if (
      restartFields.some(
        (key) =>
          JSON.stringify(next[key]) !== JSON.stringify(configuration[key]),
      ) &&
      status !== "offline"
    )
      throw error(
        409,
        "Stop this server before changing its connection, Java, memory, or server list settings.",
      );
    configBusy = true;
    try {
      if (next.launchType === "jar") await safePath(serverDir, next.jar);
      else if (options.existingServerDir) {
        await validateStartupFiles(serverDir, next);
      }
      const updates = {};
      if (next.port !== configuration.port) updates["server-port"] = next.port;
      if (next.motd !== configuration.motd) updates.motd = next.motd;
      let previousProperties;
      let propertyTarget;
      if (Object.keys(updates).length) {
        propertyTarget = await safePath(serverDir, "server.properties");
        try {
          previousProperties = await fs.readFile(propertyTarget);
        } catch (cause) {
          if (cause.code !== "ENOENT") throw cause;
        }
        await writeProperties(updates);
      }
      try {
        await persist();
      } catch (cause) {
        if (propertyTarget) {
          if (previousProperties === undefined)
            await fs.rm(propertyTarget, { force: true });
          else await fs.writeFile(propertyTarget, previousProperties);
        }
        throw cause;
      }
      const oldName = configuration.name;
      const oldMode = configuration.mode;
      const changedJar =
        next.launchType === "jar" &&
        (configuration.launchType !== "jar" || next.jar !== configuration.jar);
      configuration = {
        ...configuration,
        ...Object.fromEntries(
          Object.keys(configuration).map((key) => [
            key,
            next[key] ?? configuration[key],
          ]),
        ),
      };
      mode = configuration.mode;
      memoryLimit = configuration.memoryLimitMB;
      configuredJar = configuration.jar;
      if (oldMode !== mode || changedJar) {
        configuration.minecraftVersion = null;
        configuration.version = mode === "demo" ? "1.21.4" : "Configured JAR";
        configuration.software = mode === "demo" ? "Paper" : "Java";
      }
      if (oldMode !== mode) {
        append(
          `[Panel] ${mode === "demo" ? "Demo mode — activity is simulated" : "Live Java mode configured"}.`,
        );
      }
      await refreshStartupMetadata(true);
      if (oldName !== configuration.name)
        await audit(
          "server",
          "Server renamed",
          `${oldName} → ${configuration.name}.`,
        );
      else
        await audit(
          "server",
          "Server settings updated",
          `Settings saved for ${configuration.name}.`,
        );
      return descriptor();
    } finally {
      configBusy = false;
    }
  }

  const descriptor = () => ({
    ...configuration,
    version: startupMetadata.version,
    software: startupMetadata.software,
    configuredMemoryLimitMB: startupMetadata.memoryLimitMB,
    memoryLimitSource: startupMetadata.memoryLimitSource,
    memoryLimitState: processHandle ? "started" : "configured",
    id: options.id,
    status,
    ...(options.source === "imported" ? { source: "imported", serverDir } : {}),
  });

  const lifecycleAudit = (action, detail) => {
    // saveChain drains these writes at shutdown. Audit I/O must not make a
    // stopped server appear busy or change the process outcome.
    return audit("server", action, detail).catch(() => {});
  };
  async function startServer(restarting = false) {
    if (status !== "offline")
      throw error(409, "The server is already running or changing state.");
    // Reserve the transition before any filesystem awaits so concurrent starts cannot spawn twice.
    status = "starting";
    clearPlayers();
    try {
      if (options.existingServerDir)
        await canonicalExternalDirectory(serverDir, { requireCanonical: true });
      if (mode === "demo") {
        status = "starting";
        append("[Demo] Starting the Minecraft server…");
        demoTimer = setTimeout(() => {
          status = "running";
          startedAt = Date.now();
          append("[Demo] Done! Server is ready.", "success");
          void lifecycleAudit(
            restarting ? "Server restarted" : "Server started",
            "Simulated server is ready.",
          );
        }, 900);
        demoTimer.unref();
        return;
      }
      let launchArgs;
      let executable = configuration.javaPath;
      let windowsVerbatimArguments = false;
      let detectedStartup = {};
      if (configuration.launchType !== "jar") {
        detectedStartup = await validateStartupFiles(serverDir, configuration);
        launchArgs = configuration.launchArgs;
        if (configuration.launchType === "script") {
          const script = await safePath(serverDir, configuration.launchScript);
          const invocation = buildScriptInvocation(script, launchArgs);
          executable = invocation.executable;
          launchArgs = invocation.args;
          windowsVerbatimArguments =
            invocation.windowsVerbatimArguments ?? false;
        } else if (configuration.launchType === "executable")
          executable = configuration.launchExecutable;
      } else {
        const jar = await safePath(serverDir, configuredJar);
        if (!(await exists(jar)))
          throw error(
            400,
            "The selected server JAR does not exist in the server directory.",
          );
        launchArgs = [
          `-Xms${Math.min(memoryLimit, 1024)}M`,
          `-Xmx${memoryLimit}M`,
          "-jar",
          jar,
          "nogui",
        ];
      }
      let eula = "";
      try {
        eula = await fs.readFile(await safePath(serverDir, "eula.txt"), "utf8");
      } catch {
        /* Shown as an actionable error below. */
      }
      if (!/^\s*eula\s*=\s*true\s*$/im.test(eula))
        throw error(
          400,
          "Read the Minecraft EULA, then set eula=true in your server eula.txt before starting.",
        );
      await writeProperties({ "server-port": configuration.port });
      status = "starting";
      append("[Panel] Starting server…");
      const child = (options.spawnServer ?? spawn)(executable, launchArgs, {
        cwd: serverDir,
        shell: false,
        windowsHide: true,
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...(process.platform !== "win32" &&
        ["script", "executable"].includes(configuration.launchType)
          ? { detached: true }
          : {}),
        stdio: ["pipe", "pipe", "pipe"],
      });
      processHandle = child;
      startupMetadata = metadataFor(configuration, detectedStartup);
      const stop = createLauncherStop({
        child,
        windowsBatch:
          process.platform === "win32" &&
          configuration.launchType === "script" &&
          /\.(?:bat|cmd)$/i.test(configuration.launchScript),
        onShutdownStarted: () => {
          if (processHandle !== child) return;
          clearTimeout(stopTimer);
          status = "stopping";
          clearPlayers();
        },
        onInputClosed: (reason) =>
          append(
            reason === "shutdown"
              ? "[Panel] Closing launcher input while Minecraft finishes saving."
              : "[Panel] Continuing past the launcher's pause prompt.",
            "info",
          ),
      });
      processStop = stop;
      telemetry.reset(child.pid);
      startedAt = Date.now();
      let becameReady = false;
      let launchError;
      const ready = (text) => {
        if (processHandle !== child || status !== "starting" || becameReady)
          return;
        // Do not treat a player's chat containing "Done (" as a startup event.
        const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (
          !/^(?:(?:(?:\[[^\]\r\n]{1,80}\]\s*)?\[(?:Server thread|main)\/INFO\](?:\s*\[[^\]\r\n]{1,120}\])?|\[\d{2}:\d{2}:\d{2} INFO\](?:\s*\[[^\]\r\n]{1,120}\])?):\s*|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[INFO\]\s*)Done \(/.test(
            clean,
          )
        )
          return;
        becameReady = true;
        status = "running";
        void lifecycleAudit(
          restarting ? "Server restarted" : "Server started",
          `${configuration.name} is ready to accept players.`,
        );
      };
      const bindOutput = (stream, defaultLevel) => {
        let buffer = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          buffer += chunk;
          if (processHandle === child) stop.observe(buffer);
          const chunks = buffer.split(/\r?\n/);
          buffer = chunks.pop().slice(-32768);
          for (const text of chunks) {
            trackPlayerOutput(text, child);
            ready(text);
            append(
              text,
              /\bERROR\b|\bFATAL\b/.test(text)
                ? "error"
                : /\bWARN\b/.test(text)
                  ? "warn"
                  : defaultLevel,
            );
          }
        });
        stream.on("end", () => {
          if (buffer) {
            trackPlayerOutput(buffer, child);
            ready(buffer);
            append(buffer, defaultLevel);
          }
        });
      };
      bindOutput(child.stdout, "info");
      bindOutput(child.stderr, "warn");
      child.stdin.on("error", (cause) =>
        append(`[Panel] Server input: ${cause.message}`, "error"),
      );
      child.on("error", (cause) => {
        launchError = cause;
        append(`[Panel] Java failed: ${cause.message}`, "error");
      });
      child.on("close", (code) => {
        void lifecycleAudit(
          !becameReady && !stop.requested
            ? "Server start failed"
            : code === 0 || stop.requested
              ? "Server stopped"
              : "Server exited unexpectedly",
          launchError?.message ??
            `${configuration.name} exited with code ${code ?? "unknown"}.`,
        );
        telemetry.reset(child.pid);
        clearTimeout(stopTimer);
        processHandle = null;
        startupMetadataAt = 0;
        processStop = undefined;
        status = terminationPromise ? "stopping" : "offline";
        startedAt = null;
        clearPlayers();
        events.emit("server-exit", child);
        append(
          `[Panel] Server process exited (code ${code ?? "unknown"}).`,
          code === 0 ? "info" : "error",
        );
        const finishExit = () => {
          terminationPromise = undefined;
          status = "offline";
          if (restartRequested && !closed) {
            restartRequested = false;
            startServer(true).catch((cause) => append(cause.message, "error"));
          }
        };
        if (terminationPromise)
          terminationPromise.then(finishExit, () => {
            restartRequested = false;
          });
        else finishExit();
      });
    } catch (cause) {
      status = "offline";
      startedAt = null;
      await lifecycleAudit("Server start failed", cause.message);
      throw cause;
    }
  }

  async function power(action) {
    if (!["start", "stop", "restart"].includes(action))
      throw error(400, "Choose start, stop, or restart.");
    if (action === "start") await startServer();
    else {
      if (!["running", "starting"].includes(status))
        throw error(409, "The server is not running.");
      if (mode === "live" && !processHandle)
        throw error(
          409,
          "Java is still being prepared. Wait for the process to start before stopping or restarting it.",
        );
      restartRequested = action === "restart";
      status = "stopping";
      clearPlayers();
      append(
        `[${mode === "demo" ? "Demo" : "Panel"}] ${action === "restart" ? "Restarting" : "Stopping"} the server…`,
      );
      if (mode === "demo") {
        clearTimeout(demoTimer);
        demoTimer = setTimeout(() => {
          status = "offline";
          startedAt = null;
          append("[Demo] Server stopped.");
          void lifecycleAudit("Server stopped", "Simulated server stopped.");
          if (restartRequested) {
            restartRequested = false;
            startServer(true).catch((cause) => append(cause.message, "error"));
          }
        }, 650);
        demoTimer.unref();
      } else {
        const child = processHandle;
        const stop = processStop;
        // Bound an unresponsive wrapper, but never interrupt Minecraft after it
        // confirms graceful shutdown. A trailing batch pause is handled on stdout.
        if (["script", "executable"].includes(configuration.launchType)) {
          stopTimer = setTimeout(() => {
            if (processHandle !== child || stop.shutdownStarted) return;
            append(
              "[Panel] The launcher did not exit after stop. Terminating its process tree…",
              "warn",
            );
            terminationPromise = Promise.resolve().then(() =>
              terminateProcessTree(child, {
                tree: true,
                spawnProcess: options.spawnProcess,
              }),
            );
            terminationPromise.catch((cause) => {
              restartRequested = false;
              append(`[Panel] ${cause.message}`, "error");
            });
          }, options.stopTimeoutMs ?? 15000);
          stopTimer.unref();
        }
        stop.requestStop();
      }
    }
  }

  let backupBusy = false;
  let activeMutations = 0;
  let recycleBusy = false;
  let minecraftBusy = false;
  function withMinecraftMutation(work, { requireStopped = true } = {}) {
    if (closed) throw error(503, "The panel is shutting down.");
    if (minecraftBusy || configBusy || backupBusy || activeMutations)
      throw error(409, "Wait for the current server operation to finish.");
    if (requireStopped && status !== "offline")
      throw error(
        409,
        "Stop the server before installing Minecraft software or content.",
      );
    minecraftBusy = true;
    activeMutations++;
    return trackTask(work).finally(() => {
      minecraftBusy = false;
      activeMutations--;
    });
  }
  async function applyMinecraftConfiguration(patch) {
    const { software, version, minecraftVersion, maxPlayers, ...settings } =
      patch;
    const next = {
      ...validateServerConfiguration(settings, configuration, true),
      ...(software !== undefined ? { software } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(minecraftVersion !== undefined ? { minecraftVersion } : {}),
      ...(maxPlayers !== undefined ? { maxPlayers } : {}),
    };
    if (next.launchType === "jar") await safePath(serverDir, next.jar);
    else await validateStartupFiles(serverDir, next);
    await options.persistMinecraftConfiguration?.(next);
    configuration = next;
    mode = next.mode;
    memoryLimit = next.memoryLimitMB;
    configuredJar = next.jar;
    await refreshStartupMetadata(true);
  }
  const minecraft = await createMinecraft({
    serverDir,
    dataDir,
    safePath,
    withMinecraftMutation,
    versionsService: options.versionsService,
    versionsOptions: options.versionsOptions,
    fetch: options.catalogFetch,
    extraProviders: options.extraProviders,
    getConfiguration: () => ({ ...configuration, status }),
    getServer: async ({ refresh = false } = {}) => {
      await refreshStartupMetadata(refresh);
      const software = startupMetadata.software,
        version = startupMetadata.version;
      const loader =
        /^(neoforge|forge|fabric|quilt|paper|purpur|spigot|folia|velocity|waterfall|bukkit)$/i.test(
          software ?? "",
        )
          ? software.toLowerCase()
          : null;
      let gameVersion = configuration.minecraftVersion;
      if (loader === "neoforge") {
        const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
        if (parts)
          gameVersion =
            Number(parts[1]) < 26
              ? `1.${parts[1]}${parts[2] === "0" ? "" : "." + parts[2]}`
              : `${parts[1]}.${parts[2]}${parts[3] === "0" ? "" : "." + parts[3]}`;
      } else if (loader === "forge")
        gameVersion =
          /^(1\.\d+(?:\.\d+)?)-/.exec(version ?? "")?.[1] ?? gameVersion;
      else if (
        ["Paper", "Purpur", "Vanilla", "Spigot", "Folia"].includes(software)
      )
        gameVersion = /^\d+\.\d+(?:\.\d+)?$/.test(version ?? "")
          ? version
          : gameVersion;
      let world = "world";
      try {
        world =
          parseProperties(
            await fs.readFile(
              await safePath(serverDir, "server.properties"),
              "utf8",
            ),
          ).get("level-name") || world;
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
      const loaderVersion =
        loader === "forge"
          ? version?.replace(/^\d+\.\d+(?:\.\d+)?-/, "")
          : ["neoforge", "fabric", "quilt"].includes(loader)
            ? version
            : null;
      return {
        status,
        mode,
        software,
        version,
        gameVersion,
        loader,
        loaderVersion,
        world,
        jar: configuration.jar,
        launchScript: configuration.launchScript,
      };
    },
    applyConfiguration: applyMinecraftConfiguration,
    recycle: (relative) => recycleBin.recycle(relative),
    restore: (id) => recycleBin.restore(id),
    audit,
  });
  const writeServer = (child, command) =>
    new Promise((resolve, reject) => {
      if (!child || child !== processHandle || !child.stdin?.writable)
        return reject(
          error(
            409,
            "The server disconnected before the command could be sent.",
          ),
        );
      child.stdin.write(`${command}\n`, (cause) =>
        cause ? reject(cause) : resolve(),
      );
    });
  async function flushWorld(child) {
    let cleanup;
    const confirmation = new Promise((resolve, reject) => {
      const onLine = (line) => {
        // Only accept the exact server logger response, never chat or a command echo.
        if (
          /^\s*(?:\[\d{2}:\d{2}:\d{2}\]\s*)?\[(?:Server thread\/INFO|\d{2}:\d{2}:\d{2} INFO)\]:\s*Saved the (?:game|world)[.!]?\s*$/i.test(
            line.message,
          ) &&
          child === processHandle
        ) {
          cleanup();
          resolve();
        }
      };
      const onExit = (exited) => {
        if (exited === child) {
          cleanup();
          reject(
            error(
              409,
              "The server stopped before confirming that its world was saved.",
            ),
          );
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          error(
            409,
            "The server did not confirm a completed world save. No backup was created. Check that save-all flush is supported.",
          ),
        );
      }, options.backupFlushTimeoutMs ?? 15_000);
      cleanup = () => {
        clearTimeout(timer);
        events.off("line", onLine);
        events.off("server-exit", onExit);
      };
      events.on("line", onLine);
      events.on("server-exit", onExit);
    });
    // Attach a rejection handler immediately, including while command writes are pending.
    confirmation.catch(() => {});
    try {
      await writeServer(child, "save-off");
      await writeServer(child, "save-all flush");
      await confirmation;
    } finally {
      cleanup();
    }
  }
  async function createBackup(name, trigger = "manual") {
    if (configBusy)
      throw error(409, "Wait for the server settings to finish saving.");
    if (backupBusy) throw error(409, "A backup is already in progress.");
    if (activeMutations)
      throw error(
        409,
        "A file or server change is in progress. Try the backup again when it finishes.",
      );
    if (mode === "live" && !["running", "offline"].includes(status))
      throw error(
        409,
        "Wait for the server to finish starting or stopping before backing up.",
      );
    const backupName = name
      ? validateName(name)
      : `${trigger === "scheduled" ? "Scheduled" : "Manual"} backup`;
    backupBusy = true;
    const id = randomUUID();
    const target = path.join(backupDir, `${id}.tar.gz`);
    const liveChild =
      mode === "live" && status === "running" ? processHandle : null;
    try {
      if (liveChild) {
        append(
          "[Panel] Flushing the world and pausing automatic saves for backup…",
        );
        await flushWorld(liveChild);
      }
      await tar.c(
        {
          gzip: true,
          file: `${target}.tmp`,
          cwd: serverDir,
          portable: true,
          follow: false,
          filter: (_name, stat) => !stat.isSymbolicLink(),
        },
        ["."],
      );
      if (liveChild && processHandle !== liveChild)
        throw error(
          409,
          "The server disconnected during backup. No archive was retained.",
        );
      await fs.rename(`${target}.tmp`, target);
      const item = {
        id,
        name: backupName,
        size: (await fs.stat(target)).size,
        createdAt: new Date().toISOString(),
        status: "completed",
        trigger,
      };
      state.backups.unshift(item);
      if (trigger === "scheduled") {
        const obsolete = state.backups
          .filter((item) => item.trigger === "scheduled")
          .slice(state.schedule.retention);
        for (const old of obsolete) {
          await fs.rm(path.join(backupDir, `${old.id}.tar.gz`), {
            force: true,
          });
          state.backups = state.backups.filter((item) => item.id !== old.id);
        }
      }
      await audit("backup", "Backup created", `${backupName} (${trigger}).`);
      return item;
    } catch (cause) {
      await fs.rm(`${target}.tmp`, { force: true });
      throw cause;
    } finally {
      try {
        if (liveChild && processHandle === liveChild) {
          try {
            await writeServer(liveChild, "save-on");
            append("[Panel] Requested automatic world saves to resume.");
          } catch (cause) {
            append(
              `[Panel] Could not re-enable world saves: ${cause.message}. Run save-on on the server.`,
              "error",
            );
            await audit(
              "backup",
              "World save recovery failed",
              `Run save-on on the server: ${cause.message}`,
            );
          }
        }
      } finally {
        backupBusy = false;
      }
    }
  }

  let schedulerBusy = false;
  async function performTick(now = new Date()) {
    if (
      closed ||
      schedulerBusy ||
      !state.schedule.enabled ||
      !state.schedule.nextRun ||
      new Date(state.schedule.nextRun) > now
    )
      return;
    schedulerBusy = true;
    try {
      // Persist the next deadline before work: after a restart, one missed backup runs, without a catch-up burst.
      state.schedule.nextRun = nextRunFor(state.schedule, now);
      await save();
      try {
        await createBackup(undefined, "scheduled");
      } catch (cause) {
        await audit("backup", "Scheduled backup failed", cause.message);
        append(`[Panel] Scheduled backup failed: ${cause.message}`, "error");
      }
    } finally {
      schedulerBusy = false;
    }
  }
  const tick = (now) =>
    closed ? Promise.resolve() : trackTask(() => performTick(now));
  if (state.schedule.enabled && !state.schedule.nextRun) {
    state.schedule.nextRun = nextRunFor(state.schedule);
    await save();
  }
  const scheduler =
    options.scheduler === false
      ? null
      : setInterval(() => {
          tick().catch((cause) =>
            append(`[Panel] Backup scheduler: ${cause.message}`, "error"),
          );
        }, 15_000);
  scheduler?.unref();

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (closed) return next(error(503, "The panel is shutting down."));
    const host = (() => {
      try {
        return new URL(`http://${req.headers.host}`).hostname;
      } catch {
        return "";
      }
    })();
    if (!localHosts.has(host))
      return next(
        error(403, "This local panel only accepts localhost connections."),
      );
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (
            !localHosts.has(new URL(origin).hostname) ||
            !/^https?:$/.test(new URL(origin).protocol)
          )
            throw new Error();
        } catch {
          return next(error(403, "Cross-origin requests are not allowed."));
        }
      }
      if (req.headers["sec-fetch-site"] === "cross-site")
        return next(error(403, "Cross-site requests are not allowed."));
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    const protectedMutation =
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (/^\/api\/files(?:\/|$)/.test(req.path) ||
        /^\/api\/players(?:\/|$)/.test(req.path) ||
        req.path === "/api/server/power" ||
        req.path === "/api/server/icon" ||
        req.path === "/api/console/command");
    if (protectedMutation) {
      if (minecraftBusy)
        return next(
          error(
            409,
            "Wait for the Minecraft installation or configuration change to finish.",
          ),
        );
      if (configBusy)
        return next(
          error(409, "Wait for the server settings to finish saving."),
        );
      if (backupBusy)
        return next(
          error(
            409,
            "A backup is in progress. Wait before changing files, server power, or console commands.",
          ),
        );
      const recycling =
        (req.method === "DELETE" && req.path === "/api/files") ||
        (req.method === "DELETE" &&
          /^\/api\/files\/recycle-bin\/[^/]+$/.test(req.path)) ||
        (req.method === "POST" &&
          /^\/api\/files\/recycle-bin\/[^/]+\/restore$/.test(req.path));
      if (recycleBusy || (recycling && activeMutations))
        return next(
          error(
            409,
            "Wait for the current file or Recycle Bin operation to finish.",
          ),
        );
      if (recycling) recycleBusy = true;
      activeMutations++;
      let completed = false;
      const done = () => {
        if (!completed) {
          completed = true;
          activeMutations--;
          if (recycling) recycleBusy = false;
        }
      };
      req.panelMutationDone = done;
      const abandoned = () => {
        if (!req.panelMutationStarted) done();
      };
      res.once("finish", abandoned);
      res.once("close", abandoned);
    }
    next();
  });

  let diskCache = { value: 0, at: 0 };
  app.get("/api/server", async (_req, res) => {
    await refreshStartupMetadata();
    if (Date.now() - diskCache.at > 10000)
      diskCache = { value: await directorySize(serverDir), at: Date.now() };
    const active = status === "running";
    const storage = await fs.statfs(serverDir);
    const sampledChild = processHandle;
    const [sample, connection, icon] = await Promise.all([
      mode === "live" && sampledChild && Number.isInteger(sampledChild.pid)
        ? telemetry.sample(sampledChild.pid)
        : null,
      advertisedConnection(configuration, publicAddress),
      readServerIcon(serverDir, safePath),
    ]);
    const currentSample =
      sampledChild &&
      processHandle === sampledChild &&
      sampledChild.exitCode == null
        ? sample
        : null;
    const liveIdle = mode === "live" && !processHandle && status === "offline";
    res.json({
      id: options.id,
      name: configuration.name,
      address: configuration.address,
      ...connection,
      iconVersion:
        state.iconPreference === "default" ? null : (icon?.version ?? null),
      serverIconVersion: icon?.version ?? null,
      iconPreference: state.iconPreference,
      status,
      mode,
      version: startupMetadata.version,
      software: startupMetadata.software,
      uptime: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
      cpuCapacity: availableParallelism() * 100,
      cpu:
        mode === "demo" && active
          ? Number((7.2 + Math.sin(Date.now() / 7000) * 2.6).toFixed(1))
          : mode === "demo" || liveIdle
            ? 0
            : (currentSample?.cpu ?? null),
      memory:
        mode === "demo" && active
          ? Math.round(1840 + Math.sin(Date.now() / 12000) * 60) * 1024 ** 2
          : mode === "demo" || liveIdle
            ? 0
            : (currentSample?.memory ?? null),
      memoryLimit:
        startupMetadata.memoryLimitMB == null
          ? null
          : startupMetadata.memoryLimitMB * 1024 ** 2,
      memoryLimitSource: startupMetadata.memoryLimitSource,
      memoryLimitState: processHandle ? "started" : "configured",
      disk: diskCache.value,
      diskLimit: storage.blocks * storage.bsize,
      diskAvailable: storage.bavail * storage.bsize,
      players: [...onlinePlayers.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      maxPlayers: configuration.maxPlayers,
      metricsAvailable:
        mode === "demo" || liveIdle || currentSample?.available === true,
      metricsMessage: liveIdle
        ? "Server offline"
        : (currentSample?.error ??
          (currentSample?.cpu === null
            ? "Measuring CPU usage…"
            : currentSample?.available
              ? "Server process telemetry"
              : "Waiting for server process…")),
      processCount: currentSample?.processCount ?? 0,
      playersAvailable: true,
    });
  });
  app.get("/api/server/icon", async (_req, res) => {
    const icon = await readServerIcon(serverDir, safePath);
    if (!icon) throw error(404, "No custom server icon.");
    res.set("Cache-Control", "no-cache").type("png").send(icon.bytes);
  });
  app.post(
    "/api/server/icon",
    trackOperation(async (req, res) => {
      await writeServerIcon(serverDir, decodeIcon(req.body?.image), safePath);
      state.iconPreference = "server";
      await audit(
        "file",
        "Server icon updated",
        "server-icon.png · game clients see the new icon after a server restart.",
      );
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/server/icon",
    trackOperation(async (_req, res) => {
      state.iconPreference = "default";
      await audit(
        "server",
        "Default panel icon selected",
        "Panel display preference saved. server-icon.png is unchanged.",
      );
      res.json({ ok: true, iconPreference: state.iconPreference });
    }),
  );
  app.put(
    "/api/server/icon",
    trackOperation(async (req, res) => {
      if (req.body?.preference !== "server")
        throw error(400, "Choose the server icon display preference.");
      state.iconPreference = "server";
      await audit(
        "server",
        "Server icon display selected",
        "Panel display preference saved. server-icon.png is unchanged.",
      );
      res.json({ ok: true, iconPreference: state.iconPreference });
    }),
  );
  app.get("/api/console", (_req, res) => res.json({ lines }));
  const loadPlayerHistory = async () => {
    const [cache, savedBans, operators, savedWhitelist, settings] =
      await Promise.all([
        readPlayerRecords(serverDir, "usercache.json", safePath),
        readPlayerRecords(serverDir, "banned-players.json", safePath),
        loadOperators(),
        readPlayerRecords(serverDir, "whitelist.json", safePath),
        readWhitelistSettings(serverDir, safePath),
      ]);
    playerHistory.seed(cache.records, "cache");
    playerHistory.seed(savedBans.records, "banned");
    playerHistory.seed(operators, "operator");
    const whitelist =
      mode === "demo" ? (state.demoWhitelist ?? []) : savedWhitelist.records;
    playerHistory.seed(whitelist, "whitelist");
    const whitelistAvailable = mode === "demo" || savedWhitelist.available;
    let bans = savedBans.records;
    if (mode === "demo") {
      for (const change of state.demoPlayerBans ?? []) {
        bans = bans.filter((entry) =>
          change.uuid && entry.uuid
            ? change.uuid !== entry.uuid
            : change.name.toLowerCase() !== entry.name.toLowerCase(),
        );
        if (change.banned) bans.push(change);
      }
    }
    const history = playerHistory.snapshot(
      onlinePlayers,
      bans,
      savedBans.available,
      { operators, whitelist, whitelistAvailable },
    );
    // The live roster is one entry per observed connection name. Historical
    // UUIDs may share a reused username, so filtering history can double-count it.
    const online = [...onlinePlayers.values()].map((active) => {
      const matches = history.filter(
        (player) => player.name.toLowerCase() === active.name.toLowerCase(),
      );
      const known = active.uuid
        ? matches.find((player) => player.uuid === active.uuid)
        : matches.length === 1
          ? matches[0]
          : undefined;
      return {
        firstSeen: null,
        lastSeen: null,
        source: "observed",
        banned: null,
        ...known,
        ...active,
        online: true,
      };
    });
    return {
      operators,
      history,
      online,
      banned: history.filter((player) => player.banned),
      whitelist: whitelist.map((player) => ({
        ...player,
        online: [...onlinePlayers.values()].some((active) =>
          samePlayer(active, player),
        ),
      })),
      whitelistAvailable,
      whitelistEnabled:
        mode === "demo" && typeof state.demoWhitelistEnabled === "boolean"
          ? state.demoWhitelistEnabled
          : settings.enabled,
      whitelistSettingsAvailable:
        (mode === "demo" && typeof state.demoWhitelistEnabled === "boolean") ||
        settings.available,
      bansAvailable: savedBans.available,
      warnings: [
        cache.warning,
        savedBans.warning,
        mode === "live" ? savedWhitelist.warning : null,
        settings.warning,
      ].filter(Boolean),
    };
  };
  const loadOperators = async () => {
    let operators = state.demoOperators;
    if (mode === "live") {
      const target = await safePath(serverDir, "ops.json");
      try {
        const stat = await fs.stat(target);
        if (!stat.isFile() || stat.size > 1024 * 1024)
          throw error(409, "ops.json must be a JSON file under 1 MB.");
        try {
          operators = JSON.parse(await fs.readFile(target, "utf8"));
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;
          throw error(
            409,
            "ops.json contains invalid JSON. Check the file or refresh after the server finishes writing it.",
          );
        }
        if (
          !Array.isArray(operators) ||
          operators.some(
            (entry) =>
              !entry ||
              typeof entry !== "object" ||
              typeof entry.name !== "string" ||
              !/^[A-Za-z0-9_]{3,16}$/.test(entry.name) ||
              typeof entry.uuid !== "string" ||
              !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
                entry.uuid,
              ) ||
              !Number.isInteger(entry.level) ||
              entry.level < 1 ||
              entry.level > 4,
          )
        )
          throw error(
            409,
            "ops.json contains an invalid operator record. Check the server file before relying on this list.",
          );
        operators = operators.map(({ name, uuid, level }) => ({
          name,
          uuid,
          level,
        }));
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
        operators = [];
      }
    }
    return operators;
  };
  app.get("/api/players", async (_req, res) => {
    res.json({
      mode,
      status,
      maxPlayers: configuration.maxPlayers,
      ...(await loadPlayerHistory()),
    });
  });
  const validateKnownIdentity = (snapshot, name, uuid, authoritative) => {
    if (uuid === undefined) return;
    if (!validPlayerUuid(uuid))
      throw error(400, "The player UUID is invalid. Refresh the player list.");
    const records = authoritative ?? snapshot.history;
    const matches = records.filter(
      (player) => player.name.toLowerCase() === name.toLowerCase(),
    );
    const known = snapshot.history.filter(
      (player) => player.name.toLowerCase() === name.toLowerCase(),
    );
    if (
      !matches.some(
        (player) => player.uuid?.toLowerCase() === uuid.toLowerCase(),
      ) ||
      new Set(
        [...matches, ...known]
          .filter((player) => player.uuid)
          .map((player) => player.uuid.toLowerCase()),
      ).size > 1
    )
      throw error(
        409,
        "This player's identity changed or is unavailable. Refresh the player list before trying again.",
      );
  };
  for (const action of ["add", "remove", "state"]) {
    app.post(
      `/api/players/whitelist/${action}`,
      trackOperation(async (req, res) => {
        const command = whitelistCommand(action, req.body);
        if (status !== "running")
          throw error(409, "Start this server before changing its whitelist.");
        const snapshot = await loadPlayerHistory();
        if (action === "state") {
          if (!snapshot.whitelistSettingsAvailable)
            throw error(
              409,
              "The whitelist setting is unavailable. Check white-list in server.properties and refresh.",
            );
          if (req.body.enabled && !snapshot.whitelistAvailable)
            throw error(
              409,
              "The saved whitelist is unavailable. Fix whitelist.json before enabling it.",
            );
        } else {
          if (!snapshot.whitelistAvailable)
            throw error(
              409,
              "The saved whitelist is unavailable. Fix whitelist.json and refresh before changing it.",
            );
          const current = snapshot.whitelist.filter(
            (player) =>
              player.name.toLowerCase() === req.body.name.toLowerCase(),
          );
          if (
            action === "remove" &&
            (!current.length ||
              new Set(current.map((player) => player.uuid)).size > 1)
          )
            throw error(
              409,
              "This player is not uniquely identified in the saved whitelist. Refresh the player list.",
            );
          validateKnownIdentity(
            snapshot,
            req.body.name,
            req.body.uuid,
            action === "remove" ? snapshot.whitelist : undefined,
          );
        }
        if (mode === "live") {
          if (!processHandle?.stdin.writable)
            throw error(409, "The server is not ready to receive commands.");
          await writeServer(processHandle, command);
        } else if (action === "state")
          state.demoWhitelistEnabled = req.body.enabled;
        else {
          state.demoWhitelist = (state.demoWhitelist ?? []).filter(
            (player) =>
              player.name.toLowerCase() !== req.body.name.toLowerCase(),
          );
          if (action === "add") {
            const known = snapshot.history.filter(
              (player) =>
                player.name.toLowerCase() === req.body.name.toLowerCase(),
            );
            const uuid =
              req.body.uuid?.toLowerCase() ??
              (known.length === 1 ? known[0].uuid : undefined);
            state.demoWhitelist.push({
              name: req.body.name,
              ...(uuid ? { uuid } : {}),
            });
          }
        }
        append(
          `[${mode === "demo" ? "Demo" : "Panel"}] ${mode === "demo" ? "Simulated" : "Requested"}: ${command}`,
        );
        const event = playerCommandAudit(command, {
          simulated: mode === "demo",
        });
        await audit("player", event.action, event.detail);
        res.json({
          simulated: mode === "demo",
          message:
            mode === "demo"
              ? `Demo: ${command} was simulated. No live whitelist or server properties were changed.`
              : `Requested ${command}. Check Console for Minecraft's confirmation; the whitelist and setting update after the server writes its files.`,
        });
      }),
    );
  }
  for (const action of ["kick", "ban", "unban"]) {
    app.post(
      `/api/players/${action}`,
      trackOperation(async (req, res) => {
        const command = moderationCommand(action, req.body);
        const name = req.body.name;
        if (status !== "running")
          throw error(409, "Start this server before managing players.");
        const snapshot = await loadPlayerHistory();
        const matches = snapshot.history.filter(
          (entry) => entry.name.toLowerCase() === name.toLowerCase(),
        );
        const player = matches.find(
          (entry) =>
            !req.body.uuid || entry.uuid === req.body.uuid.toLowerCase(),
        );
        if (
          !player ||
          (matches.length > 1 &&
            new Set(matches.map((entry) => entry.uuid)).size > 1)
        )
          throw error(
            409,
            "This player's identity changed or is unavailable. Refresh the player list before trying again.",
          );
        if (action === "kick" && !player.online)
          throw error(
            409,
            "This player is no longer online. Refresh the player list.",
          );
        if (action !== "kick" && !snapshot.bansAvailable)
          throw error(
            409,
            "The saved ban list is unavailable. Fix banned-players.json and refresh before managing bans.",
          );
        if (action === "unban" && !player.banned)
          throw error(
            409,
            "This player is not in the saved ban list. Refresh the player list.",
          );
        if (mode === "live") {
          if (!processHandle?.stdin.writable)
            throw error(409, "The server is not ready to receive commands.");
          await writeServer(processHandle, command);
        } else if (action === "kick") {
          onlinePlayers.delete(name.toLowerCase());
          playerHistory.observe(player);
        } else {
          state.demoPlayerBans = (state.demoPlayerBans ?? []).filter(
            (entry) => entry.name.toLowerCase() !== name.toLowerCase(),
          );
          state.demoPlayerBans.push({
            name,
            ...(player.uuid ? { uuid: player.uuid } : {}),
            banned: action === "ban",
            reason: req.body.reason?.trim() ?? "",
          });
          if (action === "ban") onlinePlayers.delete(name.toLowerCase());
        }
        append(
          `[${mode === "demo" ? "Demo" : "Panel"}] ${mode === "demo" ? "Simulated" : "Requested"}: ${command}`,
        );
        const event = playerCommandAudit(command, {
          simulated: mode === "demo",
        });
        await audit("player", event.action, event.detail);
        res.json({
          simulated: mode === "demo",
          message:
            mode === "demo"
              ? `Demo: ${action} for ${name} was simulated. No live player or Minecraft ban file was changed.`
              : `Requested ${command}. Check Console for Minecraft's confirmation; the saved player list updates after the server writes it.`,
        });
      }),
    );
  }
  for (const action of ["op", "deop"]) {
    app.post(
      `/api/players/${action}`,
      trackOperation(async (req, res) => {
        const name = validatePlayerName(req.body?.name);
        if (req.body.uuid !== undefined) {
          if (!validPlayerUuid(req.body.uuid))
            throw error(
              400,
              "The player UUID is invalid. Refresh the player list.",
            );
          const snapshot = await loadPlayerHistory();
          validateKnownIdentity(
            snapshot,
            name,
            req.body.uuid,
            action === "deop" ? snapshot.operators : undefined,
          );
        }
        if (status !== "running")
          throw error(
            409,
            "Start this server before changing in-game operators.",
          );
        const command = `${action} ${name}`;
        if (mode === "live") {
          if (!processHandle?.stdin.writable)
            throw error(409, "The server is not ready to receive commands.");
          await writeServer(processHandle, command);
        } else {
          state.demoOperators = state.demoOperators.filter(
            (entry) => entry.name.toLowerCase() !== name.toLowerCase(),
          );
          if (action === "op")
            state.demoOperators.push({
              name,
              level: 4,
              ...(req.body.uuid ? { uuid: req.body.uuid.toLowerCase() } : {}),
            });
        }
        append(
          `[${mode === "demo" ? "Demo" : "Panel"}] ${mode === "demo" ? "Simulated" : "Requested"}: ${command}`,
        );
        const event = playerCommandAudit(command, {
          simulated: mode === "demo",
        });
        await audit("player", event.action, event.detail);
        res.json({
          simulated: mode === "demo",
          message:
            mode === "demo"
              ? `Demo: ${name} ${action === "op" ? "was added as an operator" : "had operator access removed"}. No in-game permissions were changed.`
              : `Requested ${command}. Check the console for Minecraft's confirmation; ops.json may update after the command completes.`,
        });
      }),
    );
  }
  app.post(
    "/api/server/power",
    trackOperation(async (req, res) => {
      await power(req.body?.action);
      res.json({ status });
    }),
  );
  app.post(
    "/api/console/command",
    trackOperation(async (req, res) => {
      const command = req.body?.command;
      if (
        typeof command !== "string" ||
        !command.trim() ||
        command.length > 2048 ||
        /[\r\n\0]/.test(command)
      )
        throw error(400, "Enter one console command, up to 2048 characters.");
      if (status !== "running")
        throw error(409, "Start the server before sending a command.");
      const normalized = command.trim().replace(/^\//, "");
      append(`> ${normalized}`);
      if (normalized === "stop") await power("stop");
      else if (mode === "live") await writeServer(processHandle, normalized);
      else if (normalized === "help")
        append(
          "[Demo] Available examples: help, list, say <message>, save-all, time query daytime, stop.",
        );
      else if (normalized === "list")
        append("[Demo] There are 0 of a max of 20 players online.");
      else if (normalized.startsWith("say "))
        append(`[Demo] [Server] ${normalized.slice(4)}`);
      else if (normalized === "save-all")
        append("[Demo] Saved the game (simulated).", "success");
      else if (normalized === "time query daytime")
        append("[Demo] The time is 6000.");
      else
        append(
          `[Demo] Received “${normalized}”. Connect a live server to execute Minecraft commands.`,
          "warn",
        );
      const playerEvent = playerCommandAudit(normalized);
      if (playerEvent)
        await audit(
          "player",
          playerEvent.action,
          mode === "demo"
            ? `Demo console command: ${normalized}. No live player state was changed.`
            : playerEvent.detail,
        );
      else if (normalized !== "stop")
        await audit("server", "Console command", normalized);
      res.json({ ok: true });
    }),
  );

  app.get("/api/files/recycle-bin", async (_req, res) => {
    res.json({ items: await recycleBin.list(), protected: true });
  });
  app.delete(
    "/api/files/recycle-bin/:id",
    trackOperation(async (req, res) => {
      await recycleBin.deletePermanently(req.params.id);
      await audit(
        "file",
        "Recycle Bin item permanently deleted",
        req.params.id,
      );
      res.json({ ok: true, id: req.params.id });
    }),
  );
  app.post(
    "/api/files/recycle-bin/:id/restore",
    trackOperation(async (req, res) => {
      const restoredPath = await recycleBin.restore(req.params.id);
      await audit("file", "File restored from Recycle Bin", restoredPath);
      diskCache.at = 0;
      res.json({ ok: true, path: restoredPath });
    }),
  );
  app.get("/api/files", async (req, res) => {
    const relative = req.query.path ?? "";
    const target = await safePath(serverDir, relative);
    const entries = [];
    for (const item of await fs.readdir(target, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const stat = await fs.stat(path.join(target, item.name));
      entries.push({
        name: item.name,
        path: [relative, item.name].filter(Boolean).join("/"),
        type: item.isDirectory() ? "directory" : "file",
        size: item.isDirectory() ? 0 : stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
    entries.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "directory"
          ? -1
          : 1,
    );
    res.json({ path: relative, entries });
  });
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 256 * 1024 * 1024, files: 20, fields: 5 },
  });
  const isModFile = (relative) =>
    /^mods\/[^/]+\.jar(?:\.disabled)?$/i.test(
      String(relative).replace(/\\/g, "/"),
    );
  app.post(
    "/api/files/upload",
    upload.array("files", 20),
    trackOperation(async (req, res) => {
      const files = req.files ?? [];
      try {
        const directory = req.query.path ?? "";
        const parent = await safePath(serverDir, directory);
        if (!(await fs.stat(parent)).isDirectory())
          throw error(400, "Choose a directory to upload into.");
        if (!files.length) throw error(400, "Choose at least one file.");
        const destinations = [];
        for (const file of files) {
          const name = validateName(file.originalname);
          const target = await safePath(
            serverDir,
            [directory, name].filter(Boolean).join("/"),
          );
          if (destinations.includes(target) || (await exists(target)))
            throw error(
              409,
              `A file named “${name}” already exists. Rename it before uploading.`,
            );
          destinations.push(target);
        }
        for (let i = 0; i < files.length; i++)
          await fs.copyFile(files[i].path, destinations[i], 1);
        const uploadedPaths = files.map((file) =>
          [directory, file.originalname].filter(Boolean).join("/"),
        );
        const modPaths = uploadedPaths.filter(isModFile);
        const otherPaths = uploadedPaths.filter(
          (relative) => !isModFile(relative),
        );
        if (modPaths.length)
          await audit(
            "file",
            modPaths.length === 1 ? "Mod added" : "Mods added",
            modPaths.join(", "),
          );
        if (otherPaths.length)
          await audit("file", "Files uploaded", otherPaths.join(", "));
        diskCache.at = 0;
        res.status(201).json({ uploaded: files.length });
      } finally {
        for (const file of files) await fs.rm(file.path, { force: true });
      }
    }),
  );
  app.get("/api/files/download", async (req, res) => {
    const target = await safePath(serverDir, req.query.path);
    if (!(await fs.stat(target)).isFile())
      throw error(400, "Choose a file to download.");
    res.download(target);
  });
  app.post(
    "/api/files",
    trackOperation(async (req, res) => {
      const { path: directory = "", name, type, content = "" } = req.body ?? {};
      validateName(name);
      if (!["file", "directory"].includes(type) || typeof content !== "string")
        throw error(400, "Choose a file or directory and valid text content.");
      const target = await safePath(
        serverDir,
        [directory, name].filter(Boolean).join("/"),
      );
      if (await exists(target))
        throw error(409, "A file or directory with this name already exists.");
      if (type === "directory") await fs.mkdir(target);
      else await fs.writeFile(target, content, { flag: "wx" });
      await audit(
        "file",
        type === "file" &&
          isModFile([directory, name].filter(Boolean).join("/"))
          ? "Mod added"
          : `${type === "file" ? "File" : "Directory"} created`,
        [directory, name].filter(Boolean).join("/"),
      );
      diskCache.at = 0;
      res.status(201).json({ ok: true });
    }),
  );
  const editable = async (relative) => {
    const target = await safePath(serverDir, relative);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw error(
        400,
        "The editor supports text files up to 1 MB. Download larger files instead.",
      );
    const buffer = await fs.readFile(target);
    if (buffer.includes(0))
      throw error(
        400,
        "This appears to be a binary file. Download it instead.",
      );
    return { target, content: buffer.toString("utf8") };
  };
  app.get("/api/files/content", async (req, res) => {
    const { content } = await editable(req.query.path);
    res.json({ content });
  });
  app.put(
    "/api/files/content",
    trackOperation(async (req, res) => {
      if (
        typeof req.body?.content !== "string" ||
        Buffer.byteLength(req.body.content) > 1024 * 1024
      )
        throw error(400, "The editor supports text files up to 1 MB.");
      const { target } = await editable(req.body.path);
      await fs.writeFile(target, req.body.content);
      await audit("file", "File edited", req.body.path);
      diskCache.at = 0;
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/files",
    trackOperation(async (req, res) => {
      const relative = req.query.path;
      if (!relative) throw error(400, "The server root cannot be deleted.");
      const target = await safePath(serverDir, relative);
      if (!(await exists(target)))
        throw error(404, "File or directory not found.");
      const recycled = await recycleBin.recycle(relative);
      await audit(
        "file",
        isModFile(relative)
          ? "Mod deleted"
          : /^mods[\\/]?$/i.test(relative)
            ? "Mods deleted"
            : "File deleted",
        `${relative} · moved to Recycle Bin.`,
      );
      diskCache.at = 0;
      res.json({ ok: true, recycled });
    }),
  );

  app.get("/api/backups", (_req, res) =>
    res.json({
      backups: state.backups,
      schedule: state.schedule,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  );
  app.post(
    "/api/backups",
    trackOperation(async (req, res) => {
      try {
        res.status(201).json(await createBackup(req.body?.name));
      } catch (cause) {
        await audit("backup", "Backup failed", cause.message);
        throw cause;
      }
    }),
  );
  app.put(
    "/api/backups/schedule",
    trackOperation(async (req, res) => {
      const schedule = validateSchedule(req.body);
      state.schedule = { ...schedule, nextRun: nextRunFor(schedule), timezone };
      await audit(
        "backup",
        "Backup schedule updated",
        schedule.enabled
          ? `${schedule.type} schedule enabled; retain ${schedule.retention} scheduled backups. Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`
          : "Automatic backups disabled.",
      );
      res.json({ schedule: state.schedule });
    }),
  );
  const getItem = (collection, id) => {
    const item = collection.find((entry) => entry.id === id);
    if (!item) throw error(404, "Record not found.");
    return item;
  };
  app.get("/api/backups/:id/download", (req, res) => {
    const item = getItem(state.backups, req.params.id);
    res.download(
      path.join(backupDir, `${item.id}.tar.gz`),
      `${item.name}.tar.gz`,
    );
  });
  app.delete(
    "/api/backups/:id",
    trackOperation(async (req, res) => {
      if (backupBusy)
        throw error(409, "Wait for the current backup to finish.");
      const item = getItem(state.backups, req.params.id);
      await fs.rm(path.join(backupDir, `${item.id}.tar.gz`), { force: true });
      state.backups = state.backups.filter((entry) => entry.id !== item.id);
      await audit("backup", "Backup deleted", item.name);
      res.json({ ok: true });
    }),
  );
  app.get("/api/subusers", (_req, res) =>
    res.json({ users: state.users.map(userWithPermissions) }),
  );
  app.post(
    "/api/subusers",
    trackOperation(async (req, res) => {
      const { email, role = "custom", permissions } = req.body ?? {};
      if (
        typeof email !== "string" ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !roles.has(role)
      )
        throw error(400, "Enter a valid email address and role.");
      if (state.users.some((item) => item.email === email.toLowerCase()))
        throw error(409, "This email already has a local access record.");
      const item = {
        id: randomUUID(),
        email: email.toLowerCase(),
        role,
        permissions:
          permissions === undefined
            ? [...(permissionsCatalog.roleDefaults[role] ?? [])]
            : validatePermissions(permissions),
        createdAt: new Date().toISOString(),
      };
      state.users.push(item);
      await audit(
        "user",
        "Local access record added",
        `${item.email} · ${role}. No invitation was sent; authentication is not configured.`,
      );
      res.status(201).json(item);
    }),
  );
  app.patch(
    "/api/subusers/:id",
    trackOperation(async (req, res) => {
      const item = getItem(state.users, req.params.id);
      const permissions = validatePermissions(req.body?.permissions);
      item.permissions = permissions;
      item.role = "custom";
      await audit(
        "user",
        "Local access permissions updated",
        `${item.email} · ${permissions.length} intended permissions. Authentication is not configured.`,
      );
      res.json(userWithPermissions(item));
    }),
  );
  app.delete(
    "/api/subusers/:id",
    trackOperation(async (req, res) => {
      const item = getItem(state.users, req.params.id);
      state.users = state.users.filter((entry) => entry.id !== item.id);
      await audit("user", "Local access record removed", item.email);
      res.json({ ok: true });
    }),
  );
  app.get("/api/databases", async (_req, res) => {
    const databases = await Promise.all(
      state.databases.map(async (item) => ({
        ...item,
        size: (await fs.stat(path.join(databaseDir, `${item.id}.sqlite`))).size,
      })),
    );
    res.json({ databases });
  });
  app.post(
    "/api/databases",
    trackOperation(async (req, res) => {
      const name = validateName(req.body?.name);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(name))
        throw error(
          400,
          "Database names must start with a letter and use up to 48 letters, numbers, underscores, or dashes.",
        );
      if (
        state.databases.some(
          (item) => item.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw error(409, "A database with this name already exists.");
      const item = {
        id: randomUUID(),
        name,
        type: "SQLite",
        size: 0,
        createdAt: new Date().toISOString(),
      };
      const target = path.join(databaseDir, `${item.id}.sqlite`);
      const db = new DatabaseSync(target);
      try {
        db.exec(
          "CREATE TABLE panel_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        );
        db.prepare("INSERT INTO panel_metadata (key, value) VALUES (?, ?)").run(
          "createdAt",
          item.createdAt,
        );
      } finally {
        db.close();
      }
      item.size = (await fs.stat(target)).size;
      state.databases.push(item);
      await audit("database", "SQLite database created", name);
      res.status(201).json(item);
    }),
  );
  app.get("/api/databases/:id/download", (req, res) => {
    const item = getItem(state.databases, req.params.id);
    res.download(
      path.join(databaseDir, `${item.id}.sqlite`),
      `${item.name}.sqlite`,
    );
  });
  app.delete(
    "/api/databases/:id",
    trackOperation(async (req, res) => {
      const item = getItem(state.databases, req.params.id);
      await fs.rm(path.join(databaseDir, `${item.id}.sqlite`), { force: true });
      state.databases = state.databases.filter((entry) => entry.id !== item.id);
      await audit("database", "SQLite database deleted", item.name);
      res.json({ ok: true });
    }),
  );
  app.get("/api/audit", (_req, res) => {
    const legacyContentActions = {
      "Launchpad installation completed": "Content installed",
      "Content installed": "Content installed",
      "Launchpad mod removed": "Mod deleted",
      "Mod removed": "Mod deleted",
    };
    res.json({
      entries: state.audit
        .filter((entry) => entry.category !== "database")
        .map((entry) =>
          Object.hasOwn(legacyContentActions, entry.action)
            ? {
                ...entry,
                category: "file",
                action: legacyContentActions[entry.action],
              }
            : entry,
        ),
    });
  });
  minecraft.mount(app);
  app.use("/api", (_req, _res, next) =>
    next(error(404, "API endpoint not found.")),
  );
  const distDir = path.join(projectDir, "dist");
  app.use(express.static(distDir));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(distDir, "index.html")),
  );
  app.use((cause, _req, res, _next) => {
    if (res.headersSent) return;
    const status =
      cause.status ??
      (cause.code === "ENOENT"
        ? 404
        : cause.code === "EEXIST"
          ? 409
          : cause instanceof multer.MulterError
            ? 400
            : 500);
    res.status(status).json({
      error:
        status >= 500 && status !== 503
          ? "The operation failed. Check the API terminal for details."
          : cause.message,
    });
    if (status >= 500 && status !== 503) console.error(cause);
  });

  return {
    app,
    dataDir,
    serverDir,
    tick,
    descriptor,
    refreshStartupMetadata,
    assertRemovable: () => {
      if (closed) throw error(409, "This server is already shutting down.");
      if (status !== "offline" || processHandle || terminationPromise)
        throw error(409, "Stop this server before removing it from the panel.");
      if (configBusy || backupBusy || activeMutations || inFlightTasks.size)
        throw error(
          409,
          "Wait for this server's current operation to finish before removing it.",
        );
    },
    updateConfiguration: (...args) => {
      if (closed)
        return Promise.reject(error(503, "The panel is shutting down."));
      return trackTask(() => updateConfiguration(...args));
    },
    audit,
    close: ({ gracefulOnly = false } = {}) => {
      if (!closePromise) {
        closed = true;
        clearPlayers();
        clearInterval(scheduler);
        if (!options.telemetry) telemetry.close();
        clearTimeout(demoTimer);
        clearTimeout(stopTimer);
        closePromise = (async () => {
          await minecraft.close();
          // An HTTP client can leave before its disk writes or backup finish.
          // Wait for the handler itself, including save-on and its audit write.
          while (inFlightTasks.size)
            await Promise.allSettled([...inFlightTasks]);
          clearTimeout(demoTimer);
          clearTimeout(stopTimer);
          if (terminationPromise) await terminationPromise;
          if (processHandle) {
            const child = processHandle;
            const stop = processStop;
            const exited = new Promise((resolve) =>
              child.once("close", resolve),
            );
            stop.requestStop();
            let timeout;
            try {
              if (gracefulOnly || stop.shutdownStarted) await exited;
              else
                await Promise.race([
                  exited,
                  new Promise((resolve) => {
                    timeout = setTimeout(() => {
                      if (!stop.shutdownStarted) resolve();
                    }, options.stopTimeoutMs ?? 15000);
                  }),
                ]);
              if (processHandle === child) {
                if (stop.shutdownStarted) await exited;
                else {
                  await terminateProcessTree(child, {
                    tree: ["script", "executable"].includes(
                      configuration.launchType,
                    ),
                    spawnProcess: options.spawnProcess,
                  });
                  let killTimeout;
                  try {
                    await Promise.race([
                      exited,
                      new Promise((_resolve, reject) => {
                        killTimeout = setTimeout(
                          () =>
                            reject(
                              new Error(
                                "The server process did not exit after termination. Close it before restarting the panel.",
                              ),
                            ),
                          5000,
                        );
                      }),
                    ]);
                  } finally {
                    clearTimeout(killTimeout);
                  }
                }
              }
            } finally {
              clearTimeout(timeout);
            }
          }
          await playerHistory.flush();
          await saveChain;
        })();
      }
      return closePromise;
    },
  };
}

// Registry changes are serialized, but each server has its own process, state and scheduler.
export async function createFleet(options = {}) {
  const telemetry = options.telemetry ?? createProcessTelemetry();
  const publicAddress = options.publicAddress ?? createPublicAddressResolver();
  const env = options.useEnvironment === false ? {} : process.env;
  const requestedDataDir = path.resolve(
    options.dataDir ?? env.PANEL_DATA_DIR ?? path.join(projectDir, "data"),
  );
  await fs.mkdir(requestedDataDir, { recursive: true });
  const dataDir = await fs.realpath(requestedDataDir);
  const registryPath = await safePath(dataDir, "servers.json");
  const legacyServerDir = path.resolve(
    options.serverDir ?? env.MC_SERVER_DIR ?? path.join(dataDir, "server"),
  );
  const hasLegacyWorkspace = async () => {
    if (await exists(await safePath(dataDir, "panel.json"))) return true;
    if (await exists(await safePath(dataDir, ".seeded"))) return true;
    try {
      return (await fs.readdir(legacyServerDir)).length > 0;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
      return false;
    }
  };
  const runtimes = new Map();
  let registry;
  let changeChain = Promise.resolve();
  let closed = false;
  const serialize = (work) => {
    if (closed)
      return Promise.reject(error(503, "The panel is shutting down."));
    const pending = changeChain.catch(() => {}).then(work);
    changeChain = pending;
    return pending;
  };
  const persist = async (next = registry) => {
    const temp = `${registryPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(next, null, 2));
    await fs.rename(temp, registryPath);
    registry = next;
  };
  const configKeys = [
    "connectionHost",
    "name",
    "mode",
    "port",
    "memoryLimitMB",
    "jar",
    "launchType",
    "launchScript",
    "launchArgs",
    "launchExecutable",
    "javaPath",
    "motd",
  ];
  const onlyConfig = (entry) =>
    Object.fromEntries(
      configKeys
        .filter((key) => entry[key] !== undefined)
        .map((key) => [key, entry[key]])
        .concat(
          entry.connectionHost === undefined
            ? [["connectionHost", legacyConnectionHost(entry.address)]]
            : [],
        ),
    );
  const descriptor = (entry) => runtimes.get(entry.id).descriptor();
  const checkPort = (port, exceptId) => {
    if (
      registry.servers.some(
        (entry) => entry.id !== exceptId && entry.port === port,
      )
    )
      throw error(
        409,
        `Port ${port} is already assigned to another server. Choose a different port.`,
      );
  };
  const inspectImport = (directory, exceptId, requireCanonical = false) =>
    inspectServerDirectory(directory, {
      forbiddenDirectories: [
        dataDir,
        ...registry.servers
          .filter((entry) => entry.id !== exceptId)
          .map((entry) => entry.serverDir),
      ],
      requireCanonical,
    });
  const unavailableRuntime = (entry, cause) => {
    const sourceError = `Imported server unavailable: ${cause.message} Its existing folder has not been recreated or changed.`;
    const app = express();
    app.use((_req, res) => res.status(409).json({ error: sourceError }));
    return {
      app,
      dataDir: entry.dataDir,
      serverDir: entry.serverDir,
      unavailable: true,
      descriptor: () => ({
        ...onlyConfig(entry),
        id: entry.id,
        address: entry.address,
        version: entry.version,
        software: entry.software,
        status: "offline",
        source: "imported",
        serverDir: entry.serverDir,
        unavailable: true,
        sourceError,
      }),
      updateConfiguration: async () => {
        throw error(409, sourceError);
      },
      tick: async () => {},
      close: async () => {},
    };
  };
  const makeRuntime = async (entry, allowUnavailable = false) => {
    if (entry.storage === "external") {
      try {
        const inspected = await inspectImport(entry.serverDir, entry.id, true);
        if (entry.launchType !== "jar")
          await validateStartupFiles(entry.serverDir, entry);
        else if (!inspected.jars.includes(entry.jar))
          throw error(
            409,
            "The selected server JAR is missing or is no longer a regular file in the source folder.",
          );
      } catch (cause) {
        if (!allowUnavailable) throw cause;
        const runtime = unavailableRuntime(entry, cause);
        runtimes.set(entry.id, runtime);
        return runtime;
      }
    } else await fs.mkdir(entry.serverDir, { recursive: true });
    await fs.mkdir(entry.dataDir, { recursive: true });
    const actualServer = await fs.realpath(entry.serverDir);
    const contains = (root, target) => {
      const relative = path.relative(root, target);
      return (
        !relative ||
        (!path.isAbsolute(relative) &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`))
      );
    };
    for (const [id, runtime] of runtimes) {
      if (id === entry.id) continue;
      const existingServer = await fs
        .realpath(runtime.serverDir)
        .catch((cause) => {
          if (
            !runtime.unavailable &&
            !(
              runtime.descriptor().source === "imported" &&
              ["ENOENT", "ENOTDIR"].includes(cause.code)
            )
          )
            throw cause;
          return path.resolve(runtime.serverDir);
        });
      if (
        contains(existingServer, actualServer) ||
        contains(actualServer, existingServer)
      )
        throw error(
          400,
          "Each server must use a separate, non-overlapping server directory.",
        );
    }
    const runtime = await createPanel({
      ...entry,
      memoryLimit: entry.memoryLimitMB,
      useEnvironment: false,
      existingServerDir: entry.storage === "external",
      scheduler: options.scheduler,
      spawnServer: options.spawnServer,
      spawnProcess: options.spawnProcess,
      stopTimeoutMs: options.stopTimeoutMs,
      backupFlushTimeoutMs: options.backupFlushTimeoutMs,
      telemetry,
      publicAddress,
      startupMetadataTtlMs: options.startupMetadataTtlMs,
      versionsService: options.versionsService,
      versionsOptions: options.versionsOptions,
      catalogFetch: options.catalogFetch,
      extraProviders: options.extraProviders,
      persistMinecraftConfiguration: (next) =>
        serialize(async () => {
          checkPort(next.port, entry.id);
          const { status: _status, ...saved } = next;
          await persist({
            ...registry,
            servers: registry.servers.map((item) =>
              item.id === entry.id
                ? { ...item, ...saved, address: `localhost:${saved.port}` }
                : item,
            ),
          });
        }),
    });
    runtimes.set(entry.id, runtime);
    return runtime;
  };
  if (await exists(registryPath)) {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    if (
      registry.version !== 1 ||
      !Array.isArray(registry.servers) ||
      (registry.servers.length === 0
        ? registry.defaultServerId !== null
        : !registry.servers.some(
            (entry) => entry.id === registry.defaultServerId,
          ))
    )
      throw new Error(
        "The server registry is invalid; restore data/servers.json from a known good copy.",
      );
    const ids = new Set();
    const ports = new Set();
    for (const entry of registry.servers) {
      if (
        typeof entry.id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(entry.id) ||
        ids.has(entry.id)
      )
        throw new Error(
          "The server registry contains invalid or duplicate IDs.",
        );
      ids.add(entry.id);
      Object.assign(
        entry,
        validateServerConfiguration(
          {},
          onlyConfig(entry),
          entry.storage === "external",
        ),
      );
      if (ports.has(entry.port))
        throw new Error(
          "The server registry contains duplicate Minecraft ports.",
        );
      ports.add(entry.port);
      // The default selection is not a storage location. Original installations
      // keep their legacy root; explicitly created instances keep their own roots.
      entry.storage ??=
        entry.id === registry.defaultServerId ? "legacy" : "instance";
      if (!["legacy", "instance", "external"].includes(entry.storage))
        throw new Error(
          "The server registry contains an invalid storage location.",
        );
      if (entry.storage === "legacy") {
        entry.dataDir = dataDir;
        entry.serverDir = path.resolve(
          entry.serverDir ?? path.join(dataDir, "server"),
        );
      } else {
        entry.dataDir = await safePath(dataDir, `instances/${entry.id}`);
        await fs.mkdir(entry.dataDir, { recursive: true });
        if (entry.storage === "external") {
          if (
            typeof entry.serverDir !== "string" ||
            !path.isAbsolute(entry.serverDir)
          )
            throw new Error(
              "The imported server registry path must be absolute.",
            );
          entry.source = "imported";
        } else entry.serverDir = await safePath(entry.dataDir, "server");
      }
    }
  } else if (
    options.createDefaultServer === false &&
    !(await hasLegacyWorkspace())
  ) {
    registry = { version: 1, defaultServerId: null, servers: [] };
    await persist();
  } else {
    const serverDir = path.resolve(
      options.serverDir ?? env.MC_SERVER_DIR ?? path.join(dataDir, "server"),
    );
    let properties = "";
    if (await exists(serverDir)) {
      const propertyPath = await safePath(serverDir, "server.properties");
      try {
        properties = await fs.readFile(propertyPath, "utf8");
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
    }
    const property = (key) =>
      properties
        .match(new RegExp(`^\\s*${key}\\s*[=:](.*)$`, "m"))?.[1]
        ?.trim();
    const mode =
      options.mode ?? (options.jar || env.MC_SERVER_JAR ? "live" : "demo");
    const config = validateServerConfiguration({
      name: options.name ?? env.MC_SERVER_NAME ?? "The Overworld",
      mode,
      port: Number(
        options.port ??
          env.MC_PORT ??
          property("server-port") ??
          env.MC_SERVER_ADDRESS?.match(/:(\d+)$/)?.[1] ??
          25565,
      ),
      memoryLimitMB: Number(options.memoryLimit ?? env.MC_MEMORY_MB ?? 4096),
      jar: (options.jar ?? env.MC_SERVER_JAR) || "server.jar",
      javaPath: options.javaPath ?? env.JAVA_PATH ?? "java",
      motd: options.motd ?? property("motd") ?? "Welcome to the Overworld",
    });
    const id = randomUUID();
    registry = {
      version: 1,
      defaultServerId: id,
      servers: [
        {
          ...config,
          id,
          storage: "legacy",
          dataDir,
          serverDir,
          address:
            options.address ??
            env.MC_SERVER_ADDRESS ??
            `localhost:${config.port}`,
          maxPlayers: Number(
            options.maxPlayers ??
              env.MC_MAX_PLAYERS ??
              property("max-players") ??
              20,
          ),
          version:
            options.version ??
            env.MC_VERSION ??
            (mode === "demo" ? "1.21.4" : "Configured JAR"),
          software:
            options.software ??
            env.MC_SOFTWARE ??
            (mode === "demo" ? "Paper" : "Java"),
        },
      ],
    };
    await persist();
  }
  try {
    for (const entry of registry.servers) await makeRuntime(entry, true);
  } catch (cause) {
    await Promise.all([...runtimes.values()].map((runtime) => runtime.close()));
    throw cause;
  }

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    let host;
    try {
      host = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      host = "";
    }
    if (!localHosts.has(host))
      return next(
        error(403, "This local panel only accepts localhost connections."),
      );
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.headers["sec-fetch-site"] === "cross-site")
        return next(error(403, "Cross-site requests are not allowed."));
      if (req.headers.origin) {
        try {
          const origin = new URL(req.headers.origin);
          if (
            !localHosts.has(origin.hostname) ||
            !["http:", "https:"].includes(origin.protocol)
          )
            throw new Error();
        } catch {
          return next(error(403, "Cross-origin requests are not allowed."));
        }
      }
    }
    if (closed) return next(error(503, "The panel is shutting down."));
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/server-import", (_req, res) =>
    res.json({
      canBrowse: typeof options.selectServerDirectory === "function",
    }),
  );
  app.post("/api/server-import/browse", async (_req, res) => {
    if (typeof options.selectServerDirectory !== "function")
      throw error(
        400,
        "Folder browsing is available in the desktop app. Enter the server folder's absolute path instead.",
      );
    const directory = await options.selectServerDirectory();
    res.json({ directory: directory ?? null });
  });
  app.post("/api/server-import/inspect", async (req, res) => {
    res.json(await inspectImport(req.body?.directory));
  });
  app.post("/api/server-import", async (req, res) => {
    const server = await serialize(async () => {
      const input = req.body;
      const allowed = new Set([
        "directory",
        "name",
        "jar",
        "launchType",
        "launchScript",
        "launchArgs",
        "launchExecutable",
        "javaPath",
        "memoryLimitMB",
        "port",
      ]);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !allowed.has(key))
      )
        throw error(
          400,
          "Provide the folder, server name, launch method, Java executable, memory, and port.",
        );
      const inspected = await inspectImport(input.directory);
      const launchType = input.launchType ?? "jar";
      if (launchType === "jar") {
        if (
          typeof input.jar !== "string" ||
          !inspected.jars.includes(input.jar)
        )
          throw error(
            400,
            "Choose a regular server JAR from the inspected folder's root. Scripts, installers, and nested library paths are not selected automatically.",
          );
        const selectedJar = await containedSourcePath(
          inspected.directory,
          input.jar,
        );
        if (!(await fs.stat(selectedJar)).isFile())
          throw error(400, "The selected server JAR is no longer available.");
      }
      const config = validateServerConfiguration(
        {
          name: input.name ?? inspected.name,
          mode: "live",
          port: input.port ?? inspected.port,
          launchType,
          launchScript: input.launchScript ?? "",
          launchArgs: input.launchArgs ?? [],
          launchExecutable: input.launchExecutable ?? "",
          jar: launchType === "jar" ? input.jar : "",
          javaPath: input.javaPath ?? inspected.javaPath ?? "java",
          memoryLimitMB: input.memoryLimitMB ?? 4096,
        },
        { motd: inspected.motd },
        true,
      );
      const startup = await validateStartupFiles(inspected.directory, config);
      if (
        Number.isInteger(startup.memoryLimitMB) &&
        startup.memoryLimitMB >= 256 &&
        startup.memoryLimitMB <= 262144
      )
        config.memoryLimitMB = startup.memoryLimitMB;
      const candidate = inspected.launches.find(
        (candidate) =>
          candidate.type === launchType &&
          JSON.stringify(candidate.launchArgs ?? []) ===
            JSON.stringify(config.launchArgs),
      );
      checkPort(config.port);
      const id = randomUUID();
      const instanceDir = await safePath(dataDir, `instances/${id}`);
      const entry = {
        ...config,
        id,
        storage: "external",
        source: "imported",
        dataDir: instanceDir,
        serverDir: inspected.directory,
        address: inspected.address.replace(/:\d+$/, `:${config.port}`),
        maxPlayers: inspected.maxPlayers,
        version:
          launchType === "jar"
            ? "Configured JAR"
            : (startup.version ?? "Unknown"),
        software:
          startup.software ??
          candidate?.software ??
          (launchType === "executable" ? "Custom" : "Java"),
      };
      const runtime = await makeRuntime(entry);
      try {
        await persist({
          ...registry,
          defaultServerId: registry.defaultServerId ?? id,
          servers: [...registry.servers, entry],
        });
      } catch (cause) {
        runtimes.delete(id);
        await runtime.close();
        throw cause;
      }
      await runtime.audit(
        "server",
        "Existing server imported",
        `Existing folder linked in place: ${inspected.directory}. No source files were changed and the server was not started.`,
      );
      return runtime.descriptor();
    });
    res.status(201).json({ server });
  });
  app.get("/api/servers", async (_req, res) => {
    await Promise.all(
      [...runtimes.values()].map((runtime) =>
        runtime.refreshStartupMetadata?.(),
      ),
    );
    res.json({
      servers: registry.servers.map(descriptor),
      defaultServerId: registry.defaultServerId,
    });
  });
  const setup = await createServerSetup({
    ...options,
    dataDir,
    safePath,
    javaPath:
      options.javaPath ??
      env.JAVA_PATH ??
      // Desktop ignores legacy MC_* configuration, but OS Java discovery is
      // still useful when a JDK installer configured JAVA_HOME without PATH.
      (process.env.JAVA_HOME
        ? path.join(
            process.env.JAVA_HOME,
            "bin",
            process.platform === "win32" ? "java.exe" : "java",
          )
        : "java"),
  });
  setup.mount(app);
  const createManagedServer = async (
    input,
    { requestId, acceptedEula = false } = {},
  ) => {
    return serialize(async () => {
      const config = validateServerConfiguration(input);
      const fingerprint = requestId
        ? createHash("sha256")
            .update(JSON.stringify({ config, acceptedEula }))
            .digest("hex")
        : null;
      if (requestId) {
        const previous = registry.servers.find(
          (entry) => entry.setupRequestId === requestId,
        );
        if (previous) {
          if (previous.setupFingerprint !== fingerprint)
            throw error(
              409,
              "This setup request already created a server with different settings. Resume that server or begin a new setup.",
            );
          return {
            server: { ...descriptor(previous), serverDir: previous.serverDir },
            reused: true,
          };
        }
      }
      checkPort(config.port);
      const id = randomUUID();
      const instanceDir = await safePath(dataDir, `instances/${id}`);
      for (const runtime of runtimes.values()) {
        const relative = path.relative(
          await fs.realpath(runtime.serverDir).catch((cause) => {
            if (
              !runtime.unavailable &&
              !(
                runtime.descriptor().source === "imported" &&
                ["ENOENT", "ENOTDIR"].includes(cause.code)
              )
            )
              throw cause;
            return path.resolve(runtime.serverDir);
          }),
          instanceDir,
        );
        if (
          !relative ||
          (!path.isAbsolute(relative) &&
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`))
        )
          throw error(
            400,
            "The instances storage directory overlaps an existing server. Choose a panel data directory outside your server files.",
          );
      }
      await fs.mkdir(instanceDir, { recursive: true });
      const serverDir = await safePath(instanceDir, "server");
      await fs.mkdir(serverDir);
      // EULA acceptance is only written after an explicit guided-review choice.
      if (config.mode === "live") {
        await fs.writeFile(
          path.join(serverDir, "eula.txt"),
          `# Read https://aka.ms/MinecraftEULA before accepting.\neula=${acceptedEula}\n`,
          { flag: "wx" },
        );
        await fs.writeFile(
          path.join(serverDir, "server.properties"),
          `motd=${escapeProperty(config.motd)}\nserver-port=${config.port}\nmax-players=20\nonline-mode=true\n`,
          { flag: "wx" },
        );
        if (requestId)
          await fs.writeFile(
            path.join(serverDir, "user_jvm_args.txt"),
            `# Memory selected during server setup.\n-Xms${Math.min(config.memoryLimitMB, 1024)}M\n-Xmx${config.memoryLimitMB}M\n`,
            { flag: "wx" },
          );
      }
      const entry = {
        ...config,
        id,
        storage: "instance",
        dataDir: instanceDir,
        serverDir,
        address: `localhost:${config.port}`,
        version: config.mode === "demo" ? "1.21.4" : "Configured JAR",
        software: config.mode === "demo" ? "Paper" : "Java",
        ...(requestId
          ? { setupRequestId: requestId, setupFingerprint: fingerprint }
          : {}),
      };
      if (requestId) await setup.copySettings(instanceDir);
      const runtime = await makeRuntime(entry);
      try {
        await persist({
          ...registry,
          defaultServerId: registry.defaultServerId ?? id,
          servers: [...registry.servers, entry],
        });
      } catch (cause) {
        runtimes.delete(id);
        await runtime.close();
        throw cause;
      }
      await runtime.audit(
        "server",
        "Server created",
        `${config.name} created in ${config.mode} mode on port ${config.port}.`,
      );
      return {
        server: {
          ...runtime.descriptor(),
          ...(requestId ? { serverDir } : {}),
        },
        reused: false,
      };
    });
  };
  app.post("/api/servers", async (req, res) => {
    const { server } = await createManagedServer(req.body);
    res.status(201).json({ server });
  });
  app.post("/api/server-setup", async (req, res) => {
    const {
      requestId,
      confirmed,
      configuration,
      acceptedEula = false,
    } = req.body ?? {};
    if (confirmed !== true)
      throw error(
        400,
        "Review the selected installation and confirm before creating the server.",
      );
    if (
      typeof requestId !== "string" ||
      !/^[a-z0-9-]{16,100}$/i.test(requestId)
    )
      throw error(
        400,
        "Provide a unique setup request ID so a retry cannot create another server.",
      );
    if (typeof acceptedEula !== "boolean")
      throw error(400, "Choose whether to accept the Minecraft EULA.");
    if (!configuration || configuration.mode !== "live")
      throw error(400, "New guided installations must use live mode.");
    const result = await createManagedServer(configuration, {
      requestId,
      acceptedEula,
    });
    res.status(result.reused ? 200 : 201).json(result);
  });
  app.patch("/api/servers/:id", async (req, res) => {
    const server = await serialize(async () => {
      const entry = registry.servers.find((item) => item.id === req.params.id);
      if (!entry) throw error(404, "Server not found.");
      const config = validateServerConfiguration(
        req.body,
        onlyConfig(entry),
        entry.storage === "external",
      );
      checkPort(config.port, entry.id);
      const next = { ...entry, ...config };
      if (config.port !== entry.port) next.address = `localhost:${config.port}`;
      if (
        config.mode !== entry.mode ||
        (config.launchType === "jar" &&
          (entry.launchType !== "jar" || config.jar !== entry.jar))
      ) {
        next.minecraftVersion = null;
        next.version = config.mode === "demo" ? "1.21.4" : "Configured JAR";
        next.software = config.mode === "demo" ? "Paper" : "Java";
      }
      return runtimes.get(entry.id).updateConfiguration(next, () =>
        persist({
          ...registry,
          servers: registry.servers.map((item) =>
            item.id === entry.id ? next : item,
          ),
        }),
      );
    });
    res.json({ server });
  });
  app.delete("/api/servers/:id", async (req, res) => {
    const result = await serialize(async () => {
      const entry = registry.servers.find((item) => item.id === req.params.id);
      if (!entry) throw error(404, "Server not found.");
      const runtime = runtimes.get(entry.id);
      // Missing imported folders are represented by an offline, inactive
      // placeholder and can still be removed without recreating their source.
      runtime.assertRemovable?.();
      const servers = registry.servers.filter((item) => item.id !== entry.id);
      const defaultServerId =
        registry.defaultServerId === entry.id
          ? (servers[0]?.id ?? null)
          : registry.defaultServerId;
      try {
        // close() blocks new work synchronously, before any await can let a
        // concurrent start or file write slip past the removal guard.
        await runtime.close();
        await runtime.audit?.(
          "server",
          "Server removal requested",
          "Remove this server from the panel registry. Preserve its Minecraft files, worlds, backups, and Recycle Bin data on disk.",
        );
        await persist({ ...registry, servers, defaultServerId });
      } catch (cause) {
        runtimes.delete(entry.id);
        await makeRuntime(entry, true);
        throw cause;
      }
      runtimes.delete(entry.id);
      return {
        ok: true,
        serverId: entry.id,
        defaultServerId,
        filesPreserved: true,
      };
    });
    res.json(result);
  });
  // Desktop preferences belong to the app, not to the default server runtime.
  // The authenticated desktop wrapper supplies the persistent implementation.
  app.get("/api/desktop/selection", (_req, res) =>
    res.json({ desktop: false, activeServerId: null }),
  );
  app.use(async (req, res, next) => {
    if (!/^\/api(?:\/|$)/.test(req.path)) return next();
    const header = req.headers["x-server-id"];
    const query = req.query.serverId;
    if (header !== undefined && query !== undefined && header !== query)
      return next(error(400, "Conflicting server selectors."));
    const id = header ?? query ?? registry.defaultServerId;
    if (!registry.servers.length)
      return next(
        error(404, "No servers are configured. Add a server to get started."),
      );
    if (typeof id !== "string" || !runtimes.has(id))
      return next(error(404, "Server not found."));
    let runtime = runtimes.get(id);
    if (runtime.unavailable)
      runtime = await serialize(() => {
        const current = runtimes.get(id);
        if (!current) throw error(404, "Server not found.");
        return current.unavailable
          ? makeRuntime(
              registry.servers.find((entry) => entry.id === id),
              true,
            )
          : current;
      });
    runtime.app(req, res, next);
  });
  const distDir = path.join(projectDir, "dist");
  app.use(express.static(distDir));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(distDir, "index.html")),
  );
  app.use((cause, _req, res, _next) => {
    if (res.headersSent) return;
    const status = cause.status ?? (cause.code === "ENOENT" ? 404 : 500);
    if (status >= 500 && status !== 503) console.error(cause);
    res.status(status).json({
      error:
        status >= 500 && status !== 503
          ? "The operation failed. Check the API terminal for details."
          : cause.message,
    });
  });
  return {
    app,
    dataDir,
    runtimes,
    tick: async (now) =>
      Promise.all([...runtimes.values()].map((runtime) => runtime.tick(now))),
    close: async (closeOptions = {}) => {
      closed = true;
      await setup.close();
      await changeChain.catch(() => {});
      await Promise.all(
        [...runtimes.values()].map((runtime) => runtime.close(closeOptions)),
      );
      if (!options.telemetry) telemetry.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    process.loadEnvFile(path.join(projectDir, ".env"));
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  const panel = await createFleet({ createDefaultServer: false });
  const port = Number(process.env.PORT ?? 3001);
  const listener = panel.app.listen(port, "127.0.0.1", () =>
    console.log(
      `Minecraft panel API: http://127.0.0.1:${port} · ${panel.runtimes.size} server(s)`,
    ),
  );
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    listener.close();
    await panel.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
