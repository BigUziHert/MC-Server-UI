import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseProperties } from "./import.mjs";
import { decodeText } from "./text-encoding.mjs";
import { validPlayerName, validPlayerUuid } from "./player-history.mjs";

const conflict = (message) =>
  Object.assign(new Error(message), { status: 409 });

// Call only while the stopped server holds the exclusive file mutation guard.
// Keep complete records: ban expiry/source and operator bypass flags belong to
// Minecraft and must survive edits to a different player.
export async function saveOfflinePlayer({
  serverDir,
  safePath,
  action,
  player,
  reason,
}) {
  const filename = ["op", "deop"].includes(action)
    ? "ops.json"
    : ["ban", "unban"].includes(action)
      ? "banned-players.json"
      : "whitelist.json";
  const target = await safePath(serverDir, filename);
  let records = [];
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
      throw conflict(`${filename} must be a JSON file under 5 MB.`);
    records = JSON.parse(await fs.readFile(target, "utf8"));
    if (
      !Array.isArray(records) ||
      records.length > 50000 ||
      records.some(
        (entry) =>
          !validPlayerName(entry?.name) || !validPlayerUuid(entry?.uuid),
      )
    )
      throw conflict(`${filename} contains invalid player records.`);
  } catch (cause) {
    if (cause instanceof SyntaxError)
      throw conflict(
        `${filename} contains invalid JSON. Fix it before editing players.`,
      );
    if (cause.code !== "ENOENT") throw cause;
  }
  const matches = (entry) =>
    entry.uuid.toLowerCase() === player.uuid.toLowerCase();
  let next;
  if (["deop", "unban", "remove"].includes(action)) {
    next = records.filter((entry) => !matches(entry));
  } else if (action === "ban") {
    next = records.filter((entry) => !matches(entry));
    next.push({
      ...player,
      created: new Date()
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " +0000"),
      source: "MC Panel",
      expires: "forever",
      reason: reason?.trim() || "Banned by an operator.",
    });
  } else if (records.some(matches)) {
    return;
  } else if (action === "op") {
    let level = 4;
    try {
      const propertiesPath = await safePath(serverDir, "server.properties");
      const stat = await fs.stat(propertiesPath);
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw conflict("server.properties must be a text file under 1 MB.");
      const properties = parseProperties(
        decodeText(await fs.readFile(propertiesPath)).text,
      );
      level = Number(properties.get("op-permission-level") ?? 4);
      if (!Number.isInteger(level) || level < 1 || level > 4)
        throw conflict(
          "Set op-permission-level to a number from 1 to 4 in server.properties.",
        );
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    next = [...records, { ...player, level, bypassesPlayerLimit: false }];
  } else if (action === "add") {
    next = [...records, player];
  } else {
    throw conflict("Unknown offline player action.");
  }
  const temporary = path.join(serverDir, `.panel-players-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
      flag: "wx",
    });
    await safePath(serverDir, filename);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
