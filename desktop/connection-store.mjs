import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";

const filename = "desktop-connections.json";
const maximumPanels = 50;
const maximumBytes = 128 * 1024;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fingerprint = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const empty = () => ({ activeId: "local", panels: [] });
const invalid = () =>
  Object.assign(new Error("Provide valid saved panel connections."), {
    status: 400,
  });
const unsafePath = () =>
  Object.assign(
    new Error("Saved connections require an ordinary directory and file."),
    { code: "PANEL_CONNECTION_PATH_INVALID" },
  );
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function panelRecord(value) {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !["id", "origin", "trustedFingerprint", "signedIn"].includes(key),
    ) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    typeof value.origin !== "string"
  )
    throw invalid();
  // A saved origin is exactly URL.origin, never an invitation or a URL that
  // needs normalization. Verification of the certificate belongs to Electron.
  if (
    normalizePanelConnectionUrl(value.origin) !== `${value.origin}/` ||
    new URL(value.origin).origin !== value.origin
  )
    throw invalid();
  if (
    value.trustedFingerprint !== undefined &&
    (typeof value.trustedFingerprint !== "string" ||
      !fingerprint.test(value.trustedFingerprint))
  )
    throw invalid();
  if (value.signedIn !== undefined && typeof value.signedIn !== "boolean")
    throw invalid();
  return {
    id: value.id,
    origin: value.origin,
    ...(value.trustedFingerprint !== undefined
      ? { trustedFingerprint: value.trustedFingerprint }
      : {}),
    ...(value.signedIn !== undefined ? { signedIn: value.signedIn } : {}),
  };
}

function snapshot(value, recover = false) {
  if (
    !object(value) ||
    !Array.isArray(value.panels) ||
    value.panels.length > maximumPanels ||
    (!recover &&
      (Object.keys(value).some(
        (key) => !["activeId", "panels"].includes(key),
      ) ||
        (value.activeId !== "local" &&
          (typeof value.activeId !== "string" || !uuid.test(value.activeId)))))
  ) {
    if (recover) return empty();
    throw invalid();
  }
  const panels = [];
  const ids = new Set();
  const origins = new Set();
  for (const entry of value.panels) {
    let panel;
    try {
      panel = panelRecord(entry);
    } catch (cause) {
      if (recover) continue;
      throw cause;
    }
    if (ids.has(panel.id) || origins.has(panel.origin)) continue;
    ids.add(panel.id);
    origins.add(panel.origin);
    panels.push(panel);
  }
  return {
    activeId: ids.has(value.activeId) ? value.activeId : "local",
    panels,
  };
}

export function createConnectionStore({ dataDir } = {}) {
  if (
    typeof dataDir !== "string" ||
    !path.isAbsolute(dataDir) ||
    dataDir.includes("\0")
  )
    throw new Error("Saved connections require an absolute data directory.");
  const directory = path.resolve(dataDir);
  let writes = Promise.resolve();
  let lastWrite = writes;
  let closed = false;
  let recoveredSnapshot;
  const recoverEmpty = () => {
    const value = empty();
    recoveredSnapshot = JSON.stringify(value);
    return value;
  };

  async function checkedDirectory(create = false) {
    const root = path.parse(directory).root;
    let current = root;
    for (const part of [
      "",
      ...path.relative(root, directory).split(path.sep).filter(Boolean),
    ]) {
      if (part) current = path.join(current, part);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (cause) {
        if (cause.code !== "ENOENT" || !create) throw cause;
        await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafePath();
    }
    return fs.stat(directory);
  }

  async function checkedFile(target) {
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw unsafePath();
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    return target;
  }

  function sameDirectory(first, second) {
    if (first.dev !== second.dev || first.ino !== second.ino)
      throw unsafePath();
  }

  return {
    async read() {
      await writes;
      recoveredSnapshot = undefined;
      let file;
      try {
        await checkedDirectory();
        const target = await checkedFile(path.join(directory, filename));
        file = await fs.open(
          target,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const stat = await file.stat();
        if (!stat.isFile()) throw unsafePath();
        if (stat.size > maximumBytes) return recoverEmpty();
        const buffer = Buffer.alloc(maximumBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > maximumBytes) return recoverEmpty();
        const parsed = JSON.parse(buffer.toString("utf8", 0, length));
        const saved = snapshot(parsed, true);
        if (JSON.stringify(parsed) !== JSON.stringify(saved))
          recoveredSnapshot = JSON.stringify(saved);
        return saved;
      } catch (cause) {
        // Reading damaged/obsolete records never rewrites or removes the file.
        if (cause.code === "ENOENT") return empty();
        if (cause instanceof SyntaxError) return recoverEmpty();
        throw cause;
      } finally {
        await file?.close();
      }
    },
    save(value) {
      if (closed)
        return Promise.reject(
          Object.assign(new Error("The saved connection store is closed."), {
            status: 503,
          }),
        );
      let saved;
      try {
        saved = snapshot(value);
      } catch (cause) {
        return Promise.reject(cause);
      }
      // Capture the caller's values now, before another queued write can wait.
      const contents = JSON.stringify(saved);
      const write = writes.then(async () => {
        // Restore/quit may resave the recovered view without a user change.
        // Keep the original bytes until the connection state actually changes.
        if (contents === recoveredSnapshot) return saved;
        const before = await checkedDirectory(true);
        const target = await checkedFile(path.join(directory, filename));
        const temporary = path.join(
          directory,
          `desktop-connections-${randomUUID()}.tmp`,
        );
        let file;
        let created = false;
        try {
          file = await fs.open(temporary, "wx", 0o600);
          created = true;
          await file.writeFile(contents);
          await file.sync();
          await file.close();
          file = undefined;
          sameDirectory(before, await checkedDirectory());
          await checkedFile(target);
          await fs.rename(temporary, target);
          recoveredSnapshot = undefined;
          return saved;
        } finally {
          await file?.close();
          if (created) {
            try {
              sameDirectory(before, await checkedDirectory());
              await fs.unlink(temporary);
            } catch {
              /* Never follow a replaced directory just to clean a temporary file. */
            }
          }
        }
      });
      lastWrite = write;
      writes = write.catch(() => {});
      return write;
    },
    close() {
      closed = true;
      return lastWrite;
    },
  };
}
