import { parse } from "smol-toml";
import { inspectBundledDependencies } from "./launchpad-bundled.mjs";
import { installedModManifestVersion } from "./launchpad-dependency-ranges.mjs";
import { launchpadError } from "./launchpad-network.mjs";

const invalid = () => {
  throw launchpadError(
    400,
    "This mod's dependency declarations could not be read reliably.",
  );
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const list = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : invalid();
const identifier = (value) => {
  if (typeof value !== "string") invalid();
  // Quilt can qualify a mod ID with its Maven group. Matching the mod ID is
  // conservative for removal: a qualified reference must not be overlooked.
  const id = value.split(":").at(-1);
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) invalid();
  return id;
};
const libraryWrapper = (metadata) => {
  const manifest = metadata.raw.get("META-INF/MANIFEST.MF");
  if (typeof manifest !== "string") return false;
  // Java manifest attribute names are case-insensitive and lines may continue.
  // Only main attributes describe the JAR, not per-entry sections below them.
  const main = manifest.replace(/\r\n?/g, "\n").split("\n\n", 1)[0];
  const types = [...main.replace(/\n /g, "").matchAll(/^FMLModType: (.*)$/gim)];
  if (types.length > 1) invalid();
  return ["LIBRARY", "GAMELIBRARY"].includes(types[0]?.[1]);
};

/** Read mod identities and raw version constraints for removal checks.
 * Alternate/conditional requirements are retained conservatively; the removal
 * check decides whether a remaining provider can be proved compatible.
 * `required` lists mandatory IDs; `requirements` also records constraints from
 * optional dependencies that apply while a replacement provider is installed.
 */
export async function inspectInstalledMod(archive, { loader, signal } = {}) {
  const provided = new Set(),
    required = new Set(),
    providers = [],
    requirements = [],
    clientOnlyPaths = [];
  let title,
    recognized = false,
    wrapped = false;
  await inspectBundledDependencies(archive, {
    loader,
    signal,
    metadataOnly: true,
    visitMetadata(metadata, { depth, path, serverCompatible }) {
      if (!depth && ["forge", "neoforge"].includes(loader))
        wrapped = libraryWrapper(metadata);
      const provide = (value, version) => {
        const id = identifier(value);
        provided.add(id);
        providers.push({
          id,
          version:
            typeof version === "string" &&
            version.length > 0 &&
            version.length <= 256 &&
            !/[\s\x00-\x1f\x7f]/.test(version) &&
            !version.includes("${")
              ? version
              : undefined,
        });
      };
      const constrain = (value, range) => {
        const id = identifier(value);
        requirements.push({ id, range });
        return id;
      };
      const require = (value, range) => required.add(constrain(value, range));
      const named = (value) => {
        if (
          (!depth || (wrapped && !title)) &&
          typeof value === "string" &&
          value.trim()
        )
          title = value.trim().slice(0, 256);
      };
      if (loader === "quilt" && metadata.quilt) {
        if (
          metadata.quilt.schema_version !== 1 ||
          !object(metadata.quilt.quilt_loader)
        )
          invalid();
        const mod = metadata.quilt.quilt_loader;
        if (!depth) recognized = true;
        if (!serverCompatible) return;
        provide(mod.id, mod.version);
        named(mod.metadata?.name ?? mod.id);
        for (const alias of list(mod.provides))
          provide(
            object(alias) ? alias.id : alias,
            object(alias) ? (alias.version ?? mod.version) : mod.version,
          );
        const dependency = (value, depth = 0, conditional = false) => {
          if (depth > 16) invalid();
          if (Array.isArray(value)) {
            for (const alternative of value)
              dependency(alternative, depth + 1, true);
          } else if (typeof value === "string") require(value);
          else if (object(value)) {
            if (value.optional === true || value.environment === "client")
              return;
            if (
              value.optional !== undefined &&
              typeof value.optional !== "boolean"
            )
              invalid();
            require(value.id, conditional || value.unless !== undefined
              ? undefined
              : value.versions);
            // Removing an `unless` mod can activate a requirement as well.
            if (value.unless !== undefined)
              dependency(value.unless, depth + 1, true);
          } else invalid();
        };
        for (const value of list(mod.depends)) dependency(value);
      } else if (
        (loader === "fabric" || loader === "quilt") &&
        metadata.fabric
      ) {
        const mod = metadata.fabric;
        if (mod.schemaVersion !== 1) invalid();
        if (!depth) recognized = true;
        if (!serverCompatible) return;
        provide(mod.id, mod.version);
        named(mod.name ?? mod.id);
        for (const alias of list(mod.provides)) provide(alias, mod.version);
        if (mod.depends !== undefined && !object(mod.depends)) invalid();
        for (const [id, range] of Object.entries(mod.depends ?? {}))
          require(id, range);
      } else if (loader === "forge" || loader === "neoforge") {
        const source =
          loader === "neoforge"
            ? (metadata.raw.get("META-INF/neoforge.mods.toml") ??
              metadata.raw.get("META-INF/mods.toml"))
            : metadata.raw.get("META-INF/mods.toml");
        if (source === undefined) return;
        const mod = parse(source);
        const mods = list(mod.mods);
        if (!mods.length) invalid();
        if (!depth) recognized = true;
        // This file-level flag is implemented by Forge, not NeoForge FML.
        // On NeoForge it cannot hide the mod or any of its required libraries.
        if (loader === "forge") {
          if (
            mod.clientSideOnly !== undefined &&
            typeof mod.clientSideOnly !== "boolean"
          )
            invalid();
          if (mod.clientSideOnly === true) clientOnlyPaths.push(path);
        }
        if (
          !serverCompatible ||
          clientOnlyPaths.some(
            (parent) =>
              !parent || path === parent || path.startsWith(`${parent}!/`),
          )
        )
          return;
        for (const value of mods) {
          provide(
            value.modId,
            value.version === "${file.jarVersion}"
              ? installedModManifestVersion(
                  metadata.raw.get("META-INF/MANIFEST.MF"),
                )
              : value.version,
          );
          named(value.displayName ?? value.modId);
        }
        // Language support is required even when authors omit a matching entry
        // in dependencies. The standard Java/low-code loaders ship with FML.
        if (
          mod.modLoader !== undefined &&
          !["javafml", "lowcodefml"].includes(mod.modLoader)
        )
          require(mod.modLoader, mod.loaderVersion);
        if (mod.dependencies !== undefined && !object(mod.dependencies))
          invalid();
        for (const dependencies of Object.values(mod.dependencies ?? {})) {
          for (const value of list(dependencies)) {
            if (!object(value)) invalid();
            if (
              value.side !== undefined &&
              !["CLIENT", "SERVER", "BOTH"].includes(value.side)
            )
              invalid();
            if (value.side === "CLIENT") continue;
            if (loader === "neoforge" && value.type !== undefined) {
              // NeoForge's ModInfo accepts dependency types in any case.
              // Unknown values still fail, rather than hiding real requirements.
              if (typeof value.type !== "string") invalid();
              const type = value.type.toLowerCase();
              if (
                ![
                  "required",
                  "optional",
                  "incompatible",
                  "discouraged",
                ].includes(type)
              )
                invalid();
              if (type !== "required") {
                constrain(
                  value.modId,
                  type === "optional" ? value.versionRange : undefined,
                );
                continue;
              }
            } else if (value.mandatory !== undefined) {
              if (typeof value.mandatory !== "boolean") invalid();
              if (!value.mandatory) {
                constrain(value.modId, value.versionRange);
                continue;
              }
            }
            require(value.modId, value.versionRange);
          }
        }
      }
    },
  });
  // A loader library can be a container for declared JarJar mods (for example,
  // language support packages). Only actual nested mod metadata identifies it;
  // a manifest label or arbitrary embedded files alone cannot justify removal.
  if (!recognized && !(wrapped && provided.size)) invalid();
  return {
    title,
    provided: [...provided],
    required: [...required],
    providers,
    requirements,
  };
}
