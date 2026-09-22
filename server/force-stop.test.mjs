import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { createPanel, terminateProcessTree } from "./index.mjs";

const json = (body) => ({ method: "POST", body: JSON.stringify(body) });
async function eventually(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for fixture state");
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "mc-force-stop-"),
  );
  const children = [],
    killers = [],
    commands = [];
  const panel = await createPanel({
    dataDir: root,
    jar: "server.jar",
    useEnvironment: false,
    scheduler: false,
    stopTimeoutMs: 20,
    forceStopTimeoutMs: 200,
    telemetry: { reset() {}, sample: async () => ({ available: false }) },
    publicAddress: { resolve: async () => null },
    spawnServer: () => {
      const child = new EventEmitter();
      child.pid = 12345 + children.length;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          commands.push(chunk.toString().trim());
          if (chunk.toString().trim() === "stop")
            child.stdout.write("[Server thread/INFO]: Stopping server\n");
          callback();
        },
      });
      child.kill = (signal) => {
        assert.equal(signal, "SIGKILL");
        killers.push({ child, signal });
        if (options.failKill) throw new Error("Fixture termination failed");
        return true;
      };
      children.push(child);
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (1.0s)! For help, type "help"\n',
        ),
      );
      return child;
    },
    spawnProcess: (executable, args, settings) => {
      assert.match(executable, /System32\\taskkill\.exe$/i);
      assert.deepEqual(args, ["/PID", String(children.at(-1).pid), "/T", "/F"]);
      assert.equal(settings.shell, false);
      assert.equal(settings.windowsHide, true);
      const killer = new EventEmitter();
      killer.kill = () => killer.emit("close", 1);
      killers.push(killer);
      if (options.failKill) setImmediate(() => killer.emit("close", 1));
      return killer;
    },
  });
  await fs.writeFile(path.join(panel.serverDir, "server.jar"), "fixture");
  await fs.writeFile(path.join(panel.serverDir, "eula.txt"), "eula=true\n");
  const listener = await new Promise((resolve) => {
    const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const request = async (route, init = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${listener.address().port}${route}`,
      {
        ...init,
        headers: { "Content-Type": "application/json" },
      },
    );
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    for (const child of children) child.emit("close", 0);
    for (const killer of killers) killer.emit?.("close", 0);
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-force-stop-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const power = (action, extra = {}) =>
    request("/api/server/power", json({ action, ...extra }));
  assert.equal((await power("start")).status, 200);
  await eventually(
    async () => (await request("/api/server")).body.status === "running",
  );
  return { request, power, children, killers, commands };
}

test("force stop requires explicit confirmation and a stopping server", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.power("force-stop")).status, 400);
  assert.equal(
    (await f.power("force-stop", { confirmed: "true" })).status,
    400,
  );
  assert.equal((await f.power("force-stop", { confirmed: true })).status, 409);
  assert.equal(f.killers.length, 0);
});

test("a hung graceful save stays protected until force stop, which cancels restart and deduplicates requests", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.power("restart")).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.commands, ["stop"]);
  assert.equal(f.killers.length, 0);
  assert.equal((await f.request("/api/server")).body.status, "stopping");
  const first = f.power("force-stop", { confirmed: true });
  await eventually(() => f.killers.length === 1);
  const second = f.power("force-stop", { confirmed: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.killers.length, 1);
  assert.equal((await f.power("start")).status, 409);
  f.children[0].emit("close", 1);
  if (process.platform === "win32") {
    assert.equal((await f.request("/api/server")).body.status, "stopping");
    assert.equal((await f.power("start")).status, 409);
    f.killers[0].emit("close", 0);
  }
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await f.request("/api/server")).body.status, "offline");
  assert.equal(f.children.length, 1);
  assert.equal((await f.power("force-stop", { confirmed: true })).status, 409);
  const audit = (await f.request("/api/audit")).body.entries;
  assert.equal(
    audit.filter((entry) => entry.action === "Server force stopped").length,
    1,
  );
  assert.equal((await f.power("start")).status, 200);
  assert.equal(f.children.length, 2);
});

test("failed termination stays stopping, reports failure, and allows a fresh explicit retry", async (t) => {
  const options = { failKill: true };
  const f = await fixture(t, options);
  await f.power("stop");
  const failed = await f.power("force-stop", { confirmed: true });
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /still stopping\. Try Force Stop again/);
  assert.doesNotMatch(failed.body.error, /taskkill|Fixture termination/);
  assert.equal((await f.request("/api/server")).body.status, "stopping");
  assert.equal((await f.power("start")).status, 409);
  options.failKill = false;
  const retry = f.power("force-stop", { confirmed: true });
  await eventually(() => f.killers.length === 2);
  f.killers[1].emit?.("close", 0);
  f.children[0].emit("close", 1);
  assert.equal((await retry).status, 200);
  assert.equal((await f.request("/api/server")).body.status, "offline");
  const audit = (await f.request("/api/audit")).body.entries;
  assert.ok(audit.some((entry) => entry.action === "Server force stop failed"));
});

test("a successful killer does not report offline before the child exits", async (t) => {
  const f = await fixture(t);
  await f.power("stop");
  const pending = f.power("force-stop", { confirmed: true });
  await eventually(() => f.killers.length === 1);
  f.killers[0].emit?.("close", 0);
  const timedOut = await pending;
  assert.equal(timedOut.status, 503);
  assert.match(timedOut.body.error, /still stopping\. Try Force Stop again/);
  assert.equal((await f.request("/api/server")).body.status, "stopping");
  assert.equal((await f.power("start")).status, 409);
  f.children[0].emit("close", 1);
  assert.equal((await f.request("/api/server")).body.status, "offline");
});

test(
  "Windows tree failure after wrapper exit remains blocked instead of restarting an unconfirmed tree",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await f.power("restart");
    const pending = f.power("force-stop", { confirmed: true });
    await eventually(() => f.killers.length === 1);
    f.children[0].emit("close", 1);
    f.killers[0].emit("close", 1);
    const failed = await pending;
    assert.equal(failed.status, 503);
    assert.match(
      failed.body.error,
      /process tree could not be confirmed stopped/,
    );
    assert.match(
      failed.body.error,
      /Check the server processes before restarting/,
    );
    assert.doesNotMatch(failed.body.error, /taskkill/);
    assert.equal((await f.request("/api/server")).body.status, "stopping");
    assert.equal((await f.power("start")).status, 409);
    assert.equal(
      (await f.power("force-stop", { confirmed: true })).status,
      409,
    );
    assert.equal(f.children.length, 1);
  },
);

test("a hung taskkill helper times out without targeting unrelated processes", async () => {
  const helper = new EventEmitter();
  let helperStopped = false;
  helper.kill = () => {
    helperStopped = true;
    helper.emit("close", 0);
  };
  await assert.rejects(
    terminateProcessTree(
      { pid: 12345 },
      {
        tree: true,
        platform: "win32",
        timeoutMs: 10,
        spawnProcess: (_executable, args) => {
          assert.deepEqual(args, ["/PID", "12345", "/T", "/F"]);
          return helper;
        },
      },
    ),
    /Timed out stopping/,
  );
  assert.equal(helperStopped, true);
});

test(
  "real Windows Force Stop ends a hung saving batch tree and leaves unrelated processes running",
  { skip: process.platform !== "win32", timeout: 90000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "mc-force-stop-real-"),
    );
    const serverDir = path.join(root, "server");
    await fs.mkdir(serverDir);
    await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
    await fs.writeFile(
      path.join(serverDir, "run.bat"),
      `@echo off\r\n"${process.execPath}" "%~dp0hung-server.mjs"\r\npause\r\n`,
    );
    await fs.writeFile(
      path.join(serverDir, "hung-server.mjs"),
      `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync('server.pid', String(process.pid));
setInterval(() => {}, 1000);
console.log('[Server thread/INFO]: Done (1.0s)! For help, type "help"');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'stop') console.log('[Server thread/INFO]: Stopping server');
});
`,
    );
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { windowsHide: true, stdio: "ignore" },
    );
    let child;
    const panel = await createPanel({
      dataDir: path.join(root, "panel"),
      serverDir,
      mode: "live",
      existingServerDir: true,
      launchType: "script",
      launchScript: "run.bat",
      useEnvironment: false,
      scheduler: false,
      stopTimeoutMs: 20,
      // Process-tree enumeration is slower on a busy Windows desktop than the
      // mocked timeout checks above. Keep this integration deadline bounded.
      forceStopTimeoutMs: 20000,
      telemetry: { reset() {}, sample: async () => ({ available: false }) },
      publicAddress: { resolve: async () => null },
      spawnServer: (...args) => {
        child = spawn(...args);
        return child;
      },
    });
    const listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const request = async (route, init = {}) => {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        { ...init, headers: { "Content-Type": "application/json" } },
      );
      return { status: response.status, body: await response.json() };
    };
    t.after(async () => {
      let terminationError;
      try {
        if (child && child.exitCode === null && child.signalCode === null)
          await terminateProcessTree(child, { tree: true, timeoutMs: 20000 });
      } catch (cause) {
        terminationError = cause;
        // A failed taskkill must not leak the deliberately hung test process or
        // prevent the listener and unrelated-process fixture from being closed.
        const ownedPid = Number(
          await fs
            .readFile(path.join(serverDir, "server.pid"), "utf8")
            .catch(() => ""),
        );
        if (Number.isSafeInteger(ownedPid) && ownedPid > 0) {
          try {
            process.kill(ownedPid);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        child.kill();
      } finally {
        unrelated.kill();
        listener.closeAllConnections();
        await Promise.all([
          panel.close(),
          new Promise((resolve) => listener.close(resolve)),
        ]);
      }
      assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("mc-force-stop-real-"));
      await fs.rm(root, { recursive: true, force: true });
      if (terminationError) throw terminationError;
    });
    assert.equal(
      (await request("/api/server/power", json({ action: "start" }))).status,
      200,
    );
    await eventually(
      async () => (await request("/api/server")).body.status === "running",
    );
    const serverPid = Number(
      await fs.readFile(path.join(serverDir, "server.pid"), "utf8"),
    );
    assert.equal(
      (await request("/api/server/power", json({ action: "stop" }))).status,
      200,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await request("/api/server")).body.status, "stopping");
    assert.doesNotThrow(() => process.kill(serverPid, 0));
    const forced = await request(
      "/api/server/power",
      json({ action: "force-stop", confirmed: true }),
    );
    assert.equal(forced.status, 200, JSON.stringify(forced));
    assert.equal(forced.body.status, "offline");
    assert.throws(() => process.kill(serverPid, 0), { code: "ESRCH" });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  },
);
