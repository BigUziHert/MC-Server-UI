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

async function readLaunchFile(directory, relative) {
  const target = await containedSourcePath(directory, relative);
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw error(400, `${relative} must be a regular text file under 1 MB.`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await fs.readFile(target),
    );
    if (text.includes("\0"))
      throw error(400, `${relative} must be a plain UTF-8 text file.`);
    return text.replace(/^\uFEFF/, "");
  } catch (cause) {
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      throw error(
        400,
        `Startup requires ${relative}. Restore this file from the existing server installation before importing or starting.`,
      );
    if (cause.code === "ERR_ENCODING_INVALID_ENCODED_DATA")
      throw error(400, `${relative} must be a plain UTF-8 text file.`);
    throw cause;
  }
}

// Interpret only the installer's single Java command. Never execute batch commands
// or shell expansion: Java remains the child process so stdin, stop and restart work.
export function parseJavaScript(text) {
  const unsupported = () =>
    error(
      400,
      "This launcher contains commands beyond a single Java invocation. Select Startup script to run it as configured, or enter the Java arguments explicitly. Scripts must keep the server in the foreground without automatic restart loops or detached launch commands.",
    );
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim().replace(/^@/, ""))
    .filter(
      (line) => line && !/^(?:rem(?:\s|$)|::|echo\s+off$|pause$)/i.test(line),
    );
  if (lines.length !== 1) throw unsupported();
  const line = lines[0];
  if (/[&|<>^!\x00-\x1f]/.test(line)) throw unsupported();
  const tokens = [];
  let quoted = false;
  let token = "";
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (/\s/.test(char) && !quoted) {
      if (token) tokens.push(token);
      token = "";
    } else token += char;
  }
  if (quoted) throw unsupported();
  if (token) tokens.push(token);
  const javaPath = tokens.shift();
  if (
    !javaPath ||
    !/(?:^|[\\/])java(?:\.exe)?$/i.test(javaPath) ||
    /%/.test(javaPath)
  )
    throw unsupported();
  if (tokens.at(-1) === "%*") tokens.pop();
  else if (["nogui%*", "--nogui%*"].includes(tokens.at(-1))) {
    // With no script arguments, cmd expands this common joined suffix to the
    // literal nogui flag. Keep the flag when inspecting the installed launcher.
    tokens[tokens.length - 1] = tokens.at(-1).slice(0, -2);
  }
  if (tokens.some((value) => /%/.test(value))) throw unsupported();
  if (!tokens.length) throw unsupported();
  const args = tokens.map((value) =>
    value.startsWith("@") ? `@${value.slice(1).replace(/\\/g, "/")}` : value,
  );
  if (!args.includes("nogui") && !args.includes("--nogui")) args.push("nogui");
  return { javaPath, args, ...describeJavaArguments(args) };
}

function describeJavaArguments(args) {
  const argFiles = args
    .filter((value) => value.startsWith("@"))
    .map((value) => value.slice(1).replace(/\\/g, "/").replace(/^\.\//, ""));
  const forgeArgs = argFiles.find((file) =>
    /^libraries\/(?:net\/neoforged\/neoforge|net\/minecraftforge\/forge)\/[^/]+\/(?:win|unix)_args\.txt$/i.test(
      file,
    ),
  );
  const software = forgeArgs?.toLowerCase().includes("neoforged")
    ? "NeoForge"
    : forgeArgs
      ? "Forge"
      : /fabric/i.test(args.join(" "))
        ? "Fabric"
        : /quilt/i.test(args.join(" "))
          ? "Quilt"
          : "Java";
  return {
    argFiles,
    software,
    version: forgeArgs?.split("/").at(-2) ?? "Unknown",
  };
}

// Read advisory metadata with Java's whitespace, comment and quote boundaries.
// The original files still go directly to Java; no launcher contents are rewritten.
function javaFileArguments(text) {
  const tokens = [];
  let token = "";
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!quote && char === "#") {
      while (index < text.length && !/[\r\n]/.test(text[index])) index++;
      if (token) tokens.push(token);
      token = "";
    } else if (char === quote) quote = null;
    else if (!quote && /["']/.test(char)) quote = char;
    else if (quote && char === "\\") {
      const next = text[++index];
      if (/[\r\n]/.test(next ?? "")) {
        while (/\s/.test(text[index + 1] ?? "")) index++;
      } else
        token += { n: "\n", r: "\r", t: "\t", f: "\f" }[next] ?? next ?? "";
    } else if (!quote && /\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
    } else token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function javaStartupOptions(args) {
  let memoryLimitMB = null;
  let jarIndex = -1;
  const valueOptions = new Set([
    "-cp",
    "-classpath",
    "--class-path",
    "-p",
    "--module-path",
    "--upgrade-module-path",
    "--add-modules",
    "--limit-modules",
    "--add-exports",
    "--add-opens",
    "--add-reads",
    "--patch-module",
    "--enable-native-access",
    "--source",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-jar") {
      jarIndex = index;
      break;
    }
    // Everything following the entry point is a game argument, not a JVM flag.
    if (
      ["-m", "--module"].includes(arg) ||
      arg.startsWith("--module=") ||
      !arg.startsWith("-")
    )
      break;
    if (valueOptions.has(arg)) {
      index++;
      continue;
    }
    const match = /^(?:-Xmx|-XX:MaxHeapSize=)(\d+)([kKmMgG]?)$/.exec(arg);
    if (match) {
      const bytes =
        Number(match[1]) *
        { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()];
      memoryLimitMB =
        Number.isSafeInteger(bytes) && bytes > 0 ? bytes / 1024 ** 2 : null;
    }
  }
  return { memoryLimitMB, jarIndex };
}

export async function inspectJavaArguments(directory, args) {
  const expanded = [];
  let expandFiles = true;
  for (const argument of args) {
    const tokens =
      expandFiles && argument.startsWith("@") && !argument.startsWith("@@")
        ? javaFileArguments(
            await readLaunchFile(
              directory,
              argument.slice(1).replace(/\\/g, "/"),
            ),
          )
        : [argument];
    for (const token of tokens) expanded.push(token);
    if (tokens.includes("--disable-@files")) expandFiles = false;
  }
  const { memoryLimitMB, jarIndex } = javaStartupOptions(expanded);
  if (jarIndex !== -1) {
    const jar = expanded[jarIndex + 1];
    if (typeof jar !== "string" || !/\.jar$/i.test(jar))
      throw error(
        400,
        "The -jar startup option must be followed by a relative server JAR path.",
      );
    const target = await containedSourcePath(
      directory,
      jar.replace(/\\/g, "/"),
    );
    const available = await fs
      .stat(target)
      .then((stat) => stat.isFile())
      .catch((cause) => {
        if (cause.code !== "ENOENT" && cause.code !== "ENOTDIR") throw cause;
        return false;
      });
    if (!available)
      throw error(
        400,
        `Startup requires ${jar}. Restore the selected server JAR before importing or starting.`,
      );
  }
  return {
    ...describeJavaArguments(args),
    memoryLimitMB,
    // Backend-only advisory arguments for reading the selected launcher's metadata.
    expandedArgs: expanded,
  };
}

export async function inspectJavaLauncher(directory, launchScript) {
  const launch = parseJavaScript(await readLaunchFile(directory, launchScript));
  return {
    ...launch,
    ...(await inspectJavaArguments(directory, launch.args)),
    launchScript,
  };
}

export async function validateStartupFiles(directory, config) {
  if (config.launchType === "java-args")
    return inspectJavaArguments(directory, config.launchArgs);
  if (config.launchType === "script") {
    const text = await readLaunchFile(directory, config.launchScript);
    // Unsupported wrappers may set variables, branch, or launch another program.
    // Do not guess their heap or version from unrelated files in the directory.
    let launch;
    try {
      launch = parseJavaScript(text);
    } catch {
      return {};
    }
    return inspectJavaArguments(directory, [
      ...launch.args,
      ...(config.launchArgs ?? []),
    ]);
  }
  return {};
}

export function buildScriptInvocation(
  script,
  args,
  platform = process.platform,
) {
  if (/\.(bat|cmd)$/i.test(script)) {
    if (platform !== "win32")
      throw error(
        400,
        "Windows batch launchers require Windows. Select a shell script or Java arguments on this system.",
      );
    // cmd expands %, ! and metacharacters even where ordinary argv quoting would
    // be safe. Deliberately reject those inputs instead of building a shell command.
    if ([script, ...args].some((value) => /[%!^"&|<>\x00-\x1f]/.test(value)))
      throw error(
        400,
        "Windows startup script paths and arguments cannot contain quotes, %, !, ^, &, |, <, >, or control characters. Use Java arguments or an executable for these values.",
      );
    return {
      executable: path.win32.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "cmd.exe",
      ),
      args: [
        "/d",
        "/v:off",
        "/s",
        "/c",
        `"${[script, ...args].map((value) => `"${value}"`).join(" ")}"`,
      ],
      windowsVerbatimArguments: true,
    };
  }
  if (/\.ps1$/i.test(script))
    return {
      executable:
        platform === "win32"
          ? path.win32.join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            )
          : "pwsh",
      args: ["-NoProfile", "-NonInteractive", "-File", script, ...args],
    };
  if (/\.sh$/i.test(script)) {
    if (platform === "win32")
      throw error(
        400,
        "Shell scripts require a Unix shell. Choose the Windows launcher, Java arguments, or configure a shell executable explicitly.",
      );
    return { executable: "/bin/sh", args: [script, ...args] };
  }
  throw error(
    400,
    "Choose a .bat, .cmd, .ps1, or .sh startup script, or use an executable with explicit arguments.",
  );
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
  const launches = [];
  const detected = new Map();
  const scripts = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /\.(bat|cmd|sh|ps1)$/i.test(entry.name),
    )
    .sort(
      (a, b) =>
        Number(!/^run\.bat$/i.test(a.name)) -
          Number(!/^run\.bat$/i.test(b.name)) || a.name.localeCompare(b.name),
    );
  for (const script of scripts) {
    if (/\.(bat|cmd)$/i.test(script.name)) {
      try {
        const java = await inspectJavaLauncher(canonical, script.name);
        const candidate = {
          type: "java-args",
          path: script.name,
          label: `${java.software} · ${script.name}`,
          launchArgs: java.args,
          javaPath: java.javaPath,
          software: java.software,
          version: java.version,
        };
        launches.push(candidate);
        detected.set(candidate, java);
      } catch (cause) {
        warnings.push(
          `${script.name}: ${cause.message} Launcher scripts are not executed during inspection or import.`,
        );
      }
    }
    launches.push({
      type: "script",
      path: script.name,
      label: `Startup script · ${script.name}`,
    });
  }
  launches.push(
    ...jars.map((jar) => ({
      type: "jar",
      path: jar,
      label: `Server JAR · ${jar}`,
    })),
  );
  const recommended =
    launches.find(
      (candidate) =>
        candidate.type === "java-args" &&
        ["NeoForge", "Forge"].includes(candidate.software),
    ) ??
    launches.find((candidate) => candidate.type === "java-args") ??
    (jars.length === 1 && !/installer/i.test(jars[0])
      ? launches.find((candidate) => candidate.type === "jar")
      : undefined) ??
    (scripts.length === 1 && !jars.length
      ? launches.find((candidate) => candidate.type === "script")
      : undefined);
  const detectedJava = detected.get(recommended);
  if (!jars.length && !scripts.length)
    warnings.push(
      "No root-level server JAR or startup script was found. Choose the complete server folder, or configure Java arguments or a server executable manually.",
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
  const levelFile = await containedSourcePath(canonical, `${world}/level.dat`);
  const worldExists = await fs
    .stat(levelFile)
    .then((stat) => stat.isFile())
    .catch((cause) => {
      if (cause.code !== "ENOENT" && cause.code !== "ENOTDIR") throw cause;
      return false;
    });
  if (!worldExists)
    warnings.push(
      `No saved level.dat was found in ${world}. Starting may create a new world; place your existing world in that folder before starting.`,
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
    worldExists,
    jars,
    jar: recommended?.type === "jar" ? recommended.path : null,
    launches,
    launchType: recommended?.type ?? "jar",
    launchScript: recommended?.type === "script" ? recommended.path : "",
    launchExecutable: "",
    launchArgs: detectedJava?.args ?? [],
    javaPath: detectedJava?.javaPath ?? "java",
    ...(detectedJava
      ? { software: detectedJava.software, version: detectedJava.version }
      : {}),
    ...(detectedJava?.memoryLimitMB
      ? { memoryLimitMB: detectedJava.memoryLimitMB }
      : {}),
    eulaAccepted,
    warnings,
  };
}
