import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFleet, createPanel } from "./index.mjs";
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

test("dismissed completed backups preserve their archive and restore history across restart", async (t) => {
  const context = await fixture(t);
  let panel = await boot(context);
  try {
    const created = await panel.request("/api/backups", "POST", {
      name: "Keep the archive, clear the notice",
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const archive = path.join(context.dataDir, "backups", `${id}.tar.gz`);
    const bytes = await fs.readFile(archive);
    const before = await panel.overview();
    const audit = await panel.request("/api/audit");
    const dismissed = await panel.request(
      `/api/backups/jobs/${id}/dismiss`,
      "POST",
      {},
    );
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.job.dismissed, true);
    assert.equal((await panel.overview()).job, null);
    await panel.close();
    panel = await boot(context);
    const after = await panel.overview();
    assert.equal(after.job, null);
    assert.deepEqual(after.backups, before.backups);
    assert.deepEqual((await panel.request("/api/audit")).body, audit.body);
    assert.deepEqual(await fs.readFile(archive), bytes);
    const record = await panel.request(`/api/backups/jobs/${id}`);
    assert.equal(record.body.job.status, "completed");
    assert.equal(record.body.job.dismissed, true);
    // The normal restore path still resolves the preserved history and archive.
    const restored = await panel.request(`/api/backups/${id}/restore`, "POST", {
      confirm: true,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  } finally {
    await panel.close();
  }
});

test("dismissal survives recovery replay without deleting journals, files, audit, or a newer job", async (t) => {
  const context = await fixture(t);
  await crash("backup-open", context);
  const backupDir = path.join(context.dataDir, "backups");
  const journalDir = path.join(context.dataDir, "backup-jobs");
  const partialName = (await fs.readdir(backupDir))[0];
  const journalName = (await fs.readdir(journalDir))[0];
  const partial = path.join(backupDir, partialName);
  const journal = path.join(journalDir, journalName);
  const partialBytes = await fs.readFile(partial);
  const journalBytes = await fs.readFile(journal);
  let panel = await boot(context);
  try {
    const failed = (await panel.overview()).job;
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /preserved for recovery/);
    const audit = (await panel.request("/api/audit")).body.entries;
    const dismissed = await panel.request(
      `/api/backups/jobs/${failed.id}/dismiss`,
      "POST",
      {},
    );
    assert.equal(dismissed.status, 200);
    assert.equal((await panel.overview()).job, null);
    assert.deepEqual(await fs.readFile(journal), journalBytes);
    assert.deepEqual(await fs.readFile(partial), partialBytes);
    assert.deepEqual((await panel.request("/api/audit")).body.entries, audit);
    await panel.close();
    panel = await boot(context);
    assert.equal((await panel.overview()).job, null);
    const recovered = await panel.request(`/api/backups/jobs/${failed.id}`);
    assert.equal(recovered.body.job.dismissed, true);
    assert.match(recovered.body.job.error, /preserved for recovery/);
    assert.deepEqual(await fs.readFile(journal), journalBytes);
    assert.deepEqual(await fs.readFile(partial), partialBytes);
    const entries = (await panel.request("/api/audit")).body.entries;
    assert.ok(entries.length > audit.length);
    assert.ok(
      audit.every((entry) => entries.some((item) => item.id === entry.id)),
    );

    const created = await panel.request("/api/backups", "POST", {
      name: "Newer result",
    });
    assert.equal(created.status, 201);
    await panel.close();
    panel = await boot(context);
    assert.equal((await panel.overview()).job.id, created.body.id);
    assert.equal((await panel.overview()).backups.length, 1);
    assert.deepEqual(await fs.readFile(journal), journalBytes);

    // Resolving the ambiguous partial allows ordinary recovery to finish. Its
    // prior dismissal must not skip that recovery or revive its old banner.
    await panel.close();
    await fs.rm(partial);
    panel = await boot(context);
    assert.equal((await panel.overview()).job.id, created.body.id);
    await assert.rejects(fs.stat(journal), { code: "ENOENT" });
    assert.equal((await panel.overview()).backups.length, 1);
  } finally {
    await panel.close();
  }
});

test("daily and weekly DST recurrences always reconstruct configured wall time", async () => {
  // Establish the test timezone before Node initializes Date/Intl. Mutating TZ
  // after the recovery tests have used both APIs couples this case to Windows'
  // existing timezone caches and the host's timezone.
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/backup-dst.mjs", import.meta.url))],
    {
      env: { ...process.env, TZ: "America/Winnipeg" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  assert.equal(code, 0, output);
});
