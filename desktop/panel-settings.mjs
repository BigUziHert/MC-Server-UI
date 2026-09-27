import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { safePath } from "../server/index.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const defaults = {
  startAtLogin: false,
  autoStartServerIds: [],
  keepInTray: true,
};
const keys = Object.keys(defaults);
const legacyKeys = ["startupMode", "startupServerId", "keepInTray"];
const settingsSizeLimit = 32768;
const maximumAutoStartServers = 100;
const validServerId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

function validate(value, partial = false) {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw fail(400, "Provide supported panel settings.");
  if (
    (!partial || "startAtLogin" in value) &&
    typeof value.startAtLogin !== "boolean"
  )
    throw fail(400, "Choose whether the panel starts at Windows sign-in.");
  if (
    (!partial || "keepInTray" in value) &&
    typeof value.keepInTray !== "boolean"
  )
    throw fail(
      400,
      "Choose whether closing the panel keeps it in the system tray.",
    );
  if (
    (!partial || "autoStartServerIds" in value) &&
    (!Array.isArray(value.autoStartServerIds) ||
      value.autoStartServerIds.length > maximumAutoStartServers ||
      value.autoStartServerIds.some((id) => !validServerId(id)))
  )
    throw fail(
      400,
      `Choose up to ${maximumAutoStartServers} valid servers to start with the panel.`,
    );
  return {
    ...value,
    ...("autoStartServerIds" in value
      ? { autoStartServerIds: [...new Set(value.autoStartServerIds)] }
      : {}),
  };
}

function migrateSettings(value) {
  if (!object(value) || !Object.hasOwn(value, "startupMode"))
    return { settings: validate(value), migrated: false };
  if (
    Object.keys(value).some((key) => !legacyKeys.includes(key)) ||
    !["off", "panel", "server"].includes(value.startupMode) ||
    typeof value.keepInTray !== "boolean" ||
    !(value.startupServerId === null || validServerId(value.startupServerId)) ||
    (value.startupMode === "server" && !validServerId(value.startupServerId))
  )
    throw fail(400, "Saved panel settings are invalid.");
  return {
    migrated: true,
    settings: {
      startAtLogin: value.startupMode !== "off",
      autoStartServerIds:
        value.startupMode === "server" ? [value.startupServerId] : [],
      keepInTray: value.keepInTray,
    },
  };
}

export async function readPanelSettingsBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    throw fail(400, "Provide panel settings as JSON.");
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length <= settingsSizeLimit) chunks.push(chunk);
  }
  if (length > settingsSizeLimit)
    throw fail(413, "The panel settings request is too large.");
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "Provide panel settings as JSON.");
  }
  return validate(value, true);
}

// Kept separate from display preferences: these values control local processes
// and the Windows login item, and never cross the remote connection bridge.
export function createPanelSettings({ dataDir, hasServer, loginItem = {} }) {
  let saved = { ...defaults, autoStartServerIds: [] };
  let loaded;
  let writes = Promise.resolve();
  let closed = false;
  let startupError = "";
  const target = () => safePath(dataDir, "panel-settings.json");
  const writeSettings = async (next, beforeCommit) => {
    const temporary = await safePath(
      dataDir,
      `panel-settings-${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temporary, JSON.stringify(next), {
        flag: "wx",
        mode: 0o600,
      });
      await beforeCommit?.();
      await fs.rename(temporary, await target());
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };
  const load = () =>
    (loaded ??= (async () => {
      let file;
      try {
        file = await fs.open(await target(), "r");
      } catch (cause) {
        if (cause.code === "ENOENT") return;
        throw cause;
      }
      let contents;
      try {
        if ((await file.stat()).size > settingsSizeLimit)
          throw fail(500, "Saved panel settings are too large.");
        contents = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      const { settings, migrated } = migrateSettings(JSON.parse(contents));
      // Migration changes only the persisted representation. An existing
      // Windows login item keeps its prior state, including on portable runs.
      if (migrated) await writeSettings(settings);
      saved = settings;
    })());
  const snapshot = () => ({
    desktop: true,
    ...saved,
    autoStartServerIds: [...saved.autoStartServerIds],
    startupSupported: loginItem.supported === true,
    startupReason:
      loginItem.reason ||
      "Starting MC Panel at Windows sign-in is available in the installed Windows desktop app.",
    missingAutoStartServerIds: saved.autoStartServerIds.filter(
      (id) => !hasServer(id),
    ),
    ...(startupError ? { startupError } : {}),
  });
  return {
    snapshot,
    async read() {
      await writes.catch(() => {});
      await load();
      return snapshot();
    },
    save(value) {
      if (closed)
        return Promise.reject(fail(503, "The desktop panel is closing."));
      let validated;
      try {
        validated = validate(value, true);
      } catch (cause) {
        return Promise.reject(cause);
      }
      const write = writes
        .catch(() => {})
        .then(async () => {
          await load();
          const next = { ...saved, ...validated };
          const loginChanged = next.startAtLogin !== saved.startAtLogin;
          if (loginChanged && !loginItem.supported)
            throw fail(
              409,
              loginItem.reason ||
                "Starting MC Panel at Windows sign-in requires the installed Windows desktop app.",
            );
          if (
            next.autoStartServerIds.some(
              (id) => !saved.autoStartServerIds.includes(id) && !hasServer(id),
            )
          )
            throw fail(
              400,
              "Choose local servers that are still available in this panel.",
            );
          let applied = false;
          try {
            await writeSettings(next, async () => {
              if (loginChanged) {
                applied = true;
                await loginItem.setEnabled(next.startAtLogin);
              }
            });
            saved = next;
            startupError = "";
          } catch (cause) {
            if (applied) {
              try {
                await loginItem.setEnabled(saved.startAtLogin);
              } catch {
                /* Preserve the original save failure. */
              }
            }
            throw cause;
          }
          return snapshot();
        });
      writes = write;
      return write;
    },
    setStartupError(message) {
      startupError = message;
    },
    async close() {
      closed = true;
      await writes.catch(() => {});
    },
  };
}

// NSIS passes --updated to the app after an updater install. Failed installer
// recovery uses that same flag so both update paths keep Minecraft stopped.
export function skipAutomaticServerStart(argv) {
  return argv.includes("--updated");
}

export function updateRecoveryArguments(argv) {
  return [
    ...argv.filter(
      (argument) => !["--startup", "--updated"].includes(argument),
    ),
    "--updated",
  ];
}

export function keepWindowInTray({ trayAvailable, quitting, keepInTray }) {
  return trayAvailable && !quitting && keepInTray;
}
