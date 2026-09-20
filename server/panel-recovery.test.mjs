import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createPanelRecovery } from "./panel-recovery.mjs";

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-panel-recovery-"));
  const dataDir = path.join(root, "panel");
  await fs.mkdir(dataDir);
  const registered = [];
  const recovery = createPanelRecovery({
    dataDir,
    registered: () => registered,
  });
  async function saved(id = randomUUID()) {
    const directory = path.join(dataDir, "instances", id);
    const serverDir = path.join(directory, "server");
    await fs.mkdir(serverDir, { recursive: true });
    await fs.mkdir(path.join(directory, "backups"));
    await fs.writeFile(
      path.join(directory, "backups", "saved.tar.gz"),
      "preserved backup",
    );
    await fs.writeFile(
      path.join(directory, "panel.json"),
      JSON.stringify({
        users: [{ id: "old-user" }],
        audit: [],
        backups: [{ id: "saved" }],
      }),
    );
    await fs.writeFile(
      path.join(serverDir, "server.properties"),
      "server-port=25565\nmotd=Saved world\n",
    );
    await fs.writeFile(
      path.join(serverDir, "server.jar"),
      "fixture server, never executed",
    );
    return { id, directory, serverDir };
  }
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, registered, recovery, saved };
}

test("empty recovery discovery does not create an instances folder or register anything", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.recovery.list(), { candidates: [], warnings: [] });
  assert.deepEqual(await fs.readdir(f.dataDir), []);
  assert.deepEqual(f.registered, []);
});

test("discovery excludes registered IDs and inspects a preserved instance without modifying its files", async (t) => {
  const f = await fixture(t);
  const removed = await f.saved(),
    current = await f.saved();
  f.registered.push({ id: current.id, serverDir: current.serverDir });
  const stateFile = path.join(removed.directory, "panel.json");
  const original = await fs.readFile(stateFile);
  const result = await f.recovery.list();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, removed.id);
  const inspection = await f.recovery.inspect(removed.id);
  assert.equal(inspection.id, removed.id);
  assert.equal(inspection.storage, "instance");
  assert.equal(inspection.dataDir, removed.directory);
  assert.equal(inspection.serverDir, removed.serverDir);
  assert.equal(inspection.jar, "server.jar");
  assert.equal(inspection.port, 25565);
  assert.equal(inspection.motd, "Saved world");
  assert.match(inspection.revision, /^[a-f0-9]{64}$/);
  assert.equal(
    (await f.recovery.inspect(removed.id)).revision,
    inspection.revision,
  );
  assert.deepEqual(await fs.readFile(stateFile), original);
  assert.equal(
    await fs.readFile(
      path.join(removed.directory, "backups", "saved.tar.gz"),
      "utf8",
    ),
    "preserved backup",
  );
  assert.deepEqual(
    f.registered.map(({ id }) => id),
    [current.id],
  );
  await assert.rejects(fs.stat(path.join(f.dataDir, "servers.json")), {
    code: "ENOENT",
  });
});

test("recovery revisions change with startup files and panel metadata without hashing world contents", async (t) => {
  const f = await fixture(t);
  const saved = await f.saved();
  const first = await f.recovery.inspect(saved.id);
  await fs.writeFile(
    path.join(saved.serverDir, "server.properties"),
    "server-port=25577\nmotd=Changed saved world\n",
  );
  const changed = await f.recovery.inspect(saved.id);
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.port, 25577);
  await fs.writeFile(
    path.join(saved.directory, "panel.json"),
    JSON.stringify({ users: [], audit: [{ action: "changed" }] }),
  );
  assert.notEqual(
    (await f.recovery.inspect(saved.id)).revision,
    changed.revision,
  );
  await fs.mkdir(path.join(saved.serverDir, "world"));
  await fs.writeFile(
    path.join(saved.serverDir, "world", "level.dat"),
    "world data",
  );
  const world = await f.recovery.inspect(saved.id);
  await fs.writeFile(
    path.join(saved.serverDir, "world", "level.dat"),
    "world data changed without replacing the folder",
  );
  assert.equal((await f.recovery.inspect(saved.id)).revision, world.revision);
});

test("recovery rejects traversal, registered identities, and overlapping server roots", async (t) => {
  const f = await fixture(t);
  const saved = await f.saved();
  for (const id of ["../server", "", "not-an-id", `${saved.id}/server`])
    await assert.rejects(f.recovery.inspect(id), { status: 400 });
  f.registered.push({ id: saved.id, serverDir: saved.serverDir });
  await assert.rejects(f.recovery.inspect(saved.id), { status: 409 });
  f.registered[0] = { id: randomUUID(), serverDir: saved.directory };
  await assert.rejects(f.recovery.inspect(saved.id), /overlaps/);
});

for (const layer of ["instance", "server", "instances"]) {
  test(`recovery never follows a linked ${layer} folder`, async (t) => {
    const f = await fixture(t);
    const saved = await f.saved();
    const linked =
      layer === "instance"
        ? saved.directory
        : layer === "server"
          ? saved.serverDir
          : path.dirname(saved.directory);
    const preserved = path.join(f.root, `preserved-${layer}`);
    await fs.rename(linked, preserved);
    await fs.symlink(
      preserved,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      await assert.rejects(
        f.recovery.inspect(saved.id),
        /symbolic link|changed/,
      );
      if (layer !== "instances") {
        const result = await f.recovery.list();
        assert.equal(result.candidates.length, 0);
        assert.equal(result.warnings.length, 1);
      } else await assert.rejects(f.recovery.list(), /symbolic link|changed/);
    } finally {
      await fs.unlink(linked);
    }
  });
}

test("replacing a saved server directory invalidates its review even with identical files", async (t) => {
  const f = await fixture(t);
  const saved = await f.saved();
  const first = await f.recovery.inspect(saved.id);
  const preserved = path.join(f.root, "preserved-server");
  await fs.rename(saved.serverDir, preserved);
  await fs.mkdir(saved.serverDir);
  for (const name of ["server.jar", "server.properties"])
    await fs.copyFile(
      path.join(preserved, name),
      path.join(saved.serverDir, name),
    );
  assert.notEqual(
    (await f.recovery.inspect(saved.id)).revision,
    first.revision,
  );
});
