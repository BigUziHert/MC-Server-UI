import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { inspectBundledDependencies } from "./launchpad-bundled.mjs";

const configPaths = [
  "automodpack/server.conf",
  "automodpack/automodpack-server.json",
];
const maximum = 128 * 1024;
const defaults = {
  "from-server": ["mods/*.jar", "kubejs/**", "emotes/*"],
  exclude: [
    "**/.*",
    "**/.*/**",
    "**/*.{tmp,disabled,bak}",
    "kubejs/server_scripts/**",
  ],
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const unsupported = () => {
  throw new Error("unsupported AutoModpack configuration");
};

// AutoModpack writes a small HOCON subset, not YAML. Deliberately reject
// substitutions, includes, dotted assignments, duplicate keys and concatenation.
function parseConfig(source) {
  let at = 0,
    tokens = 0;
  const space = () => {
    while (at < source.length) {
      if (/\s/.test(source[at])) at++;
      else if (source[at] === "#" || source.slice(at, at + 2) === "//") {
        while (at < source.length && source[at] !== "\n") at++;
      } else break;
    }
  };
  const word = () => {
    space();
    if (++tokens > 8192) unsupported();
    const start = at;
    if (source[at] === '"') {
      at++;
      while (at < source.length) {
        if (source[at++] === "\\") at++;
        else if (source[at - 1] === '"')
          return JSON.parse(source.slice(start, at));
      }
      unsupported();
    }
    let braces = 0;
    while (at < source.length) {
      const c = source[at];
      if (!braces && /[\s\[\],}:=#]/.test(c)) break;
      if (c === "{") {
        if (at === start) break;
        braces++;
      } else if (c === "}") {
        if (!braces) break;
        braces--;
      }
      at++;
    }
    if (at === start || braces) unsupported();
    const value = source.slice(start, at);
    if (/[\$"']/.test(value)) unsupported();
    return value === "true" ? true : value === "false" ? false : value;
  };
  const value = (depth) => {
    space();
    if (depth > 24) unsupported();
    if (source[at] === "{") {
      at++;
      return fields(depth + 1, true);
    }
    if (source[at] !== "[") return word();
    at++;
    const result = [];
    for (;;) {
      space();
      if (source[at] === "]") {
        at++;
        return result;
      }
      if (result.length >= 512) unsupported();
      result.push(value(depth + 1));
      space();
      if (source[at] === ",") at++;
      else if (source[at] !== "]") unsupported();
    }
  };
  const fields = (depth, nested) => {
    const result = Object.create(null);
    for (;;) {
      space();
      if (at === source.length) {
        if (nested) unsupported();
        return result;
      }
      if (source[at] === "}" && nested) {
        at++;
        return result;
      }
      const key = word();
      if (
        typeof key !== "string" ||
        !/^[A-Za-z0-9 _-]+$/.test(key) ||
        Object.hasOwn(result, key)
      )
        unsupported();
      space();
      if (source[at] === ":" || source[at] === "=") at++;
      else if (source[at] !== "{") unsupported();
      result[key] = value(depth + 1);
      space();
      if (source[at] === ",") at++;
    }
  };
  space();
  const result = source[at] === "{" ? value(0) : fields(0, false);
  space();
  if (at !== source.length) unsupported();
  return result;
}

function ruleSet(rules = []) {
  if (!Array.isArray(rules) || rules.length > 128) unsupported();
  const positive = [],
    negative = [];
  let total = 0,
    compiledSize = 0;
  const expand = (glob) => {
    const start = glob.indexOf("{");
    if (start < 0) return [glob];
    const end = glob.indexOf("}", start + 1);
    if (end < 0 || glob.slice(start + 1, end).includes("{")) unsupported();
    const alternatives = glob.slice(start + 1, end).split(",");
    const suffixes = expand(glob.slice(end + 1));
    if (alternatives.length * suffixes.length > 32) unsupported();
    return alternatives.flatMap((part) =>
      suffixes.map((suffix) => glob.slice(0, start) + part + suffix),
    );
  };
  const compile = (glob) => {
    if (/[\[\]{}]/.test(glob) || (compiledSize += glob.length) > 16384)
      unsupported();
    const tokens = [];
    for (let i = 0; i < glob.length; i++) {
      if (glob[i] === "*" && glob[i + 1] === "*") {
        tokens.push("**");
        i++;
      } else tokens.push(glob[i]);
    }
    // Dynamic programming keeps untrusted wildcard runs polynomial, including
    // adversarial *a*a*a patterns that cause regex engines to backtrack.
    return (path) => {
      let previous = new Uint8Array(path.length + 1);
      previous[0] = 1;
      for (const token of tokens) {
        const next = new Uint8Array(path.length + 1);
        if (token === "*" || token === "**") {
          next[0] = previous[0];
          for (let i = 1; i <= path.length; i++)
            next[i] =
              previous[i] ||
              (next[i - 1] && (token === "**" || path[i - 1] !== "/"));
        } else {
          for (let i = 1; i <= path.length; i++)
            next[i] =
              previous[i - 1] &&
              (token === "?" ? path[i - 1] !== "/" : token === path[i - 1]);
        }
        previous = next;
      }
      return Boolean(previous[path.length]);
    };
  };
  for (const raw of rules) {
    if (
      typeof raw !== "string" ||
      !raw ||
      raw.length > 256 ||
      (total += raw.length) > 8192
    )
      unsupported();
    let glob = raw.replace(/^!/, "").replaceAll("\\", "/").replace(/^\/+/, "");
    if (!glob || glob.split("/").includes("..")) unsupported();
    while (glob.includes("**/**")) glob = glob.replaceAll("**/**", "**");
    // Match AutoModpack's case-sensitive, slash-based zero-directory variants.
    const variants = new Set([glob]);
    if (glob.includes("/**/")) variants.add(glob.replaceAll("/**/", "/"));
    if (glob.startsWith("**/")) variants.add(glob.slice(3));
    const target = raw.startsWith("!") ? negative : positive;
    target.push(...[...variants].flatMap(expand).map(compile));
  }
  return (path) =>
    positive.some((rule) => rule(path)) && !negative.some((rule) => rule(path));
}

function policy(config) {
  if (
    Object.hasOwn(config, "syncedFiles") ||
    Object.hasOwn(config, "modpackName") ||
    Object.hasOwn(config, "autoExcludeServerSideMods")
  )
    unsupported();
  let group = defaults;
  if (Object.hasOwn(config, "modpack")) {
    if (!object(config.modpack)) unsupported();
    const groups = [];
    for (const [name, category] of Object.entries(config.modpack)) {
      if (name === "name") continue;
      if (!object(category)) unsupported();
      if (Object.hasOwn(category, "main")) groups.push(category.main);
    }
    if (groups.length !== 1 || !object(groups[0])) unsupported();
    group = groups[0];
  }
  if (
    Object.hasOwn(group, "fromServer") ||
    Object.hasOwn(group, "syncedFiles") ||
    Object.hasOwn(group, "excludedFiles") ||
    Object.hasOwn(group, "autoExcludeServerSideMods")
  )
    unsupported();
  if (
    group.selection !== undefined &&
    (typeof group.selection !== "string" ||
      group.selection.toUpperCase() !== "REQUIRED")
  )
    unsupported();
  if (
    group["compatible-platforms"] !== undefined &&
    (!Array.isArray(group["compatible-platforms"]) ||
      group["compatible-platforms"].length)
  )
    unsupported();
  const legacyMode = config["auto-exclude-server-side-mods"];
  if (legacyMode !== undefined && typeof legacyMode !== "boolean")
    unsupported();
  let mode =
    group["auto-exclude-server-side-mods"] ??
    (legacyMode === false ? "DISABLED" : "METADATA");
  if (typeof mode !== "string") unsupported();
  mode = mode.toUpperCase();
  if (!["DISABLED", "METADATA"].includes(mode)) unsupported();
  return {
    fromServer: ruleSet(group["from-server"]),
    exclude: ruleSet(group.exclude),
    mode,
  };
}

async function readConfig(serverDir, safePath, relative, signal) {
  signal?.throwIfAborted();
  try {
    const file = await safePath(serverDir, relative);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum)
      unsupported();
    const handle = await fs.open(file, "r");
    try {
      const bytes = Buffer.alloc(maximum + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        signal?.throwIfAborted();
        const read = await handle.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead,
        );
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      signal?.throwIfAborted();
      const after = await handle.stat();
      if (
        bytesRead > maximum ||
        bytesRead !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ino !== info.ino ||
        after.dev !== info.dev
      )
        unsupported();
      const content = bytes.subarray(0, bytesRead);
      return {
        path: relative,
        hash: createHash("sha256").update(content).digest("hex"),
        content: content.toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause.code === "ENOENT") return { path: relative, hash: "absent" };
    return {
      path: relative,
      hash: `unreadable:${cause.code ?? "invalid"}`,
      failed: true,
    };
  }
}

// Read-only eligibility for dependencies that AutoModpack will already ship.
// Source rules (unknown config never grants reuse):
// https://github.com/Skidamek/AutoModpack/blob/v5.0.0-rc.7/docs/configuration/server-config.mdx
// https://github.com/Skidamek/AutoModpack/blob/v5.0.0-rc.7/core/src/main/java/pl/skidam/automodpack_core/modpack/candidate/PathRuleSet.java
// https://github.com/Skidamek/AutoModpack/blob/v5.0.0-rc.7/core/src/main/java/pl/skidam/automodpack_core/modpack/candidate/StableSourceSnapshotter.java
export async function readAutoModpackSources({ serverDir, safePath, signal }) {
  const files = [];
  for (const relative of configPaths)
    files.push(await readConfig(serverDir, safePath, relative, signal));
  const snapshot = JSON.stringify(
    files.map(({ path, hash }) => ({ path, hash })),
  );
  const warnings = [];
  let rules;
  try {
    if (files.some((file) => file.failed) || files[1].hash !== "absent")
      unsupported();
    rules = policy(
      files[0].content === undefined ? {} : parseConfig(files[0].content),
    );
  } catch {
    warnings.push(
      "AutoModpack's content rules could not be verified. Dependencies will be staged in AutoModpack instead of reusing regular Mods.",
    );
  }
  return {
    snapshot,
    warnings,
    async includes(item, loader) {
      signal?.throwIfAborted();
      if (
        !rules ||
        item?.active === false ||
        !/^mods\/[^/\\]+\.jar$/.test(item?.path ?? "")
      )
        return false;
      if (
        !rules.fromServer(item.path) ||
        rules.exclude(item.path) ||
        rules.exclude(`automodpack/host-modpack/main/${item.path}`)
      )
        return false;
      try {
        // The explicit host file wins by logical path, even when it belongs to
        // an unrelated or unidentified project. AutoModpack never falls back.
        try {
          const staged = await safePath(
            serverDir,
            `automodpack/host-modpack/main/${item.path}`,
          );
          await fs.lstat(staged);
          return false;
        } catch (cause) {
          if (cause.code !== "ENOENT") throw cause;
        }
        const file = await safePath(serverDir, item.path);
        let valid = false,
          excluded = false;
        await inspectBundledDependencies(file, {
          loader,
          signal,
          metadataOnly: true,
          visitMetadata(metadata, { depth }) {
            if (depth) return;
            const fabric = metadata.fabric;
            if (fabric) {
              valid = true;
              if (
                /^automodpack(?:[-_](?:mod|bootstrap))?$/.test(fabric.id ?? "")
              )
                excluded = true;
              if (
                rules.mode !== "DISABLED" &&
                fabric.environment?.toLowerCase() === "server"
              )
                excluded = true;
            }
            const source =
              metadata.raw.get("META-INF/neoforge.mods.toml") ??
              metadata.raw.get("META-INF/mods.toml");
            if (source !== undefined) {
              const toml = parseToml(source);
              if (!Array.isArray(toml.mods) || !toml.mods.length) unsupported();
              valid = true;
              for (const mod of toml.mods) {
                if (
                  /^automodpack(?:[-_](?:mod|bootstrap))?$/.test(
                    mod.modId ?? "",
                  )
                )
                  excluded = true;
                if (
                  rules.mode !== "DISABLED" &&
                  mod.displayTest?.toUpperCase() === "IGNORE_SERVER_VERSION"
                )
                  excluded = true;
              }
              // Early v5 releases treated these as server-only. Retaining the
              // conservative exclusion also works before AutoModpack is installed.
              if (rules.mode !== "DISABLED")
                for (const dependencies of Object.values(
                  toml.dependencies ?? {},
                )) {
                  if (!Array.isArray(dependencies)) unsupported();
                  if (
                    dependencies.some(
                      (dep) =>
                        ["minecraft", "forge", "neoforge"].includes(
                          dep.modId,
                        ) && dep.side?.toUpperCase() === "SERVER",
                    )
                  )
                    excluded = true;
                }
            }
          },
        });
        return valid && !excluded;
      } catch {
        signal?.throwIfAborted();
        const warning = `AutoModpack could not verify whether ${item.path} reaches clients. Its dependencies will use staged content.`;
        if (!warnings.includes(warning)) warnings.push(warning);
        return false;
      }
    },
  };
}
