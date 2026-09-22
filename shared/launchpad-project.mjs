export function safeProjectUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

// Identified files from older panels/receipts may lack project metadata.
// These providers accept their stable IDs directly; never guess from a JAR name.
export function projectPageUrl({ platform, projectId, url } = {}) {
  const explicit = safeProjectUrl(url);
  if (explicit) return explicit;
  if (typeof projectId !== "string") return undefined;
  if (
    platform === "modrinth" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)
  )
    return `https://modrinth.com/project/${encodeURIComponent(projectId)}`;
  if (/^[1-9]\d{0,15}$/.test(projectId)) {
    if (platform === "curseforge")
      return `https://www.curseforge.com/projects/${projectId}`;
    if (platform === "spigot")
      return `https://www.spigotmc.org/resources/${projectId}/`;
    if (platform === "ftb")
      return `https://www.feed-the-beast.com/modpacks/${projectId}`;
  }
  if (
    platform === "atlauncher" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)
  )
    return `https://atlauncher.com/pack/${encodeURIComponent(projectId)}`;
  return undefined;
}
