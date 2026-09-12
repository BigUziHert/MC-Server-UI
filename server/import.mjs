import fs from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";

const error = (status, message) =>
  Object.assign(new Error(message), { status });
const whitespace = (char) => char === " " || char === "\t" || char === "\f";

// Java Properties.load(Reader) syntax: escaped separators, logical line
// continuations, comments, and a single u followed by exactly four hex digits.
export function parseProperties(text) {
  const values = new Map();
  const unescape = (value) => {
    let result = "";
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char !== "\\") {
        result += char;
        continue;
      }
      if (++index === value.length) break;
      const escaped = value[index];
      if (escaped === "u") {
        const hex = value.slice(index + 1, index + 5);
        if (!/^[a-fA-F0-9]{4}$/.test(hex))
          throw error(
            400,
            "A properties file contains an invalid Unicode escape; expected \\u followed by four hexadecimal digits.",
          );
        result += String.fromCharCode(parseInt(hex, 16));
        index += 4;
      } else
        result += { t: "\t", n: "\n", r: "\r", f: "\f" }[escaped] ?? escaped;
    }
    return result;
  };
  const consume = (line) => {
    let keyEnd = line.length;
    for (let index = 0; index < line.length; index++) {
      if (line[index] === "\\") {
        index++;
        continue;
      }
      if (
        line[index] === "=" ||
        line[index] === ":" ||
        whitespace(line[index])
      ) {
        keyEnd = index;
        break;
      }
    }
    let valueStart = keyEnd;
    while (whitespace(line[valueStart])) valueStart++;
    if (line[valueStart] === "=" || line[valueStart] === ":") valueStart++;
    while (whitespace(line[valueStart])) valueStart++;
    values.set(
      unescape(line.slice(0, keyEnd)),
      unescape(line.slice(valueStart)),
    );
  };
  let logical = "";
  let continuing = false;
  for (const natural of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    const part = natural.replace(/^[ \t\f]+/, "");
    if (!continuing && (!part || /^[#!]/.test(part))) continue;
    logical = continuing ? logical + part : part;
    const slashCount = logical.match(/\\+$/)?.[0].length ?? 0;
    continuing = slashCount % 2 === 1;
    if (continuing) logical = logical.slice(0, -1);
    else {
      consume(logical);
      logical = "";
    }
  }
  if (continuing) consume(logical);
  return values;
}

export function directoriesOverlap(first, second) {
  const contains = (root, target) => {
    const relative = path.relative(root, target);
    return (
      !relative ||
      (!path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`))
    );
  };
  return contains(first, second) || contains(second, first);
}

export async function canonicalExternalDirectory(
  directory,
  { requireCanonical = false } = {},
) {
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    /[\0\r\n]/.test(directory)
  )
    throw error(
      400,
      "Choose an absolute path to an existing Minecraft server folder.",
    );
  const resolved = path.resolve(directory);
  let stat;
  let canonical;
  try {
    stat = await fs.lstat(resolved);
    canonical = await fs.realpath(resolved);
  } catch (cause) {
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      throw error(
        404,
        "The imported server folder is unavailable. Reconnect its drive or restore the folder at its original location.",
      );
    if (cause.code === "EACCES" || cause.code === "EPERM")
      throw error(
        403,
        "The server folder cannot be read. Check this account's folder permissions.",
      );
    throw cause;
  }
  if (stat.isSymbolicLink())
    throw error(
      400,
      "Choose the actual server folder, not a symbolic link or directory junction.",
    );
  if (!stat.isDirectory())
    throw error(400, "Choose a server folder, not a file.");
  if (
    requireCanonical &&
    (process.platform === "win32"
      ? canonical.toLowerCase() !== resolved.toLowerCase()
      : canonical !== resolved)
  )
    throw error(
      409,
      "The imported server folder now resolves to a different location. Restore the original folder before using it.",
    );
  return canonical;
}

export async function containedSourcePath(directory, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    /[\0\r\n\\:]/.test(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw error(
      400,
      "The server's files and world must stay inside its selected folder.",
    );
  let current = directory;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw error(
          400,
          "Symbolic links cannot be used for the server's configuration, JAR, or world.",
        );
      const actual = await fs.realpath(current);
      const relativeActual = path.relative(directory, actual);
      if (
        path.isAbsolute(relativeActual) ||
        relativeActual === ".." ||
        relativeActual.startsWith(`..${path.sep}`)
      )
        throw error(
          400,
          "The selected server file resolves outside its folder.",
        );
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }
  return current;
}

async function readProperties(directory, filename, { optional = false } = {}) {
  const target = await containedSourcePath(directory, filename);
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw error(400, `${filename} must be a readable text file under 1 MB.`);
    const buffer = await fs.readFile(target);
    if (buffer.includes(0))
      throw error(
        400,
        `${filename} must use UTF-8 or legacy Latin-1 text, not binary or UTF-16 data.`,
      );
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      text = buffer.toString("latin1");
    }
    return parseProperties(text);
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    if (optional) return new Map();
    throw error(
      400,
      "This folder does not contain server.properties. Choose the Minecraft server's root folder.",
    );
  }
}

export async function inspectServerDirectory(
  directory,
  { forbiddenDirectories = [], requireCanonical = false } = {},
) {
  const canonical = await canonicalExternalDirectory(directory, {
    requireCanonical,
  });
  for (const forbidden of forbiddenDirectories) {
    let actual;
    try {
      actual = await fs.realpath(forbidden);
    } catch (cause) {
      if (cause.code !== "ENOENT" && cause.code !== "ENOTDIR") throw cause;
      actual = path.resolve(forbidden);
    }
    if (directoriesOverlap(canonical, actual))
      throw error(
        409,
        "This folder overlaps panel storage or another managed server. Choose a separate existing server folder.",
      );
  }
  const properties = await readProperties(canonical, "server.properties");
  const integer = (key, fallback, minimum, maximum) => {
    const raw = properties.get(key);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw.trim()))
      throw error(400, `server.properties contains an invalid ${key}.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw error(400, `server.properties contains an invalid ${key}.`);
    return value;
  };
  const port = integer("server-port", 25565, 1, 65535);
  const maxPlayers = integer("max-players", 20, 1, 2147483647);
  const world = properties.get("level-name") || "world";
  await containedSourcePath(canonical, world);
  const entries = await fs.readdir(canonical, { withFileTypes: true });
  const jars = entries
    .filter(
      (entry) =>
        entry.isFile() && !entry.isSymbolicLink() && /\.jar$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const eula = await readProperties(canonical, "eula.txt", { optional: true });
  const eulaAccepted = eula.get("eula")?.toLowerCase() === "true";
  const warnings = [
    "Import keeps the existing folder in place. Stop any separately running server before starting it from this panel.",
  ];
  if (
    entries.some(
      (entry) =>
        /\.(bat|cmd|sh|ps1|args)$/i.test(entry.name) ||
        entry.name === "user_jvm_args.txt",
    )
  )
    warnings.push(
      "Launcher scripts are not executed. Servers that require run.bat, run.sh, argument files, or custom JVM flags need manual setup; select a server JAR that supports java -jar.",
    );
  if (!jars.length)
    warnings.push(
      "No root-level server JAR was found. This importer cannot launch a script-only server; place a runnable server JAR in this folder before importing.",
    );
  if (jars.length > 1)
    warnings.push(
      "Several JARs were found. Select the server JAR explicitly; libraries and installer JARs are not server launchers.",
    );
  if (!eulaAccepted)
    warnings.push(
      "The Minecraft EULA is not accepted in eula.txt. Review it and accept it yourself before starting.",
    );
  if (port < 1024)
    warnings.push(
      "Choose a port between 1024 and 65535 for this panel; an override is applied only when the server is started.",
    );
  const serverIp = properties.get("server-ip")?.trim();
  const host =
    serverIp && isIP(serverIp) && !["0.0.0.0", "::"].includes(serverIp)
      ? isIP(serverIp) === 6
        ? `[${serverIp}]`
        : serverIp
      : "localhost";
  return {
    directory: canonical,
    name:
      path
        .basename(canonical)
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim()
        .slice(0, 64) || "Imported server",
    port,
    address: `${host}:${port}`,
    motd: properties.get("motd") ?? "A Minecraft Server",
    maxPlayers,
    world,
    jars,
    jar: jars.length === 1 ? jars[0] : null,
    eulaAccepted,
    warnings,
  };
}
