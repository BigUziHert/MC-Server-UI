import { parse } from "smol-toml";
import { inspectBundledDependencies } from "./launchpad-bundled.mjs";

const unverifiable = () => {
  throw new Error("The installed dependency's compatibility cannot be proved.");
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(value))
    unverifiable();
  return value;
};
const numericVersion = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^\d+(?:\.\d+){0,31}$/.test(value)
  )
    unverifiable();
  return value.split(".").map((part) => BigInt(part));
};
const compare = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? 0n,
      b = right[index] ?? 0n;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
};

// A deliberately narrow subset of Maven hard requirements. Bare versions are
// recommendations, and qualifiers need Maven's full ordering implementation.
// https://maven.apache.org/pom.html#Dependency_Version_Requirement_Specification
function permittedByRange(version, value) {
  if (typeof value !== "string" || value.length > 4096) unverifiable();
  let remainder = value.trim();
  const ranges = [];
  while (remainder) {
    const match = /^([[(])([^\[\]()]*)([\])])/.exec(remainder);
    if (!match || ranges.length >= 64) unverifiable();
    const [, opening, body, closing] = match;
    const parts = body.split(",").map((part) => part.trim());
    let lower,
      upper,
      includeLower = opening === "[",
      includeUpper = closing === "]";
    if (parts.length === 1) {
      if (!includeLower || !includeUpper) unverifiable();
      lower = upper = numericVersion(parts[0]);
    } else if (parts.length === 2) {
      lower = parts[0] ? numericVersion(parts[0]) : null;
      upper = parts[1] ? numericVersion(parts[1]) : null;
      if (
        (!lower && !upper) ||
        (!lower && includeLower) ||
        (!upper && includeUpper)
      )
        unverifiable();
      if (lower && upper) {
        const order = compare(lower, upper);
        if (order > 0 || (order === 0 && !(includeLower && includeUpper)))
          unverifiable();
      }
    } else unverifiable();
    const previous = ranges.at(-1);
    if (previous) {
      if (!previous.upper || !lower) unverifiable();
      const order = compare(previous.upper, lower);
      if (order > 0 || (order === 0 && previous.includeUpper && includeLower))
        unverifiable();
    }
    ranges.push({ lower, upper, includeLower, includeUpper });
    remainder = remainder.slice(match[0].length).trim();
    if (remainder) {
      if (!remainder.startsWith(",")) unverifiable();
      remainder = remainder.slice(1).trim();
      if (!remainder) unverifiable();
    }
  }
  if (!ranges.length) unverifiable();
  return ranges.some(({ lower, upper, includeLower, includeUpper }) => {
    const from = lower ? compare(version, lower) : 1,
      to = upper ? compare(version, upper) : -1;
    return (
      (from > 0 || (from === 0 && includeLower)) &&
      (to < 0 || (to === 0 && includeUpper))
    );
  });
}

// Only the main manifest section supplies file.jarVersion. Folded lines belong
// to the preceding attribute; duplicate attributes are not an unambiguous proof.
// https://docs.oracle.com/en/java/javase/21/docs/specs/jar/jar.html
function manifestVersion(source) {
  if (typeof source !== "string" || source.includes("\0")) unverifiable();
  const attributes = new Map();
  const lines = source.split(/\r\n|\n|\r/);
  let previous,
    terminated = false;
  for (const [index, line] of lines.entries()) {
    if (!line) {
      terminated = index < lines.length - 1;
      break;
    }
    if (line.startsWith(" ")) {
      if (!previous) unverifiable();
      attributes.set(previous, attributes.get(previous) + line.slice(1));
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]*): (.*)$/.exec(line);
    if (!match) unverifiable();
    const key = match[1].toLowerCase();
    if (key === "name" || attributes.has(key)) unverifiable();
    attributes.set(key, match[2]);
    previous = key;
  }
  if (!terminated) unverifiable();
  numericVersion(attributes.get("manifest-version"));
  return attributes.get("implementation-version");
}

function modMetadata(metadata, loader) {
  const modern =
    loader === "neoforge" && metadata.raw.has("META-INF/neoforge.mods.toml");
  const source = metadata.raw.get(
    modern ? "META-INF/neoforge.mods.toml" : "META-INF/mods.toml",
  );
  if (source === undefined) return null;
  const value = parse(source);
  if (
    !Array.isArray(value.mods) ||
    !value.mods.length ||
    value.mods.length > 128 ||
    (value.clientSideOnly !== undefined &&
      typeof value.clientSideOnly !== "boolean")
  )
    unverifiable();
  const ids = new Set();
  for (const mod of value.mods) {
    if (!object(mod)) unverifiable();
    const id = identifier(mod.modId);
    if (ids.has(id)) unverifiable();
    ids.add(id);
  }
  return { value, ids, modern };
}

/** Prove that a retained Forge/NeoForge JAR satisfies this parent's declared
 * dependency ranges. This is not a general mod compatibility check: the caller
 * must already establish the installed project's identity and target runtime.
 * Only root mod versions identify the retained dependency. Required declarations
 * in the parent's declared nested mods also constrain it. Unknown metadata,
 * soft/empty ranges, or qualified versions return false; cancellation propagates.
 */
export async function installedDependencySatisfies(
  parentArchive,
  installedArchive,
  { loader, signal } = {},
) {
  signal?.throwIfAborted();
  if (loader !== "forge" && loader !== "neoforge") return false;
  try {
    const installed = new Map();
    await inspectBundledDependencies(installedArchive, {
      loader,
      signal,
      visitMetadata(metadata, { depth }) {
        if (depth) return;
        const model = modMetadata(metadata, loader);
        if (!model || model.value.clientSideOnly === true) unverifiable();
        for (const mod of model.value.mods) {
          const version =
            mod.version === "${file.jarVersion}"
              ? manifestVersion(metadata.raw.get("META-INF/MANIFEST.MF"))
              : mod.version;
          installed.set(mod.modId, numericVersion(version));
        }
      },
    });
    if (!installed.size) return false;
    let recognized = false,
      required = 0;
    const parentIds = new Set();
    await inspectBundledDependencies(parentArchive, {
      loader,
      signal,
      visitMetadata(metadata, { depth, serverCompatible }) {
        const model = modMetadata(metadata, loader);
        if (!model) return;
        const { value, ids, modern } = model;
        if (!depth) recognized = true;
        if (!serverCompatible || value.clientSideOnly === true) {
          if (!depth) unverifiable();
          return;
        }
        for (const id of ids) {
          if (parentIds.has(id)) unverifiable();
          parentIds.add(id);
        }
        if (value.dependencies !== undefined && !object(value.dependencies))
          unverifiable();
        for (const [owner, dependencies] of Object.entries(
          value.dependencies ?? {},
        )) {
          if (!ids.has(owner) || !Array.isArray(dependencies)) unverifiable();
          for (const dependency of dependencies) {
            if (!object(dependency)) unverifiable();
            const id = identifier(dependency.modId);
            if (
              dependency.side !== undefined &&
              !["BOTH", "CLIENT", "SERVER"].includes(dependency.side)
            )
              unverifiable();
            let type;
            if (modern) {
              type = dependency.type ?? "required";
              if (
                ![
                  "required",
                  "optional",
                  "incompatible",
                  "discouraged",
                ].includes(type)
              )
                unverifiable();
            } else {
              if (typeof dependency.mandatory !== "boolean") unverifiable();
              type = dependency.mandatory ? "required" : "optional";
            }
            if (dependency.side === "CLIENT" || !installed.has(id)) continue;
            // Optional requirements also apply when the dependency is present.
            // Do not prove retention against a declared conflict or warning.
            if (type !== "required" && type !== "optional") unverifiable();
            if (!permittedByRange(installed.get(id), dependency.versionRange))
              unverifiable();
            if (type === "required") required++;
          }
        }
      },
    });
    signal?.throwIfAborted();
    return recognized && required > 0;
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === "AbortError") throw error;
    return false;
  }
}
