import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { exportClientPack } from "./client-pack.mjs";

test("client export retains client-only manifest members but omits server policy and untrusted downloads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-client-export-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("mc-client-export-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const hashes = { sha512: "a".repeat(128), sha1: "b".repeat(40) };
  const member = {
    path: "mods/client.jar",
    hashes,
    fileSize: 100,
    downloads: [
      "https://cdn.modrinth.com/data/project/versions/version/client.jar",
    ],
    env: { client: "required", server: "unsupported" },
  };
  const result = await exportClientPack({
    serverDir: root,
    safePath: async (base, name) => path.join(base, name),
    configuration: {
      name: "Survival",
      minecraftVersion: "1.21.1",
      software: "Fabric",
      version: "0.16.10",
    },
    receipts: [
      {
        pack: true,
        clientManifest: {
          formatVersion: 1,
          game: "minecraft",
          dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.10" },
          files: [
            member,
            { ...member, path: "server.properties" },
            {
              ...member,
              path: "mods/untrusted.jar",
              downloads: ["https://localhost/private"],
            },
          ],
        },
      },
    ],
    fetch: async () => {
      throw new Error("Client-only entries need no request");
    },
  });
  assert.equal(result.files, 1);
  assert.ok(result.warnings.some((value) => value.includes("untrusted.jar")));
  assert.equal(result.filename, "MC-Panel-client-pack.mrpack");
  assert.equal(result.buffer.readUInt32LE(0), 0x04034b50);
});

test("unknown nonempty environment declarations never imply client support", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-client-export-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("mc-client-export-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "mods"));
  const source = Buffer.from("unknown mod");
  await fs.writeFile(path.join(root, "mods/unknown.jar"), source);
  const hashes = Object.fromEntries(
    ["sha512", "sha1"].map((algorithm) => [
      algorithm,
      createHash(algorithm).update(source).digest("hex"),
    ]),
  );
  let lookedUpProject = false;
  await assert.rejects(
    exportClientPack({
      serverDir: root,
      safePath: async (base, name) => path.join(base, name),
      configuration: {
        minecraftVersion: "1.21.1",
        software: "neoforge",
        version: "21.1.200",
      },
      receipts: [],
      fetch: async (url) => {
        if (String(url).includes("/version_file/"))
          return Response.json({
            project_id: "unknown",
            environment: "new_undocumented_mode",
            files: [
              {
                hashes,
                size: source.length,
                url: "https://cdn.modrinth.com/unknown.jar",
              },
            ],
          });
        lookedUpProject = true;
        return Response.json({ client_side: "unsupported" });
      },
    }),
    /No verified client files/,
  );
  assert.equal(lookedUpProject, true);
});
