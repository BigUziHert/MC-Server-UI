import { randomUUID } from "node:crypto";

export function auditEntry(
  category,
  action,
  detail,
  actor = "Local administrator",
  context = {},
) {
  return {
    id: randomUUID(),
    category,
    action,
    detail,
    actor,
    createdAt: new Date().toISOString(),
    ...context,
  };
}

export function auditHistory(entries) {
  // Older releases persisted these action names. Normalize the view without
  // rewriting the original history retained on disk.
  const legacy = {
    "Launchpad installation completed": "Content installed",
    "Content installed": "Content installed",
    "Launchpad mod removed": "Mod deleted",
    "Mod removed": "Mod deleted",
  };
  return entries
    .map((entry) =>
      Object.hasOwn(legacy, entry.action)
        ? { ...entry, category: "file", action: legacy[entry.action] }
        : entry,
    )
    .filter((entry) =>
      ["server", "file", "backup", "user", "player"].includes(entry.category),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function contentKind(relative, type = "file", world = "world") {
  const normalized = String(relative).replace(/\\/g, "/").replace(/\/$/, "");
  if (type === "directory") return "Directory";
  if (/^mods\/[^/]+\.jar(?:\.disabled)?$/i.test(normalized)) return "Mod";
  if (/^plugins\/[^/]+\.jar(?:\.disabled)?$/i.test(normalized)) return "Plugin";
  const prefix = `${String(world).replace(/\\/g, "/").replace(/\/$/, "")}/datapacks/`;
  if (
    normalized.startsWith(prefix) &&
    /^[^/]+\.zip(?:\.disabled)?$/i.test(normalized.slice(prefix.length))
  )
    return "Datapack";
  return "File";
}
