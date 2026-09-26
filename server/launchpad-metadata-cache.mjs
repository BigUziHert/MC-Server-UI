import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { safeProjectUrl } from "../shared/launchpad-project.mjs";

const maximumBytes = 4 * 1024 ** 2;
const maximumEntries = 4000;
const filename = "metadata-cache.json";
const token = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const checksum = (value) =>
  typeof value === "string" && /^[a-f0-9]{128}$/.test(value);
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function displayFields(value) {
  const result = {};
  for (const key of ["title", "author", "versionName"])
    if (
      typeof value[key] === "string" &&
      value[key].trim() &&
      value[key].length <= 512 &&
      !/[\x00-\x1f\x7f]/.test(value[key])
    )
      result[key] = value[key];
  for (const key of ["url", "iconUrl"])
    if (typeof value[key] === "string" && value[key].length <= 2048) {
      const url = safeProjectUrl(value[key]);
      if (url) result[key] = url;
    }
  return result;
}

// This is disposable display data, separate from installation receipts. File
// paths, trusted stat stamps, update results, and negative lookups never persist.
export async function createLaunchpadMetadataCache({
  pathFor,
  platforms,
  now = Date.now,
  debounceMs = 250,
}) {
  const allowed = new Set(platforms);
  const entries = new Map();
  let bytes = 0,
    generation = 0,
    revision = 0,
    dirty = false,
    closed = false,
    timer = null,
    writes = Promise.resolve();
  const normalize = (row) => {
    if (!plain(row) || !plain(row.value)) return null;
    if (row.kind === "identity") {
      const value = row.value;
      if (
        !checksum(row.sha512) ||
        !allowed.has(value.platform) ||
        !token(value.projectId) ||
        !token(value.versionId)
      )
        return null;
      return {
        kind: "identity",
        sha512: row.sha512,
        value: {
          platform: value.platform,
          projectId: value.projectId,
          versionId: value.versionId,
          ...displayFields(value),
        },
      };
    }
    if (
      row.kind !== "project" ||
      !allowed.has(row.platform) ||
      !token(row.projectId)
    )
      return null;
    const value = displayFields(row.value);
    delete value.versionName;
    if (!Object.keys(value).length) return null;
    return {
      kind: "project",
      platform: row.platform,
      projectId: row.projectId,
      value,
      checkedAt:
        Number.isFinite(row.checkedAt) &&
        row.checkedAt >= 0 &&
        row.checkedAt <= now()
          ? row.checkedAt
          : 0,
    };
  };
  const keyFor = (row) =>
    row.kind === "identity"
      ? `identity:${row.sha512}`
      : `project:${row.platform}:${row.projectId}`;
  const insert = (row) => {
    const key = keyFor(row),
      content = JSON.stringify(row),
      previous = entries.get(key);
    if (previous?.content === content) return false;
    if (previous) {
      bytes -= previous.bytes;
      entries.delete(key);
    }
    const size = Buffer.byteLength(content) + 1;
    entries.set(key, { row, content, bytes: size });
    bytes += size;
    while (entries.size > maximumEntries || bytes > maximumBytes - 64) {
      const [oldKey, old] = entries.entries().next().value;
      entries.delete(oldKey);
      bytes -= old.bytes;
    }
    return true;
  };
  try {
    const target = await pathFor(filename);
    const before = await fs.lstat(target);
    if (
      before.isFile() &&
      !before.isSymbolicLink() &&
      before.size <= maximumBytes
    ) {
      const handle = await fs.open(target, "r");
      try {
        const opened = await handle.stat();
        if (opened.ino === before.ino && opened.dev === before.dev) {
          // Bound the read even if another process grows the cache after lstat.
          const buffer = Buffer.alloc(maximumBytes + 1);
          let length = 0;
          while (length < buffer.length) {
            const read = await handle.read(
              buffer,
              length,
              buffer.length - length,
            );
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length <= maximumBytes) {
            const saved = JSON.parse(buffer.toString("utf8", 0, length));
            if (saved?.version === 1 && Array.isArray(saved.entries))
              for (const candidate of saved.entries.slice(-maximumEntries)) {
                const row = normalize(candidate);
                if (row) insert(row);
              }
          }
        }
      } finally {
        await handle.close();
      }
    }
  } catch {
    // An absent, damaged, or inaccessible cache must never block inventory.
  }
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return writes;
    dirty = false;
    const savedRevision = revision;
    const content = `{"version":1,"entries":[${[...entries.values()].map((entry) => entry.content).join(",")}]}`;
    writes = writes.then(async () => {
      if (savedRevision !== revision) return;
      const temporaryName = `metadata-cache-${randomUUID()}.tmp`;
      let temporary;
      try {
        temporary = await pathFor(temporaryName);
        await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        if (savedRevision === revision) {
          // Recheck the private anchor after asynchronous IO and before promotion.
          await pathFor(temporaryName);
          const destination = await pathFor(filename);
          if (savedRevision === revision)
            await fs.rename(temporary, destination);
        }
      } catch {
        // Retrying on the next change/close is sufficient for disposable data.
        if (savedRevision === revision) dirty = true;
      } finally {
        if (temporary)
          try {
            await fs.rm(await pathFor(temporaryName), { force: true });
          } catch {}
      }
    });
    return writes;
  };
  const changed = () => {
    revision++;
    dirty = true;
    if (!timer) {
      timer = setTimeout(flush, debounceMs);
      timer.unref?.();
    }
  };
  const get = (key) => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    // Reads update eviction order without causing a disk write.
    entries.delete(key);
    entries.set(key, entry);
    return structuredClone(entry.row);
  };
  return {
    get generation() {
      return generation;
    },
    identity: (sha512) => get(`identity:${sha512}`)?.value,
    project: (platform, projectId) => get(`project:${platform}:${projectId}`),
    rememberIdentity(sha512, value, expectedGeneration = generation) {
      if (closed || expectedGeneration !== generation) return;
      const row = normalize({ kind: "identity", sha512, value });
      if (row && insert(row)) changed();
    },
    rememberProject(
      platform,
      projectId,
      value,
      checkedAt,
      expectedGeneration = generation,
    ) {
      if (closed || expectedGeneration !== generation) return;
      const previous = entries.get(`project:${platform}:${projectId}`)?.row
        .value;
      const row = normalize({
        kind: "project",
        platform,
        projectId,
        value: { ...previous, ...value },
        checkedAt,
      });
      if (row && insert(row)) changed();
    },
    clear() {
      if (closed) return;
      generation++;
      entries.clear();
      bytes = 0;
      changed();
    },
    async close() {
      closed = true;
      // A previous best-effort write may still fail while close is waiting.
      await flush();
      if (dirty) await flush();
    },
  };
}
