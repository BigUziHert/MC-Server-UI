import { parse } from "smol-toml";
import { inspectBundledDependencies } from "./launchpad-bundled.mjs";
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

/** Read required mod IDs from the installed loader's authoritative metadata.
 * This checks removal, not version-range satisfaction. Alternate/conditional
 * requirements are treated conservatively, never used to justify deletion.
 */
export async function inspectInstalledMod(archive, { loader, signal } = {}) {
  const provided = new Set(),
    required = new Set();
  let title,
    recognized = false,
    wrapped = false;
  await inspectBundledDependencies(archive, {
    loader,
    signal,
    metadataOnly: true,
    visitMetadata(metadata, { depth, serverCompatible }) {
      if (!depth && ["forge", "neoforge"].includes(loader))
        wrapped = libraryWrapper(metadata);
      const add = (set, value) => set.add(identifier(value));
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
        add(provided, mod.id);
        named(mod.metadata?.name ?? mod.id);
        for (const alias of list(mod.provides))
          add(provided, object(alias) ? alias.id : alias);
        const dependency = (value, depth = 0) => {
          if (depth > 16) invalid();
          if (Array.isArray(value)) {
            for (const alternative of value) dependency(alternative, depth + 1);
          } else if (typeof value === "string") add(required, value);
          else if (object(value)) {
            if (value.optional === true || value.environment === "client")
              return;
            if (
              value.optional !== undefined &&
              typeof value.optional !== "boolean"
            )
              invalid();
            add(required, value.id);
            // Removing an `unless` mod can activate a requirement as well.
            if (value.unless !== undefined) dependency(value.unless, depth + 1);
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
        add(provided, mod.id);
        named(mod.name ?? mod.id);
        for (const alias of list(mod.provides)) add(provided, alias);
        if (mod.depends !== undefined && !object(mod.depends)) invalid();
        for (const id of Object.keys(mod.depends ?? {})) add(required, id);
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
        if (!serverCompatible) return;
        for (const value of mods) {
          add(provided, value.modId);
          named(value.displayName ?? value.modId);
        }
        // Language support is required even when authors omit a matching entry
        // in dependencies. The standard Java/low-code loaders ship with FML.
        if (
          mod.modLoader !== undefined &&
          !["javafml", "lowcodefml"].includes(mod.modLoader)
        )
          add(required, mod.modLoader);
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
              if (type !== "required") continue;
            } else if (value.mandatory !== undefined) {
              if (typeof value.mandatory !== "boolean") invalid();
              if (!value.mandatory) continue;
            }
            add(required, value.modId);
          }
        }
      }
    },
  });
  // A loader library can be a container for declared JarJar mods (for example,
  // language support packages). Only actual nested mod metadata identifies it;
  // a manifest label or arbitrary embedded files alone cannot justify removal.
  if (!recognized && !(wrapped && provided.size)) invalid();
  return { title, provided: [...provided], required: [...required] };
}
