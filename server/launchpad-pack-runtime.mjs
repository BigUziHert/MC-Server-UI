import fs from "node:fs/promises";
import path from "node:path";

// Read only checksum-verified, privately extracted archive metadata. Never run
// pack scripts or infer a build from a mod filename or the installed server.
export async function inferPackRuntime(entries, input) {
  const found = new Map();
  const add = (loader, loaderVersion, gameVersion = input.gameVersion) => {
    if (!/^[a-z0-9][a-z0-9.+_-]{0,99}$/i.test(String(loaderVersion ?? "")))
      return;
    if (loader === "forge" && loaderVersion.startsWith(`${gameVersion}-`))
      loaderVersion = loaderVersion.slice(gameVersion.length + 1);
    const value = { loader, loaderVersion, gameVersion };
    found.set(JSON.stringify(value), value);
  };
  for (const entry of entries) {
    const name = entry.path.replaceAll("\\", "/");
    const library = name.match(
      /(?:^|\/)libraries\/net\/(neoforged\/neoforge|minecraftforge\/forge)\/([^/]+)\//i,
    );
    if (library)
      add(
        library[1].toLowerCase().startsWith("neoforged") ? "neoforge" : "forge",
        library[2],
      );
    if (!name.includes("/")) {
      const forgeJar = name.match(
        /^(forge|neoforge)-([a-z0-9.+_-]+?)(?:-(?:installer|universal|server))?\.jar$/i,
      );
      if (forgeJar) add(forgeJar[1].toLowerCase(), forgeJar[2]);
      const fabricJar = name.match(
        /^fabric-server-mc\.(.+)-loader\.([\d.]+)-launcher\.[\d.]+\.jar$/i,
      );
      if (fabricJar) add("fabric", fabricJar[2], fabricJar[1]);
    }
    if (entry.size > 256 * 1024 || name.includes("/")) continue;
    const basename = path.posix.basename(name).toLowerCase();
    if (
      ![
        "manifest.json",
        "variables.txt",
        "run.bat",
        "run.cmd",
        "run.sh",
        "start.bat",
        "start.cmd",
        "start.sh",
        "fabric-server-launcher.properties",
        "quilt-server-launcher.properties",
      ].includes(basename)
    )
      continue;
    const text = await fs.readFile(entry.stagedPath, "utf8");
    if (basename === "manifest.json") {
      let manifest;
      try {
        manifest = JSON.parse(text);
      } catch {
        continue;
      }
      const loaders = manifest.minecraft?.modLoaders;
      if (Array.isArray(loaders))
        for (const candidate of loaders) {
          const match =
            typeof candidate?.id === "string"
              ? candidate.id.match(/^(forge|neoforge|fabric|quilt)-(.+)$/)
              : null;
          if (match) add(match[1], match[2], manifest.minecraft.version);
        }
      continue;
    }
    const values = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(?:#|REM\b|::)/i.test(line)) continue;
      const assignment = line.match(
        /^\s*(?:(?:set|export)\s+)?["']?([a-z_]+)\s*=\s*["']?([^"'\s]+)["']?\s*$/i,
      );
      if (assignment) values.set(assignment[1].toUpperCase(), assignment[2]);
      for (const match of line.matchAll(
        /libraries[\\/]net[\\/](neoforged[\\/]neoforge|minecraftforge[\\/]forge)[\\/]([a-z0-9.+_-]+)[\\/]/gi,
      ))
        add(
          match[1].toLowerCase().startsWith("neoforged") ? "neoforge" : "forge",
          match[2],
        );
    }
    const gameVersion =
      values.get("MINECRAFT_VERSION") ??
      values.get("MC_VERSION") ??
      values.get("GAME_VERSION") ??
      input.gameVersion;
    const loader = (
      values.get("MODLOADER") ??
      values.get("LOADER") ??
      ""
    ).toLowerCase();
    if (["forge", "neoforge", "fabric", "quilt"].includes(loader))
      add(
        loader,
        values.get("MODLOADER_VERSION") ?? values.get("LOADER_VERSION"),
        gameVersion,
      );
    for (const id of ["forge", "neoforge", "fabric", "quilt"])
      if (values.has(`${id.toUpperCase()}_VERSION`))
        add(id, values.get(`${id.toUpperCase()}_VERSION`), gameVersion);
  }
  if (found.size > 1)
    throw Object.assign(
      new Error(
        "The server pack declares conflicting runtime versions. No server files were changed.",
      ),
      { status: 400 },
    );
  return [...found.values()][0];
}
