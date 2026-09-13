import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { safeInstallPath } from "./launchpad-archives.mjs";
import { launchpadError } from "./launchpad-network.mjs";

const limits = {
  metadata: 512 * 1024,
  nested: 16 * 1024 ** 2,
  total: 128 * 1024 ** 2,
  jars: 64,
  entries: 10000,
  depth: 3,
};
const metadataNames = [
  "META-INF/jarjar/metadata.json",
  "fabric.mod.json",
  "quilt.mod.json",
  "META-INF/neoforge.mods.toml",
  "META-INF/mods.toml",
  "META-INF/MANIFEST.MF",
];
const invalid = (message) => launchpadError(400, message);
const displayText = (value) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(value) &&
  !value.includes("${")
    ? value.trim()
    : undefined;

function openZip(source, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      settled = true;
      reject(signal.reason);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", aborted);
      aborted();
      return;
    }
    const callback = (error, zip) => {
      signal?.removeEventListener("abort", aborted);
      if (settled) {
        zip?.close();
        return;
      }
      settled = true;
      if (error) reject(error);
      else resolve(zip);
    };
    const options = {
      lazyEntries: true,
      autoClose: false,
      strictFileNames: true,
      validateEntrySizes: true,
    };
    if (Buffer.isBuffer(source)) yauzl.fromBuffer(source, options, callback);
    else yauzl.open(source, options, callback);
  });
}

function nextEntry(zip, signal) {
  return new Promise((resolve, reject) => {
    const finish = (done, value) => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      done(value);
    };
    const onEntry = (entry) => finish(resolve, entry);
    const onEnd = () => finish(resolve, null);
    const onError = (error) => finish(reject, error);
    const onAbort = () => finish(reject, signal.reason);
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else zip.readEntry();
  });
}

async function indexEntries(zip, budget, signal) {
  const entries = new Map(),
    seen = new Map(),
    parents = new Set();
  for (;;) {
    signal?.throwIfAborted();
    const entry = await nextEntry(zip, signal);
    if (!entry) return entries;
    if (++budget.entries > limits.entries)
      throw invalid(
        "Bundled dependency inspection exceeds 10,000 ZIP entries.",
      );
    const name = safeInstallPath(entry.fileName.replace(/\/$/, ""));
    const key = name.toLowerCase();
    const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
    if (kind && kind !== 0x8000 && kind !== 0x4000)
      throw invalid(
        "Bundled dependency archives cannot contain links or special files.",
      );
    if (entry.generalPurposeBitFlag & 1)
      throw invalid(
        "Encrypted bundled dependency archives cannot be inspected.",
      );
    const directory =
      entry.fileName.endsWith("/") ||
      kind === 0x4000 ||
      Boolean(entry.externalFileAttributes & 0x10);
    if (seen.has(key) || (!directory && parents.has(key)))
      throw invalid(
        "Bundled dependency archives contain duplicate or conflicting paths.",
      );
    const parts = key.split("/");
    for (let count = 1; count < parts.length; count++) {
      const parent = parts.slice(0, count).join("/");
      if (seen.get(parent) === false)
        throw invalid(
          "Bundled dependency archives contain conflicting file paths.",
        );
      parents.add(parent);
    }
    seen.set(key, directory);
    entries.set(name, { entry, directory });
  }
}

async function readEntry(zip, entry, maximum, budget, signal) {
  signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > maximum
  )
    throw invalid(
      `Bundled dependency entry ${entry.fileName} exceeds its ${maximum / 1024} KB inspection limit.`,
    );
  if ((budget.bytes += entry.uncompressedSize) > limits.total)
    throw invalid("Bundled dependency inspection exceeds 128 MB in total.");
  const stream = await new Promise((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      settled = true;
      reject(signal.reason);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", aborted);
      aborted();
      return;
    }
    zip.openReadStream(entry, (error, stream) => {
      signal?.removeEventListener("abort", aborted);
      if (settled) {
        stream?.destroy();
        return;
      }
      settled = true;
      if (error) reject(error);
      else resolve(stream);
    });
  });
  const aborted = () =>
    stream.destroy(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("Bundled dependency inspection cancelled."),
    );
  signal?.addEventListener("abort", aborted, { once: true });
  const chunks = [];
  let size = 0,
    checksum = 0;
  try {
    if (signal?.aborted) aborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > entry.uncompressedSize || size > maximum)
        throw invalid("Bundled dependency data exceeds its declared size.");
      checksum = crc32(chunk, checksum);
      chunks.push(chunk);
    }
    if (size !== entry.uncompressedSize || checksum !== entry.crc32)
      throw invalid(
        "Bundled dependency ZIP data failed its size or CRC check.",
      );
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener("abort", aborted);
    stream.destroy();
  }
}

function jsonObject(text, name) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid(`Bundled dependency metadata ${name} is invalid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(`Bundled dependency metadata ${name} must be an object.`);
  return value;
}

function manifestFields(text = "") {
  const fields = new Map();
  let previous;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line) break; // Only the main attributes describe the whole JAR.
    if (line.startsWith(" ") && previous) {
      fields.set(previous, fields.get(previous) + line.slice(1));
      continue;
    }
    const match = /^([^:]+): (.*)$/.exec(line);
    previous = match?.[1].toLowerCase();
    if (match) fields.set(previous, match[2]);
  }
  return fields;
}

// Extract only simple string fields from [[mods]], not a general TOML parser.
// The lexer skips comments and entire multiline strings, so descriptions cannot
// masquerade as new tables or dependency identities. Unsupported values fall
// back to the manifest or JarJar display metadata; identity always uses hashes.
function* tomlStatements(text) {
  let statement = "",
    quote = "",
    triple = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      statement += character;
      if (quote === '"' && character === "\\") {
        statement += text[++index] ?? "";
      } else if (character === quote) {
        if (!triple) quote = "";
        else if (text.slice(index, index + 3) === quote.repeat(3)) {
          statement += quote.repeat(2);
          index += 2;
          quote = "";
        }
      } else if (!triple && /[\r\n]/.test(character))
        throw invalid("Bundled dependency TOML contains an invalid string.");
      continue;
    }
    if (character === "#") {
      while (index < text.length && !/[\r\n]/.test(text[index])) index++;
      index--;
    } else if (character === '"' || character === "'") {
      quote = character;
      triple = text.slice(index, index + 3) === character.repeat(3);
      statement += triple ? character.repeat(3) : character;
      if (triple) index += 2;
    } else if (/[\r\n]/.test(character)) {
      yield statement.trim();
      statement = "";
    } else statement += character;
  }
  if (quote)
    throw invalid("Bundled dependency TOML contains an unfinished string.");
  yield statement.trim();
}

function tomlMod(text = "") {
  let fields;
  const mods = [];
  for (const statement of tomlStatements(text)) {
    if (/^\[\[\s*mods\s*\]\]$/.test(statement)) {
      fields = {};
      mods.push(fields);
    } else if (statement.startsWith("[")) fields = undefined;
    else if (fields) {
      const match = /^(modId|displayName|version)\s*=\s*(.+)$/.exec(statement);
      if (!match) continue;
      let value;
      if (/^'[^'\r\n]*'$/.test(match[2])) value = match[2].slice(1, -1);
      else if (/^"(?!"")/.test(match[2])) {
        try {
          value = JSON.parse(match[2]);
        } catch {
          continue;
        }
      }
      if (typeof value === "string") fields[match[1]] = value;
    }
  }
  return (
    mods.find(
      (mod) =>
        typeof mod.modId === "string" &&
        /^[a-z][a-z0-9_-]{1,63}$/.test(mod.modId),
    ) ?? {}
  );
}

function describe(metadata, fallback, filename, loader) {
  const quilt = loader === "quilt" ? metadata.quilt?.quilt_loader : undefined;
  const fabric =
    loader === "fabric" || (loader === "quilt" && !metadata.quilt)
      ? metadata.fabric
      : undefined;
  const manifest = manifestFields(metadata.raw.get("META-INF/MANIFEST.MF"));
  const toml = tomlMod(
    loader === "neoforge"
      ? (metadata.raw.get("META-INF/neoforge.mods.toml") ??
          metadata.raw.get("META-INF/mods.toml"))
      : loader === "forge"
        ? metadata.raw.get("META-INF/mods.toml")
        : undefined,
  );
  const modId = displayText(quilt?.id ?? fabric?.id ?? toml.modId);
  const declaredVersion = quilt?.version ?? fabric?.version ?? toml.version;
  const version =
    declaredVersion === "${file.jarVersion}"
      ? manifest.get("implementation-version")
      : declaredVersion;
  return {
    title:
      displayText(quilt?.metadata?.name) ??
      displayText(fabric?.name) ??
      displayText(toml.displayName) ??
      displayText(manifest.get("specification-title")) ??
      displayText(manifest.get("implementation-title")) ??
      modId ??
      displayText(fallback?.title) ??
      path.posix.basename(filename, ".jar"),
    version:
      displayText(version) ??
      displayText(manifest.get("implementation-version")) ??
      displayText(manifest.get("specification-version")) ??
      displayText(fallback?.version) ??
      "Unknown",
    ...(modId && /^[a-z][a-z0-9_-]{1,63}$/.test(modId) ? { modId } : {}),
  };
}

function declarations(metadata, loader) {
  const declared = new Map();
  const add = (filename, fallback = {}) => {
    const name = safeInstallPath(filename);
    if (!/\.jar$/i.test(name))
      throw invalid("A declared bundled dependency is not a JAR file.");
    if (declared.has(name)) return;
    if (declared.size >= limits.jars)
      throw invalid("The archive declares more than 64 bundled dependencies.");
    declared.set(name, fallback);
  };
  const array = (value, name) => {
    if (value == null) return [];
    if (!Array.isArray(value))
      throw invalid(
        `Bundled dependency metadata ${name} must contain a JAR array.`,
      );
    return value;
  };
  // Official format definitions:
  // https://docs.neoforged.net/toolchain/docs/dependencies/jarinjar/
  // https://wiki.fabricmc.net/documentation:fabric_mod_json_spec
  // https://github.com/QuiltMC/rfcs/blob/main/specification/0002-quilt.mod.json.md
  if (loader === "neoforge" || loader === "forge") {
    for (const jar of array(metadata.jarjar?.jars, "JarJar"))
      add(jar?.path, {
        title: jar?.identifier?.artifact,
        version: jar?.version?.artifactVersion,
      });
  } else if (loader === "quilt" && metadata.quilt) {
    for (const jar of array(metadata.quilt.quilt_loader?.jars, "Quilt"))
      add(jar);
  } else {
    for (const jar of array(metadata.fabric?.jars, "Fabric")) add(jar?.file);
  }
  return declared;
}

function permitsServer(metadata, loader) {
  if (loader === "quilt" && metadata.quilt) {
    const environment = metadata.quilt.minecraft?.environment;
    return (
      environment == null ||
      environment === "*" ||
      environment === "dedicated_server"
    );
  }
  if (loader === "fabric" || loader === "quilt") {
    const environment = metadata.fabric?.environment;
    return (
      environment == null ||
      environment === "*" ||
      environment === "server" ||
      (Array.isArray(environment) &&
        environment.some((value) => value === "*" || value === "server"))
    );
  }
  return true;
}

/**
 * Read declared embedded JARs from an already checksum-verified private file.
 * No extraction or execution. Hashes prove file identity, never names/mod IDs.
 * The selected loader is required and controls declarations at every depth.
 * Limits apply across the whole traversal. fingerprint, if supplied, is a
 * synchronous callback for a provider's uint32 fingerprint algorithm.
 */
export async function inspectBundledDependencies(
  archive,
  { signal, fingerprint, loader } = {},
) {
  signal?.throwIfAborted();
  if (!["neoforge", "forge", "fabric", "quilt"].includes(loader))
    throw invalid(
      "Choose a supported mod loader before inspecting bundled dependencies.",
    );
  const info = await fs.lstat(archive);
  if (!info.isFile() || info.isSymbolicLink())
    throw invalid(
      "Bundled dependency inspection requires a regular staged JAR file.",
    );
  const budget = { entries: 0, bytes: 0, jars: 0 };
  const result = [];
  const inspect = async (
    source,
    parentPath,
    depth,
    fallback,
    parentPermitsServer = true,
  ) => {
    signal?.throwIfAborted();
    const zip = await openZip(source, signal);
    let zipError;
    zip.on("error", (error) => {
      zipError = error;
    });
    try {
      const entries = await indexEntries(zip, budget, signal);
      const raw = new Map();
      for (const name of metadataNames) {
        const found = entries.get(name);
        if (!found) continue;
        if (found.directory)
          throw invalid(
            `Bundled dependency metadata ${name} is not a regular file.`,
          );
        raw.set(
          name,
          (
            await readEntry(zip, found.entry, limits.metadata, budget, signal)
          ).toString("utf8"),
        );
      }
      const metadata = { raw };
      for (const [name, key] of [
        ["META-INF/jarjar/metadata.json", "jarjar"],
        ["fabric.mod.json", "fabric"],
        ["quilt.mod.json", "quilt"],
      ])
        if (raw.has(name)) metadata[key] = jsonObject(raw.get(name), name);
      const serverCompatible =
        parentPermitsServer && permitsServer(metadata, loader);
      if (depth) {
        const descriptor = {
          ...describe(metadata, fallback, parentPath, loader),
          path: parentPath,
          sha512: createHash("sha512").update(source).digest("hex"),
          sha1: createHash("sha1").update(source).digest("hex"),
          serverCompatible,
        };
        if (fingerprint) {
          const value = fingerprint(source);
          if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
            throw invalid("The bundled dependency fingerprint is invalid.");
          descriptor.fingerprint = value;
        }
        result.push(descriptor);
      }
      for (const [name, fallback] of declarations(metadata, loader)) {
        signal?.throwIfAborted();
        if (depth >= limits.depth)
          throw invalid("Bundled dependencies exceed three nested JAR levels.");
        if (++budget.jars > limits.jars)
          throw invalid(
            "The archive contains more than 64 bundled dependencies.",
          );
        const found = entries.get(name);
        if (!found || found.directory)
          throw invalid(
            `The declared bundled dependency ${name} is missing or is not a regular file.`,
          );
        const buffer = await readEntry(
          zip,
          found.entry,
          limits.nested,
          budget,
          signal,
        );
        await inspect(
          buffer,
          parentPath ? `${parentPath}!/${name}` : name,
          depth + 1,
          fallback,
          serverCompatible,
        );
      }
      if (zipError) throw zipError;
    } finally {
      zip.close();
    }
  };
  await inspect(archive, "", 0);
  signal?.throwIfAborted();
  return result;
}
