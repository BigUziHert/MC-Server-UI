import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import * as tar from "tar";
import { createPanel } from "./index.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-shutdown-test-"));
  const cleanup = [];
  const panel = await createPanel({
    dataDir,
    scheduler: false,
    useEnvironment: false,
    publicAddress: { resolve: async () => null },
    ...options,
  });
  const listener = await new Promise((resolve) => {
    const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    for (const callback of cleanup) callback();
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("mc-shutdown-test-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ...panel, dataDir, base, request, cleanup };
}

function gatedJava() {
  const commands = [];
  const flushing = deferred();
  const ready = deferred();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 1);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const command = chunk.toString().trim();
      commands.push(command);
      if (command === "save-all flush") flushing.resolve();
      if (command === "stop") setImmediate(() => child.emit("close", 0));
      callback();
    },
  });
  return {
    child,
    commands,
    flushing: flushing.promise,
    ready: ready.promise,
    confirm: () => child.stdout.write("[Server thread/INFO]: Saved the game\n"),
    spawnServer: () => {
      setImmediate(() => {
        child.stdout.write(
          '[Server thread/INFO]: Done (1.24s)! For help, type "help"\n',
        );
        ready.resolve();
      });
      return child;
    },
  };
}

for (const trigger of ["manual", "scheduled"]) {
  test(`shutdown finishes ${trigger} online backup and save-on before stopping Java`, async (t) => {
    const java = gatedJava();
    const panel = await fixture(t, {
      jar: "server.jar",
      spawnServer: java.spawnServer,
      backupFlushTimeoutMs: 2000,
    });
    panel.cleanup.push(java.confirm);
    await fs.writeFile(
      path.join(panel.serverDir, "server.jar"),
      "never executed",
    );
    await fs.writeFile(path.join(panel.serverDir, "eula.txt"), "eula=true\n");
    await fs.writeFile(
      path.join(panel.serverDir, "world-proof.txt"),
      "world must survive quit",
    );
    const started = await panel.request(
      "/api/server/power",
      json("POST", { action: "start" }),
    );
    assert.equal(started.status, 200, JSON.stringify(started));
    await java.ready;
    const abort = new AbortController();
    let pending;
    if (trigger === "manual") {
      pending = panel
        .request("/api/backups", {
          ...json("POST", { name: "Backup before quit" }),
          signal: abort.signal,
        })
        .catch((cause) => cause);
    } else {
      const saved = await panel.request(
        "/api/backups/schedule",
        json("PUT", {
          enabled: true,
          type: "interval",
          intervalHours: 1,
          retention: 2,
        }),
      );
      pending = panel.tick(
        new Date(new Date(saved.body.schedule.nextRun).getTime() + 1),
      );
    }
    // A request rejected before reaching Java must fail the test, rather than
    // leave an unresolved fixture gate that hides the original HTTP failure.
    await Promise.race([
      java.flushing,
      pending.then((result) =>
        assert.fail(
          `The ${trigger} backup completed before requesting its world flush: ${JSON.stringify(result)}`,
        ),
      ),
    ]);
    // A closed browser tab does not mean its backup stopped doing disk work.
    if (trigger === "manual") abort.abort();
    let completed = false;
    const closing = panel.close().then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(completed, false);
    assert.deepEqual(java.commands, ["save-off", "save-all flush"]);
    assert.equal(
      (
        await panel.request(
          "/api/files",
          json("POST", { name: "too-late.txt", type: "file" }),
        )
      ).status,
      503,
    );
    java.confirm();
    await Promise.all([closing, pending]);
    assert.deepEqual(java.commands, [
      "save-off",
      "save-all flush",
      "save-on",
      "stop",
    ]);
    const state = JSON.parse(
      await fs.readFile(path.join(panel.dataDir, "panel.json"), "utf8"),
    );
    assert.equal(state.backups.length, 1);
    assert.equal(state.backups[0].trigger, trigger);
    assert.ok(state.audit.some((entry) => entry.action === "Backup created"));
    if (trigger === "scheduled")
      assert.ok(new Date(state.schedule.nextRun) > new Date());
    const verified = path.join(panel.dataDir, "verified");
    await fs.mkdir(verified);
    await tar.x({
      file: path.join(
        panel.dataDir,
        "backups",
        `${state.backups[0].id}.tar.gz`,
      ),
      cwd: verified,
    });
    assert.equal(
      await fs.readFile(path.join(verified, "world-proof.txt"), "utf8"),
      "world must survive quit",
    );
  });
}

test("shutdown drains a disconnected file mutation through its disk write and audit save", async (t) => {
  const panel = await fixture(t);
  const reachedWrite = deferred();
  const releaseWrite = deferred();
  panel.cleanup.push(releaseWrite.resolve);
  // safePath resolves existing parents before writing. Windows CI can expose
  // TEMP using a short-name alias or different casing, so match that same path.
  const target = path.join(await fs.realpath(panel.serverDir), "slow.txt");
  const original = fs.writeFile;
  t.mock.method(fs, "writeFile", async (destination, ...args) => {
    if (destination === target) {
      reachedWrite.resolve();
      await releaseWrite.promise;
    }
    return original(destination, ...args);
  });
  const abort = new AbortController();
  const pending = panel
    .request("/api/files", {
      ...json("POST", {
        name: "slow.txt",
        type: "file",
        content: "completed after client left",
      }),
      signal: abort.signal,
    })
    .catch((cause) => cause);
  await Promise.race([
    reachedWrite.promise,
    pending.then((result) =>
      assert.fail(
        `The file request completed before its gated disk write: ${JSON.stringify(result)}`,
      ),
    ),
  ]);
  abort.abort();
  assert.equal(
    (
      await panel.request(
        "/api/backups",
        json("POST", { name: "Cannot race a disconnected write" }),
      )
    ).status,
    409,
  );
  let completed = false;
  const closing = panel.close().then(() => {
    completed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completed, false);
  releaseWrite.resolve();
  await Promise.all([closing, pending]);
  assert.equal(
    await fs.readFile(target, "utf8"),
    "completed after client left",
  );
  const state = JSON.parse(
    await fs.readFile(path.join(panel.dataDir, "panel.json"), "utf8"),
  );
  assert.ok(
    state.audit.some(
      (entry) => entry.action === "File created" && entry.detail === "slow.txt",
    ),
  );
});
