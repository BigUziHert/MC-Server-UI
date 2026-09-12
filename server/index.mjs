import express from "express";
import multer from "multer";
import * as tar from "tar";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const roles = new Set(["admin", "operator", "viewer"]);
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

export function validateServerConfiguration(input, previous = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw error(400, "Provide server settings.");
  const allowed = new Set([
    "name",
    "mode",
    "port",
    "memoryLimitMB",
    "jar",
    "javaPath",
    "motd",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw error(400, "Unknown server setting.");
  const result = {
    name: "New server",
    mode: "live",
    port: 25565,
    memoryLimitMB: 4096,
    jar: "server.jar",
    javaPath: "java",
    motd: "Welcome to the Overworld",
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
  if (
    typeof result.jar !== "string" ||
    !result.jar.endsWith(".jar") ||
    result.jar.length > 180 ||
    result.jar.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw error(400, "Choose a relative .jar path inside this server's files.");
  for (const part of result.jar.split("/")) validateName(part);
  if (
    typeof result.javaPath !== "string" ||
    !result.javaPath.trim() ||
    result.javaPath.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(result.javaPath)
  )
    throw error(400, "Enter java or the path to a Java executable.");
  if (
    typeof result.motd !== "string" ||
    result.motd.length > 256 ||
    /[\x00-\x1f\x7f]/.test(result.motd)
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
  // A fleet passes every setting explicitly. Legacy callers may still use .env.
  const env = options.useEnvironment === false ? {} : process.env;
  const dataDir = path.resolve(
    options.dataDir ?? env.PANEL_DATA_DIR ?? path.join(projectDir, "data"),
  );
  const serverDir = path.resolve(
    options.serverDir ?? env.MC_SERVER_DIR ?? path.join(dataDir, "server"),
  );
  let configuredJar = (options.jar ?? env.MC_SERVER_JAR) || "server.jar";
  let mode =
    options.mode ?? (options.jar || env.MC_SERVER_JAR ? "live" : "demo");
  let memoryLimit = Number(options.memoryLimit ?? env.MC_MEMORY_MB ?? 4096);
  let configuration = {
    name: options.name ?? env.MC_SERVER_NAME ?? "The Overworld",
    mode,
    port: Number(options.port ?? env.MC_PORT ?? 25565),
    memoryLimitMB: memoryLimit,
    jar: configuredJar,
    javaPath: options.javaPath ?? env.JAVA_PATH ?? "java",
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
  for (const dir of [dataDir, serverDir, backupDir, databaseDir, uploadDir])
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
  let state = {
    users: [],
    databases: [],
    backups: [],
    audit: [],
    demoOperators: [],
    schedule: { ...defaultSchedule },
  };
  if (await exists(statePath))
    state = { ...state, ...JSON.parse(await fs.readFile(statePath, "utf8")) };
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
  let restartRequested = false;
  let closed = false;
  let closePromise;
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
  const clearPlayers = () => {
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
      /^(?:\[\d{2}:\d{2}:\d{2}\] )?\[(Server thread|User Authenticator #\d+)\/INFO\]: (.+)$/,
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
      if (player) player.uuid = value;
      return;
    }
    if (vanilla && vanilla[1] !== "Server thread") return;
    const event = message.match(
      /^([A-Za-z0-9_]{3,16}) (joined|left) the game$/,
    );
    if (!event) return;
    const key = event[1].toLowerCase();
    if (event[2] === "left") onlinePlayers.delete(key);
    else {
      const uuid = playerUuids.get(key);
      onlinePlayers.set(key, { name: event[1], ...(uuid ? { uuid } : {}) });
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
      "javaPath",
      "motd",
    ];
    if (
      restartFields.some((key) => next[key] !== configuration[key]) &&
      status !== "offline"
    )
      throw error(
        409,
        "Stop this server before changing its connection, Java, memory, or server list settings.",
      );
    configBusy = true;
    try {
      await safePath(serverDir, next.jar);
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
      if (oldMode !== mode) {
        configuration.version = mode === "demo" ? "1.21.4" : "Configured JAR";
        configuration.software = mode === "demo" ? "Paper" : "Java";
        append(
          `[Panel] ${mode === "demo" ? "Demo mode — activity is simulated" : "Live Java mode configured"}.`,
        );
      }
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

  const descriptor = () => ({ ...configuration, id: options.id, status });

  async function startServer() {
    if (status !== "offline")
      throw error(409, "The server is already running or changing state.");
    // Reserve the transition before any filesystem awaits so concurrent starts cannot spawn twice.
    status = "starting";
    clearPlayers();
    try {
      if (mode === "demo") {
        status = "starting";
        append("[Demo] Starting the Minecraft server…");
        demoTimer = setTimeout(() => {
          status = "running";
          startedAt = Date.now();
          append("[Demo] Done! Server is ready.", "success");
        }, 900);
        demoTimer.unref();
        return;
      }
      const jar = await safePath(serverDir, configuredJar);
      if (!(await exists(jar)))
        throw error(
          400,
          "MC_SERVER_JAR does not exist in the server directory.",
        );
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
      append("[Panel] Starting Java server…");
      const child = (options.spawnServer ?? spawn)(
        configuration.javaPath,
        [
          `-Xms${Math.min(memoryLimit, 1024)}M`,
          `-Xmx${memoryLimit}M`,
          "-jar",
          jar,
          "nogui",
        ],
        {
          cwd: serverDir,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      processHandle = child;
      startedAt = Date.now();
      const bindOutput = (stream, defaultLevel) => {
        let buffer = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          buffer += chunk;
          const chunks = buffer.split(/\r?\n/);
          buffer = chunks.pop().slice(-32768);
          for (const text of chunks) {
            trackPlayerOutput(text, child);
            if (/Done \(/.test(text) && status === "starting")
              status = "running";
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
        append(`[Panel] Java failed: ${cause.message}`, "error");
      });
      child.on("close", (code) => {
        processHandle = null;
        status = "offline";
        startedAt = null;
        clearPlayers();
        events.emit("server-exit", child);
        append(
          `[Panel] Server process exited (code ${code ?? "unknown"}).`,
          code === 0 ? "info" : "error",
        );
        if (restartRequested && !closed) {
          restartRequested = false;
          startServer().catch((cause) => append(cause.message, "error"));
        }
      });
    } catch (cause) {
      status = "offline";
      startedAt = null;
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
          if (restartRequested) {
            restartRequested = false;
            startServer().catch((cause) => append(cause.message, "error"));
          }
        }, 650);
        demoTimer.unref();
      } else processHandle?.stdin.write("stop\n");
    }
    await audit(
      "server",
      `Server ${action}`,
      `${mode === "demo" ? "Simulated" : "Requested"} server ${action}.`,
    );
  }

  let backupBusy = false;
  let activeMutations = 0;
  const writeServer = (child, command) =>
    new Promise((resolve, reject) => {
      if (child !== processHandle || !child.stdin.writable)
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
        req.path === "/api/console/command");
    if (protectedMutation) {
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
      activeMutations++;
      let completed = false;
      const done = () => {
        if (!completed) {
          completed = true;
          activeMutations--;
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
    if (Date.now() - diskCache.at > 10000)
      diskCache = { value: await directorySize(serverDir), at: Date.now() };
    const active = status === "running";
    const storage = await fs.statfs(serverDir);
    res.json({
      id: options.id,
      name: configuration.name,
      address: configuration.address,
      status,
      mode,
      version: configuration.version,
      software: configuration.software,
      uptime: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
      cpu:
        mode === "demo" && active
          ? Number((7.2 + Math.sin(Date.now() / 7000) * 2.6).toFixed(1))
          : 0,
      memory:
        mode === "demo" && active
          ? Math.round(1840 + Math.sin(Date.now() / 12000) * 60) * 1024 ** 2
          : 0,
      memoryLimit: memoryLimit * 1024 ** 2,
      disk: diskCache.value,
      diskLimit: storage.blocks * storage.bsize,
      diskAvailable: storage.bavail * storage.bsize,
      players: [...onlinePlayers.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      maxPlayers: configuration.maxPlayers,
      metricsAvailable: mode === "demo",
      playersAvailable: true,
    });
  });
  app.get("/api/console", (_req, res) => res.json({ lines }));
  app.get("/api/players", async (_req, res) => {
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
    res.json({ operators, mode, status });
  });
  for (const action of ["op", "deop"]) {
    app.post(
      `/api/players/${action}`,
      trackOperation(async (req, res) => {
        const name = validatePlayerName(req.body?.name);
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
          if (action === "op") state.demoOperators.push({ name, level: 4 });
        }
        append(
          `[${mode === "demo" ? "Demo" : "Panel"}] ${mode === "demo" ? "Simulated" : "Requested"}: ${command}`,
        );
        await audit(
          "player",
          action === "op"
            ? "Operator access requested"
            : "Operator removal requested",
          `${mode === "demo" ? "Simulated" : "Sent to Java"}: ${command}.`,
        );
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
      else if (mode === "live") processHandle.stdin.write(`${normalized}\n`);
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
      await audit("server", "Console command", normalized);
      res.json({ ok: true });
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
        await audit(
          "file",
          "Files uploaded",
          `${files.length} file(s) uploaded to /${directory}.`,
        );
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
        `${type === "file" ? "File" : "Directory"} created`,
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
      await fs.rm(target, { recursive: true });
      await audit("file", "File deleted", relative);
      diskCache.at = 0;
      res.json({ ok: true });
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
  app.get("/api/subusers", (_req, res) => res.json({ users: state.users }));
  app.post(
    "/api/subusers",
    trackOperation(async (req, res) => {
      const { email, role } = req.body ?? {};
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
  app.get("/api/audit", (_req, res) => res.json({ entries: state.audit }));
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
    updateConfiguration: (...args) => {
      if (closed)
        return Promise.reject(error(503, "The panel is shutting down."));
      return trackTask(() => updateConfiguration(...args));
    },
    audit,
    close: () => {
      if (!closePromise) {
        closed = true;
        clearPlayers();
        clearInterval(scheduler);
        clearTimeout(demoTimer);
        closePromise = (async () => {
          // An HTTP client can leave before its disk writes or backup finish.
          // Wait for the handler itself, including save-on and its audit write.
          while (inFlightTasks.size)
            await Promise.allSettled([...inFlightTasks]);
          clearTimeout(demoTimer);
          if (processHandle) {
            const child = processHandle;
            const exited = new Promise((resolve) =>
              child.once("close", resolve),
            );
            child.stdin.write("stop\n");
            let timeout;
            try {
              await Promise.race([
                exited,
                new Promise((resolve) => {
                  timeout = setTimeout(resolve, 15000);
                }),
              ]);
              if (processHandle === child) child.kill();
            } finally {
              clearTimeout(timeout);
            }
          }
          await saveChain;
        })();
      }
      return closePromise;
    },
  };
}

// Registry changes are serialized, but each server has its own process, state and scheduler.
export async function createFleet(options = {}) {
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
    "name",
    "mode",
    "port",
    "memoryLimitMB",
    "jar",
    "javaPath",
    "motd",
  ];
  const onlyConfig = (entry) =>
    Object.fromEntries(
      configKeys
        .filter((key) => entry[key] !== undefined)
        .map((key) => [key, entry[key]]),
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
  const makeRuntime = async (entry) => {
    await fs.mkdir(entry.serverDir, { recursive: true });
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
    for (const runtime of runtimes.values()) {
      const existingServer = await fs.realpath(runtime.serverDir);
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
      scheduler: options.scheduler,
      spawnServer: options.spawnServer,
      backupFlushTimeoutMs: options.backupFlushTimeoutMs,
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
      Object.assign(entry, validateServerConfiguration(onlyConfig(entry)));
      if (ports.has(entry.port))
        throw new Error(
          "The server registry contains duplicate Minecraft ports.",
        );
      ports.add(entry.port);
      // The default selection is not a storage location. Original installations
      // keep their legacy root; explicitly created instances keep their own roots.
      entry.storage ??=
        entry.id === registry.defaultServerId ? "legacy" : "instance";
      if (!["legacy", "instance"].includes(entry.storage))
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
        entry.serverDir = await safePath(entry.dataDir, "server");
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
    for (const entry of registry.servers) await makeRuntime(entry);
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
  app.get("/api/servers", (_req, res) =>
    res.json({
      servers: registry.servers.map(descriptor),
      defaultServerId: registry.defaultServerId,
    }),
  );
  app.post("/api/servers", async (req, res) => {
    const server = await serialize(async () => {
      const config = validateServerConfiguration(req.body);
      checkPort(config.port);
      const id = randomUUID();
      const instanceDir = await safePath(dataDir, `instances/${id}`);
      for (const runtime of runtimes.values()) {
        const relative = path.relative(
          await fs.realpath(runtime.serverDir),
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
      // New live instances need an explicit user EULA decision and uploaded JAR.
      if (config.mode === "live") {
        await fs.writeFile(
          path.join(serverDir, "eula.txt"),
          "# Read https://aka.ms/MinecraftEULA before accepting.\neula=false\n",
          { flag: "wx" },
        );
        await fs.writeFile(
          path.join(serverDir, "server.properties"),
          `motd=${escapeProperty(config.motd)}\nserver-port=${config.port}\nmax-players=20\nonline-mode=true\n`,
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
        "Server created",
        `${config.name} created in ${config.mode} mode on port ${config.port}.`,
      );
      return runtime.descriptor();
    });
    res.status(201).json({ server });
  });
  app.patch("/api/servers/:id", async (req, res) => {
    const server = await serialize(async () => {
      const entry = registry.servers.find((item) => item.id === req.params.id);
      if (!entry) throw error(404, "Server not found.");
      const config = validateServerConfiguration(req.body, onlyConfig(entry));
      checkPort(config.port, entry.id);
      const next = { ...entry, ...config };
      if (config.port !== entry.port) next.address = `localhost:${config.port}`;
      if (config.mode !== entry.mode) {
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
      if (entry.mode !== "demo")
        throw error(
          409,
          "Only demo servers can be removed here. Live servers and their worlds are protected.",
        );
      const runtime = runtimes.get(entry.id);
      await runtime.audit(
        "server",
        "Demo removal requested",
        "Remove this demo from the panel registry and preserve all of its files and backups on disk.",
      );
      await runtime.close();
      const servers = registry.servers.filter((item) => item.id !== entry.id);
      const defaultServerId =
        registry.defaultServerId === entry.id
          ? (servers[0]?.id ?? null)
          : registry.defaultServerId;
      try {
        await persist({ ...registry, servers, defaultServerId });
      } catch (cause) {
        runtimes.delete(entry.id);
        await makeRuntime(entry);
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
  app.use((req, res, next) => {
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
    runtimes.get(id).app(req, res, next);
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
    close: async () => {
      closed = true;
      await changeChain.catch(() => {});
      await Promise.all(
        [...runtimes.values()].map((runtime) => runtime.close()),
      );
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
  const panel = await createFleet();
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
