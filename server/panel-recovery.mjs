import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectServerDirectory } from "./import.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const identity = (stat) => [stat.dev, stat.ino, stat.birthtimeMs];
const stamp = (stat) => [...identity(stat), stat.size, stat.mtimeMs, stat.mode];
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Discovery never registers, creates, moves, or starts a server. Only direct,
// canonical managed instance folders qualify for the explicit fleet recovery API.
export function createPanelRecovery({ dataDir, registered = () => [] }) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir))
    throw fail(
      500,
      "Server recovery requires the panel's absolute data folder.",
    );
  const root = path.resolve(dataDir);
  let rootIdentity;
  async function regularDirectory(directory) {
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(directory)) !== path.resolve(directory)
    )
      throw fail(
        409,
        "This saved server folder changed or contains a symbolic link. Restore its original folder before recovering it.",
      );
    return stat;
  }
  async function instances() {
    const stat = await regularDirectory(root);
    const current = digest(identity(stat));
    if (rootIdentity && current !== rootIdentity)
      throw fail(
        409,
        "Panel storage changed. Restart MC Panel before recovering servers.",
      );
    rootIdentity ??= current;
    const directory = path.join(root, "instances");
    await regularDirectory(directory);
    return directory;
  }
  function assertUnregistered(id) {
    if (typeof id !== "string" || !uuid.test(id))
      throw fail(400, "Choose a saved server from the recovery list.");
    if (
      registered().some((entry) => entry.id.toLowerCase() === id.toLowerCase())
    )
      throw fail(
        409,
        "This server is already in the panel. Refresh the server list.",
      );
  }
  async function location(id) {
    assertUnregistered(id);
    const directory = path.join(await instances(), id);
    const instance = await regularDirectory(directory);
    const serverDir = path.join(directory, "server");
    const server = await regularDirectory(serverDir);
    return { directory, serverDir, instance, server };
  }
  async function snapshot(id) {
    const found = await location(id);
    const entries = await fs.readdir(found.serverDir, { withFileTypes: true });
    if (entries.length > 10000)
      throw fail(
        409,
        "This saved server has too many top-level entries to review. Organize its folder before recovering it.",
      );
    const files = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Root file metadata catches startup/configuration changes without walking
      // or hashing world contents. lstat never follows entries that are links.
      const stat = await fs.lstat(path.join(found.serverDir, entry.name));
      files.push([
        entry.name,
        stat.isDirectory() ? identity(stat) : stamp(stat),
      ]);
    }
    let metadata = null;
    try {
      const stat = await fs.lstat(path.join(found.directory, "panel.json"));
      if (!stat.isFile() || stat.isSymbolicLink())
        throw fail(
          409,
          "The saved panel metadata is not a regular file. Restore it before recovering this server.",
        );
      metadata = stamp(stat);
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    return {
      ...found,
      revision: digest([
        id,
        rootIdentity,
        identity(found.instance),
        identity(found.server),
        files,
        metadata,
      ]),
    };
  }
  return {
    async list() {
      let directory;
      try {
        directory = await instances();
      } catch (cause) {
        if (cause.code === "ENOENT") return { candidates: [], warnings: [] };
        throw cause;
      }
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const known = new Set(
        registered().map((entry) => entry.id.toLowerCase()),
      );
      const candidates = [],
        warnings = [];
      const possible = entries
        .filter(
          (entry) =>
            uuid.test(entry.name) && !known.has(entry.name.toLowerCase()),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of possible.slice(0, 1000)) {
        try {
          const found = await location(entry.name);
          if (!(await fs.readdir(found.serverDir)).length) continue;
          candidates.push({
            id: entry.name,
            name: `Recovered server ${entry.name.slice(0, 8)}`,
            directory: found.serverDir,
          });
        } catch {
          warnings.push(
            `Skipped an unavailable or linked saved server folder (${entry.name}).`,
          );
        }
      }
      if (possible.length > 1000)
        warnings.push(
          "Only the first 1,000 saved server folders are listed. Recover those before checking again.",
        );
      return { candidates, warnings };
    },
    async inspect(id) {
      const before = await snapshot(id);
      const inspection = await inspectServerDirectory(before.serverDir, {
        requireCanonical: true,
        forbiddenDirectories: registered()
          .map((entry) => entry.serverDir)
          .filter(Boolean),
      });
      const after = await snapshot(id);
      if (before.revision !== after.revision)
        throw fail(
          409,
          "The saved server changed during inspection. Review it again.",
        );
      return {
        ...inspection,
        id,
        name: `Recovered server ${id.slice(0, 8)}`,
        dataDir: before.directory,
        serverDir: before.serverDir,
        storage: "instance",
        revision: after.revision,
      };
    },
  };
}
