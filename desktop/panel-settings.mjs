import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { safePath } from "../server/index.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const defaults = {
  startupMode: "off",
  startupServerId: null,
  keepInTray: true,
};
const keys = Object.keys(defaults);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

function validate(value, partial = false) {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw fail(400, "Provide supported panel settings.");
  if (
    (!partial || "startupMode" in value) &&
    !["off", "panel", "server"].includes(value.startupMode)
  )
    throw fail(400, "Choose how the panel starts at sign-in.");
  if (
    (!partial || "keepInTray" in value) &&
    typeof value.keepInTray !== "boolean"
  )
    throw fail(
      400,
      "Choose whether closing the panel keeps it in the system tray.",
    );
  if (
    (!partial || "startupServerId" in value) &&
    value.startupServerId !== null &&
    (typeof value.startupServerId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.startupServerId))
  )
    throw fail(400, "Choose a valid startup server.");
  return value;
}

export async function readPanelSettingsBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    throw fail(400, "Provide panel settings as JSON.");
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length <= 4096) chunks.push(chunk);
  }
  if (length > 4096)
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
  let saved = { ...defaults };
  let loaded;
  let writes = Promise.resolve();
  let closed = false;
  let startupError = "";
  const target = () => safePath(dataDir, "panel-settings.json");
  const load = () =>
    (loaded ??= (async () => {
      try {
        const file = await fs.open(await target(), "r");
        let contents;
        try {
          if ((await file.stat()).size > 4096)
            throw fail(500, "Saved panel settings are too large.");
          contents = await file.readFile("utf8");
        } finally {
          await file.close();
        }
        const parsed = JSON.parse(contents);
        saved = { ...validate(parsed) };
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
    })());
  const snapshot = () => ({
    desktop: true,
    ...saved,
    startupSupported: loginItem.supported === true,
    startupReason:
      loginItem.reason ||
      "Automatic startup is available in the installed Windows desktop app.",
    missingStartupServer:
      saved.startupMode === "server" && !hasServer(saved.startupServerId),
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
      try {
        validate(value, true);
      } catch (cause) {
        return Promise.reject(cause);
      }
      const write = writes
        .catch(() => {})
        .then(async () => {
          await load();
          const next = { ...saved, ...value };
          const startupChanged =
            next.startupMode !== saved.startupMode ||
            next.startupServerId !== saved.startupServerId;
          if (startupChanged && !loginItem.supported)
            throw fail(
              409,
              loginItem.reason ||
                "Automatic startup requires the installed Windows desktop app.",
            );
          if (
            startupChanged &&
            next.startupMode === "server" &&
            !hasServer(next.startupServerId)
          )
            throw fail(
              400,
              "Choose a local server that is still available in this panel.",
            );
          const temporary = await safePath(
            dataDir,
            `panel-settings-${randomUUID()}.tmp`,
          );
          let applied = false;
          try {
            await fs.writeFile(temporary, JSON.stringify(next), {
              flag: "wx",
              mode: 0o600,
            });
            if (startupChanged) {
              applied = true;
              await loginItem.setEnabled(next.startupMode !== "off");
            }
            await fs.rename(temporary, await target());
            saved = next;
            if (startupChanged) startupError = "";
          } catch (cause) {
            if (applied) {
              try {
                await loginItem.setEnabled(saved.startupMode !== "off");
              } catch {
                /* Preserve the original save failure. */
              }
            }
            throw cause;
          } finally {
            await fs.rm(temporary, { force: true });
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

export function keepWindowInTray({ trayAvailable, quitting, keepInTray }) {
  return trayAvailable && !quitting && keepInTray;
}
