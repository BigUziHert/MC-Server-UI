import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPanel } from "./index.mjs";
import { processStartup } from "../tests/fixtures/process-options.mjs";

for (const [name, content, accepted] of [
  ["a colon separator", "eula:true\n", true],
  ["the final accepted value", "eula=false\neula=TrUe\n", true],
  ["an escaped key and continued value", "e\\u0075la=tr\\\n  ue\n", true],
  ["the final declined value", "eula=true\neula=false\n", false],
  [
    "a continued unrelated value",
    "eula=false\nother=value\\\neula=true\n",
    false,
  ],
  ["commented acceptance", "# eula=true\n", false],
]) {
  test(`Start honors ${name} in the effective EULA properties`, async (t) => {
    const temporary = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temporary, "mc-eula-test-"));
    let panel;
    let listener;
    t.after(async () => {
      await panel?.close();
      if (listener) {
        listener.closeAllConnections();
        await new Promise((resolve) => listener.close(resolve));
      }
      assert.equal(path.dirname(root), temporary);
      assert.ok(path.basename(root).startsWith("mc-eula-test-"));
      await fs.rm(root, { recursive: true, force: true });
    });
    let spawned = 0;
    panel = await createPanel({
      dataDir: root,
      scheduler: false,
      publicAddress: { resolve: async () => null },
      ...processStartup,
      spawnServer: (...args) => {
        spawned++;
        return spawn(...args);
      },
    });
    await fs.writeFile(path.join(panel.serverDir, "eula.txt"), content);
    listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const power = (action) =>
      fetch(`http://127.0.0.1:${listener.address().port}/api/server/power`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    const waitForStatus = async (status) => {
      const deadline = Date.now() + 10000;
      while (panel.descriptor().status !== status) {
        assert.ok(Date.now() < deadline, `Server did not become ${status}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const started = await power("start");
    assert.equal(started.status, accepted ? 200 : 400);
    assert.equal(spawned, accepted ? 1 : 0);
    if (accepted) {
      await waitForStatus("running");
      assert.equal((await power("stop")).status, 200);
      await waitForStatus("offline");
    } else {
      assert.match((await started.json()).error, /Read the Minecraft EULA/);
      assert.equal(panel.descriptor().status, "offline");
    }
    assert.equal(
      await fs.readFile(path.join(panel.serverDir, "eula.txt"), "utf8"),
      content,
      "Start must not rewrite the user's decision",
    );
  });
}
