import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createBackupLocation } from "./backup-location.mjs";
import { createPanel, createFleet } from "./index.mjs";

const json = (method, body = {}) => ({ method, body: JSON.stringify(body) });
const missing = (location) =>
  assert.rejects(fs.stat(location), { code: "ENOENT" });
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-backup-location-")),
  );
  const dataDir = path.join(root, "panel");
  await fs.mkdir(dataDir);
  const defaultDirectory = path.join(dataDir, "backups");
  const destination = path.join(root, "other-drive", "archives");
  const open = [];
  t.after(async () => {
    for (const close of open) await close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-backup-location-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const manager = (options = {}) =>
    createBackupLocation({
      dataDir,
      defaultDirectory,
      forbiddenDirectories: async () => [dataDir],
      ...options,
    });
  const boot = async (options = {}) => {
    const factory = options.fleet ? createFleet : createPanel;
    const panel = await factory({
      dataDir,
      useEnvironment: false,
      scheduler: false,
      remoteListen: false,
      publicAddress: { resolve: async () => null },
      ...options,
    });
    const listener = await new Promise((resolve) => {
      const instance = panel.app.listen(0, "127.0.0.1", () =>
        resolve(instance),
      );
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      await panel.close();
      closed = true;
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    };
    open.push(close);
    const request = async (route, options = {}, serverId) => {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...(serverId ? { "X-Server-Id": serverId } : {}),
            ...options.headers,
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
    return { ...panel, close, request };
  };
  return { root, dataDir, defaultDirectory, destination, manager, boot };
}
async function completed(panel) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await panel.request("/api/backups/location");
    if (state.body.job?.status !== "running") return state.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Backup move did not finish");
}
async function migrate(panel, directory) {
  const preview = await panel.request(
    "/api/backups/location/preview",
    json("POST", { directory }),
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const accepted = await panel.request(
    "/api/backups/location/jobs",
    json("POST", { ...preview.body, confirm: true }),
  );
  assert.equal(accepted.status, 202);
  const state = await completed(panel);
  assert.equal(state.job.status, "completed", state.job.error);
  return state;
}

test("moves verified archives, preserves backup history and recycle restores, and persists restart/default return", async (t) => {
  const { boot, destination, defaultDirectory } = await fixture(t);
  const panel = await boot();
  await fs.writeFile(path.join(panel.serverDir, "world.txt"), "saved world");
  const first = (
    await panel.request("/api/backups", json("POST", { name: "First" }))
  ).body;
  const second = (
    await panel.request("/api/backups", json("POST", { name: "Second" }))
  ).body;
  const original = (await panel.request(`/api/backups/${first.id}/download`))
    .body;
  const recycled = (
    await panel.request(`/api/backups/${second.id}`, json("DELETE"))
  ).body.recycled;
  const schedule = (await panel.request("/api/backups")).body.schedule;
  const state = await migrate(panel, destination);
  assert.equal(state.directory, destination);
  assert.equal(state.job.totalFiles, 1);
  assert.deepEqual(
    await fs.readFile(path.join(destination, `${first.id}.tar.gz`)),
    original,
  );
  await missing(path.join(defaultDirectory, `${first.id}.tar.gz`));
  assert.deepEqual(
    (await panel.request("/api/backups")).body.schedule,
    schedule,
  );
  assert.deepEqual(
    (await panel.request(`/api/backups/${first.id}/download`)).body,
    original,
  );
  await panel.close();
  const restart = await boot();
  assert.equal(
    (await restart.request("/api/backups/location")).body.directory,
    destination,
  );
  const restored = await restart.request(
    `/api/files/recycle-bin/${recycled.id}/restore`,
    json("POST"),
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.ok(
    (await fs.stat(path.join(destination, `${second.id}.tar.gz`))).isFile(),
  );
  assert.deepEqual(
    (await restart.request("/api/backups")).body.backups
      .map((item) => item.id)
      .sort(),
    [first.id, second.id].sort(),
  );
  await migrate(restart, defaultDirectory);
  assert.deepEqual(
    await fs.readFile(path.join(defaultDirectory, `${first.id}.tar.gz`)),
    original,
  );
});

test("missing custom drive remains unavailable across restart and never silently falls back", async (t) => {
  const { boot, destination, defaultDirectory } = await fixture(t);
  const panel = await boot();
  await migrate(panel, destination);
  await panel.close();
  await fs.rename(
    path.dirname(destination),
    `${path.dirname(destination)}-disconnected`,
  );
  const restart = await boot();
  const location = (await restart.request("/api/backups/location")).body;
  assert.equal(location.available, false);
  assert.equal(location.directory, destination);
  const failed = await restart.request(
    "/api/backups",
    json("POST", { name: "Missing drive" }),
  );
  assert.equal(failed.status, 409);
  await missing(destination);
  assert.deepEqual(await fs.readdir(defaultDirectory), []);
});

test("destination validation rejects roots, nonempty paths, protected trees, links and stale reviews", async (t) => {
  const { manager, root, dataDir, destination, defaultDirectory } =
    await fixture(t);
  const store = await manager();
  const id = randomUUID();
  await fs.writeFile(path.join(defaultDirectory, `${id}.tar.gz`), "archive");
  await assert.rejects(store.preview(path.parse(root).root), /root of a drive/);
  await assert.rejects(
    store.preview(path.join(dataDir, "private")),
    /overlaps panel storage/,
  );
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "unrelated.txt"), "keep");
  await assert.rejects(store.preview(destination), /empty backup folder/);
  const link = path.join(root, "linked");
  await fs.symlink(
    destination,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(store.preview(link), /symbolic link|junction/);
  const clean = path.join(root, "clean");
  const reviewed = await store.preview(clean);
  await fs.writeFile(
    path.join(defaultDirectory, `${id}.tar.gz`),
    "changed archive",
  );
  const operation = store.begin(clean, reviewed.revision);
  await operation.promise;
  assert.equal(operation.job.status, "failed");
  assert.match(operation.job.error, /changed/);
  await missing(clean);
});

test("failed precommit leaves originals authoritative and failed cleanup resumes safely after restart", async (t) => {
  const { manager, destination, defaultDirectory, dataDir } = await fixture(t);
  const store = await manager({
    hooks: {
      beforeCommit() {
        throw new Error("simulated commit failure");
      },
    },
  });
  const name = `${randomUUID()}.tar.gz`;
  await fs.writeFile(path.join(defaultDirectory, name), "original archive");
  let preview = await store.preview(destination);
  let operation = store.begin(destination, preview.revision);
  await operation.promise;
  assert.equal(operation.job.status, "failed");
  assert.equal(store.directory, defaultDirectory);
  assert.equal(
    await fs.readFile(path.join(defaultDirectory, name), "utf8"),
    "original archive",
  );
  assert.deepEqual(await fs.readdir(destination), []);
  const retry = await manager({
    hooks: {
      afterCommit() {
        throw new Error("simulated interruption after commit");
      },
    },
  });
  preview = await retry.preview(destination);
  operation = retry.begin(destination, preview.revision);
  await operation.promise;
  assert.equal(retry.directory, destination);
  assert.equal(
    await fs.readFile(path.join(defaultDirectory, name), "utf8"),
    "original archive",
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(dataDir, "backup-location.json"), "utf8"),
    ).pending.committed,
    true,
  );
  const recovered = await manager();
  assert.equal(recovered.directory, destination);
  assert.equal((await recovered.status()).job.status, "completed");
  await missing(path.join(defaultDirectory, name));
  assert.equal(
    await fs.readFile(path.join(destination, name), "utf8"),
    "original archive",
  );
});

test("migration blocks backup, restore, recycle and download work, drains on shutdown, and rejects a second recovery owner", async (t) => {
  const { boot, manager, destination } = await fixture(t);
  let reached, release;
  const entered = new Promise((resolve) => (reached = resolve));
  const wait = new Promise((resolve) => (release = resolve));
  const panel = await boot({
    backupLocationHooks: {
      async beforeCommit() {
        reached();
        await wait;
      },
    },
  });
  t.after(() => release());
  const backup = (
    await panel.request("/api/backups", json("POST", { name: "Archive" }))
  ).body;
  const review = (
    await panel.request(
      "/api/backups/location/preview",
      json("POST", { directory: destination }),
    )
  ).body;
  const accepted = await panel.request(
    "/api/backups/location/jobs",
    json("POST", { ...review, confirm: true }),
  );
  assert.equal(accepted.status, 202);
  await entered;
  await assert.rejects(manager(), /Another process may still own/);
  for (const [route, options] of [
    ["/api/backups", json("POST")],
    [`/api/backups/${backup.id}/restore`, json("POST", { confirm: true })],
    [`/api/backups/${backup.id}`, json("DELETE")],
    [`/api/backups/${backup.id}/download`, {}],
    [
      "/api/files/recycle-bin/00000000-0000-4000-8000-000000000001/restore",
      json("POST"),
    ],
  ])
    assert.equal((await panel.request(route, options)).status, 409, route);
  let closed = false;
  const closing = panel.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(closed, false);
  release();
  await closing;
  assert.ok(
    (await fs.stat(path.join(destination, `${backup.id}.tar.gz`))).isFile(),
  );
});

test("a process crash before commit rolls back only unchanged owned copies; changed copies remain for recovery", async (t) => {
  const { manager, destination, defaultDirectory, dataDir, root } =
    await fixture(t);
  await manager();
  const name = `${randomUUID()}.tar.gz`;
  await fs.writeFile(path.join(defaultDirectory, name), "original archive");
  const crash = async (target) => {
    const source = `import { createBackupLocation } from ${JSON.stringify(new URL("./backup-location.mjs", import.meta.url).href)};
      const store = await createBackupLocation({ dataDir: ${JSON.stringify(dataDir)}, defaultDirectory: ${JSON.stringify(defaultDirectory)}, hooks: { beforeCommit() { process.exit(73); } } });
      const review = await store.preview(${JSON.stringify(target)});
      await store.begin(review.directory, review.revision).promise;`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      { stdio: "pipe" },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exit = await new Promise((resolve, reject) => {
      child.on("exit", resolve);
      child.on("error", reject);
    });
    assert.equal(exit, 73, stderr);
  };
  await crash(destination);
  assert.equal(
    await fs.readFile(path.join(destination, name), "utf8"),
    "original archive",
  );
  const recovered = await manager();
  assert.equal(recovered.directory, defaultDirectory);
  assert.equal((await recovered.status()).job.status, "failed");
  await missing(path.join(destination, name));
  const secondDestination = path.join(root, "retained");
  await crash(secondDestination);
  await fs.writeFile(
    path.join(secondDestination, name),
    "external modification",
  );
  const retained = await manager();
  assert.equal(retained.directory, defaultDirectory);
  assert.equal(
    await fs.readFile(path.join(secondDestination, name), "utf8"),
    "external modification",
  );
  assert.equal(
    await fs.readFile(path.join(defaultDirectory, name), "utf8"),
    "original archive",
  );
  await assert.rejects(retained.preview(destination), /recovery copies/);
});

test("source changes before commit keep original location and retain the verified copy", async (t) => {
  const { manager, destination, defaultDirectory } = await fixture(t);
  const name = `${randomUUID()}.tar.gz`;
  const store = await manager({
    hooks: {
      async beforeCommit() {
        await fs.writeFile(
          path.join(defaultDirectory, name),
          "new external contents",
        );
      },
    },
  });
  await fs.writeFile(path.join(defaultDirectory, name), "original archive");
  const review = await store.preview(destination);
  const operation = store.begin(destination, review.revision);
  await operation.promise;
  assert.equal(operation.job.status, "failed");
  assert.equal(store.directory, defaultDirectory);
  assert.equal(
    await fs.readFile(path.join(defaultDirectory, name), "utf8"),
    "new external contents",
  );
  assert.equal(
    await fs.readFile(path.join(destination, name), "utf8"),
    "original archive",
  );
});

test("fleet setup reserves storage before publishing its server and excludes concurrent backup moves", async (t) => {
  const { boot, root, destination } = await fixture(t);
  const panel = await boot({ fleet: true, createDefaultServer: true });
  const first = (await panel.request("/api/servers")).body.servers[0].id;
  const installationDirectory = path.join(root, "new-server");
  let entered, release;
  const paused = new Promise((resolve) => (entered = resolve));
  const barrier = new Promise((resolve) => (release = resolve));
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    if (args[0] === path.join(installationDirectory, "eula.txt")) {
      entered();
      await barrier;
    }
    return originalOpen(...args);
  };
  const creating = panel.request(
    "/api/servers",
    json("POST", {
      name: "Installing",
      mode: "live",
      port: 25566,
      memoryLimitMB: 2048,
      jar: "server.jar",
      javaPath: "java",
      installationDirectory,
    }),
  );
  try {
    await paused;
    for (const route of ["preview", "jobs"]) {
      const blocked = await panel.request(
        `/api/backups/location/${route}`,
        json("POST", {
          directory: destination,
          revision: "stale",
          confirm: true,
        }),
        first,
      );
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error, /server setup or settings/);
    }
  } finally {
    release();
    fs.open = originalOpen;
    assert.equal((await creating).status, 201);
  }
  assert.equal(
    (
      await panel.request(
        "/api/backups/location/preview",
        json("POST", { directory: destination }),
        first,
      )
    ).status,
    200,
  );
});
