import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel, createFleet } from "./index.mjs";
import { contentKind } from "./audit.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function fixture(t, { fleet = false, ...options } = {}) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "mc-audit-events-"),
  );
  let panel, listener;
  const open = async () => {
    panel = await (fleet ? createFleet : createPanel)({
      dataDir: root,
      mode: "live",
      useEnvironment: false,
      scheduler: false,
      publicAddress: { resolve: async () => null },
      createDefaultServer: false,
      catalogFetch: async () => Response.json([]),
      ...options,
    });
    if (!fleet)
      await fs.mkdir(path.join(panel.serverDir, "plugins"), {
        recursive: true,
      });
    listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
  };
  const close = async () => {
    try {
      await panel.close();
    } finally {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
  };
  await open();
  t.after(async () => {
    await close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-audit-events-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get panel() {
      return panel;
    },
    restart: async () => {
      await close();
      await open();
    },
    request: async (route, options = {}, id) => {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...(id ? { "X-Server-Id": id } : {}),
            ...options.headers,
          },
        },
      );
      return { status: response.status, body: await response.json() };
    },
    upload: async (directory, names) => {
      const form = new FormData();
      for (const name of names) form.append("files", new Blob([name]), name);
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}/api/files/upload?path=${encodeURIComponent(directory)}`,
        { method: "POST", body: form },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

test("content audit classification recognizes plugins and custom-world datapacks", () => {
  assert.equal(contentKind("plugins/test.jar"), "Plugin");
  assert.equal(contentKind("mods/test.jar.disabled"), "Mod");
  assert.equal(
    contentKind("custom/world/datapacks/example.zip", "file", "custom/world"),
    "Datapack",
  );
  assert.equal(
    contentKind("world/datapacks/example.zip", "file", "custom/world"),
    "File",
  );
  assert.equal(contentKind("plugins", "directory"), "Directory");
});

test("file audits distinguish plugin/datapack uploads, directory deletion, restore and permanent paths", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.panel.serverDir, "custom-world", "datapacks"), {
    recursive: true,
  });
  await fs.appendFile(
    path.join(f.panel.serverDir, "server.properties"),
    "\nlevel-name=custom-world\n",
  );
  assert.equal((await f.upload("plugins", ["example.jar"])).status, 201);
  assert.equal(
    (await f.upload("custom-world/datapacks", ["pack.zip"])).status,
    201,
  );
  // Upload temp-file cleanup remains protected after the response is sent.
  const cleanupDeadline = performance.now() + 15_000;
  for (;;) {
    try {
      f.panel.assertRemovable();
      break;
    } catch (cause) {
      if (performance.now() >= cleanupDeadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  let removed = await f.request("/api/files?path=plugins/example.jar", {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  assert.equal(
    (
      await f.request(
        `/api/files/recycle-bin/${removed.body.recycled.id}/restore`,
        json("POST", {}),
      )
    ).status,
    200,
  );
  removed = await f.request("/api/files?path=plugins/example.jar", {
    method: "DELETE",
  });
  assert.equal(
    (
      await f.request(`/api/files/recycle-bin/${removed.body.recycled.id}`, {
        method: "DELETE",
      })
    ).status,
    200,
  );
  await f.request("/api/files?path=custom-world", { method: "DELETE" });
  const expectedActions = [
    "Plugin added",
    "Datapack added",
    "Plugin restored",
    "Directory deleted",
  ];
  // A committed move responds before audit classification/persistence finishes,
  // so a slow server.properties read cannot hold its file-operation lock.
  // Require the exact audit entries once that tracked background work settles.
  const auditDeadline = performance.now() + 10_000;
  let events;
  for (;;) {
    events = (await f.request("/api/audit")).body.entries;
    if (
      expectedActions.every((action) =>
        events.some((event) => event.action === action),
      ) ||
      performance.now() >= auditDeadline
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const action of expectedActions)
    assert.ok(
      events.some((event) => event.action === action),
      action,
    );
  assert.equal(
    events.find(
      (event) => event.action === "Recycle Bin item permanently deleted",
    ).detail,
    "plugins/example.jar",
  );
});

test("partial uploads audit the files that reached disk even when a later copy fails", async (t) => {
  const f = await fixture(t),
    copy = fs.copyFile;
  t.mock.method(console, "error", () => {});
  t.mock.method(fs, "copyFile", async (source, destination, ...args) => {
    if (destination.endsWith(`${path.sep}failed.jar`))
      throw Object.assign(new Error("fixture copy failure"), {
        code: "EACCES",
      });
    return copy(source, destination, ...args);
  });
  assert.equal(
    (await f.upload("plugins", ["landed.jar", "failed.jar"])).status,
    500,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.panel.serverDir, "plugins/landed.jar"),
      "utf8",
    ),
    "landed.jar",
  );
  const events = (await f.request("/api/audit")).body.entries;
  assert.ok(
    events.some(
      (event) =>
        event.action === "Plugin added" &&
        event.detail === "plugins/landed.jar",
    ),
  );
  assert.ok(events.every((event) => !event.detail.includes("failed.jar")));
});

test("failed audit writes are reported and later saves recover without losing in-memory events", async (t) => {
  const f = await fixture(t),
    rename = fs.rename;
  t.mock.method(console, "error", () => {});
  let fail = true;
  t.mock.method(fs, "rename", async (source, destination) => {
    if (fail && destination === path.join(f.root, "panel.json")) {
      fail = false;
      throw Object.assign(new Error("fixture disk failure"), {
        code: "EACCES",
      });
    }
    return rename(source, destination);
  });
  await assert.rejects(
    f.panel.audit("file", "First event", "retained in memory"),
    /fixture disk failure/,
  );
  const lines = (await f.request("/api/console")).body.lines;
  assert.ok(
    lines.some((line) =>
      line.message.includes("Could not save panel state or audit history"),
    ),
  );
  await f.panel.audit("file", "Second event", "saved after recovery");
  const state = JSON.parse(
    await fs.readFile(path.join(f.root, "panel.json"), "utf8"),
  );
  assert.ok(state.audit.some((entry) => entry.action === "First event"));
  assert.ok(state.audit.some((entry) => entry.action === "Second event"));
});

test("retention and scheduled creation identify the Scheduler actor", async (t) => {
  const f = await fixture(t);
  const response = await f.request(
    "/api/backups/schedule",
    json("PUT", {
      enabled: true,
      type: "interval",
      intervalHours: 1,
      retention: 1,
    }),
  );
  assert.equal(response.status, 200);
  const deadline = Date.parse(response.body.schedule.nextRun);
  await f.panel.tick(new Date(deadline + 100));
  await f.panel.tick(new Date(deadline + 3_600_100));
  const events = (await f.request("/api/audit")).body.entries;
  assert.ok(
    events.some(
      (entry) =>
        entry.action === "Backup moved to Recycle Bin" &&
        entry.detail.includes("retention") &&
        entry.actor === "Scheduler",
    ),
  );
  assert.equal(
    events.filter(
      (entry) =>
        entry.action === "Backup created" && entry.actor === "Scheduler",
    ).length,
    2,
  );
});

test("offline console requests cannot fabricate player changes or audit success", async (t) => {
  const f = await fixture(t);
  const response = await f.request(
    "/api/console/command",
    json("POST", { command: "op ExamplePlayer" }),
  );
  assert.equal(response.status, 409);
  const events = (await f.request("/api/audit")).body.entries;
  assert.ok(events.every((entry) => !entry.action.startsWith("Player op")));
  assert.deepEqual((await f.request("/api/players")).body.operators, []);
});

for (const scenario of [
  {
    name: "icon preference",
    route: "/api/server/icon",
    method: "DELETE",
    body: {},
    action: "Default panel icon selected",
    check: (state) => assert.equal(state.iconPreference, "default"),
  },
]) {
  test(`${scenario.name} is durable even if its later audit write fails`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(
      path.join(f.panel.serverDir, "usercache.json"),
      JSON.stringify([
        {
          name: "ExamplePlayer",
          uuid: "12345678-1234-1234-1234-123456789abc",
        },
      ]),
    );
    const statePath = path.join(f.root, "panel.json");
    const write = fs.writeFile;
    let failed = false;
    t.mock.method(console, "error", () => {});
    t.mock.method(fs, "writeFile", async (target, data, ...args) => {
      if (
        !failed &&
        String(target).startsWith(`${statePath}.`) &&
        typeof data === "string" &&
        JSON.parse(data).audit[0]?.action === scenario.action
      ) {
        failed = true;
        throw Object.assign(new Error("Fixture audit write failure"), {
          code: "EIO",
        });
      }
      return write(target, data, ...args);
    });
    const result = await f.request(
      scenario.route,
      json(scenario.method, scenario.body),
    );
    assert.equal(result.status, 500);
    assert.equal(failed, true);
    const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
    scenario.check(saved);
    assert.ok(saved.audit.every((entry) => entry.action !== scenario.action));
    await f.panel.audit(
      "server",
      "Audit persistence recovered",
      "Fixture disk is available again.",
    );
  });
}

test("removed-server events remain accessible after deleting the last server and restarting", async (t) => {
  const f = await fixture(t, { fleet: true });
  const created = await f.request(
    "/api/servers",
    json("POST", { name: "Removed world", mode: "live", port: 25565 }),
  );
  assert.equal(created.status, 201);
  const id = created.body.server.id;
  await f.request("/api/server/power", json("POST", { action: "stop" }), id);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    (await f.request(`/api/servers/${id}`, { method: "DELETE" })).status,
    200,
  );
  await f.restart();
  const events = (await f.request("/api/audit")).body.entries;
  const removed = events.find((entry) => entry.action === "Server removed");
  assert.equal(removed.serverId, id);
  assert.equal(removed.serverName, "Removed world");
  assert.equal((await f.request("/api/panel/audit")).status, 200);
});
