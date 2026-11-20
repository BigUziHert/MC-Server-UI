import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const releases = "https://hub.spigotmc.org/versions/";
const buildToolsNumber = 201;
const buildToolsJob = `https://hub.spigotmc.org/jenkins/job/BuildTools/${buildToolsNumber}`;
// Jenkins publishes the matching Maven artifact MD5 c79d2f12d08ce70734d24b71c0594fc6
// at /mavenArtifacts/api/json. Pin the SHA-256 of that archived JAR as well.
export const spigotBuildTools = {
  url: `${buildToolsJob}/artifact/target/BuildTools.jar`,
  sha256: "81ed06f5ce5fb705b558bf9b3cc2c5c53cdd9742406c5338c452faa13a1e1c24",
};

const releaseId =
  /^(?:1\.(?:[89]|\d{2})(?:\.\d{1,2})?|26\.(?:[12](?:\.\d{1,2})?|3))$/;
const revisionId = /^\d[a-z0-9.-]{0,29}$/i;
const gitRefs = ["BuildData", "Bukkit", "CraftBukkit", "Spigot"];
const officialRevision = (revision) =>
  `${releases}${encodeURIComponent(revision)}.json`;
const fail = (status, message) => Object.assign(new Error(message), { status });

function javaRange(release) {
  // BuildTools itself requires Java 8. Without release metadata it accepts
  // Java 7–8 for legacy builds. Version 201 recognizes class levels up to 70.
  const limits = release.javaVersions ?? [51, 52];
  if (
    !Array.isArray(limits) ||
    limits.length !== 2 ||
    !limits.every(Number.isInteger) ||
    limits[0] < 51 ||
    limits[1] > 70 ||
    limits[1] < Math.max(52, limits[0])
  )
    return null;
  return [Math.max(52, limits[0]) - 44, limits[1] - 44];
}

const validRelease = (data) =>
  typeof data?.name === "string" &&
  revisionId.test(data.name) &&
  gitRefs.every((name) => /^[a-f0-9]{40}$/i.test(data.refs?.[name] ?? "")) &&
  (data.toolsVersion == null ||
    (Number.isInteger(data.toolsVersion) &&
      data.toolsVersion > 0 &&
      data.toolsVersion <= buildToolsNumber)) &&
  javaRange(data) !== null;

function sameRevision(release, pinned) {
  return (
    validRelease(pinned) &&
    release.name === pinned.name &&
    release.toolsVersion === pinned.toolsVersion &&
    javaRange(release).join() === javaRange(pinned).join() &&
    gitRefs.every((name) => release.refs[name] === pinned.refs[name]) &&
    release.hashes?.Spigot === pinned.hashes?.Spigot
  );
}

async function hostTools(javaPath, javaVersions, { cwd, env, signal }) {
  const probe = (executable, args) =>
    exec(executable, args, {
      cwd,
      env,
      signal,
      timeout: 8000,
      windowsHide: true,
    });
  const windows = process.platform === "win32";
  const pathName =
    Object.keys(env).find((name) => /^path$/i.test(name)) ?? "PATH";
  const addToPath = (directory) => {
    env[pathName] = [directory, env[pathName]]
      .filter(Boolean)
      .join(path.delimiter);
  };

  let javaHome;
  let version;
  try {
    const { stderr, stdout } = await probe(javaPath, [
      "-XshowSettings:properties",
      "-version",
    ]);
    const properties = `${stdout}\n${stderr}`;
    javaHome = /^\s*java\.home\s*=\s*(.+?)\s*$/m.exec(properties)?.[1];
    version =
      Number(
        /^\s*java\.class\.version\s*=\s*(\d+)\.\d+\s*$/m.exec(properties)?.[1],
      ) - 44;
  } catch {
    signal?.throwIfAborted();
  }
  const [minimum, maximum] = javaVersions;
  const expectedJava =
    minimum === maximum ? `Java ${minimum}` : `Java ${minimum}–${maximum}`;
  if (!javaHome || !(version >= minimum && version <= maximum))
    throw fail(
      400,
      `This Spigot release requires a ${expectedJava} JDK. Choose a compatible Java executable.`,
    );
  // A Java 8 executable reports the JDK's embedded JRE as java.home.
  const jdk =
    version === 8 && /^jre$/i.test(path.basename(javaHome))
      ? path.dirname(javaHome)
      : javaHome;
  const jdkBin = path.join(jdk, "bin");
  try {
    await probe(path.join(jdkBin, windows ? "javac.exe" : "javac"), [
      "-version",
    ]);
  } catch {
    signal?.throwIfAborted();
    throw fail(
      400,
      `Spigot needs a ${expectedJava} JDK with javac. Choose Java from a full JDK installation.`,
    );
  }

  try {
    await probe("sh", ["-c", "exit"]);
  } catch {
    signal?.throwIfAborted();
    if (windows) {
      // Git for Windows exposes git.exe on PATH without its POSIX shell.
      // BuildTools downloads PortableGit if it cannot run sh itself.
      const git = await probe("git", ["--exec-path"]).catch(() => null);
      signal?.throwIfAborted();
      const gitDirectory = git?.stdout.trim();
      if (gitDirectory && path.isAbsolute(gitDirectory))
        addToPath(path.resolve(gitDirectory, "..", "..", "..", "usr", "bin"));
    }
  }
  try {
    await probe("sh", ["-c", "exit"]);
    await probe("git", ["--version"]);
  } catch {
    signal?.throwIfAborted();
    throw fail(
      400,
      "Spigot BuildTools requires Git and a working shell. On Windows, install Git for Windows and make git available on PATH.",
    );
  }
  env.JAVA_HOME = jdk;
  addToPath(jdkBin);
}

export function createSpigotProvider({ json, text, cached }) {
  async function versions() {
    const index = await text(releases);
    return [
      ...new Set(
        Array.from(
          index.matchAll(/href="(\d[\d.]+)\.json"/gi),
          (entry) => entry[1],
        ),
      ),
    ]
      .filter((version) => releaseId.test(version))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .map((id) => ({
        id,
        label: id,
        stable: true,
        url: officialRevision(id),
      }));
  }

  async function revision(version) {
    if (typeof version !== "string" || !releaseId.test(version)) return null;
    return cached(`spigot:revision:${version}`, async () => {
      const release = await json(officialRevision(version));
      if (!validRelease(release)) return null;
      const pinned =
        release.name === version
          ? release
          : await json(officialRevision(release.name));
      return sameRevision(release, pinned) ? pinned : null;
    });
  }

  async function builds(version) {
    const release = await revision(version);
    if (!release) return [];
    const [javaVersion, maxJavaVersion] = javaRange(release);
    return [
      {
        id: release.name,
        label: `Build ${release.name}`,
        stable: true,
        javaVersion,
        maxJavaVersion,
        url: officialRevision(release.name),
      },
    ];
  }

  async function installer({ version, build, root, output, javaPath, signal }) {
    signal?.throwIfAborted();
    const release = await revision(version);
    if (!release || release.name !== build)
      throw fail(
        400,
        "Choose a Spigot build supported by the verified BuildTools release.",
      );
    const cwd = path.join(root, "buildtools");
    const home = path.join(root, "buildtools-home");
    await fs.mkdir(cwd);
    await fs.mkdir(home);
    // BuildTools downloads its own checksum-verified Maven. Use that copy and
    // its pinned defaults instead of a machine-wide Maven installation.
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/^(?:M2_HOME|MAVEN_ARGS)$/i.test(name),
        ),
      ),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
      MAVEN_OPTS: `-Duser.home="${home}" -Dmaven.repo.local="${path.join(home, "repository")}"`,
    };
    await hostTools(javaPath, javaRange(release), { cwd, env, signal });
    const jar = `spigot-${version}-${build}.jar`;
    return {
      args: [
        "--nogui",
        "--rev",
        build,
        "--compile",
        "SPIGOT",
        "--output-dir",
        output,
        "--final-name",
        jar,
      ],
      javaArgs: [`-Duser.home=${home}`, "-Djava.awt.headless=true"],
      cwd,
      jar,
      timeoutMs: 30 * 60 * 1000,
      env,
    };
  }

  return {
    versions,
    builds,
    installer,
    page: (_version, build) => officialRevision(build),
  };
}
