import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createFleet, createPanel, safePath } from "./index.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";

const json = (method, body = {}) => ({ method, body: JSON.stringify(body) });
const missing = (target) => assert.rejects(fs.stat(target), { code: "ENOENT" });
async function fixture(t) {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-backup-recycle-")),
  );
  const open = [];
  const boot = async (factory = createPanel, options = {}) => {
    const panel = await factory({
      dataDir,
      scheduler: false,
      useEnvironment: false,
      publicAddress: { resolve: async () => null },
      ...options,
    });
    const listener = await new Promise((resolve) => {
      const http = panel.app.listen(0, "127.0.0.1", () => resolve(http));
    });
    const request = async (route, options = {}, id) => {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...(id ? { "X-Server-Id": id } : {}),
          },
        },
      );
      const body = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : Buffer.from(await response.arrayBuffer());
      return { status: response.status, body };
    };
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await panel.close();
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    };
    open.push(close);
    return { ...panel, close, request };
  };
  t.after(async () => {
    for (const close of open) await close();
    assert.equal(path.dirname(dataDir), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("mc-backup-recycle-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, boot };
}

test("deleted backups recover their archive bytes and original metadata after restart without extracting into the world", async (t) => {
  const { dataDir, boot } = await fixture(t);
  const panel = await boot();
  await fs.writeFile(
    path.join(panel.serverDir, "world.txt"),
    "world at backup time",
  );
  const { body: backup, status } = await panel.request(
    "/api/backups",
    json("POST", { name: "Before adventure" }),
  );
  assert.equal(status, 201);
  const archive = (await panel.request(`/api/backups/${backup.id}/download`))
    .body;
  await fs.writeFile(
    path.join(panel.serverDir, "world.txt"),
    "current world stays untouched",
  );
  const removed = await panel.request(
    `/api/backups/${backup.id}`,
    json("DELETE"),
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.body.recycled.kind, "backup");
  assert.equal(removed.body.recycled.name, backup.name);
  assert.deepEqual(removed.body.recycled.backup, backup);
  assert.equal((await panel.request("/api/backups")).body.backups.length, 0);
  await missing(path.join(dataDir, "backups", `${backup.id}.tar.gz`));
  assert.equal(
    (await panel.request(`/api/backups/${backup.id}/download`)).status,
    404,
  );
  await panel.close();
  const restarted = await boot();
  const bin = (await restarted.request("/api/files/recycle-bin")).body.items;
  assert.equal(bin.length, 1);
  assert.deepEqual(bin[0].backup, backup);
  assert.equal(bin[0].status, "ready");
  const restore = await restarted.request(
    `/api/files/recycle-bin/${bin[0].id}/restore`,
    json("POST"),
  );
  assert.equal(restore.status, 200);
  assert.deepEqual(restore.body, { ok: true, kind: "backup", backup });
  assert.deepEqual((await restarted.request("/api/backups")).body.backups, [
    backup,
  ]);
  assert.deepEqual(
    (await restarted.request(`/api/backups/${backup.id}/download`)).body,
    archive,
  );
  assert.equal(
    await fs.readFile(path.join(panel.serverDir, "world.txt"), "utf8"),
    "current world stays untouched",
  );
  assert.deepEqual(
    (await restarted.request("/api/files/recycle-bin")).body.items,
    [],
  );
  await missing(path.join(panel.serverDir, "backups"));
});

test("retention recycles obsolete scheduled archives while preserving the active limit and manual backups", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const manual = (
    await panel.request(
      "/api/backups",
      json("POST", { name: "Manual keepsake" }),
    )
  ).body;
  const schedule = await panel.request(
    "/api/backups/schedule",
    json("PUT", {
      enabled: true,
      type: "interval",
      intervalHours: 1,
      time: "03:00",
      dayOfWeek: 0,
      retention: 1,
    }),
  );
  assert.equal(schedule.status, 200);
  await panel.tick(new Date(schedule.body.schedule.nextRun));
  const afterFirst = (await panel.request("/api/backups")).body;
  const scheduled = afterFirst.backups.find(
    (entry) => entry.trigger === "scheduled",
  );
  await panel.tick(new Date(afterFirst.schedule.nextRun));
  const active = (await panel.request("/api/backups")).body.backups;
  assert.equal(
    active.filter((entry) => entry.trigger === "scheduled").length,
    1,
  );
  assert.ok(active.some((entry) => entry.id === manual.id));
  const bin = (await panel.request("/api/files/recycle-bin")).body.items;
  assert.equal(bin.length, 1);
  assert.deepEqual(bin[0].backup, scheduled);
  const audit = (await panel.request("/api/audit")).body.entries;
  assert.ok(
    audit.some(
      (entry) =>
        entry.action === "Backup moved to Recycle Bin" &&
        entry.actor === "Scheduler",
    ),
  );
});

test("backup recycle and permanent deletion stay scoped to the selected server", async (t) => {
  const { boot } = await fixture(t);
  const fleet = await boot(createFleet, { createDefaultServer: false });
  const first = (
    await fleet.request(
      "/api/servers",
      json("POST", { name: "First", port: 25565 }),
    )
  ).body.server;
  const second = (
    await fleet.request(
      "/api/servers",
      json("POST", { name: "Second", port: 25566 }),
    )
  ).body.server;
  const backup = (
    await fleet.request(
      "/api/backups",
      json("POST", { name: "Private archive" }),
      first.id,
    )
  ).body;
  const deleted = await fleet.request(
    `/api/backups/${backup.id}`,
    json("DELETE"),
    first.id,
  );
  assert.equal(deleted.status, 200);
  const item = deleted.body.recycled;
  assert.deepEqual(
    (await fleet.request("/api/files/recycle-bin", {}, second.id)).body.items,
    [],
  );
  assert.equal(
    (
      await fleet.request(
        `/api/files/recycle-bin/${item.id}/restore`,
        json("POST"),
        second.id,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await fleet.request(
        `/api/files/recycle-bin/${item.id}`,
        json("DELETE"),
        second.id,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await fleet.request(
        `/api/files/recycle-bin/${item.id}`,
        json("DELETE"),
        first.id,
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await fleet.request("/api/files/recycle-bin", {}, first.id)).body.items,
    [],
  );
  assert.equal(
    (
      await fleet.request(
        `/api/files/recycle-bin/${item.id}/restore`,
        json("POST"),
        first.id,
      )
    ).status,
    404,
  );
  const runtime = fleet.runtimes.get(first.id);
  await missing(path.join(runtime.dataDir, "recycle-bin", item.id));
  await missing(path.join(runtime.dataDir, "backups", `${backup.id}.tar.gz`));
});

test("restart reconciles a completed recycle move whose active-history write was interrupted", async (t) => {
  const { dataDir, boot } = await fixture(t);
  const panel = await boot();
  const backup = (
    await panel.request(
      "/api/backups",
      json("POST", { name: "Interrupted history" }),
    )
  ).body;
  await panel.request(`/api/backups/${backup.id}`, json("DELETE"));
  await panel.close();
  const statePath = path.join(dataDir, "panel.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.backups = [backup];
  await fs.writeFile(statePath, JSON.stringify(state));
  const restarted = await boot();
  assert.deepEqual((await restarted.request("/api/backups")).body.backups, []);
  assert.equal(
    (await restarted.request("/api/files/recycle-bin")).body.items[0].backup.id,
    backup.id,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(statePath, "utf8")).backups,
    [],
  );
});

test("an interrupted final recycle journal can restore in-session despite its stale active-history row", async (t) => {
  const { dataDir, boot } = await fixture(t);
  const panel = await boot();
  const backup = (
    await panel.request(
      "/api/backups",
      json("POST", { name: "Journal interruption" }),
    )
  ).body;
  const bytes = (await panel.request(`/api/backups/${backup.id}/download`))
    .body;
  let interrupted = false;
  const bin = await createRecycleBin({
    dataDir,
    serverDir: panel.serverDir,
    backupDir: path.join(dataDir, "backups"),
    safePath,
    fileSystem: {
      ...fs,
      rename: async (source, destination) => {
        if (
          !interrupted &&
          path.basename(destination) === "entry.json" &&
          JSON.parse(await fs.readFile(source, "utf8")).phase === "ready"
        ) {
          interrupted = true;
          throw new Error("final journal unavailable");
        }
        return fs.rename(source, destination);
      },
    },
  });
  await assert.rejects(
    bin.recycle(`backups/${backup.id}.tar.gz`, { backup }),
    /final journal unavailable/,
  );
  assert.equal(
    (await panel.request("/api/backups")).body.backups[0].id,
    backup.id,
  );
  const item = (await panel.request("/api/files/recycle-bin")).body.items[0];
  assert.equal(item.status, "ready");
  assert.equal(
    (
      await panel.request(
        `/api/files/recycle-bin/${item.id}/restore`,
        json("POST"),
      )
    ).status,
    200,
  );
  assert.deepEqual((await panel.request("/api/backups")).body.backups, [
    backup,
  ]);
  assert.deepEqual(
    (await panel.request(`/api/backups/${backup.id}/download`)).body,
    bytes,
  );
});

test("a failed history commit retains recovery data and retry adopts only the identical restored backup", async (t) => {
  const { dataDir } = await fixture(t);
  const serverDir = path.join(dataDir, "server");
  const backupDir = path.join(dataDir, "backups");
  await fs.mkdir(serverDir);
  await fs.mkdir(backupDir);
  const backup = {
    id: randomUUID(),
    name: "Recoverable commit",
    size: 13,
    createdAt: new Date().toISOString(),
    status: "completed",
    trigger: "manual",
  };
  const filename = path.join(backupDir, `${backup.id}.tar.gz`);
  await fs.writeFile(filename, "archive bytes");
  const bin = await createRecycleBin({
    dataDir,
    serverDir,
    backupDir,
    safePath,
  });
  const item = await bin.recycle(`backups/${backup.id}.tar.gz`, { backup });
  await assert.rejects(
    bin.restore(item.id, {
      commitBackup: async () => {
        throw new Error("history disk full");
      },
    }),
    /history disk full/,
  );
  assert.equal((await bin.list())[0].status, "ready");
  const payload = path.join(bin.directory, item.id, "content");
  assert.equal(await fs.readFile(payload, "utf8"), "archive bytes");
  await fs.writeFile(filename, "a conflicting archive");
  await assert.rejects(
    bin.restore(item.id, { commitBackup: async () => {} }),
    /already exists/,
  );
  assert.equal(await fs.readFile(filename, "utf8"), "a conflicting archive");
  await fs.writeFile(filename, "archive bytes");
  let committed;
  await bin.restore(item.id, {
    commitBackup: async (value) => {
      committed = value;
    },
  });
  assert.deepEqual(committed, backup);
  assert.deepEqual(await bin.list(), []);
  assert.equal(await fs.readFile(filename, "utf8"), "archive bytes");
});

test("backup recovery validates its private destination and never overwrites an existing archive", async (t) => {
  const { dataDir } = await fixture(t);
  const serverDir = path.join(dataDir, "server");
  const backupDir = path.join(dataDir, "backups");
  await fs.mkdir(serverDir);
  await fs.mkdir(backupDir);
  const backup = {
    id: randomUUID(),
    name: "Scoped archive",
    size: 4,
    createdAt: new Date().toISOString(),
    status: "completed",
    trigger: "manual",
  };
  const filename = path.join(backupDir, `${backup.id}.tar.gz`);
  await fs.writeFile(filename, "safe");
  const bin = await createRecycleBin({
    dataDir,
    serverDir,
    backupDir,
    safePath,
  });
  const item = await bin.recycle(`backups/${backup.id}.tar.gz`, { backup });
  await fs.writeFile(filename, "existing");
  await assert.rejects(
    bin.restore(item.id, { commitBackup: async () => {} }),
    /already exists/,
  );
  const journalPath = path.join(bin.directory, item.id, "entry.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
  journal.originalPath = "../outside.tar.gz";
  await fs.writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(
    bin.restore(item.id, { commitBackup: async () => {} }),
    /recovery record/,
  );
  assert.equal(await fs.readFile(filename, "utf8"), "existing");
  assert.equal(
    await fs.readFile(path.join(bin.directory, item.id, "content"), "utf8"),
    "safe",
  );
});
