import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFleet, createPanel, nextRunFor } from "./index.mjs";
import { createBackupArchive } from "./backup-archive.mjs";
import { reconcileInterruptedRestores } from "./backup-restore.mjs";

async function fixture(t) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-backup-crash-")),
  );
  const dataDir = path.join(directory, "data");
  const serverDir = path.join(dataDir, "server");
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(path.join(serverDir, "server.jar"), "fixture jar");
  await fs.writeFile(path.join(serverDir, "world.dat"), "backup world");
  const archive = path.join(directory, "backup.tar.gz");
  await createBackupArchive(serverDir, archive);
  await fs.writeFile(path.join(serverDir, "world.dat"), "current world");
  t.after(async () => {
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("mc-backup-crash-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, dataDir, serverDir, archive };
}

async function crash(mode, { dataDir, serverDir, archive }) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/backup-crash.mjs", import.meta.url)),
      mode,
      dataDir,
      serverDir,
      archive,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  assert.equal(code, 71, output);
}

async function boot(options, factory = createPanel) {
  const panel = await factory({
    ...options,
    scheduler: false,
    useEnvironment: false,
    publicAddress: { resolve: async () => null },
  });
  const listener = panel.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  return {
    ...panel,
    async request(route, method = "GET", body, id) {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(id ? { "X-Server-Id": id } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    async overview() {
      return (
        await fetch(`http://127.0.0.1:${listener.address().port}/api/backups`)
      ).json();
    },
    async close() {
      await panel.close();
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

for (const boundary of [
  "before-first",
  "after-first",
  "before-second",
  "after-second",
  "cleanup",
])
  for (const existingServerDir of [false, true])
    test(`restore crash ${boundary}: ${existingServerDir ? "imported" : "managed"} startup preserves the right tree`, async (t) => {
      const context = await fixture(t);
      await crash(`restore-${boundary}`, context);
      const panel = await boot({ ...context, existingServerDir });
      await panel.close();
      const expected = ["after-second", "cleanup"].includes(boundary)
        ? "backup world"
        : "current world";
      assert.equal(
        await fs.readFile(path.join(context.serverDir, "world.dat"), "utf8"),
        expected,
      );
      assert.deepEqual(
        await reconcileInterruptedRestores(context.serverDir),
        [],
      );
      const state = JSON.parse(
        await fs.readFile(path.join(context.dataDir, "panel.json"), "utf8"),
      );
      assert.ok(
        state.audit.some(
          (entry) => entry.action === "Interrupted restore recovered",
        ),
      );
    });

test("interrupted restore never overwrites an externally recreated destination", async (t) => {
  const context = await fixture(t);
  await crash("restore-after-first", context);
  await fs.mkdir(context.serverDir);
  await fs.writeFile(
    path.join(context.serverDir, "external.txt"),
    "external bytes",
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      boot(context),
      /interrupted backup restore needs recovery.*preserved/i,
    );
  assert.equal(
    await fs.readFile(path.join(context.serverDir, "external.txt"), "utf8"),
    "external bytes",
  );
  const workspace = (await fs.readdir(context.dataDir)).find((name) =>
    name.startsWith(".server-restore-"),
  );
  assert.equal(
    await fs.readFile(
      path.join(context.dataDir, workspace, "previous", "world.dat"),
      "utf8",
    ),
    "current world",
  );
  assert.equal(
    await fs.readFile(
      path.join(context.dataDir, workspace, "restored", "world.dat"),
      "utf8",
    ),
    "backup world",
  );
});

for (const boundary of [
  "partial",
  "before-publish",
  "after-publish",
  "history-failure",
])
  test(`backup crash ${boundary}: restart reconciles owned output and retains a visible job`, async (t) => {
    const context = await fixture(t);
    await crash(`backup-${boundary}`, context);
    for (let attempt = 0; attempt < 2; attempt++) {
      const panel = await boot(context);
      const overview = await panel.overview();
      await panel.close();
      assert.equal(overview.backups.length, boundary === "partial" ? 0 : 1);
      assert.equal(
        overview.job.status,
        boundary === "partial" ? "failed" : "completed",
      );
      if (boundary === "partial")
        assert.match(overview.job.error, /interrupted/);
      else {
        assert.equal(overview.job.backupId, overview.backups[0].id);
        assert.equal(
          overview.backups[0].size,
          (
            await fs.stat(
              path.join(
                context.dataDir,
                "backups",
                `${overview.backups[0].id}.tar.gz`,
              ),
            )
          ).size,
        );
      }
      assert.equal(
        (await fs.readdir(path.join(context.dataDir, "backups"))).some((name) =>
          name.endsWith(".tmp"),
        ),
        false,
      );
    }
  });

test("fleet startup recovers managed roots before creation and isolates ambiguous restores", async (t) => {
  const context = await fixture(t);
  let fleet = await boot(
    { ...context, createDefaultServer: true },
    createFleet,
  );
  const firstId = (await fleet.request("/api/servers")).body.defaultServerId;
  const second = await fleet.request("/api/servers", "POST", {
    name: "Independent server",
    port: 25566,
  });
  assert.equal(second.status, 201);
  await fleet.close();
  await crash("restore-after-first", context);
  fleet = await boot(context, createFleet);
  assert.equal(
    await fs.readFile(path.join(context.serverDir, "world.dat"), "utf8"),
    "current world",
  );
  await fleet.close();
  await crash("restore-after-first", context);
  await fs.mkdir(context.serverDir);
  await fs.writeFile(path.join(context.serverDir, "external.txt"), "keep");
  fleet = await boot(context, createFleet);
  try {
    assert.equal(fleet.runtimes.get(firstId).unavailable, true);
    const files = await fleet.request(
      "/api/files",
      "GET",
      undefined,
      second.body.server.id,
    );
    assert.equal(files.status, 200);
    assert.equal(
      await fs.readFile(path.join(context.serverDir, "external.txt"), "utf8"),
      "keep",
    );
  } finally {
    await fleet.close();
  }
});

test("retention failure cannot hide the newly committed scheduled archive after restart", async (t) => {
  const context = await fixture(t);
  let panel = await boot(context);
  const schedule = await panel.request("/api/backups/schedule", "PUT", {
    enabled: true,
    type: "interval",
    intervalHours: 1,
    time: "03:00",
    dayOfWeek: 0,
    retention: 1,
  });
  await panel.tick(new Date(schedule.body.schedule.nextRun));
  const first = await panel.overview();
  const oldArchive = path.join(
    context.dataDir,
    "backups",
    `${first.backups[0].id}.tar.gz`,
  );
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (source, target) => {
    if (source === oldArchive) throw new Error("Injected retention failure");
    return rename(source, target);
  });
  await panel.tick(new Date(first.schedule.nextRun));
  t.mock.restoreAll();
  await panel.close();
  panel = await boot(context);
  try {
    const overview = await panel.overview();
    assert.equal(overview.backups.length, 2);
    assert.equal(overview.job.status, "failed");
    assert.ok(
      overview.backups.some((item) => item.id === overview.job.backupId),
    );
    for (const item of overview.backups)
      assert.equal(
        (
          await fs.stat(
            path.join(context.dataDir, "backups", `${item.id}.tar.gz`),
          )
        ).size,
        item.size,
      );
  } finally {
    await panel.close();
  }
});

test("backup reconciliation preserves an externally replaced partial output and foreign archives", async (t) => {
  const context = await fixture(t);
  await crash("backup-partial", context);
  const backupDir = path.join(context.dataDir, "backups");
  const partial = (await fs.readdir(backupDir)).find((name) =>
    name.endsWith(".tmp"),
  );
  await fs.rename(
    path.join(backupDir, partial),
    path.join(backupDir, "original-partial"),
  );
  await fs.writeFile(path.join(backupDir, partial), "externally replaced");
  await fs.copyFile(context.archive, path.join(backupDir, "foreign.tar.gz"));
  const panel = await boot(context);
  const overview = await panel.overview();
  await panel.close();
  assert.equal(overview.backups.length, 0);
  assert.equal(overview.job.status, "failed");
  assert.match(overview.job.error, /preserved for recovery/);
  assert.equal(
    await fs.readFile(path.join(backupDir, partial), "utf8"),
    "externally replaced",
  );
  assert.ok((await fs.stat(path.join(backupDir, "foreign.tar.gz"))).size > 0);
});

test("a crash after output open but before recording its identity preserves and exposes unknown output", async (t) => {
  const context = await fixture(t);
  await crash("backup-open", context);
  const backupDir = path.join(context.dataDir, "backups");
  const files = await fs.readdir(backupDir);
  assert.equal(files.length, 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    const panel = await boot(context);
    const overview = await panel.overview();
    await panel.close();
    assert.equal(overview.backups.length, 0);
    assert.equal(overview.job.status, "failed");
    assert.match(overview.job.error, /preserved for recovery/);
    assert.deepEqual(await fs.readdir(backupDir), files);
  }
});

test("daily and weekly DST recurrences always reconstruct configured wall time", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Winnipeg";
  try {
    const daily = { enabled: true, type: "daily", time: "02:30" };
    assert.equal(
      nextRunFor(daily, new Date("2027-03-14T07:00:00Z")),
      "2027-03-14T08:30:00.000Z",
    );
    assert.equal(
      nextRunFor(daily, new Date("2027-03-14T08:30:01Z")),
      "2027-03-15T07:30:00.000Z",
    );
    assert.equal(
      nextRunFor(
        { ...daily, type: "weekly", dayOfWeek: 0 },
        new Date("2027-03-14T08:30:01Z"),
      ),
      "2027-03-21T07:30:00.000Z",
    );
    const fall = { ...daily, time: "01:30" };
    assert.equal(
      nextRunFor(fall, new Date("2027-11-07T05:00:00Z")),
      "2027-11-07T06:30:00.000Z",
    );
    assert.equal(
      nextRunFor(fall, new Date("2027-11-07T06:30:01Z")),
      "2027-11-08T07:30:00.000Z",
    );
    assert.equal(
      nextRunFor(
        { ...fall, type: "weekly", dayOfWeek: 0 },
        new Date("2027-11-07T06:30:01Z"),
      ),
      "2027-11-14T07:30:00.000Z",
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
