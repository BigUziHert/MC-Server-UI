import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import {
  createLauncherStop,
  isMinecraftShutdownLine,
} from "./launcher-stop.mjs";
import { createPanel, terminateProcessTree } from "./index.mjs";

test("only trusted shutdown lines protect a save; chat, commands and routine saves do not", () => {
  for (const line of [
    "[Server thread/INFO]: Stopping server",
    "[21:54:10] [Server thread/INFO] [minecraft/MinecraftServer]: Stopping server",
    "[21:54:10 INFO]: Stopping server",
  ])
    assert.equal(isMinecraftShutdownLine(line), true, line);
  for (const line of [
    "Stopping server",
    "[Panel] > stop",
    "[Server thread/INFO]: <Alex> Stopping server",
    "[Server thread/INFO]: [Server] Stopping server",
    "[Worker/INFO]: Stopping server",
    "[Server thread/INFO]: Saving worlds",
    "[Server thread/INFO]: Stopping server is a chat message",
  ])
    assert.equal(isMinecraftShutdownLine(line), false, line);
  assert.equal(
    isMinecraftShutdownLine("[Server thread/INFO]: Saving players", {
      allowSaving: true,
    }),
    true,
  );
});

test("a batch pause closes input only after stop and exact prompt detection; nonbatch input stays open", () => {
  const writes = [];
  const child = {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callback();
      },
    }),
  };
  const stop = createLauncherStop({ child, windowsBatch: true });
  stop.observe(
    "[Server thread/INFO]: <Alex> Press any key to continue . . .\n",
  );
  stop.requestStop();
  stop.requestStop();
  assert.deepEqual(writes, ["stop\n"]);
  stop.observe("Press any key to contin");
  assert.equal(child.stdin.writableEnded, false);
  stop.observe("Press any key to continue . . .");
  assert.equal(child.stdin.writableEnded, true);
  const other = {
    stdin: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  };
  const direct = createLauncherStop({ child: other });
  direct.requestStop();
  direct.observe("Press any key to continue . . .");
  assert.equal(other.stdin.writableEnded, false);
  direct.observe("[Server thread/INFO]: Stopping server\n");
  assert.equal(other.stdin.writableEnded, false);
  other.stdin.end();
});

test("trusted game stop also handles in-game shutdown, while incomplete log chunks do not change state", () => {
  const child = {
    stdin: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  };
  let notifications = 0;
  const stop = createLauncherStop({
    child,
    windowsBatch: true,
    onShutdownStarted: () => notifications++,
  });
  stop.observe("[Server thread/INFO]: Saving worlds\n");
  assert.equal(stop.shutdownStarted, false);
  stop.observe(
    "[Server thread/INFO] [minecraft/MinecraftServer]: Stopping server",
  );
  assert.equal(stop.shutdownStarted, false);
  stop.observe(
    "[Server thread/INFO] [minecraft/MinecraftServer]: Stopping server\n",
  );
  stop.observe("[Server thread/INFO]: Saving players\n");
  assert.equal(stop.shutdownStarted, true);
  assert.equal(notifications, 1);
  stop.observe("Press any key to continue . . .");
  assert.equal(child.stdin.writableEnded, true);
});

const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function eventually(check, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out: ${label}`);
}
async function batchFixture(t, exitCode = 0, pauseCommands = ["pause"]) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-launcher-stop-")),
  );
  const serverDir = path.join(root, "Existing world");
  await fs.mkdir(serverDir);
  const script = [
    "@echo off",
    `"${process.execPath}" "%~dp0fake-server.mjs"`,
    ...(exitCode
      ? [
          'set "SERVER_EXIT=%ERRORLEVEL%"',
          ...pauseCommands,
          "exit /b %SERVER_EXIT%",
        ]
      : pauseCommands),
    "",
  ].join("\r\n");
  await fs.writeFile(path.join(serverDir, "run.bat"), script);
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  await fs.writeFile(
    path.join(serverDir, "fake-server.mjs"),
    `
import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';
const input = createInterface({ input: process.stdin });
let stopping = false;
let inputEnded = false;
input.on('close', () => { inputEnded = true; });
console.log('[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: Done (0.1s)! For help, type "help"');
input.on('line', (line) => {
  if (line.trim() !== 'stop' || stopping) return;
  stopping = true;
  console.log('[12:00:01] [Server thread/INFO] [minecraft/MinecraftServer]: Stopping server');
  setTimeout(async () => {
    await appendFile('saved-world.txt', 'complete\\n');
    await appendFile('input-ended-before-save.txt', String(inputEnded) + '\\n');
    console.log('[12:00:02] [Server thread/INFO] [minecraft/MinecraftServer]: ThreadedAnvilChunkStorage: All dimensions are saved');
    ${exitCode ? "console.error('[12:00:02] [Server thread/ERROR]: Fixture shutdown failure');" : ""}
    process.exit(${exitCode});
  }, 650);
});
`,
  );
  const children = [];
  const panel = await createPanel({
    dataDir: path.join(root, "panel"),
    serverDir,
    mode: "live",
    launchType: "script",
    launchScript: "run.bat",
    existingServerDir: true,
    useEnvironment: false,
    scheduler: false,
    stopTimeoutMs: 400,
    telemetry: { reset() {}, sample: async () => ({ available: false }) },
    publicAddress: { resolve: async () => null },
    spawnServer: (...args) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    },
    spawnProcess: () =>
      assert.fail("A saving server or paused wrapper must not be force-killed"),
  });
  const listener = await new Promise((resolve) => {
    const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, {
      ...options,
      headers: { "Content-Type": "application/json" },
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    // Only fixture-owned PIDs are eligible for emergency teardown if an assertion
    // fails before ordinary graceful shutdown can complete.
    const emergency = setTimeout(() => {
      for (const child of children)
        if (child.exitCode == null)
          terminateProcessTree(child, { tree: true }).catch(() => {});
    }, 2000);
    try {
      await panel.close();
    } finally {
      clearTimeout(emergency);
    }
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-launcher-stop-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const start = await request(
    "/api/server/power",
    json("POST", { action: "start" }),
  );
  assert.equal(start.status, 200, JSON.stringify(start));
  await eventually(
    async () => (await request("/api/server")).body.status === "running",
    "server ready",
  );
  return { ...panel, request, children, script };
}

for (const action of ["stop", "restart", "close", "update"]) {
  test(
    `real Windows batch ${action} saves beyond the stop deadline and exits its trailing pause cleanly`,
    { skip: process.platform !== "win32" },
    async (t) => {
      const panel = await batchFixture(t);
      if (action === "close" || action === "update")
        await panel.close({ gracefulOnly: action === "update" });
      else {
        const response = await panel.request(
          "/api/server/power",
          json("POST", { action }),
        );
        assert.equal(response.status, 200);
        await eventually(
          async () =>
            (await panel.request("/api/server")).body.status ===
            (action === "restart" ? "running" : "offline"),
          `${action} complete`,
        );
      }
      assert.equal(panel.children[0].exitCode, 0);
      assert.equal(
        await fs.readFile(
          path.join(panel.serverDir, "saved-world.txt"),
          "utf8",
        ),
        "complete\n",
      );
      assert.equal(
        await fs.readFile(path.join(panel.serverDir, "run.bat"), "utf8"),
        panel.script,
      );
      if (action === "stop" || action === "restart") {
        const logs = (await panel.request("/api/console")).body.lines;
        assert.ok(
          logs.some((line) =>
            line.message.includes(
              "Closing launcher input while Minecraft finishes saving",
            ),
          ),
        );
        assert.ok(
          logs.every(
            (line) =>
              !/did not exit|Terminating|exited \(code 1\)/.test(line.message),
          ),
        );
      }
      if (action === "restart") assert.equal(panel.children.length, 2);
    },
  );
}

test(
  "a real batch wrapper preserves genuine nonzero exit status after pause acknowledgement",
  { skip: process.platform !== "win32" },
  async (t) => {
    const panel = await batchFixture(t, 7);
    await panel.request("/api/server/power", json("POST", { action: "stop" }));
    await eventually(
      async () =>
        (await panel.request("/api/server")).body.status === "offline",
      "failed server exit",
    );
    assert.equal(panel.children[0].exitCode, 7);
    const logs = (await panel.request("/api/console")).body.lines;
    assert.ok(
      logs.some(
        (line) => line.level === "error" && line.message.includes("code 7"),
      ),
    );
    assert.ok(
      logs.some(
        (line) =>
          line.level === "error" &&
          line.message.includes("Fixture shutdown failure"),
      ),
    );
  },
);

for (const variant of [
  {
    name: "localized",
    commands: ["echo Appuyez sur une touche pour continuer...", "pause >nul"],
    exitCode: 0,
  },
  { name: "suppressed", commands: ["pause >nul"], exitCode: 7 },
]) {
  test(
    `real Windows ${variant.name} pause completes after EOF without interrupting the delayed world save`,
    { skip: process.platform !== "win32" },
    async (t) => {
      const panel = await batchFixture(t, variant.exitCode, variant.commands);
      if (variant.exitCode) await panel.close({ gracefulOnly: true });
      else {
        await panel.request(
          "/api/server/power",
          json("POST", { action: "stop" }),
        );
        await eventually(
          async () =>
            (await panel.request("/api/server")).body.status === "offline",
          "localized pause exit",
        );
      }
      assert.equal(panel.children[0].exitCode, variant.exitCode);
      assert.equal(
        await fs.readFile(
          path.join(panel.serverDir, "saved-world.txt"),
          "utf8",
        ),
        "complete\n",
      );
      assert.equal(
        await fs.readFile(
          path.join(panel.serverDir, "input-ended-before-save.txt"),
          "utf8",
        ),
        "true\n",
      );
      assert.equal(
        await fs.readFile(path.join(panel.serverDir, "run.bat"), "utf8"),
        panel.script,
      );
    },
  );
}
