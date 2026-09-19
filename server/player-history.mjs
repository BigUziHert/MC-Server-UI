import fs from "node:fs/promises";
import { parseProperties } from "./import.mjs";

const fail = (message) => Object.assign(new Error(message), { status: 400 });
export const validPlayerName = (name) =>
  typeof name === "string" && /^[A-Za-z0-9_]{3,16}$/.test(name);
export const validPlayerUuid = (uuid) =>
  typeof uuid === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid);

// Commands written to Java are requests, not proof that Minecraft accepted them.
export function playerCommandAudit(command) {
  const normalized = command.trim().replace(/^\//, "");
  const [verb, argument] = normalized.replace(/^minecraft:/i, "").split(/\s+/);
  const labels = {
    op: "Player op requested",
    deop: "Player deop requested",
    ban: "Player ban requested",
    pardon: "Player unban requested",
    kick: "Player kick requested",
    "ban-ip": "IP ban requested",
    "pardon-ip": "IP unban requested",
  };
  const whitelistLabels = {
    add: "Whitelist addition requested",
    remove: "Whitelist removal requested",
    on: "Whitelist enable requested",
    off: "Whitelist disable requested",
    reload: "Whitelist reload requested",
  };
  const label =
    verb === "whitelist"
      ? Object.hasOwn(whitelistLabels, argument) && whitelistLabels[argument]
      : Object.hasOwn(labels, verb) && labels[verb];
  if (!label) return null;
  return {
    action: label,
    detail: `Sent to Minecraft: ${normalized}.`,
  };
}

export function whitelistCommand(action, input) {
  if (action === "state") {
    if (typeof input?.enabled !== "boolean")
      throw fail("Choose whether the whitelist is enabled.");
    return `whitelist ${input.enabled ? "on" : "off"}`;
  }
  if (!["add", "remove"].includes(action))
    throw fail("Unknown whitelist action.");
  if (!validPlayerName(input?.name))
    throw fail(
      "Use a Minecraft username with 3–16 letters, numbers, or underscores.",
    );
  if (input.uuid !== undefined && !validPlayerUuid(input.uuid))
    throw fail("The player UUID is invalid. Refresh the player list.");
  return `whitelist ${action} ${input.name}`;
}

export const samePlayer = (first, second) =>
  first.uuid && second.uuid
    ? first.uuid.toLowerCase() === second.uuid.toLowerCase()
    : first.name.toLowerCase() === second.name.toLowerCase();

export async function readWhitelistSettings(serverDir, safePath) {
  try {
    const target = await safePath(serverDir, "server.properties");
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Invalid properties file");
    const content = await fs.readFile(target);
    if (content.includes(0)) throw new Error("Invalid properties encoding");
    const settings = parseProperties(content.toString("utf8"));
    const value = settings.get("white-list")?.trim().toLowerCase() ?? "false";
    if (!["true", "false"].includes(value))
      throw new Error("Invalid white-list value");
    return { enabled: value === "true", available: true, warning: null };
  } catch {
    return {
      enabled: null,
      available: false,
      warning:
        "The whitelist setting could not be read. Check white-list in server.properties, then refresh.",
    };
  }
}

export function moderationCommand(action, input) {
  if (!["kick", "ban", "unban"].includes(action))
    throw fail("Unknown player action.");
  if (!validPlayerName(input?.name))
    throw fail(
      "Use a Minecraft username with 3–16 letters, numbers, or underscores.",
    );
  if (input.uuid !== undefined && !validPlayerUuid(input.uuid))
    throw fail("The player UUID is invalid. Refresh the player list.");
  const reason = input.reason ?? "";
  // Minecraft receives one console line. Reject controls instead of silently
  // changing a pasted reason that could otherwise contain another command.
  if (
    typeof reason !== "string" ||
    reason.length > 200 ||
    /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(reason)
  )
    throw fail("Use a single-line reason of at most 200 characters.");
  return `${action === "unban" ? "pardon" : action} ${input.name}${action !== "unban" && reason.trim() ? ` ${reason.trim()}` : ""}`;
}

export async function readPlayerRecords(serverDir, filename, safePath) {
  try {
    const target = await safePath(serverDir, filename);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
      throw new Error("must be a JSON file under 5 MB");
    const entries = JSON.parse(await fs.readFile(target, "utf8"));
    if (!Array.isArray(entries) || entries.length > 50000)
      throw new Error("must contain a player list with at most 50,000 records");
    const valid = entries.filter(
      (entry) => validPlayerName(entry?.name) && validPlayerUuid(entry?.uuid),
    );
    return {
      records: valid.map(({ name, uuid, reason }) => ({
        name,
        uuid: uuid.toLowerCase(),
        ...(typeof reason === "string"
          ? { reason: reason.slice(0, 1000) }
          : {}),
      })),
      available: valid.length === entries.length,
      warning:
        valid.length === entries.length
          ? null
          : `${filename} contains invalid player records. Valid records are shown; fix the file before changing this list.`,
    };
  } catch (cause) {
    if (cause.code === "ENOENT")
      return { records: [], available: true, warning: null };
    return {
      records: [],
      available: false,
      warning: `${filename} could not be read. Check its JSON and file permissions, then refresh.`,
    };
  }
}

const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
const sourcePriority = {
  banned: 0,
  whitelist: 1,
  operator: 2,
  cache: 3,
  observed: 4,
};
export function createPlayerHistory({
  records = [],
  persist,
  now = () => new Date().toISOString(),
  delayMs = 400,
}) {
  const history = Array.isArray(records)
    ? records
        .filter(
          (entry) =>
            validPlayerName(entry?.name) &&
            (!entry.uuid || validPlayerUuid(entry.uuid)),
        )
        .map((entry) => ({
          name: entry.name,
          ...(entry.uuid ? { uuid: entry.uuid.toLowerCase() } : {}),
          firstSeen: timestamp(entry.firstSeen),
          lastSeen: timestamp(entry.lastSeen),
          source: Object.hasOwn(sourcePriority, entry.source)
            ? entry.source
            : "cache",
        }))
    : [];
  const byUuid = new Map();
  const byName = new Map();
  const index = (entry) => {
    if (entry.uuid) byUuid.set(entry.uuid, entry);
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(entry);
  };
  for (const entry of history) index(entry);
  let timer;
  let dirty = false;
  let pending = Promise.resolve();
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (dirty) {
      dirty = false;
      const snapshot = history.map((entry) => ({ ...entry }));
      pending = pending.catch(() => {}).then(() => persist(snapshot));
    }
    return pending;
  };
  const changed = () => {
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => {
        void flush().catch(() => {
          dirty = true;
        });
      }, delayMs);
      timer.unref?.();
    }
  };
  const upsert = (player, source, seen) => {
    if (
      !validPlayerName(player?.name) ||
      (player.uuid && !validPlayerUuid(player.uuid))
    )
      return;
    const uuid = player.uuid?.toLowerCase();
    const named = byName.get(player.name.toLowerCase());
    let entry =
      (uuid ? byUuid.get(uuid) : undefined) ??
      (named ? [...named].find((item) => !uuid || !item.uuid) : undefined);
    if (!entry) {
      entry = {
        name: player.name,
        ...(uuid ? { uuid } : {}),
        firstSeen: null,
        lastSeen: null,
        source,
      };
      history.push(entry);
      changed();
    }
    const before = JSON.stringify(entry);
    const oldName = entry.name.toLowerCase();
    // Files can lag a newly observed login or retain a banned player's old name.
    if (sourcePriority[source] >= sourcePriority[entry.source])
      entry.name = player.name;
    if (sourcePriority[source] > sourcePriority[entry.source])
      entry.source = source;
    if (uuid) entry.uuid = uuid;
    if (source === "observed") {
      entry.source = source;
      if (seen) {
        entry.firstSeen ??= seen;
        entry.lastSeen = seen;
      }
    }
    if (oldName !== entry.name.toLowerCase()) {
      byName.get(oldName)?.delete(entry);
      if (byName.get(oldName)?.size === 0) byName.delete(oldName);
    }
    index(entry);
    if (before !== JSON.stringify(entry)) changed();
  };
  return {
    seed(entries, source) {
      for (const entry of entries) upsert(entry, source);
    },
    observe(player) {
      upsert(player, "observed", now());
    },
    identify(player) {
      upsert(player, "observed");
    },
    snapshot(
      online,
      bans,
      bansAvailable = true,
      { operators = [], whitelist = [], whitelistAvailable = true } = {},
    ) {
      const bansByUuid = new Map();
      const bansByName = new Map();
      for (const ban of bans) {
        if (ban.uuid) bansByUuid.set(ban.uuid.toLowerCase(), ban);
        bansByName.set(ban.name.toLowerCase(), ban);
      }
      const membership = (entries) => {
        const uuids = new Set(
          entries
            .filter((entry) => entry.uuid)
            .map((entry) => entry.uuid.toLowerCase()),
        );
        const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
        const unboundNames = new Set(
          entries
            .filter((entry) => !entry.uuid)
            .map((entry) => entry.name.toLowerCase()),
        );
        return (entry) =>
          entry.uuid
            ? uuids.has(entry.uuid.toLowerCase()) ||
              unboundNames.has(entry.name.toLowerCase())
            : names.has(entry.name.toLowerCase());
      };
      const operator = membership(operators);
      const whitelisted = membership(whitelist);
      return history
        .map((entry) => {
          const active = online.get(entry.name.toLowerCase());
          const namedBan = bansByName.get(entry.name.toLowerCase());
          const ban = entry.uuid
            ? (bansByUuid.get(entry.uuid) ??
              (!namedBan?.uuid ? namedBan : undefined))
            : namedBan;
          return {
            ...entry,
            online: Boolean(
              active &&
              (!active.uuid || !entry.uuid || active.uuid === entry.uuid),
            ),
            banned: bansAvailable ? Boolean(ban) : null,
            operator: operator(entry),
            whitelisted: whitelistAvailable ? whitelisted(entry) : null,
            ...(ban?.reason ? { banReason: ban.reason } : {}),
          };
        })
        .sort(
          (a, b) =>
            Number(b.online) - Number(a.online) ||
            (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") ||
            a.name.localeCompare(b.name),
        );
    },
    flush,
  };
}
