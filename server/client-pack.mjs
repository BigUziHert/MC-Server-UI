import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { ZipFile } from "yazl";
import {
  checkedProviderUrl,
  providerJson,
  curseforgeDownloadHosts,
} from "./launchpad-network.mjs";

const safeClientPath = (value) =>
  typeof value === "string" &&
  /^(?:mods\/[^/]+\.jar|(?:resourcepacks|shaderpacks)\/[^/]+\.zip)$/i.test(
    value,
  ) &&
  !/[\\:\0]/.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..");
const downloadHosts = [
  "cdn.modrinth.com",
  ...curseforgeDownloadHosts,
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "gitlab.com",
];
const fail = (message) => Object.assign(new Error(message), { status: 409 });
const fileStamp = (stat) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const knownEnvironments = new Set([
  "client_and_server",
  "client_only",
  "client_only_server_optional",
  "singleplayer_only",
  "client_or_server",
  "client_or_server_prefers_both",
  "server_only",
  "server_only_client_optional",
  "dedicated_server_only",
]);
async function archiveManifest(manifest, name, warnings) {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), name);
  zip.addBuffer(
    Buffer.from(warnings.join("\n") + "\n"),
    "MC-Panel-export-notes.txt",
  );
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.once("end", resolve);
    zip.outputStream.once("error", reject);
    zip.once("error", reject);
  });
  zip.end();
  await completed;
  return Buffer.concat(chunks);
}

export async function exportClientPack({
  receipts,
  configuration,
  serverDir,
  safePath,
  fetch: request = fetch,
  signal,
}) {
  const pack = receipts.find((item) => item.pack);
  const original = pack?.clientManifest;
  const warnings = [
    "Server configuration, player lists, credentials, worlds and custom client configuration are not included. Review omitted files before sharing.",
  ];
  if (
    pack?.clientManifestFormat === "curseforge" &&
    original?.minecraft?.version &&
    Array.isArray(original.files)
  ) {
    const exported = new Map(
      original.files
        .filter(
          (file) =>
            Number.isSafeInteger(file.projectID) &&
            file.projectID > 0 &&
            Number.isSafeInteger(file.fileID) &&
            file.fileID > 0,
        )
        .map(({ projectID, fileID, required }) => [
          projectID,
          { projectID, fileID, required: required !== false },
        ]),
    );
    for (const receipt of receipts.filter(
      (item) => item.type === "mod" && safeClientPath(item.path),
    )) {
      if (
        receipt.platform !== "curseforge" ||
        !/^\d+$/.test(String(receipt.projectId)) ||
        !/^\d+$/.test(String(receipt.versionId))
      ) {
        warnings.push(
          `Install ${receipt.title ?? receipt.path} separately; its provider is not part of this CurseForge manifest.`,
        );
        continue;
      }
      const file = await safePath(serverDir, receipt.path);
      const stat = await fs.lstat(file).catch((cause) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const digest = createHash("sha512");
      const handle = await fs.open(file, "r");
      try {
        for await (const chunk of handle.createReadStream({
          autoClose: false,
        })) {
          signal?.throwIfAborted();
          digest.update(chunk);
        }
      } finally {
        await handle.close();
      }
      if (
        fileStamp(stat) !== fileStamp(await fs.lstat(file)) ||
        digest.digest("hex") !== receipt.sha512
      ) {
        warnings.push(
          `Omitted changed file ${receipt.path}; its exact version could not be verified.`,
        );
        exported.delete(Number(receipt.projectId));
        continue;
      }
      exported.set(Number(receipt.projectId), {
        projectID: Number(receipt.projectId),
        fileID: Number(receipt.versionId),
        required: true,
      });
    }
    warnings.push(
      "The original pack's client-only entries are retained. Additional CurseForge mods may need a client compatibility check; custom server ZIPs may require the original launcher profile.",
    );
    warnings.push(
      "The original CurseForge manifest does not identify which entries were client-only or were later removed from the server. Review its original entries; this export cannot prove an exact current client inventory.",
    );
    const manifest = {
      minecraft: original.minecraft,
      manifestType: "minecraftModpack",
      manifestVersion: 1,
      name: configuration.name ?? pack.title,
      version: `panel-${Date.now()}`,
      author: "MC Panel",
      files: [...exported.values()],
      overrides: "overrides",
    };
    return {
      buffer: await archiveManifest(manifest, "manifest.json", warnings),
      filename: "MC-Panel-client-pack.zip",
      files: manifest.files.length,
      warnings,
      summary: manifest.name,
    };
  }
  const files = new Map();
  const validFile = (entry) => {
    if (
      !safeClientPath(entry.path) ||
      !/^[a-f0-9]{128}$/i.test(entry.hashes?.sha512 ?? "") ||
      !/^[a-f0-9]{40}$/i.test(entry.hashes?.sha1 ?? "") ||
      !Number.isSafeInteger(entry.fileSize) ||
      entry.fileSize < 0
    )
      return null;
    const downloads = (entry.downloads ?? []).flatMap((url) => {
      try {
        return [checkedProviderUrl(url, downloadHosts)];
      } catch {
        return [];
      }
    });
    if (!downloads.length) return null;
    return {
      path: entry.path,
      hashes: { sha512: entry.hashes.sha512, sha1: entry.hashes.sha1 },
      downloads,
      fileSize: entry.fileSize,
      env: {
        client: entry.env?.client === "optional" ? "optional" : "required",
        server: ["required", "optional", "unsupported"].includes(
          entry.env?.server,
        )
          ? entry.env.server
          : "optional",
      },
    };
  };
  if (original?.formatVersion === 1 && original.game === "minecraft") {
    for (const entry of original.files ?? []) {
      if (entry.env?.client === "unsupported") continue;
      const safe = validFile(entry);
      if (!safe) {
        warnings.push(
          `Omitted ${String(entry.path).slice(0, 180)}: no verified client download.`,
        );
        continue;
      }
      // Client-only members are retained even though they were never installed on the server.
      if (safe.env.server !== "unsupported" && safe.path.startsWith("mods/")) {
        const present = await fs
          .lstat(await safePath(serverDir, safe.path))
          .catch((cause) => {
            if (cause.code === "ENOENT") return null;
            throw cause;
          });
        if (!present) continue;
      }
      files.set(safe.path, safe);
    }
  }
  const entries = await fs
    .readdir(await safePath(serverDir, "mods"), { withFileTypes: true })
    .catch((cause) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
  for (const entry of entries) {
    signal?.throwIfAborted();
    const relative = `mods/${entry.name}`;
    if (!entry.isFile() || !safeClientPath(relative)) continue;
    const target = await safePath(serverDir, relative);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || stat.size > 512 * 1024 ** 2) {
      warnings.push(`Omitted ${entry.name}: unsupported file.`);
      files.delete(relative);
      continue;
    }
    const hash = createHash("sha512");
    const handle = await fs.open(target, "r");
    try {
      for await (const bytes of handle.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted();
        hash.update(bytes);
      }
    } finally {
      await handle.close();
    }
    const sha512 = hash.digest("hex");
    if (fileStamp(stat) !== fileStamp(await fs.lstat(target))) {
      files.delete(relative);
      warnings.push(
        `Omitted changed file ${entry.name}; refresh and export again after file changes finish.`,
      );
      continue;
    }
    if (files.get(relative)?.hashes.sha512 === sha512) continue;
    files.delete(relative);
    const receipt = receipts.find(
      (item) => item.path === relative && item.sha512 === sha512,
    );
    try {
      const version = await providerJson(
        `https://api.modrinth.com/v2/version_file/${sha512}?algorithm=sha512`,
        { fetch: request, signal, deadlineMs: 10000 },
      );
      if (
        ["server_only", "dedicated_server_only"].includes(version.environment)
      )
        continue;
      if (!knownEnvironments.has(version.environment)) {
        const project = await providerJson(
          `https://api.modrinth.com/v2/project/${encodeURIComponent(version.project_id)}`,
          { fetch: request, signal, deadlineMs: 10000 },
        );
        if (project.client_side === "unsupported") continue;
        if (!["required", "optional"].includes(project.client_side))
          throw new Error("Client support is unknown");
      }
      const downloadable = version.files?.find(
        (file) => file.hashes?.sha512 === sha512,
      );
      const safe =
        downloadable &&
        validFile({
          path: relative,
          hashes: downloadable.hashes,
          downloads: [downloadable.url],
          fileSize: downloadable.size,
          env: {
            client:
              version.environment === "server_only_client_optional"
                ? "optional"
                : "required",
            server: "required",
          },
        });
      if (!safe) throw new Error("No verified client download");
      files.set(relative, safe);
    } catch (cause) {
      signal?.throwIfAborted();
      warnings.push(
        `Omitted ${receipt?.title ?? entry.name}: a verified client-compatible download could not be found. Install it manually if required.`,
      );
    }
  }
  const loader = String(configuration.software ?? "").toLowerCase();
  const dependencies = {
    ...(original?.dependencies ?? {}),
    minecraft:
      configuration.minecraftVersion ?? original?.dependencies?.minecraft,
  };
  const loaderKey = {
    fabric: "fabric-loader",
    quilt: "quilt-loader",
    forge: "forge",
    neoforge: "neoforge",
  }[loader];
  if (loaderKey && configuration.version) {
    for (const key of ["fabric-loader", "quilt-loader", "forge", "neoforge"])
      delete dependencies[key];
    dependencies[loaderKey] =
      loader === "forge"
        ? configuration.version.replace(/^\d+\.\d+(?:\.\d+)?-/, "")
        : configuration.version;
  }
  if (!dependencies.minecraft)
    throw fail(
      "Identify this server's Minecraft version before exporting a client pack.",
    );
  const manifest = {
    formatVersion: 1,
    game: "minecraft",
    versionId: `panel-${Date.now()}`,
    name: configuration.name ?? pack?.title ?? "Server client pack",
    summary:
      "Client downloads matching this server. Read MC-Panel-export-notes.txt for omissions.",
    files: [...files.values()],
    dependencies,
  };
  if (!files.size)
    throw fail(
      "No verified client files are available to export. Use the original pack's launcher page, then add client mods manually.",
    );
  return {
    buffer: await archiveManifest(manifest, "modrinth.index.json", warnings),
    filename: "MC-Panel-client-pack.mrpack",
    files: manifest.files.length,
    warnings,
    summary: manifest.name,
  };
}
