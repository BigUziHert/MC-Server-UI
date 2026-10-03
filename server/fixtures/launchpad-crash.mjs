import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createLaunchpad } from "../launchpad.mjs";
import { createRecycleBin } from "../recycle-bin.mjs";
import { containedSourcePath } from "../import.mjs";
const [root, cut] = process.argv.slice(2);
const serverDir = path.join(root, "server"),
  dataDir = path.join(root, "panel");
const safePath = (base, name = "") =>
  name ? containedSourcePath(base, name) : fs.realpath(base);
const content = Buffer.from("new plugin contents");
const hashes = { sha512: createHash("sha512").update(content).digest("hex") };
const bin = await createRecycleBin({ serverDir, dataDir, safePath });
const originalOpen = fs.open.bind(fs),
  originalRename = fs.rename.bind(fs);
let writing = false;
fs.open = async (target, flags, ...args) => {
  const handle = await originalOpen(target, flags, ...args);
  if (
    target === path.join(serverDir, "plugins", "audit.jar") &&
    flags === "wx"
  ) {
    writing = true;
    const write = handle.writeFile.bind(handle),
      close = handle.close.bind(handle);
    handle.writeFile = async (chunk) => {
      if (cut === "partial-output") {
        await write(chunk.subarray(0, 4));
        await handle.sync();
        process.exit(86);
      }
      return write(chunk);
    };
    handle.close = async () => {
      await close();
      if (cut === "after-output") process.exit(86);
    };
  }
  return handle;
};
fs.rename = async (source, target) => {
  await originalRename(source, target);
  if (
    writing &&
    path.basename(target) === "installed.json" &&
    cut === "after-receipts"
  )
    process.exit(86);
  if (path.basename(target) === "transaction.json" && cut === "committed") {
    const journal = JSON.parse(await fs.readFile(target, "utf8"));
    if (journal.state === "committed") process.exit(86);
  }
};
const service = await createLaunchpad({
  serverDir,
  dataDir,
  safePath,
  getServer: async () => ({
    status: "offline",
    gameVersion: "1.21.1",
    loader: "paper",
  }),
  withMinecraftMutation: async (work) => work(),
  recycle: async (relative) => {
    if (cut === "before-recycle") process.exit(86);
    const item = await bin.recycle(relative);
    if (cut === "after-recycle") process.exit(86);
    return item;
  },
  restore: (id) => bin.restore(id),
  fetch: async (url) =>
    new URL(url).hostname === "cdn.modrinth.com"
      ? new Response(content)
      : Response.json({}),
  extraProviders: [
    {
      id: "fixture",
      name: "Fixture",
      types: ["plugin"],
      available: true,
      downloadHosts: ["cdn.modrinth.com"],
      resolve: async () => ({
        title: "Recovery plugin",
        versionName: "new",
        files: [
          {
            path: "audit.jar",
            url: "https://cdn.modrinth.com/audit.jar",
            size: content.length,
            hashes,
          },
          {
            path: "second.jar",
            url: "https://cdn.modrinth.com/second.jar",
            size: content.length,
            hashes,
          },
        ],
        warnings: [],
      }),
    },
  ],
});
const plan = await service.preview({
  platform: "fixture",
  type: "plugin",
  projectId: "1",
  versionId: "2",
  loader: "paper",
  gameVersion: "1.21.1",
});
await service.install({ planId: plan.planId, confirmed: true });
setTimeout(() => {
  throw new Error("The crash cut point was not reached.");
}, 5000);
