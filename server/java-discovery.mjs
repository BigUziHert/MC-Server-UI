import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";

const fail = (status, message) => Object.assign(new Error(message), { status });
const unquote = (value) =>
  String(value ?? "")
    .trim()
    .replace(/^"(.*)"$/, "$1");

export function probeJava(
  javaPath = "java",
  { spawnProcess = spawn, timeoutMs = 5000 } = {},
) {
  if (
    typeof javaPath !== "string" ||
    !javaPath.trim() ||
    javaPath.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(javaPath)
  )
    throw fail(400, "Choose a Java executable.");
  return new Promise((resolve) => {
    let child,
      timer,
      done = false,
      output = "";
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const property = (name) =>
        new RegExp(`^\\s*${name.replaceAll(".", "\\.")}\\s*=\\s*(.+)$`, "m")
          .exec(output)?.[1]
          ?.trim();
      const version =
        property("java.version") ??
        /^(?:openjdk|java)\s+(?:version\s+)?["']?([\d][\w.+-]*)/im.exec(
          output,
        )?.[1] ??
        null;
      const majorVersion = version
        ? Number(
            version.startsWith("1.")
              ? version.split(".")[1]
              : version.split(/[.+-]/)[0],
          )
        : null;
      resolve({
        path: javaPath,
        available: !error && !!majorVersion,
        version,
        majorVersion,
        ...(/(?:64-Bit|aarch64)/i.test(output)
          ? { architecture: /aarch64/i.test(output) ? "aarch64" : "x64" }
          : {}),
        ...(property("os.arch") ? { architecture: property("os.arch") } : {}),
        ...(property("java.vendor") ? { vendor: property("java.vendor") } : {}),
        ...(property("java.home") ? { home: property("java.home") } : {}),
        ...(error || !majorVersion
          ? {
              error:
                error ||
                `Java at ${javaPath} did not report a recognizable version.`,
            }
          : {}),
      });
    };
    try {
      child = spawnProcess(
        javaPath,
        ["-XshowSettings:properties", "-version"],
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const collect = (data) => {
        output = (output + data.toString()).slice(0, 65536);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", (cause) =>
        finish(
          cause.code === "ENOENT"
            ? `Java was not found at ${javaPath}. Refresh the installed Java list and choose an available runtime.`
            : `Could not check Java at ${javaPath}: ${cause.message}`,
        ),
      );
      child.once("close", (code) =>
        finish(
          code === 0
            ? null
            : `Java at ${javaPath} exited with code ${code} during its version check.`,
        ),
      );
      timer = setTimeout(() => {
        finish(
          `Java at ${javaPath} did not respond to its version check. Choose another runtime.`,
        );
        child.kill();
      }, timeoutMs);
    } catch (cause) {
      finish(`Could not check Java at ${javaPath}: ${cause.message}`);
    }
  });
}

async function mapLimit(items, limit, work) {
  let cursor = 0;
  const result = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        result.push(await work(item));
      }
    }),
  );
  return result;
}

function windowsRegistryHomes(env) {
  const executable = path.win32.join(
    env.SystemRoot || "C:\\Windows",
    "System32",
    "reg.exe",
  );
  const keys = [
    "HKLM\\SOFTWARE\\JavaSoft",
    "HKLM\\SOFTWARE\\Eclipse Adoptium",
    "HKLM\\SOFTWARE\\AdoptOpenJDK",
    "HKLM\\SOFTWARE\\Microsoft\\JDK",
    "HKLM\\SOFTWARE\\Azul Systems",
    "HKCU\\SOFTWARE\\JavaSoft",
    "HKCU\\SOFTWARE\\Eclipse Adoptium",
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  return mapLimit(
    keys,
    4,
    (key) =>
      new Promise((resolve) => {
        execFile(
          executable,
          ["query", key, "/s"],
          {
            windowsHide: true,
            timeout: 2000,
            maxBuffer: 256 * 1024,
            encoding: "utf8",
          },
          (_error, stdout = "") => {
            resolve(
              [
                ...stdout.matchAll(
                  /^\s*(?:JavaHome|Path|InstallationPath|JAVA_HOME|JDK_HOME|JRE_HOME)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/gim,
                ),
              ].map((match) =>
                unquote(match[1]).replace(
                  /%([^%]+)%/g,
                  (value, name) => env[name] ?? value,
                ),
              ),
            );
          },
        );
      }),
  ).then((values) => values.flat());
}

export async function findJavaCandidates({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  preferredPath,
  roots: suppliedRoots,
  registryHomes = windowsRegistryHomes,
  maxDirectories = 4000,
  managedDir,
} = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const executable = platform === "win32" ? "java.exe" : "java";
  const candidates = new Set();
  const roots = [];
  const addHome = (directory) => {
    directory = unquote(directory);
    if (directory) candidates.add(p.join(directory, "bin", executable));
  };
  const addRoot = (directory, depth = 3) => {
    if (directory) roots.push({ directory, depth });
  };
  if (managedDir) {
    try {
      const stat = await fs.lstat(managedDir);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        for (const entry of await fs.readdir(managedDir, {
          withFileTypes: true,
        }))
          if (
            entry.isDirectory() &&
            /^temurin-\d+-windows-(?:x64|aarch64)-[a-f0-9]{16}$/.test(
              entry.name,
            )
          )
            addRoot(p.join(managedDir, entry.name), 4);
    } catch {
      /* Managed Java is optional until the first installation. */
    }
  }
  if (preferredPath && /[\\/]/.test(preferredPath))
    candidates.add(unquote(preferredPath));
  for (const [name, value] of Object.entries(env))
    if (
      /^(?:JAVA_HOME|JDK_HOME|JRE_HOME|JAVA_?\d+_HOME|JDK_?\d+_HOME)$/i.test(
        name,
      )
    )
      addHome(value);
  const searchPath =
    Object.entries(env).find(([name]) => name.toLowerCase() === "path")?.[1] ??
    "";
  for (const directory of searchPath
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)) {
    candidates.add(p.join(unquote(directory), executable));
    if (preferredPath && !/[\\/]/.test(preferredPath))
      candidates.add(p.join(unquote(directory), preferredPath));
  }
  if (suppliedRoots) {
    for (const root of suppliedRoots)
      addRoot(
        typeof root === "string" ? root : root.directory,
        typeof root === "string" ? 6 : root.depth,
      );
  } else if (platform === "win32") {
    const programDirs = new Set(
      [
        env.ProgramW6432,
        env.ProgramFiles,
        env["ProgramFiles(x86)"],
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, "Programs"),
      ].filter(Boolean),
    );
    for (const directory of programDirs)
      for (const vendor of [
        "Java",
        "Eclipse Adoptium",
        "AdoptOpenJDK",
        "Microsoft",
        "Amazon Corretto",
        "BellSoft",
        "Zulu",
        "Semeru",
        "IBM",
        "RedHat",
        "OpenJDK",
      ])
        addRoot(p.join(directory, vendor));
    for (const directory of programDirs)
      addRoot(p.join(directory, "Minecraft Launcher", "runtime"), 6);
    for (const directory of await registryHomes(env)) addHome(directory);
    const roaming = env.APPDATA || p.join(homeDir, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || p.join(homeDir, "AppData", "Local");
    for (const directory of [
      p.join(roaming, ".minecraft", "runtime"),
      p.join(roaming, "PrismLauncher", "java"),
      p.join(roaming, "ModrinthApp", "meta", "java_versions"),
      p.join(roaming, "com.modrinth.theseus", "meta", "java_versions"),
      p.join(roaming, "ATLauncher", "runtimes"),
      p.join(local, "FTBApp", "runtime"),
      p.join(homeDir, "curseforge", "minecraft", "Install", "runtime"),
      p.join(homeDir, "Documents", "Curse", "Minecraft", "Install", "runtime"),
    ])
      addRoot(directory, 6);
  } else {
    for (const directory of [
      "/usr/lib/jvm",
      "/usr/java",
      "/opt/java",
      "/Library/Java/JavaVirtualMachines",
      p.join(homeDir, "Library", "Java", "JavaVirtualMachines"),
    ])
      addRoot(directory, 5);
    for (const directory of [
      p.join(homeDir, ".minecraft", "runtime"),
      p.join(homeDir, "Library", "Application Support", "minecraft", "runtime"),
      p.join(homeDir, ".local", "share", "PrismLauncher", "java"),
    ])
      addRoot(directory, 6);
  }
  if (!suppliedRoots)
    for (const directory of [
      p.join(homeDir, ".jdks"),
      p.join(homeDir, ".jabba", "jdk"),
      p.join(homeDir, ".sdkman", "candidates", "java"),
    ])
      addRoot(directory, 5);
  let visited = 0;
  const seen = new Set();
  const walk = async ({ directory, depth }) => {
    if (visited >= maxDirectories || seen.has(directory)) return;
    visited++;
    seen.add(directory);
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name.toLowerCase() === executable.toLowerCase() &&
        !entry.isDirectory()
      )
        candidates.add(p.join(directory, entry.name));
      if (
        entry.isDirectory() &&
        depth > 0 &&
        !["legal", "lib", "include", "jmods", "demo", "man"].includes(
          entry.name.toLowerCase(),
        )
      )
        await walk({
          directory: p.join(directory, entry.name),
          depth: depth - 1,
        });
    }
  };
  await mapLimit(roots, 6, walk);
  const found = await mapLimit(
    [...candidates].slice(0, 1024),
    16,
    async (candidate) => {
      try {
        const absolute = await fs.realpath(candidate);
        return (await fs.stat(absolute)).isFile() ? absolute : null;
      } catch {
        return null;
      }
    },
  );
  const unique = new Map();
  for (const candidate of found.filter(Boolean))
    unique.set(
      platform === "win32" ? candidate.toLowerCase() : candidate,
      candidate,
    );
  return [...unique.values()];
}

export function createJavaDiscovery({
  probe = (candidate) => probeJava(candidate, { timeoutMs: 2000 }),
  findCandidates = findJavaCandidates,
  cacheMs = 60000,
  ...options
} = {}) {
  let cached,
    expires = 0,
    pending;
  return async ({ refresh = false } = {}) => {
    if (pending) return pending;
    if (!refresh && cached && expires > Date.now()) return cached;
    pending = (async () => {
      const candidates = await findCandidates(options);
      const values = await mapLimit(
        candidates.slice(0, 64),
        8,
        async (candidate) => {
          const checked = await probe(candidate);
          if (!checked.available || !checked.majorVersion) return null;
          if (checked.home)
            try {
              const actual = path.join(
                checked.home,
                "bin",
                process.platform === "win32" ? "java.exe" : "java",
              );
              if ((await fs.stat(actual)).isFile())
                candidate = await fs.realpath(actual);
            } catch {}
          let release = "";
          try {
            release = await fs.readFile(
              path.join(path.dirname(candidate), "..", "release"),
              "utf8",
            );
          } catch {}
          const field = (name) =>
            new RegExp(`^${name}="([^"]+)"`, "m").exec(release)?.[1];
          return {
            ...checked,
            path: candidate,
            ...(field("IMPLEMENTOR") ? { vendor: field("IMPLEMENTOR") } : {}),
            ...(field("OS_ARCH") ? { architecture: field("OS_ARCH") } : {}),
          };
        },
      );
      const unique = new Map();
      for (const value of values.filter(Boolean)) {
        const key =
          process.platform === "win32" ? value.path.toLowerCase() : value.path;
        unique.set(key, value);
      }
      cached = [...unique.values()].sort(
        (a, b) =>
          b.majorVersion - a.majorVersion ||
          b.version.localeCompare(a.version, undefined, { numeric: true }) ||
          a.path.localeCompare(b.path),
      );
      expires = Date.now() + cacheMs;
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}

// Match the runtime major specified by the official release. A newer JVM is not
// automatically supported by older loaders (notably Forge).
export const compatibleJava = (java, requiredMajor) =>
  !!java.available &&
  (!requiredMajor || java.majorVersion === requiredMajor) &&
  !/^(?:x86|i[3-6]86|32)$/i.test(java.architecture ?? "");
