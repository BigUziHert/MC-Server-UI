import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createFleet } from "./index.mjs";

test("custom backup roots stay isolated from other servers and imports across fleet restarts", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-backup-fleet-")),
  );
  const dataDir = path.join(root, "panel");
  const destination = path.join(root, "archives");
  const opened = [];
  t.after(async () => {
    for (const close of opened) await close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-backup-fleet-"));
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true });
  });
  const boot = async () => {
    const fleet = await createFleet({
      dataDir,
      createDefaultServer: true,
      useEnvironment: false,
      scheduler: false,
      remoteListen: false,
      publicAddress: { resolve: async () => null },
    });
    const listener = await new Promise((resolve) => {
      const server = fleet.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await fleet.close();
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    };
    opened.push(close);
    const request = async (route, serverId, body) => {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            ...(serverId ? { "X-Server-Id": serverId } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    return { fleet, request, close };
  };
  let panel = await boot();
  const first = (await panel.request("/api/servers")).body.defaultServerId;
  const created = await panel.request("/api/servers", undefined, {
    name: "Separate backups",
    port: 25566,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const second = created.body.server.id;
  const backup = await panel.request("/api/backups", first, {
    name: "Keep this archive",
  });
  assert.equal(backup.status, 201);
  const original = (await panel.request("/api/backups/location", first)).body;
  const move = async (directory) => {
    const preview = await panel.request(
      "/api/backups/location/preview",
      first,
      {
        directory,
      },
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const accepted = await panel.request("/api/backups/location/jobs", first, {
      ...preview.body,
      confirm: true,
    });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = (await panel.request("/api/backups/location", first)).body;
      if (state.job?.status !== "running") {
        assert.equal(state.job?.status, "completed", state.job?.error);
        assert.equal(state.directory, directory);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Backup move did not complete");
  };
  await move(destination);
  const assertIsolation = async () => {
    for (const directory of [
      destination,
      path.join(destination, "nested"),
      panel.fleet.runtimes.get(first).serverDir,
      path.join(dataDir, "shared-backups"),
    ]) {
      const rejected = await panel.request(
        "/api/backups/location/preview",
        second,
        { directory },
      );
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.match(rejected.body.error, /overlap|panel storage/i);
    }
    const imported = await panel.request(
      "/api/server-import/inspect",
      undefined,
      { directory: destination },
    );
    assert.equal(imported.status, 409, JSON.stringify(imported.body));
    assert.match(imported.body.error, /overlap|panel storage/i);
    assert.equal(
      (await panel.request("/api/backups", first)).body.backups[0].id,
      backup.body.id,
    );
  };
  await assertIsolation();
  await panel.close();
  panel = await boot();
  await assertIsolation();
  await move(original.defaultDirectory);
  assert.ok(
    (
      await fs.stat(
        path.join(original.defaultDirectory, `${backup.body.id}.tar.gz`),
      )
    ).isFile(),
  );
});
