import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

// All runtimes share one serialization queue for this computer's credential.
// An explicit null setting prevents legacy keys from being resurrected.
const pending = new Map();
const listeners = new Map();
const normalize = (value) => ({
  curseforgeApiKey:
    typeof value?.curseforgeApiKey === "string" && value.curseforgeApiKey.trim()
      ? value.curseforgeApiKey
      : null,
});
export function catalogSettings(dataDir, safePath, legacy = []) {
  const location = () => safePath(dataDir, "catalog-settings.json");
  const serialized = async (work) => {
    const file = await location();
    const operation = (pending.get(file) ?? Promise.resolve())
      .catch(() => {})
      .then(() => work(file));
    pending.set(file, operation);
    try {
      return await operation;
    } finally {
      if (pending.get(file) === operation) pending.delete(file);
    }
  };
  const read = async (file) => {
    try {
      return normalize(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw cause;
    }
  };
  const write = async (file, value) => {
    const temporary = await safePath(
      dataDir,
      `catalog-settings.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temporary, JSON.stringify(normalize(value)), {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, file);
      // Notification is synchronous: once set resolves, every open runtime has
      // discarded results obtained using the previous credential.
      for (const listener of listeners.get(file) ?? []) listener();
    } finally {
      await fs.rm(temporary, { force: true });
    }
  };
  return {
    get: () =>
      serialized(async (file) => {
        const shared = await read(file);
        if (shared) return shared;
        for (const previous of legacy) {
          if (previous === file) continue;
          const value = await read(previous);
          if (value?.curseforgeApiKey) {
            await write(file, value);
            return value;
          }
        }
        return { curseforgeApiKey: null };
      }),
    set: (value) => serialized((file) => write(file, value)),
    async subscribe(listener) {
      const file = await location();
      const subscribers = listeners.get(file) ?? new Set();
      subscribers.add(listener);
      listeners.set(file, subscribers);
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size) listeners.delete(file);
      };
    },
  };
}
