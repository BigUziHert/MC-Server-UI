import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument, isMap, isScalar } from "yaml";
import { parseProperties } from "./import.mjs";

const files = [
  "server.properties",
  "bukkit.yml",
  "spigot.yml",
  "pufferfish.yml",
  "purpur.yml",
  "config/paper-global.yml",
  "config/paper-world-defaults.yml",
];
const fail = (status, message) => Object.assign(new Error(message), { status });
const revision = (buffer) => createHash("sha256").update(buffer).digest("hex");
const enums = {
  difficulty: ["peaceful", "easy", "normal", "hard"],
  gamemode: ["survival", "creative", "adventure", "spectator"],
};
const ranges = {
  "server-port": [1, 65535],
  "query.port": [1, 65535],
  "rcon.port": [1, 65535],
  "max-players": [1, 100000],
  "view-distance": [2, 32],
  "simulation-distance": [2, 32],
  "max-world-size": [1, 29999984],
};
const textKeys = new Set([
  "motd",
  "level-name",
  "level-seed",
  "level-type",
  "generator-settings",
  "server-ip",
  "resource-pack",
  "resource-pack-id",
  "resource-pack-sha1",
  "resource-pack-prompt",
  "rcon.password",
  "bug-report-link",
  "initial-enabled-packs",
  "initial-disabled-packs",
  "region-file-compression",
]);
const escape = (value) =>
  String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/^[ #!:=]/, "\\$&");
function typed(value) {
  if (value === "true" || value === "false")
    return { type: "boolean", value: value === "true" };
  if (
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
    Number.isSafeInteger(Number(value))
  )
    return { type: "number", value: Number(value) };
  return { type: "string", value };
}
function field(key, value, type, label = key) {
  return {
    key,
    label: label.replace(/[-_]/g, " "),
    value,
    type,
    ...(enums[key] ? { options: enums[key] } : {}),
    ...(ranges[key] ? { min: ranges[key][0], max: ranges[key][1] } : {}),
    secret: /password|secret|token/i.test(key),
  };
}
function yamlFields(document) {
  const result = [];
  function walk(node, keys = []) {
    if (!isMap(node)) return;
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
      const next = [...keys, pair.key.value];
      if (isMap(pair.value)) walk(pair.value, next);
      else if (isScalar(pair.value)) {
        let value = pair.value.value;
        if (
          typeof value === "bigint" &&
          value >= BigInt(Number.MIN_SAFE_INTEGER) &&
          value <= BigInt(Number.MAX_SAFE_INTEGER)
        )
          value = Number(value);
        if (
          !["string", "number", "boolean"].includes(typeof value) ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          continue;
        const key = JSON.stringify(next);
        result.push({
          ...field(key, value, typeof value, next.join(" / ")),
          path: next,
        });
      }
    }
  }
  walk(document.contents);
  return result;
}
function decode(buffer) {
  if (buffer.length > 1024 * 1024)
    throw fail(
      400,
      "This configuration file is too large for Properties. Use File Manager.",
    );
  if (buffer.includes(0))
    throw fail(400, "Properties requires a plain text configuration file.");
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      encoding: "utf8",
    };
  } catch {
    return { text: buffer.toString("latin1"), encoding: "latin1" };
  }
}
function parse(filename, buffer) {
  const { text, encoding } = decode(buffer);
  if (filename === "server.properties")
    return {
      text,
      encoding,
      fields: [...parseProperties(text)].map(([key, value]) => {
        const entry =
          textKeys.has(key) || enums[key]
            ? { value, type: "string" }
            : typed(value);
        return field(key, entry.value, entry.type);
      }),
    };
  const document = parseDocument(text, { uniqueKeys: true, intAsBigInt: true });
  if (document.errors.length)
    throw fail(
      400,
      `Fix the YAML syntax in File Manager first: ${document.errors[0].message.split("\n")[0]}`,
    );
  return { text, encoding, document, fields: yamlFields(document) };
}
function updateProperties(text, changes) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const natural = text.split(/\r\n|\n|\r/),
    groups = [];
  for (let i = 0; i < natural.length; i++) {
    let group = natural[i];
    // Java comment lines never continue, even when their last character is a
    // backslash. Keep them separate so editing the next key preserves them.
    const comment = /^[ \t\f]*[#!]/.test(group.replace(/^\uFEFF/, ""));
    while (
      !comment &&
      (group.match(/\\+$/)?.[0].length ?? 0) % 2 &&
      i + 1 < natural.length
    )
      group += newline + natural[++i];
    const key = [...parseProperties(group).keys()][0];
    groups.push({ group, key });
  }
  // Duplicate Java property keys use the last value. Replace every occurrence
  // so an older duplicate cannot become effective after a later manual edit.
  return groups
    .map(({ group, key }) =>
      changes.has(key)
        ? `${String(key)
            .replace(/\\/g, "\\\\")
            .replace(
              /[\x00-\x1f\x7f]/g,
              (char) =>
                `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
            )
            .replace(/[:= #!]/g, "\\$&")}=${escape(changes.get(key))}`
        : group,
    )
    .join(newline);
}

export function createPropertiesService(ctx) {
  async function read(filename) {
    if (!files.includes(filename))
      throw fail(400, "Choose a configuration file listed in Properties.");
    const target = await ctx.safePath(ctx.serverDir, filename);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw fail(400, "Choose a regular configuration file.");
    const buffer = await fs.readFile(target);
    return { target, buffer, ...parse(filename, buffer) };
  }
  async function list() {
    const available = [];
    for (const file of files) {
      try {
        const target = await ctx.safePath(ctx.serverDir, file);
        if ((await fs.stat(target)).isFile())
          available.push({ path: file, name: file });
      } catch (cause) {
        if (!["ENOENT", "ENOTDIR"].includes(cause.code)) throw cause;
      }
    }
    return { files: available, status: ctx.getServer().status };
  }
  async function get(filename) {
    const result = await read(filename);
    return {
      path: filename,
      revision: revision(result.buffer),
      fields: result.fields,
      status: ctx.getServer().status,
    };
  }
  async function save(input) {
    if (
      !input ||
      !Array.isArray(input.changes) ||
      input.changes.length > 4096 ||
      typeof input.revision !== "string"
    )
      throw fail(
        400,
        "Provide the changed fields and the loaded file revision.",
      );
    return ctx.withMinecraftMutation(
      async () => {
        const loaded = await read(input.path);
        if (revision(loaded.buffer) !== input.revision)
          throw fail(
            409,
            "This file changed after you opened it. Reload before saving to keep those changes.",
          );
        const known = new Map(loaded.fields.map((entry) => [entry.key, entry])),
          changes = new Map();
        for (const change of input.changes) {
          const entry = known.get(change?.key);
          if (
            !entry ||
            changes.has(change.key) ||
            typeof change.value !== entry.type
          )
            throw fail(
              400,
              "A changed field is missing, duplicated, or has the wrong type. Reload Properties.",
            );
          if (
            entry.type === "number" &&
            (!Number.isFinite(change.value) ||
              (ranges[change.key] && !Number.isInteger(change.value)) ||
              (entry.min != null && change.value < entry.min) ||
              (entry.max != null && change.value > entry.max))
          )
            throw fail(400, `Choose a valid value for ${entry.label}.`);
          if (
            entry.type === "string" &&
            (change.value.length > 16384 || change.value.includes("\0"))
          )
            throw fail(
              400,
              `The value for ${entry.label} is too long or contains invalid characters.`,
            );
          if (entry.options && !entry.options.includes(change.value))
            throw fail(400, `Choose an available ${entry.label}.`);
          changes.set(change.key, change.value);
        }
        if (!changes.size) return get(input.path);
        const configuration = {};
        if (input.path === "server.properties") {
          for (const [key, configKey] of [
            ["server-port", "port"],
            ["motd", "motd"],
            ["max-players", "maxPlayers"],
          ]) {
            if (changes.has(key)) configuration[configKey] = changes.get(key);
          }
          if (
            (changes.has("server-port") || changes.has("motd")) &&
            ctx.getServer().status !== "offline"
          )
            throw fail(
              409,
              "Stop the server before changing its port or server list message.",
            );
        }
        let content;
        if (loaded.document) {
          // Replace only edited scalar spans. Re-serializing the whole document
          // can round unrelated decimal values or normalize its formatting.
          const replacements = [...changes]
            .map(([key, value]) => {
              const node = loaded.document.getIn(known.get(key).path, true);
              if (!node?.range)
                throw fail(400, "This value must be edited in File Manager.");
              const [start, end] = node.range;
              const original = loaded.text.slice(start, end);
              const ending = original.endsWith("\r\n")
                ? "\r\n"
                : original.endsWith("\n")
                  ? "\n"
                  : "";
              return { start, end, value: JSON.stringify(value) + ending };
            })
            .sort((a, b) => b.start - a.start);
          content = loaded.text;
          for (const replacement of replacements)
            content =
              content.slice(0, replacement.start) +
              replacement.value +
              content.slice(replacement.end);
        } else content = updateProperties(loaded.text, changes);
        if (loaded.encoding === "latin1" && /[^\x00-\xff]/.test(content)) {
          if (loaded.document)
            throw fail(
              400,
              "This YAML file uses a legacy text encoding. Convert it to UTF-8 in File Manager before adding these characters.",
            );
          content = content.replace(
            /[^\x00-\xff]/g,
            (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
          );
        }
        const buffer = Buffer.from(content, loaded.encoding);
        // Revalidate immediately before replacing the loaded file, including its
        // revision: external editors are not covered by the panel mutation lock.
        const target = await ctx.safePath(ctx.serverDir, input.path);
        if (revision(await fs.readFile(target)) !== input.revision)
          throw fail(409, "This file changed while saving. Reload Properties.");
        const tempRelative = `${input.path}.${randomUUID()}.tmp`;
        const temp = await ctx.safePath(ctx.serverDir, tempRelative);
        try {
          await fs.writeFile(temp, buffer, { flag: "wx" });
          const currentTarget = await ctx.safePath(ctx.serverDir, input.path);
          if (revision(await fs.readFile(currentTarget)) !== input.revision)
            throw fail(
              409,
              "This file changed while saving. Reload Properties to keep the external changes.",
            );
          await fs.rename(temp, target);
          try {
            if (Object.keys(configuration).length)
              await ctx.applyConfiguration(configuration);
          } catch (cause) {
            const rollback = await ctx.safePath(ctx.serverDir, input.path);
            if (revision(await fs.readFile(rollback)) === revision(buffer))
              await fs.writeFile(rollback, loaded.buffer);
            else
              throw fail(
                409,
                `${cause.message} An external editor changed the file during saving; its changes were kept. Reload Properties.`,
              );
            throw cause;
          }
        } finally {
          await fs.rm(await ctx.safePath(ctx.serverDir, tempRelative), {
            force: true,
          });
        }
        await ctx.audit(
          "server",
          "Properties updated",
          `${input.path}: ${[...changes.keys()].map((key) => known.get(key).label).join(", ")}`,
        );
        return {
          ...(await get(input.path)),
          message:
            "Properties saved. Restart the server to apply configuration changes.",
        };
      },
      { requireStopped: false },
    );
  }
  return { list, get, save };
}
