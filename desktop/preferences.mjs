import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { safePath } from "../server/index.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const rowKeys = new Set([
  "mc-panel.launchpad.rows",
  ...[
    "online-players",
    "banned-players",
    "operators",
    "whitelist",
    "history",
  ].map((id) => `mc-panel.players.rows.${id}`),
]);
const viewKey = /^mc-panel\.launchpad\.view\.(?:default|[a-zA-Z0-9_-]{1,128})$/;
const choices = {
  platform: [
    "modrinth",
    "curseforge",
    "ftb",
    "atlauncher",
    "spigot",
    "voidswrath",
  ],
  type: ["mod", "modpack", "plugin", "datapack"],
  loader: [
    "",
    "fabric",
    "forge",
    "neoforge",
    "quilt",
    "paper",
    "purpur",
    "spigot",
    "bukkit",
    "folia",
    "sponge",
    "vanilla",
    "datapack",
    "velocity",
    "waterfall",
    "bungeecord",
  ],
  sort: ["", "downloads", "relevance", "popular", "updated", "newest", "name"],
  installedSort: ["updates", "name", "size", "author"],
};

// This file stores display choices only. Credentials, invitations, arbitrary
// browser storage, server paths, and unrestricted strings are never accepted.
export function validatePreference(key, value) {
  if (
    typeof key !== "string" ||
    typeof value !== "string" ||
    value.length > 4096
  )
    throw fail(400, "Provide a supported display preference.");
  if (rowKeys.has(key)) {
    if (!["5", "10", "25", "50", "75", "100"].includes(value))
      throw fail(400, "Choose a supported number of rows.");
    return value;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw fail(400, "Provide a valid display preference.");
  }
  if (!object(parsed)) throw fail(400, "Provide a valid display preference.");
  if (key === "mc-panel.navigation-collapsed") {
    if (
      Object.entries(parsed).some(
        ([name, choice]) =>
          !["servers", "server", "minecraft", "management"].includes(name) ||
          typeof choice !== "boolean",
      )
    )
      throw fail(400, "Provide valid navigation choices.");
  } else if (viewKey.test(key)) {
    if (
      Object.entries(parsed).some(([name, choice]) => {
        if (name === "installedOnly") return typeof choice !== "boolean";
        if (name === "gameVersion")
          return (
            typeof choice !== "string" ||
            choice.length > 32 ||
            (choice !== "" && !/^\d+(?:\.\d+)+$/.test(choice))
          );
        return !Object.hasOwn(choices, name) || !choices[name].includes(choice);
      })
    )
      throw fail(400, "Provide valid Launchpad display choices.");
  } else throw fail(400, "This preference cannot be saved by the desktop app.");
  return JSON.stringify(parsed);
}

export function createDesktopPreferences({ dataDir }) {
  let writes = Promise.resolve();
  let closed = false;
  let loaded;
  const target = () => safePath(dataDir, "desktop-preferences.json");
  const read = () => {
    loaded ??= (async () => {
      const entries = {};
      try {
        const file = await fs.open(await target(), "r");
        let contents;
        try {
          if ((await file.stat()).size > 128 * 1024) return entries;
          contents = await file.readFile("utf8");
        } finally {
          await file.close();
        }
        const saved = JSON.parse(contents);
        if (!object(saved) || Object.keys(saved).length > 256) return entries;
        for (const [key, value] of Object.entries(saved)) {
          try {
            entries[key] = validatePreference(key, value);
          } catch {
            /* Ignore obsolete display fields. */
          }
        }
      } catch (cause) {
        if (cause.code !== "ENOENT" && !(cause instanceof SyntaxError))
          throw cause;
      }
      return entries;
    })();
    return loaded;
  };
  return {
    async read() {
      await writes;
      return { desktop: true, preferences: { ...(await read()) } };
    },
    save(key, value) {
      if (closed)
        return Promise.reject(fail(503, "The desktop panel is closing."));
      let validated;
      try {
        validated = validatePreference(key, value);
      } catch (cause) {
        return Promise.reject(cause);
      }
      const write = writes
        .catch(() => {})
        .then(async () => {
          const saved = await read();
          if (saved[key] === validated) return;
          if (!(key in saved) && Object.keys(saved).length >= 256)
            throw fail(
              409,
              "The saved display preference limit has been reached.",
            );
          const next = { ...saved, [key]: validated };
          const temporary = await safePath(
            dataDir,
            `desktop-preferences-${randomUUID()}.tmp`,
          );
          try {
            await fs.writeFile(temporary, JSON.stringify(next), {
              flag: "wx",
              mode: 0o600,
            });
            await fs.rename(temporary, await target());
            saved[key] = validated;
          } finally {
            await fs.rm(temporary, { force: true });
          }
        });
      writes = write;
      return write;
    },
    // Failed display preferences must not prevent Minecraft from saving/exiting.
    async close() {
      closed = true;
      await writes.catch(() => {});
    },
  };
}

export async function readPreferenceBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    throw fail(400, "Provide the display preference as JSON.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 8192) chunks.push(chunk);
  }
  if (size > 8192)
    throw fail(413, "The display preference request is too large.");
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "Provide the display preference as JSON.");
  }
  if (
    !object(body) ||
    Object.keys(body).some((key) => !["key", "value"].includes(key))
  )
    throw fail(400, "Provide one display preference.");
  return { key: body.key, value: validatePreference(body.key, body.value) };
}
