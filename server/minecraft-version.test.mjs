import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel } from "./index.mjs";
import { minecraftGameVersion } from "./minecraft-version.mjs";

test("game releases stay distinct from loader builds and prefer installed metadata", () => {
  for (const [metadata, expected] of [
    [{ software: "NeoForge", version: "21.1.251" }, "1.21.1"],
    [{ software: "NeoForge", version: "21.0.167" }, "1.21"],
    [{ software: "Forge", version: "1.20.1-47.3.0" }, "1.20.1"],
    [{ software: "Fabric", version: "0.16.14" }, null],
    [{ software: "Quilt", version: "0.28.0", gameVersion: "1.20.1" }, "1.20.1"],
    [
      { software: "Fabric", version: "0.16.14", minecraftVersion: "1.21.4" },
      "1.21.4",
    ],
    [{ software: "Paper", version: "1.21.1" }, "1.21.1"],
    [{ software: "Java", version: "21.1.251" }, null],
    [{ software: "NeoForge", version: "Unknown" }, null],
  ])
    assert.equal(
      minecraftGameVersion(metadata),
      expected,
      JSON.stringify(metadata),
    );
});

for (const configured of [false, true]) {
  test(`${configured ? "configured Fabric" : "imported NeoForge"} exposes Minecraft release separately in fleet descriptors and server polling`, async (t) => {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temp, "mc-game-version-"));
    const serverDir = path.join(root, "server");
    await fs.mkdir(serverDir);
    const argsFile = "libraries/net/neoforged/neoforge/21.1.251/win_args.txt";
    if (!configured) {
      await fs.mkdir(path.dirname(path.join(serverDir, argsFile)), {
        recursive: true,
      });
      await fs.writeFile(path.join(serverDir, argsFile), "net.fixture.Main\n");
    }
    const panel = await createPanel({
      id: "metadata-fixture",
      dataDir: path.join(root, "panel"),
      serverDir,
      useEnvironment: false,
      scheduler: false,
      publicAddress: { resolve: async () => null },
      ...(configured
        ? { software: "Fabric", version: "0.16.14", minecraftVersion: "1.21.4" }
        : {
            source: "imported",
            launchType: "java-args",
            launchArgs: [`@${argsFile}`, "nogui"],
          }),
    });
    const listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    t.after(async () => {
      await panel.close();
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
      assert.equal(path.dirname(root), temp);
      assert.ok(path.basename(root).startsWith("mc-game-version-"));
      await fs.rm(root, { recursive: true, force: true });
    });
    const expected = configured
      ? { software: "Fabric", version: "0.16.14", minecraftVersion: "1.21.4" }
      : {
          software: "NeoForge",
          version: "21.1.251",
          minecraftVersion: "1.21.1",
        };
    const response = await fetch(
      `http://127.0.0.1:${listener.address().port}/api/server`,
    );
    assert.equal(response.status, 200);
    for (const metadata of [panel.descriptor(), await response.json()]) {
      for (const [key, value] of Object.entries(expected))
        assert.equal(metadata[key], value, key);
      assert.notEqual(metadata.minecraftVersion, metadata.version);
    }
  });
}
