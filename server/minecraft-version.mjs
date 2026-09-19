export function minecraftGameVersion({
  software,
  version,
  minecraftVersion,
  gameVersion,
}) {
  // Installed or detected game metadata is distinct from the loader's build.
  for (const value of [minecraftVersion, gameVersion])
    if (typeof value === "string" && value.trim()) return value.trim();

  const loader = typeof software === "string" ? software.toLowerCase() : "";
  if (loader === "neoforge") {
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
    if (parts)
      return Number(parts[1]) < 26
        ? `1.${parts[1]}${parts[2] === "0" ? "" : "." + parts[2]}`
        : `${parts[1]}.${parts[2]}${parts[3] === "0" ? "" : "." + parts[3]}`;
  } else if (loader === "forge")
    return /^(1\.\d+(?:\.\d+)?)-/.exec(version ?? "")?.[1] ?? null;
  else if (["paper", "purpur", "vanilla", "spigot", "folia"].includes(loader))
    return /^\d+\.\d+(?:\.\d+)?$/.test(version ?? "") ? version : null;
  return null;
}
