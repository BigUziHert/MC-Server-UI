import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import * as tar from "tar";
import { DatabaseSync } from "node:sqlite";
import {
  createPanel,
  nextRunFor,
  validateSchedule,
  safePath,
} from "./index.mjs";

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-panel-test-"));
  const panel = await createPanel({
    dataDir,
    scheduler: false,
    publicAddress: { resolve: async () => null },
    ...options,
  });
  const listener = await new Promise((resolve) => {
    const instance = panel.app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const content = await response.json();
    return { status: response.status, body: content };
  };
  t.after(async () => {
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    // mkdtemp returns a unique direct child of os.tmpdir(), checked before recursive cleanup.
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("mc-panel-test-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ...panel, base, request };
}
const json = (method, body) => ({ method, body: JSON.stringify(body) });

test("file operations upload and download original bytes, edit text, and reject overwrite", async (t) => {
  const { request, base } = await fixture(t);
  assert.equal(
    (
      await request(
        "/api/files",
        json("POST", { name: "custom", type: "directory" }),
      )
    ).status,
    201,
  );
  const form = new FormData();
  form.append("files", new Blob(["hello from a real upload\n"]), "hello.txt");
  const uploaded = await fetch(`${base}/api/files/upload?path=custom`, {
    method: "POST",
    body: form,
  });
  assert.equal(uploaded.status, 201);
  const listing = await request("/api/files?path=custom");
  assert.equal(listing.body.entries[0].path, "custom/hello.txt");
  assert.equal(
    await (
      await fetch(`${base}/api/files/download?path=custom/hello.txt`)
    ).text(),
    "hello from a real upload\n",
  );
  assert.equal(
    (
      await fetch(`${base}/api/files/upload?path=custom`, {
        method: "POST",
        body: form,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "/api/files/content",
        json("PUT", { path: "custom/hello.txt", content: "edited" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/files/content?path=custom/hello.txt")).body.content,
    "edited",
  );
  assert.equal(
    (await request("/api/files?path=custom/hello.txt", { method: "DELETE" }))
      .status,
    200,
  );
  assert.deepEqual((await request("/api/files?path=custom")).body.entries, []);
  const entries = (await request("/api/audit")).body.entries;
  assert.ok(
    entries.some(
      (entry) =>
        entry.category === "file" &&
        entry.action === "File edited" &&
        entry.detail === "custom/hello.txt",
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.category === "file" &&
        entry.action === "File deleted" &&
        entry.detail.includes("custom/hello.txt"),
    ),
  );
});

test("audit describes added and deleted mods and hides legacy database records without erasing history", async (t) => {
  const { request, base, serverDir, dataDir, audit, assertRemovable } =
    await fixture(t, {
      mode: "live",
    });
  await fs.mkdir(path.join(serverDir, "mods"));
  const form = new FormData();
  form.append("files", new Blob(["mod bytes"]), "new-mod.jar");
  form.append("files", new Blob(["notes"]), "README.txt");
  assert.equal(
    (
      await fetch(`${base}/api/files/upload?path=mods`, {
        method: "POST",
        body: form,
      })
    ).status,
    201,
  );
  // Upload responses precede temporary-file cleanup; wait for its mutation
  // lock to release before exercising the exclusive Recycle Bin operation.
  for (let attempt = 0; ; attempt++) {
    try {
      assertRemovable();
      break;
    } catch (cause) {
      if (attempt >= 100) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const removed = await request("/api/files?path=mods/new-mod.jar", {
    method: "DELETE",
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  await audit("database", "SQLite database created", "legacy database");
  await audit(
    "server",
    "Launchpad installation completed",
    "old mod installation",
  );
  const entries = (await request("/api/audit")).body.entries;
  assert.ok(
    entries.some(
      (entry) =>
        entry.category === "file" &&
        entry.action === "Mod added" &&
        entry.detail === "mods/new-mod.jar",
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.category === "file" &&
        entry.action === "Mod deleted" &&
        entry.detail.includes("mods/new-mod.jar"),
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.category === "file" &&
        entry.action === "Files uploaded" &&
        entry.detail === "mods/README.txt",
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.category === "file" &&
        entry.action === "Content installed" &&
        entry.detail === "old mod installation",
    ),
  );
  assert.ok(entries.every((entry) => entry.category !== "database"));
  const saved = JSON.parse(
    await fs.readFile(path.join(dataDir, "panel.json"), "utf8"),
  );
  assert.ok(saved.audit.some((entry) => entry.category === "database"));
});

test("live lifecycle audits confirmed starts, restarts and exits, never chat or failed startup as success", async (t) => {
  const children = [];
  const spawnServer = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    child.kill = () => child.emit("close", 0);
    children.push(child);
    return child;
  };
  const { request, serverDir } = await fixture(t, {
    jar: "server.jar",
    spawnServer,
  });
  await fs.writeFile(path.join(serverDir, "server.jar"), "not executed");
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  const actions = async () =>
    (await request("/api/audit")).body.entries
      .filter((entry) => entry.category === "server")
      .map((entry) => entry.action);
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Expected lifecycle transition did not complete");
  };
  assert.equal(
    (await request("/api/server/power", json("POST", { action: "start" })))
      .status,
    200,
  );
  children[0].stdout.write("[Server thread/INFO]: <Player> Done (1s)!\n");
  assert.equal((await request("/api/server")).body.status, "starting");
  assert.deepEqual(await actions(), []);
  children[0].stdout.write(
    "[18Sep2026 13:02:01.210] [Server thread/INFO] [minecraft/DedicatedServer]: Done (1s)!\n",
  );
  await waitFor(async () => (await actions()).includes("Server started"));
  children[0].stdout.write("[Server thread/INFO]: Done (1s)!\n");
  assert.equal(
    (await actions()).filter((action) => action === "Server started").length,
    1,
  );
  assert.equal(
    (await request("/api/server/power", json("POST", { action: "restart" })))
      .status,
    200,
  );
  children[0].emit("close", 0);
  await waitFor(() => children.length === 2);
  children[1].stdout.write("  2013-06-01 12:00:00 [INFO] Done (1s)!\n");
  await waitFor(async () => (await actions()).includes("Server restarted"));
  assert.equal(
    (await request("/api/console/command", json("POST", { command: "stop" })))
      .status,
    200,
  );
  children[1].emit("close", 0);
  await waitFor(
    async () =>
      (await actions()).filter((action) => action === "Server stopped")
        .length === 2,
  );
  assert.equal(
    (await actions()).filter((action) => action === "Console command").length,
    0,
  );
  assert.equal(
    (await request("/api/server/power", json("POST", { action: "start" })))
      .status,
    200,
  );
  children[2].emit("error", new Error("fixture Java failed"));
  children[2].emit("close", 1);
  await waitFor(async () => (await actions()).includes("Server start failed"));
  const lifecycleEvents = (await request("/api/audit")).body.entries;
  assert.equal(
    lifecycleEvents.find((entry) => entry.action === "Server start failed")
      .actor,
    "Server process",
  );
  assert.ok(
    lifecycleEvents
      .filter((entry) => entry.action === "Server stopped")
      .every((entry) => entry.actor === "Local administrator"),
  );
  assert.equal(
    (await actions()).filter((action) => action === "Server started").length,
    1,
  );
});

test("sandbox rejects traversal, reserved names, root deletion, and symlink access", async (t) => {
  const { request, serverDir, dataDir } = await fixture(t);
  for (const malicious of [
    "../panel.json",
    "..\\panel.json",
    "C:/Windows",
    "/Windows",
    "world/../../panel.json",
  ]) {
    assert.equal(
      (
        await request(
          `/api/files/content?path=${encodeURIComponent(malicious)}`,
        )
      ).status,
      400,
      malicious,
    );
  }
  assert.equal((await request("/api/files", { method: "DELETE" })).status, 400);
  assert.equal(
    (await request("/api/files", json("POST", { name: "CON", type: "file" })))
      .status,
    400,
  );
  await fs.mkdir(path.join(dataDir, "outside"));
  await fs.writeFile(
    path.join(dataDir, "outside", "private.txt"),
    "outside server",
  );
  // Directory junctions work on Windows without requiring developer mode.
  await fs.symlink(
    path.join(dataDir, "outside"),
    path.join(serverDir, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    safePath(serverDir, "escape/private.txt"),
    /Symbolic links/,
  );
  assert.equal(
    (await request("/api/files/content?path=escape/private.txt")).status,
    400,
  );
  const files = await request("/api/files");
  assert.ok(!files.body.entries.some((entry) => entry.name === "escape"));
  assert.equal(
    await fs.readFile(path.join(dataDir, "outside", "private.txt"), "utf8"),
    "outside server",
  );
});

test("local security rejects foreign hosts and cross-site mutations", async (t) => {
  const { request, base } = await fixture(t);
  const forbiddenHost = await new Promise((resolve, reject) => {
    const req = http.get(
      `${base}/api/server`,
      { headers: { Host: "attacker.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(forbiddenHost, 403);
  assert.equal(
    (
      await request("/api/files", {
        ...json("POST", { name: "attack", type: "directory" }),
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/files", {
        ...json("POST", { name: "attack", type: "directory" }),
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
});

test("backup is a readable gzip tar containing uploaded files, and survives a restart", async (t) => {
  const { request, base, dataDir, close } = await fixture(t);
  await request(
    "/api/files",
    json("POST", {
      name: "proof.txt",
      type: "file",
      content: "this content must be in the archive",
    }),
  );
  const created = await request(
    "/api/backups",
    json("POST", { name: "Before updates" }),
  );
  assert.equal(created.status, 201);
  assert.ok(created.body.size > 0);
  const response = await fetch(
    `${base}/api/backups/${created.body.id}/download`,
  );
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
  const unpackDir = path.join(dataDir, "verify");
  await fs.mkdir(unpackDir);
  await tar.x({
    file: path.join(dataDir, "backups", `${created.body.id}.tar.gz`),
    cwd: unpackDir,
  });
  assert.equal(
    await fs.readFile(path.join(unpackDir, "proof.txt"), "utf8"),
    "this content must be in the archive",
  );
  await close();
  const restarted = await createPanel({ dataDir, scheduler: false });
  await restarted.close();
  const state = JSON.parse(
    await fs.readFile(path.join(dataDir, "panel.json"), "utf8"),
  );
  assert.equal(state.backups[0].id, created.body.id);
  assert.equal(
    (await request(`/api/backups/${created.body.id}`, { method: "DELETE" }))
      .status,
    503,
  );
});

test("scheduler persists deadlines, catches up once, and retains only scheduled backups", async (t) => {
  const { request, tick, dataDir, close } = await fixture(t);
  const manual = await request(
    "/api/backups",
    json("POST", { name: "Keep forever" }),
  );
  const schedule = {
    enabled: true,
    type: "interval",
    intervalHours: 1,
    time: "03:00",
    dayOfWeek: 0,
    retention: 1,
  };
  const saved = await request("/api/backups/schedule", json("PUT", schedule));
  assert.equal(saved.status, 200);
  assert.ok(saved.body.schedule.timezone);
  const deadline = new Date(saved.body.schedule.nextRun);
  await tick(new Date(deadline.getTime() + 100));
  await tick(new Date(deadline.getTime() + 3_600_200));
  const result = await request("/api/backups");
  assert.equal(
    result.body.backups.filter((item) => item.trigger === "scheduled").length,
    1,
  );
  assert.ok(result.body.backups.some((item) => item.id === manual.body.id));
  assert.equal((await fs.readdir(path.join(dataDir, "backups"))).length, 2);
  await close();
  const restarted = await createPanel({ dataDir, scheduler: false });
  await restarted.tick(new Date(deadline.getTime() + 86_400_000));
  await restarted.close();
  const stored = JSON.parse(
    await fs.readFile(path.join(dataDir, "panel.json"), "utf8"),
  );
  assert.equal(
    stored.backups.filter((item) => item.trigger === "scheduled").length,
    1,
  );
  assert.equal(
    stored.audit.filter((item) => item.action === "Backup created").length,
    4,
  );
  assert.ok(
    new Date(stored.schedule.nextRun) >
      new Date(deadline.getTime() + 86_400_000),
  );
});

test("schedules validate values and compute interval, daily, and weekly future runs", () => {
  const interval = validateSchedule({
    enabled: true,
    type: "interval",
    intervalHours: 2,
    retention: 3,
  });
  const now = new Date(2026, 8, 12, 12, 30, 0);
  assert.equal(
    new Date(nextRunFor(interval, now)).getTime() - now.getTime(),
    7_200_000,
  );
  const daily = { ...interval, type: "daily", time: "08:00" };
  const tomorrow = new Date(nextRunFor(daily, now));
  assert.equal(tomorrow.getDate(), 13);
  assert.equal(tomorrow.getHours(), 8);
  const weekly = new Date(
    nextRunFor({ ...daily, type: "weekly", dayOfWeek: now.getDay() }, now),
  );
  assert.equal(weekly.getDate(), 19);
  assert.equal(nextRunFor({ ...interval, enabled: false }, now), null);
  for (const change of [
    { retention: 0 },
    { retention: 101 },
    { intervalHours: 0 },
    { time: "25:00" },
    { dayOfWeek: 7 },
    { enabled: "true" },
    { type: "cron" },
  ])
    assert.throws(() => validateSchedule({ ...interval, ...change }));
});

test("databases are actual SQLite files and access records do not imply authentication", async (t) => {
  const { request, base, dataDir } = await fixture(t);
  const created = await request(
    "/api/databases",
    json("POST", { name: "survival" }),
  );
  assert.equal(created.status, 201);
  const db = new DatabaseSync(
    path.join(dataDir, "databases", `${created.body.id}.sqlite`),
    { readOnly: true },
  );
  try {
    assert.ok(
      db
        .prepare("SELECT value FROM panel_metadata WHERE key = ?")
        .get("createdAt").value,
    );
  } finally {
    db.close();
  }
  const downloaded = Buffer.from(
    await (
      await fetch(`${base}/api/databases/${created.body.id}/download`)
    ).arrayBuffer(),
  );
  assert.equal(downloaded.subarray(0, 15).toString(), "SQLite format 3");
  assert.equal(
    (await request("/api/databases", json("POST", { name: "survival" })))
      .status,
    409,
  );
  const user = await request(
    "/api/subusers",
    json("POST", { email: "builder@example.com", role: "operator" }),
  );
  assert.equal(user.status, 201);
  const audit = await request("/api/audit");
  assert.ok(
    audit.body.entries.some((item) =>
      item.detail.includes("No invitation was sent"),
    ),
  );
  assert.equal(
    (await request(`/api/subusers/${user.body.id}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal(
    (await request(`/api/databases/${created.body.id}`, { method: "DELETE" }))
      .status,
    200,
  );
});

test("console identifies simulation, accepts a single command, and tracks power state", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request("/api/server")).body.mode, "demo");
  const lines = await request("/api/console");
  assert.ok(
    lines.body.lines.some((item) => item.message.includes("simulated")),
  );
  assert.equal(
    (
      await request(
        "/api/console/command",
        json("POST", { command: "say hello\nstop" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/console/command",
        json("POST", { command: "say hello" }),
      )
    ).status,
    200,
  );
  assert.ok(
    (await request("/api/console")).body.lines.some(
      (item) => item.message === "[Demo] [Server] hello",
    ),
  );
  assert.equal(
    (await request("/api/server/power", json("POST", { action: "stop" }))).body
      .status,
    "stopping",
  );
  assert.equal(
    (await request("/api/console/command", json("POST", { command: "list" })))
      .status,
    409,
  );
});

function fakeJava({ confirm = true, flushDelay = 0, fakeChat = false } = {}) {
  const commands = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 1);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const command = chunk.toString().trim();
      commands.push(command);
      if (command === "save-all flush" && confirm)
        setTimeout(
          () => child.stdout.write("[Server thread/INFO]: Saved the game\n"),
          flushDelay,
        );
      if (command === "save-all flush" && fakeChat)
        setImmediate(() =>
          child.stdout.write(
            "[Server thread/INFO]: <Builder> Saved the game\n[12:34:56 INFO]: [Server] Saved the game\n> say Saved the game\n",
          ),
        );
      if (command === "stop") setImmediate(() => child.emit("close", 0));
      callback();
    },
  });
  return {
    commands,
    child,
    spawnServer: () => {
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (1.24s)! For help, type "help"\n',
        ),
      );
      return child;
    },
  };
}

test("live console waits for command delivery and rejects a failed or disconnected input", async (t) => {
  const java = fakeJava();
  let acknowledge;
  let entered;
  const writing = new Promise((resolve) => {
    entered = resolve;
  });
  java.child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      acknowledge = callback;
      entered();
    },
  });
  const { request, serverDir } = await fixture(t, {
    jar: "server.jar",
    spawnServer: java.spawnServer,
  });
  await fs.writeFile(path.join(serverDir, "server.jar"), "never executed");
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  assert.equal(
    (await request("/api/server/power", json("POST", { action: "start" })))
      .status,
    200,
  );
  try {
    const pending = request(
      "/api/console/command",
      json("POST", { command: "say delivery proof" }),
    );
    await writing;
    const beforeDelivery = (await request("/api/audit")).body.entries;
    acknowledge(new Error("Fixture server pipe closed"));
    acknowledge = null;
    assert.equal((await pending).status, 500);
    assert.equal(
      beforeDelivery.some((entry) => entry.action === "Console command"),
      false,
    );
    assert.equal(
      (await request("/api/console/command", json("POST", { command: "list" })))
        .status,
      409,
    );
    assert.equal(
      (await request("/api/audit")).body.entries.some(
        (entry) => entry.action === "Console command",
      ),
      false,
    );
  } finally {
    acknowledge?.();
    java.child.emit("close", 0);
  }
});

test("live online backup flushes, blocks concurrent writes, and restores automatic saves", async (t) => {
  const java = fakeJava({ flushDelay: 120 });
  const { request, serverDir } = await fixture(t, {
    jar: "server.jar",
    spawnServer: java.spawnServer,
    backupFlushTimeoutMs: 1000,
  });
  await fs.writeFile(
    path.join(serverDir, "server.jar"),
    "test fixture, never executed",
  );
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  assert.equal(
    (await request("/api/server/power", json("POST", { action: "start" })))
      .status,
    200,
  );
  assert.equal((await request("/api/server")).body.status, "running");
  const pending = request(
    "/api/backups",
    json("POST", { name: "Online backup" }),
  );
  while (!java.commands.includes("save-all flush"))
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    (
      await request(
        "/api/files",
        json("POST", { name: "race.txt", type: "file" }),
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("/api/server/power", json("POST", { action: "stop" })))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        "/api/console/command",
        json("POST", { command: "save-on" }),
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("/api/players/op", json("POST", { name: "BuilderOne" })))
      .status,
    409,
  );
  assert.equal((await pending).status, 201);
  assert.deepEqual(java.commands, ["save-off", "save-all flush", "save-on"]);
  assert.equal((await request("/api/server")).body.status, "running");
});

test("unconfirmed live world save fails without an archive and still sends save-on", async (t) => {
  const java = fakeJava({ confirm: false, fakeChat: true });
  const { request, serverDir, dataDir } = await fixture(t, {
    jar: "server.jar",
    spawnServer: java.spawnServer,
    backupFlushTimeoutMs: 25,
  });
  await fs.writeFile(
    path.join(serverDir, "server.jar"),
    "test fixture, never executed",
  );
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  await request("/api/server/power", json("POST", { action: "start" }));
  const result = await request(
    "/api/backups",
    json("POST", { name: "Should fail safely" }),
  );
  assert.equal(result.status, 409);
  assert.match(result.body.error, /did not confirm/);
  assert.deepEqual(java.commands, ["save-off", "save-all flush", "save-on"]);
  assert.deepEqual(await fs.readdir(path.join(dataDir, "backups")), []);
  assert.ok(
    (await request("/api/audit")).body.entries.some(
      (item) => item.action === "Backup failed",
    ),
  );
  assert.equal(
    (
      await request(
        "/api/files",
        json("POST", { name: "unlocked.txt", type: "file" }),
      )
    ).status,
    201,
  );
});

test("managed Java tracks vanilla and Paper online players without trusting chat or command echoes", async (t) => {
  const java = fakeJava();
  const { request, serverDir } = await fixture(t, {
    jar: "server.jar",
    spawnServer: java.spawnServer,
  });
  await fs.writeFile(path.join(serverDir, "server.jar"), "never executed");
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  await request("/api/server/power", json("POST", { action: "start" }));
  const uuid = "12345678-1234-1234-1234-123456789abc";
  java.child.stdout.write(
    `[12:00:00] [User Authenticator #1/INFO]: UUID of player BuilderOne is ${uuid}\n`,
  );
  java.child.stdout.write(
    "[12:00:01] [Server thread/INFO]: BuilderOne joined the ",
  );
  java.child.stdout.write(
    "game\r\n\u001b[32m[12:00:02 INFO]: BuilderTwo joined the game\u001b[0m\n",
  );
  assert.deepEqual((await request("/api/server")).body.players, [
    { name: "BuilderOne", uuid },
    { name: "BuilderTwo" },
  ]);
  assert.equal((await request("/api/server")).body.playersAvailable, true);
  java.child.stdout.write(
    [
      "[12:00:03] [Server thread/INFO]: <BuilderTwo> ForgedUser joined the game",
      "[12:00:03 INFO]: [Server] ForgedUser joined the game",
      "[12:00:03 INFO]: [Not Secure] <BuilderTwo> BuilderOne left the game",
      "[12:00:03 INFO]: [Plugin] ForgedUser joined the game",
      "[12:00:03] [Async Chat Thread - #1/INFO]: ForgedUser joined the game",
      "[12:00:03] [User Authenticator #1/INFO]: ForgedUser joined the game",
      "ForgedUser joined the game",
      "> [Server thread/INFO]: BuilderOne left the game",
      "[12:00:03 INFO]: BuilderOne left the game!",
    ].join("\n") + "\n",
  );
  await request(
    "/api/console/command",
    json("POST", { command: "say ForgedUser joined the game" }),
  );
  assert.deepEqual((await request("/api/server")).body.players, [
    { name: "BuilderOne", uuid },
    { name: "BuilderTwo" },
  ]);
  const secondUuid = "87654321-abcd-1234-abcd-123456789abc";
  java.child.stderr.write(
    `[12:00:04 INFO]: UUID of player BuilderTwo is ${secondUuid.toUpperCase()}\n`,
  );
  java.child.stdout.write(
    "[12:00:05] [Server thread/INFO]: BuilderOne left the game\n[12:00:06 INFO]: BuilderTwo joined the game\n",
  );
  assert.deepEqual((await request("/api/server")).body.players, [
    { name: "BuilderTwo", uuid: secondUuid },
  ]);
  java.child.stdout.write("[12:00:07 INFO]: BuilderTwo left the game\n");
  assert.deepEqual((await request("/api/server")).body.players, []);
});

test("online-player tracking clears at stop, process exit and restart and ignores obsolete processes", async (t) => {
  const processes = [];
  const { request, serverDir } = await fixture(t, {
    jar: "server.jar",
    spawnServer: () => {
      const java = fakeJava();
      processes.push(java);
      return java.spawnServer();
    },
  });
  await fs.writeFile(path.join(serverDir, "server.jar"), "never executed");
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  await request("/api/server/power", json("POST", { action: "start" }));
  const first = processes[0];
  first.child.stdout.write(
    "[12:00:00 INFO]: UUID of player BuilderOne is 12345678-1234-1234-1234-123456789abc\n[12:00:01 INFO]: BuilderOne joined the game\n",
  );
  assert.equal((await request("/api/server")).body.players.length, 1);
  await request("/api/server/power", json("POST", { action: "stop" }));
  assert.deepEqual((await request("/api/server")).body.players, []);
  await request("/api/server/power", json("POST", { action: "start" }));
  assert.deepEqual((await request("/api/server")).body.players, []);
  first.child.stdout.write("[12:00:02 INFO]: StalePlayer joined the game\n");
  const second = processes[1];
  second.child.stdout.write("[12:00:03 INFO]: BuilderOne joined the game\n");
  assert.deepEqual((await request("/api/server")).body.players, [
    { name: "BuilderOne" },
  ]);
  second.child.emit("close", 1);
  assert.deepEqual((await request("/api/server")).body.players, []);
  assert.equal((await request("/api/server")).body.status, "offline");
});
