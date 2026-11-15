import fs from "node:fs/promises";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { parseProperties } from "./import.mjs";

const release = (value) =>
  typeof value === "string" &&
  /^(?:1\.[0-9]+(?:\.[0-9]+)?|[2-9][0-9]\.[0-9]+(?:\.[0-9]+)?|[0-9]{2}w[0-9]{2}[a-z]|(?:1\.[0-9]+(?:\.[0-9]+)?|[2-9][0-9]\.[0-9]+)(?:-(?:pre|rc)[ -]?[0-9]+|-(?:snapshot|pre|rc)-[0-9]+))$/.test(
    value,
  )
    ? value
    : null;
const wanted = new Set([
  "install.properties",
  "fabric-server-launch.properties",
  "quilt-server-launch.properties",
  "version.json",
  "META-INF/MANIFEST.MF",
  "META-INF/versions.list",
  "patch.properties",
]);

function manifestSections(source) {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/\n /g, "")
    .split(/\n\n+/)
    .map((section) => {
      const fields = new Map();
      for (const line of section.split("\n")) {
        if (!line) continue;
        const match = /^([a-zA-Z0-9_-]+): (.*)$/.exec(line);
        if (!match || fields.has(match[1].toLowerCase()))
          throw new Error("Invalid manifest attributes");
        fields.set(match[1].toLowerCase(), match[2]);
      }
      return fields;
    });
}

function bundledVersion(source) {
  if (!source) return {};
  const lines = source.trim().split(/\r?\n/);
  if (lines.length !== 1) return {};
  const [hash, id, target, extra] = lines[0].split("\t");
  if (
    extra !== undefined ||
    !/^[a-f0-9]{64}$/i.test(hash) ||
    !release(id) ||
    !target ||
    target.includes("\\") ||
    target.split("/").some((part) => !part || part === "." || part === "..")
  )
    return {};
  const product = /^(paper|purpur|folia)-/.exec(target.split("/").at(-1));
  return {
    gameVersion: id,
    ...(product
      ? {
          software: { paper: "Paper", purpur: "Purpur", folia: "Folia" }[
            product[1]
          ],
        }
      : {}),
  };
}

// Inspect only bounded metadata; no archive is extracted or executed. Filename
// guesses cannot select a Minecraft release for an imported server.
async function jarMetadata(target) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 ** 3)
    return new Map();
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(
      target,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (cause, archive) => (cause ? reject(cause) : resolve(archive)),
    ),
  );
  const values = new Map();
  let entries = 0;
  try {
    for (;;) {
      const entry = await new Promise((resolve, reject) => {
        const done = (value, cause) => {
          zip.off("entry", onEntry);
          zip.off("end", onEnd);
          zip.off("error", onError);
          cause ? reject(cause) : resolve(value);
        };
        const onEntry = (value) => done(value),
          onEnd = () => done(null),
          onError = (cause) => done(null, cause);
        zip.once("entry", onEntry);
        zip.once("end", onEnd);
        zip.once("error", onError);
        zip.readEntry();
      });
      if (!entry) break;
      if (++entries > 250000) throw new Error("Too many archive entries");
      if (!wanted.has(entry.fileName)) continue;
      const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (
        values.has(entry.fileName) ||
        entry.uncompressedSize > 256 * 1024 ||
        entry.generalPurposeBitFlag & 1 ||
        (entry.versionMadeBy >>> 8 === 3 && kind && kind !== 0x8000)
      )
        throw new Error("Invalid launcher metadata");
      const stream = await new Promise((resolve, reject) =>
        zip.openReadStream(entry, (cause, value) =>
          cause ? reject(cause) : resolve(value),
        ),
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        if ((size += chunk.length) > entry.uncompressedSize)
          throw new Error("Invalid metadata size");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (size !== entry.uncompressedSize || crc32(bytes) !== entry.crc32)
        throw new Error("Invalid metadata checksum");
      values.set(entry.fileName, bytes.toString("utf8"));
    }
    return values;
  } finally {
    zip.close();
  }
}

export async function installedMinecraftMetadata({
  serverDir,
  safePath,
  configuration,
  detected = {},
}) {
  try {
    if (
      !["jar", "java-args", "script"].includes(configuration.launchType) ||
      (configuration.launchType === "script" && !detected.expandedArgs)
    )
      return {};
    const args = detected.expandedArgs ?? configuration.launchArgs ?? [];
    const jarIndex = args.indexOf("-jar");
    const selected =
      configuration.launchType === "jar"
        ? configuration.jar
        : jarIndex >= 0
          ? args[jarIndex + 1]
          : null;
    const metadata = selected
      ? await jarMetadata(
          await safePath(serverDir, selected.replace(/\\/g, "/")),
        )
      : new Map();
    const installer = parseProperties(metadata.get("install.properties") ?? "");
    const main = metadata.get("META-INF/MANIFEST.MF") ?? "";
    const sections = manifestSections(main);
    const attributes = sections[0];
    const mainClass = attributes.get("main-class") ?? "";
    const software =
      metadata.has("fabric-server-launch.properties") ||
      installer.has("fabric-loader-version") ||
      /^net\.fabricmc\./i.test(mainClass)
        ? "Fabric"
        : metadata.has("quilt-server-launch.properties") ||
            /^org\.quiltmc\./i.test(mainClass)
          ? "Quilt"
          : (detected.software ?? configuration.software);
    if (!["Fabric", "Quilt"].includes(software)) {
      const title = `${attributes.get("implementation-title") ?? ""} ${mainClass} ${attributes.get("brand-id") ?? ""}`;
      const bundled = bundledVersion(metadata.get("META-INF/versions.list"));
      const forge =
        /^(?:net\.minecraftforge\.fml|cpw\.mods\.fml)\.relauncher\.ServerLaunchWrapper$|^net\.minecraftforge\.server\.ServerMain$/.test(
          mainClass,
        );
      const identified = forge
        ? "Forge"
        : /purpur/i.test(title)
          ? "Purpur"
          : /folia/i.test(title)
            ? "Folia"
            : /paper(?:clip|mc)?/i.test(title)
              ? (bundled.software ?? "Paper")
              : /spigot/i.test(title)
                ? "Spigot"
                : /bukkit/i.test(title)
                  ? "Bukkit"
                  : /velocity/i.test(title)
                    ? "Velocity"
                    : /net\.minecraft\.(?:server|bundler)\.Main/.test(title)
                      ? "Vanilla"
                      : null;
      const versionInfo = JSON.parse(metadata.get("version.json") ?? "{}");
      const patch = parseProperties(metadata.get("patch.properties") ?? "");
      // Forge's manifest explicitly identifies the referenced Minecraft server;
      // this is launcher metadata, not a guess from the user-selected JAR name.
      const forgeMinecraft = forge
        ? (attributes.get("class-path") ?? "").split(/\s+/).flatMap((entry) => {
            const match = /^minecraft_server\.(.+)\.jar$/.exec(entry);
            return match && release(match[1]) ? [match[1]] : [];
          })
        : [];
      const releases = [
        ...new Set(
          [
            release(versionInfo.id),
            release(attributes.get("minecraft-version")),
            release(patch.get("version")),
            bundled.gameVersion,
            ...forgeMinecraft,
          ].filter(Boolean),
        ),
      ];
      const gameVersion = releases.length === 1 ? releases[0] : null;
      if (!identified) return {};
      if (forge) {
        const forgeSection = sections.find(
          (section) => section.get("name") === "net/minecraftforge/common/",
        );
        const rawVersion =
          forgeSection?.get("implementation-version") ??
          attributes.get("implementation-version");
        const loaderVersion =
          gameVersion && rawVersion?.startsWith(`${gameVersion}-`)
            ? rawVersion.slice(gameVersion.length + 1)
            : rawVersion;
        return {
          software: identified,
          ...(gameVersion ? { gameVersion } : {}),
          ...(/^[0-9]+(?:\.[0-9]+){2,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(
            loaderVersion ?? "",
          )
            ? { version: loaderVersion }
            : {}),
        };
      }
      return {
        software: identified,
        ...(gameVersion ? { gameVersion, version: gameVersion } : {}),
        ...(!gameVersion &&
        identified === "Velocity" &&
        attributes.get("implementation-version")
          ? { version: attributes.get("implementation-version") }
          : {}),
      };
    }
    const result = { software };
    const loader = software.toLowerCase();
    const installerVersion = installer.get(`${loader}-loader-version`);
    if (
      installerVersion &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(installerVersion)
    )
      result.version = installerVersion;
    const explicit = args
      .find((arg) =>
        arg.startsWith(
          `-D${loader === "fabric" ? "fabric" : "loader"}.gameVersion=`,
        ),
      )
      ?.split("=")
      .slice(1)
      .join("=");
    if (explicit !== undefined && !release(explicit)) return result;
    const configuredVersion =
      release(explicit) ?? release(installer.get("game-version"));
    if (configuredVersion) return { ...result, gameVersion: configuredVersion };
    let gameJar = args
      .find((arg) =>
        arg.startsWith(
          `-D${loader === "fabric" ? "fabric" : "loader"}.gameJarPath=`,
        ),
      )
      ?.split("=")
      .slice(1)
      .join("=");
    if (!gameJar) {
      try {
        const propertiesPath = await safePath(
          serverDir,
          `${loader}-server-launcher.properties`,
        );
        const stat = await fs.lstat(propertiesPath);
        if (!stat.isFile() || stat.size > 256 * 1024) return result;
        gameJar = parseProperties(
          await fs.readFile(propertiesPath, "utf8"),
        ).get("serverJar");
      } catch (cause) {
        if (cause.code !== "ENOENT") return result;
      }
    }
    const game = gameJar || "server.jar";
    const gameMetadata =
      game === selected
        ? metadata
        : await jarMetadata(
            await safePath(serverDir, game.replace(/\\/g, "/")),
          );
    const gameVersion = release(
      JSON.parse(gameMetadata.get("version.json") ?? "{}").id,
    );
    return { ...result, ...(gameVersion ? { gameVersion } : {}) };
  } catch {
    return {};
  }
}
