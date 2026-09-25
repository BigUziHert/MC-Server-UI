import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import * as tar from "tar";
import { createFleet, createPanel } from "./index.mjs";
import { requiredPermissions } from "./remote-access.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(check, description) {
  const deadline = Date.now() + 10_000;
  let latest;
  do {
    latest = await check();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(typeof description === "function" ? description() : description);
}

async function fixture(
  t,
  { fleet = false, beforeClose = () => {}, ...options } = {},
) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-backup-jobs-"));
  const panel = await (fleet ? createFleet : createPanel)({
    dataDir,
    scheduler: false,
    publicAddress: { resolve: async () => null },
    ...(fleet
      ? {
          useEnvironment: false,
          createDefaultServer: true,
          remoteListen: false,
        }
      : {}),
    ...options,
  });
  const listener = await new Promise((resolve) => {
    const instance = panel.app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = async (route, options = {}, serverId) => {
    const response = await fetch(base + route, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(serverId ? { "X-Server-Id": serverId } : {}),
        ...options.headers,
      },
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    await beforeClose();
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("mc-backup-jobs-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ...panel, dataDir, request, base };
}

function controlledJava() {
  const commands = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 1);
  let holdingSaveOn = false;
  let pendingSaveOn;
  const confirmSave = () =>
    child.stdout.write("[Server thread/INFO]: Saved the game\n");
  const releaseSaveOn = (cause) => {
    holdingSaveOn = false;
    const callback = pendingSaveOn;
    pendingSaveOn = null;
    callback?.(cause);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const command = chunk.toString().trim();
      commands.push(command);
      if (command === "save-on" && holdingSaveOn) {
        pendingSaveOn = callback;
        return;
      }
      if (command === "stop") setImmediate(() => child.emit("close", 0));
      callback();
    },
  });
  return {
    child,
    commands,
    confirmSave,
    holdSaveOn: () => {
      holdingSaveOn = true;
    },
    releaseSaveOn,
    release: () => {
      confirmSave();
      releaseSaveOn();
    },
    spawnServer: () => {
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (1.0s)! For help, type "help"\n',
        ),
      );
      return child;
    },
  };
}

async function startJava(panel) {
  await fs.writeFile(
    path.join(panel.serverDir, "server.jar"),
    "never executed",
  );
  await fs.writeFile(path.join(panel.serverDir, "eula.txt"), "eula=true\n");
  const result = await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  await until(
    async () => (await panel.request("/api/server")).body.status === "running",
    "Fixture Java did not become ready.",
  );
}

async function jobState(request, id, condition, serverId) {
  let latest;
  return until(
    async () => {
      const result = await request(`/api/backups/jobs/${id}`, {}, serverId);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      latest = result.body.job;
      return condition(latest) && latest;
    },
    () =>
      `Backup job ${id} did not reach the expected state: ${JSON.stringify(latest)}`,
  );
}

async function holdFileRead(t, target) {
  const expected = (await fs.realpath(target)).toLowerCase();
  const descriptors = new Set();
  const entered = deferred();
  const open = nativeFs.open.bind(nativeFs);
  const read = nativeFs.read.bind(nativeFs);
  const close = nativeFs.close.bind(nativeFs);
  let releaseRead;
  let armed = true;
  t.mock.method(nativeFs, "open", (file, ...args) => {
    const callback = args.pop();
    return open(file, ...args, (cause, fd) => {
      if (
        !cause &&
        nativeFs.realpathSync.native(file).toLowerCase() === expected
      )
        descriptors.add(fd);
      callback(cause, fd);
    });
  });
  t.mock.method(nativeFs, "read", (fd, ...args) => {
    if (!armed || !descriptors.has(fd)) return read(fd, ...args);
    armed = false;
    releaseRead = (cause) => {
      if (cause) setImmediate(() => args.at(-1)(cause));
      else read(fd, ...args);
    };
    entered.resolve();
  });
  t.mock.method(nativeFs, "close", (fd, ...args) => {
    descriptors.delete(fd);
    return close(fd, ...args);
  });
  return {
    entered: entered.promise,
    release: (cause) => {
      armed = false;
      const release = releaseRead;
      releaseRead = null;
      release?.(cause);
    },
  };
}

test("backup jobs respond while saving, cancel safely, and retain the mutation lock until saves resume", async (t) => {
  const java = controlledJava();
  const panel = await fixture(t, {
    spawnServer: java.spawnServer,
    backupFlushTimeoutMs: 60_000,
    beforeClose: java.release,
  });
  await startJava(panel);
  java.holdSaveOn();
  const created = await panel.request("/api/backups/jobs", {
    ...json("POST", { name: "Cancel pending world save" }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const id = created.body.job.id;
  assert.ok(id);
  const saving = await jobState(
    panel.request,
    id,
    (job) => job.phase === "saving",
  );
  assert.equal(saving.status, "running");
  assert.equal(saving.cancellable, true);
  assert.equal(saving.trigger, "manual");
  assert.deepEqual(java.commands, ["save-off", "save-all flush"]);
  const overview = (await panel.request("/api/backups")).body;
  assert.equal(overview.job.id, id);
  assert.deepEqual(overview.backups, []);
  assert.equal(
    (
      await panel.request(
        "/api/backups/jobs",
        json("POST", { name: "Duplicate" }),
      )
    ).status,
    409,
  );

  const cancel = await panel.request(
    `/api/backups/jobs/${id}/cancel`,
    json("POST", {}),
  );
  assert.equal(cancel.status, 202);
  await until(
    () => java.commands.includes("save-on"),
    "Cancelling must resume automatic saves without waiting for save confirmation.",
  );
  const cancelling = (await panel.request(`/api/backups/jobs/${id}`)).body.job;
  assert.equal(cancelling.status, "cancelling");
  assert.equal(
    (
      await panel.request(
        "/api/files",
        json("POST", { name: "too-early.txt", type: "file" }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await panel.request(
        "/api/backups/jobs",
        json("POST", { name: "Too early" }),
      )
    ).status,
    409,
  );

  java.releaseSaveOn();
  const cancelled = await jobState(
    panel.request,
    id,
    (job) => job.status === "cancelled",
  );
  assert.equal(cancelled.cancellable, false);
  assert.ok(cancelled.finishedAt);
  assert.equal(cancelled.backupId, undefined);
  assert.deepEqual(java.commands, ["save-off", "save-all flush", "save-on"]);
  assert.deepEqual((await panel.request("/api/backups")).body.backups, []);
  assert.deepEqual(await fs.readdir(path.join(panel.dataDir, "backups")), []);
  const state = JSON.parse(
    await fs.readFile(path.join(panel.dataDir, "panel.json"), "utf8"),
  );
  assert.deepEqual(state.backups, []);
  assert.equal(
    state.audit.some((entry) => entry.action === "Backup created"),
    false,
  );
  assert.equal(
    (
      await panel.request(
        "/api/files",
        json("POST", { name: "after-cleanup.txt", type: "file" }),
      )
    ).status,
    201,
  );

  const next = await panel.request(
    "/api/backups/jobs",
    json("POST", { name: "Second job" }),
  );
  assert.equal(next.status, 202);
  const nextId = next.body.job.id;
  assert.notEqual(nextId, id);
  await jobState(panel.request, nextId, (job) => job.phase === "saving");
  const stale = await panel.request(
    `/api/backups/jobs/${id}/cancel`,
    json("POST", {}),
  );
  assert.ok([200, 202, 404, 409].includes(stale.status));
  assert.equal(
    (await panel.request(`/api/backups/jobs/${nextId}`)).body.job.status,
    "running",
  );
  assert.equal(
    (
      await panel.request(
        `/api/backups/jobs/${nextId}/cancel`,
        json("POST", {}),
      )
    ).status,
    202,
  );
  await jobState(panel.request, nextId, (job) => job.status === "cancelled");
});

test("backup job progress describes the compressed archive and completed files remain downloadable", async (t) => {
  let gate;
  const panel = await fixture(t, { beforeClose: () => gate?.release() });
  const content = Buffer.alloc(512 * 1024, 42);
  const target = path.join(panel.serverDir, "world", "region", "r.0.0.mca");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  await fs.writeFile(
    path.join(panel.serverDir, "world", "session.lock"),
    "runtime lock",
  );
  gate = await holdFileRead(t, target);
  const created = await panel.request("/api/backups/jobs", {
    ...json("POST", { name: "Progress proof" }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const id = created.body.job.id;
  await gate.entered;
  const progress = await jobState(
    panel.request,
    id,
    (job) => job.phase === "archiving" && job.currentFile,
  );
  assert.equal(progress.status, "running");
  assert.equal(progress.totalBytes, content.length);
  assert.equal(progress.totalFiles, 1);
  assert.ok(
    progress.processedBytes >= 0 && progress.processedBytes <= content.length,
  );
  assert.ok(progress.processedFiles >= 0 && progress.processedFiles <= 1);
  assert.match(
    progress.currentFile.replaceAll("\\", "/"),
    /world\/region\/r\.0\.0\.mca$/,
  );
  assert.ok(progress.compressedBytes >= 0);
  assert.ok(progress.startedAt);
  assert.ok(progress.updatedAt);
  gate.release();
  const completed = await jobState(
    panel.request,
    id,
    (job) => job.status === "completed",
  );
  assert.equal(completed.cancellable, false);
  assert.ok(completed.finishedAt);
  assert.equal(completed.processedBytes, content.length);
  assert.equal(completed.processedFiles, 1);
  const backups = (await panel.request("/api/backups")).body.backups;
  assert.equal(backups.length, 1);
  const backup = backups[0];
  assert.equal(completed.backupId, backup.id);
  assert.equal(backup.compression, "gzip");
  assert.equal(backup.compressionLevel, 9);
  assert.equal(backup.originalSize, content.length);
  assert.equal(completed.compressedBytes, backup.size);
  assert.ok(backup.size < content.length / 20);
  const archive = path.join(panel.dataDir, "backups", `${backup.id}.tar.gz`);
  const bytes = await fs.readFile(archive);
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
  assert.equal(bytes[8], 2);
  const download = await fetch(
    `${panel.base}/api/backups/${backup.id}/download`,
  );
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const extracted = path.join(panel.dataDir, "extracted");
  await fs.mkdir(extracted);
  await tar.x({ file: archive, cwd: extracted });
  assert.deepEqual(
    await fs.readFile(path.join(extracted, "world", "region", "r.0.0.mca")),
    content,
  );
  await assert.rejects(fs.stat(path.join(extracted, "world", "session.lock")), {
    code: "ENOENT",
  });
  const stored = JSON.parse(
    await fs.readFile(path.join(panel.dataDir, "panel.json"), "utf8"),
  );
  assert.equal(stored.backups[0].id, completed.backupId);
  const legacy = await panel.request(
    "/api/backups",
    json("POST", { name: "Legacy blocking request" }),
  );
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  assert.equal(legacy.body.status, "completed");
  assert.equal(legacy.body.originalSize, content.length);
});

test("cancelling an archive job waits for its pending read before discarding the partial file", async (t) => {
  let gate;
  const panel = await fixture(t, { beforeClose: () => gate?.release() });
  const source = path.join(panel.serverDir, "world.dat");
  await fs.writeFile(source, Buffer.alloc(512 * 1024, 19));
  gate = await holdFileRead(t, source);
  const created = await panel.request(
    "/api/backups/jobs",
    json("POST", { name: "Cancel active archive" }),
  );
  assert.equal(created.status, 202);
  const id = created.body.job.id;
  await gate.entered;
  assert.equal(
    (await panel.request(`/api/backups/jobs/${id}/cancel`, json("POST", {})))
      .status,
    202,
  );
  assert.equal(
    (await panel.request(`/api/backups/jobs/${id}`)).body.job.status,
    "cancelling",
  );
  assert.equal(
    (
      await panel.request(
        "/api/files",
        json("POST", { name: "too-early.txt", type: "file" }),
      )
    ).status,
    409,
  );
  gate.release();
  await jobState(panel.request, id, (job) => job.status === "cancelled");
  assert.deepEqual((await panel.request("/api/backups")).body.backups, []);
  assert.deepEqual(await fs.readdir(path.join(panel.dataDir, "backups")), []);
  assert.equal(
    (
      await panel.request(
        "/api/files",
        json("POST", { name: "after-cancel.txt", type: "file" }),
      )
    ).status,
    201,
  );
});

test("a failed save-on reports recovery instructions while retaining the completed backup", async (t) => {
  const java = controlledJava();
  const panel = await fixture(t, {
    spawnServer: java.spawnServer,
    backupFlushTimeoutMs: 60_000,
    beforeClose: () => {
      java.release();
      java.child.emit("close", 0);
    },
  });
  await startJava(panel);
  java.holdSaveOn();
  const created = await panel.request(
    "/api/backups/jobs",
    json("POST", { name: "Retained archive" }),
  );
  assert.equal(created.status, 202);
  const id = created.body.job.id;
  await jobState(panel.request, id, (job) => job.phase === "saving");
  java.confirmSave();
  await until(
    () => java.commands.includes("save-on"),
    "The completed archive must resume automatic saves.",
  );
  assert.equal(
    (await panel.request(`/api/backups/jobs/${id}`)).body.job.phase,
    "resuming",
  );
  java.releaseSaveOn(new Error("Fixture save-on pipe failed"));
  const failed = await jobState(
    panel.request,
    id,
    (job) => job.status === "failed",
  );
  assert.equal(failed.cancellable, false);
  assert.match(failed.error, /archive was saved/i);
  assert.match(failed.error, /run save-on/i);
  const backups = (await panel.request("/api/backups")).body.backups;
  assert.equal(backups.length, 1);
  assert.equal(failed.backupId, backups[0].id);
  assert.deepEqual(await fs.readdir(path.join(panel.dataDir, "backups")), [
    `${backups[0].id}.tar.gz`,
  ]);
  assert.equal(
    (await panel.request("/api/audit")).body.entries.some(
      (entry) => entry.action === "World save recovery failed",
    ),
    true,
  );
  assert.deepEqual(java.commands, ["save-off", "save-all flush", "save-on"]);
});

test("shutdown waits for an accepted background backup before stopping Java", async (t) => {
  const java = controlledJava();
  const panel = await fixture(t, {
    spawnServer: java.spawnServer,
    backupFlushTimeoutMs: 60_000,
    beforeClose: java.release,
  });
  await startJava(panel);
  const created = await panel.request(
    "/api/backups/jobs",
    json("POST", { name: "Finish during shutdown" }),
  );
  assert.equal(created.status, 202);
  const id = created.body.job.id;
  await jobState(panel.request, id, (job) => job.phase === "saving");
  let closed = false;
  const closing = panel.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.deepEqual(java.commands, ["save-off", "save-all flush"]);
  java.confirmSave();
  await closing;
  assert.deepEqual(java.commands, [
    "save-off",
    "save-all flush",
    "save-on",
    "stop",
  ]);
  const stored = JSON.parse(
    await fs.readFile(path.join(panel.dataDir, "panel.json"), "utf8"),
  );
  assert.equal(stored.backups.length, 1);
  assert.equal(stored.backups[0].id, id);
  assert.equal(
    (await fs.readdir(path.join(panel.dataDir, "backups"))).length,
    1,
  );
});

test("failed backup jobs report the locked file, discard partial archives, and permit a fresh job", async (t) => {
  let gate;
  const panel = await fixture(t, { beforeClose: () => gate?.release() });
  const source = path.join(panel.serverDir, "world", "level.dat");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, Buffer.alloc(64 * 1024, 19));
  gate = await holdFileRead(t, source);
  const created = await panel.request(
    "/api/backups/jobs",
    json("POST", { name: "Locked source" }),
  );
  assert.equal(created.status, 202);
  await gate.entered;
  gate.release(
    Object.assign(new Error("EBUSY: resource busy or locked, read"), {
      code: "EBUSY",
      syscall: "read",
    }),
  );
  const failed = await jobState(
    panel.request,
    created.body.job.id,
    (job) => job.status === "failed",
  );
  assert.equal(failed.cancellable, false);
  assert.ok(failed.finishedAt);
  assert.equal(failed.backupId, undefined);
  assert.match(failed.error.replaceAll("\\", "/"), /world\/level\.dat/);
  assert.match(failed.error, /locked|busy/i);
  assert.deepEqual((await panel.request("/api/backups")).body.backups, []);
  assert.deepEqual(await fs.readdir(path.join(panel.dataDir, "backups")), []);
  const stored = JSON.parse(
    await fs.readFile(path.join(panel.dataDir, "panel.json"), "utf8"),
  );
  assert.deepEqual(stored.backups, []);
  const retry = await panel.request(
    "/api/backups/jobs",
    json("POST", { name: "Successful retry" }),
  );
  assert.equal(retry.status, 202);
  await jobState(
    panel.request,
    retry.body.job.id,
    (job) => job.status === "completed",
  );
  assert.equal((await panel.request("/api/backups")).body.backups.length, 1);
});

test("backup jobs remain scoped to their selected fleet server", async (t) => {
  let gate;
  const panel = await fixture(t, {
    fleet: true,
    beforeClose: () => gate?.release(),
  });
  const firstId = (await panel.request("/api/servers")).body.defaultServerId;
  const second = await panel.request(
    "/api/servers",
    json("POST", { name: "Independent server", port: 25566 }),
  );
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const secondId = second.body.server.id;
  const first = panel.runtimes.get(firstId);
  const source = path.join(first.serverDir, "world.dat");
  await fs.writeFile(source, Buffer.alloc(64 * 1024, 19));
  gate = await holdFileRead(t, source);
  const created = await panel.request(
    "/api/backups/jobs",
    json("POST", { name: "First server job" }),
    firstId,
  );
  assert.equal(created.status, 202);
  const id = created.body.job.id;
  await gate.entered;
  assert.equal(
    (await panel.request(`/api/backups/jobs/${id}`, {}, secondId)).status,
    404,
  );
  assert.equal(
    (
      await panel.request(
        `/api/backups/jobs/${id}/cancel`,
        json("POST", {}),
        secondId,
      )
    ).status,
    404,
  );
  assert.equal(
    (await panel.request(`/api/backups/jobs/${id}`, {}, firstId)).body.job
      .status,
    "running",
  );
  assert.equal(
    (
      await panel.request(
        "/api/files",
        json("POST", { name: "allowed.txt", type: "file" }),
        secondId,
      )
    ).status,
    201,
  );
  const independent = await panel.request(
    "/api/backups/jobs",
    json("POST", { name: "Second server job" }),
    secondId,
  );
  assert.equal(independent.status, 202);
  await jobState(
    panel.request,
    independent.body.job.id,
    (job) => job.status === "completed",
    secondId,
  );
  gate.release();
  await jobState(
    panel.request,
    id,
    (job) => job.status === "completed",
    firstId,
  );
  assert.equal(
    (await panel.request("/api/backups", {}, firstId)).body.backups.length,
    1,
  );
  assert.equal(
    (await panel.request("/api/backups", {}, secondId)).body.backups.length,
    1,
  );
});

test("scheduled backup jobs publish their progress and can be cancelled without losing the next deadline", async (t) => {
  const java = controlledJava();
  const panel = await fixture(t, {
    spawnServer: java.spawnServer,
    backupFlushTimeoutMs: 60_000,
    beforeClose: java.release,
  });
  await startJava(panel);
  const saved = await panel.request(
    "/api/backups/schedule",
    json("PUT", {
      enabled: true,
      type: "interval",
      intervalHours: 1,
      time: "03:00",
      dayOfWeek: 0,
      retention: 3,
    }),
  );
  assert.equal(saved.status, 200);
  const deadline = new Date(saved.body.schedule.nextRun);
  const tick = panel.tick(new Date(deadline.getTime() + 1));
  const scheduled = await until(async () => {
    const job = (await panel.request("/api/backups")).body.job;
    return job?.trigger === "scheduled" && job;
  }, "The scheduled backup must publish a job before its save flush completes.");
  await jobState(panel.request, scheduled.id, (job) => job.phase === "saving");
  assert.equal(
    (
      await panel.request(
        `/api/backups/jobs/${scheduled.id}/cancel`,
        json("POST", {}),
      )
    ).status,
    202,
  );
  await tick;
  await jobState(
    panel.request,
    scheduled.id,
    (job) => job.status === "cancelled",
  );
  const overview = (await panel.request("/api/backups")).body;
  assert.deepEqual(overview.backups, []);
  assert.ok(new Date(overview.schedule.nextRun) > deadline);
  assert.deepEqual(java.commands, ["save-off", "save-all flush", "save-on"]);
});

test("remote backup job routes require backup read or create permission", () => {
  for (const [method, route, expected] of [
    ["GET", "/api/backups/jobs/example-id", ["backup.read"]],
    ["POST", "/api/backups/jobs", ["backup.create"]],
    ["POST", "/api/backups/jobs/example-id/cancel", ["backup.create"]],
  ])
    assert.deepEqual(
      requiredPermissions({ method, path: route, query: {} }),
      expected,
    );
});
