import yauzl from "yauzl";
import { parseDocument } from "yaml";

const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const pluginId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_. -]{1,100}$/.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
const descriptorName =
  /^(?:(?:paper-plugin|plugin|bungee)\.yml|velocity-plugin\.json)$/i;

/** Read bounded plugin declarations only; never execute or extract plugin code.
 * Paper bootstrap/server dependencies and Velocity optional defaults follow:
 * https://docs.papermc.io/paper/dev/getting-started/paper-plugins/
 * https://docs.papermc.io/velocity/dev/velocity-plugin-json/
 */
export async function inspectPluginIdentity(source, { signal, loader } = {}) {
  signal?.throwIfAborted();
  const zip = await new Promise((resolve, reject) => {
    const callback = (cause, value) => (cause ? reject(cause) : resolve(value));
    if (Buffer.isBuffer(source))
      yauzl.fromBuffer(source, { lazyEntries: true }, callback);
    else yauzl.open(source, { lazyEntries: true }, callback);
  });
  const abort = () => zip.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const descriptors = [];
    let count = 0;
    while (true) {
      signal?.throwIfAborted();
      const entry = await new Promise((resolve, reject) => {
        const cleanup = () => {
          zip.off("entry", row);
          zip.off("end", end);
          zip.off("error", fail);
          zip.off("close", closed);
        };
        const row = (value) => {
            cleanup();
            resolve(value);
          },
          end = () => {
            cleanup();
            resolve(null);
          },
          fail = (cause) => {
            cleanup();
            reject(cause);
          },
          closed = () => {
            cleanup();
            reject(
              signal?.reason ??
                new Error(
                  "Plugin archive closed before its metadata was read.",
                ),
            );
          };
        zip.once("entry", row);
        zip.once("end", end);
        zip.once("error", fail);
        zip.once("close", closed);
        zip.readEntry();
      });
      if (!entry) break;
      if (++count > 10000)
        throw new Error("Plugin archive contains too many entries.");
      if (!descriptorName.test(entry.fileName)) continue;
      if (
        entry.uncompressedSize > 1024 ** 2 ||
        descriptors.some(
          (row) => row.path.toLowerCase() === entry.fileName.toLowerCase(),
        )
      )
        throw new Error("Plugin identity metadata is oversized or ambiguous.");
      const stream = await new Promise((resolve, reject) =>
        zip.openReadStream(entry, (cause, value) =>
          cause ? reject(cause) : resolve(value),
        ),
      );
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          if ((size += chunk.length) > 1024 ** 2)
            throw new Error("Plugin identity metadata is oversized.");
          chunks.push(chunk);
        }
      } finally {
        stream.destroy();
      }
      const velocity = entry.fileName.toLowerCase() === "velocity-plugin.json";
      if (velocity) JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const document = parseDocument(Buffer.concat(chunks).toString("utf8"), {
        uniqueKeys: true,
      });
      if (document.errors.length)
        throw new Error("Plugin identity metadata is invalid.");
      const value = document.toJS({ maxAliasCount: 10 });
      const id = pluginId(velocity ? value?.id : value?.name);
      if (!id || (velocity && !/^[a-z][a-z0-9_-]{0,63}$/.test(id)))
        throw new Error("Plugin name could not be verified.");
      descriptors.push({
        path: entry.fileName.toLowerCase(),
        id,
        title: typeof value.name === "string" ? value.name.slice(0, 100) : id,
        value,
      });
    }
    const prefer =
      loader === "velocity"
        ? ["velocity-plugin.json"]
        : ["waterfall", "bungeecord", "bungee"].includes(loader)
          ? ["bungee.yml", "plugin.yml"]
          : ["paper", "purpur", "folia"].includes(loader)
            ? ["paper-plugin.yml", "plugin.yml"]
            : ["spigot", "bukkit"].includes(loader)
              ? ["plugin.yml"]
              : [];
    const selected = prefer.length
      ? descriptors.filter(
          (row) =>
            row.path ===
            prefer.find((name) =>
              descriptors.some((value) => value.path === name),
            ),
        )
      : descriptors;
    if (!selected.length || new Set(selected.map((row) => row.id)).size !== 1)
      throw new Error("Plugin identity metadata is missing or ambiguous.");
    const provided = new Set(),
      required = new Set(),
      optional = new Set(),
      warnings = [],
      versions = new Map();
    const warn = (where) =>
      warnings.push(
        `${where}: dependency declarations could not be read completely; check the plugin documentation.`,
      );
    const names = (value, where) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 1000) {
        warn(where);
        return [];
      }
      return value.flatMap((name) => {
        const id = pluginId(name);
        if (!id) {
          warn(where);
          return [];
        }
        return [id];
      });
    };
    for (const row of selected) {
      const { value } = row;
      const version =
        ["string", "number"].includes(typeof value.version) &&
        String(value.version).length <= 256 &&
        !/[\x00-\x1f]/.test(String(value.version))
          ? String(value.version)
          : undefined;
      for (const id of [
        row.id,
        ...names(value.provides, `${row.path} provides`),
      ]) {
        provided.add(id);
        versions.set(id, version);
      }
      if (row.path === "velocity-plugin.json") {
        if (
          value.dependencies !== undefined &&
          (!Array.isArray(value.dependencies) ||
            value.dependencies.length > 1000)
        )
          warn(row.path);
        else
          for (const dependency of value.dependencies ?? []) {
            const id = pluginId(dependency?.id);
            if (
              !id ||
              !object(dependency) ||
              (dependency.optional !== undefined &&
                typeof dependency.optional !== "boolean")
            ) {
              warn(row.path);
              continue;
            }
            (dependency.optional === true ? optional : required).add(id);
          }
      } else if (row.path === "paper-plugin.yml") {
        if (value.dependencies !== undefined && !object(value.dependencies))
          warn(row.path);
        else
          for (const phase of ["bootstrap", "server"]) {
            const declarations = value.dependencies?.[phase];
            if (declarations === undefined) continue;
            if (
              !object(declarations) ||
              Object.keys(declarations).length > 1000
            ) {
              warn(`${row.path} ${phase}`);
              continue;
            }
            for (const [name, dependency] of Object.entries(declarations)) {
              const id = pluginId(name);
              if (
                !id ||
                !object(dependency) ||
                (dependency.required !== undefined &&
                  typeof dependency.required !== "boolean")
              ) {
                warn(`${row.path} ${phase}`);
                continue;
              }
              (dependency.required === false ? optional : required).add(id);
            }
          }
      } else {
        const proxy =
          row.path === "bungee.yml" ||
          ["waterfall", "bungeecord", "bungee"].includes(loader);
        for (const id of names(
          proxy ? value.depends : value.depend,
          `${row.path} ${proxy ? "depends" : "depend"}`,
        ))
          required.add(id);
        for (const id of names(
          proxy ? value.softDepends : value.softdepend,
          `${row.path} ${proxy ? "softDepends" : "softdepend"}`,
        ))
          optional.add(id);
      }
    }
    for (const id of required) optional.delete(id);
    return {
      title: selected[0].title,
      provided: [...provided],
      providers: [...provided].map((id) => ({ id, version: versions.get(id) })),
      required: [...required],
      optional: [...optional],
      requirements: [...new Set([...required, ...optional])].map((id) => ({
        id,
        range: "*",
        side: "server",
        source: "plugin",
      })),
      ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    zip.close();
  }
}
