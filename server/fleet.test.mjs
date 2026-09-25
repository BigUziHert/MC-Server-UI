import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createFleet, createPanel } from "./index.mjs";
import { processStartup } from "../tests/fixtures/process-options.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function waitFor(check, message = "Fixture transition did not complete") {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}
async function startAndWait(panel, id) {
  const configured = await panel.request(
    `/api/servers/${id}`,
    json("PATCH", processStartup),
  );
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  await fs.writeFile(
    path.join(panel.runtimes.get(id).serverDir, "eula.txt"),
    "eula=true\n",
  );
  const started = await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
    id,
  );
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await waitFor(
    async () =>
      (await panel.request("/api/server", {}, id)).body.status === "running",
  );
}
async function stopAndWait(panel, id) {
  if ((await panel.request("/api/server", {}, id)).body.status === "offline")
    return;
  const response = await panel.request(
    "/api/server/power",
    json("POST", { action: "stop" }),
    id,
  );
  assert.equal(response.status, 200);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await panel.request("/api/server", {}, id)).body.status === "offline")
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Fixture server did not stop");
}
async function fixture(t, settings = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-fleet-test-"));
  const fleets = [];
  const listeners = [];
  const boot = async (extra = {}) => {
    const fleet = await createFleet({
      dataDir,
      createDefaultServer: true,
      scheduler: false,
      useEnvironment: false,
      publicAddress: { resolve: async () => null },
      ...settings,
      ...extra,
    });
    fleets.push(fleet);
    const listener = await new Promise((resolve) => {
      const server = fleet.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    listeners.push(listener);
    const base = `http://127.0.0.1:${listener.address().port}`;
    const request = async (route, options = {}, id) => {
      const response = await fetch(base + route, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(id ? { "X-Server-Id": id } : {}),
          ...options.headers,
        },
      });
      return { status: response.status, body: await response.json() };
    };
    return { ...fleet, request, base };
  };
  t.after(async () => {
    for (const fleet of fleets) await fleet.close();
    for (const listener of listeners) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("mc-fleet-test-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, boot };
}

test("browser desktop-selection capability is independent of an empty fleet and an unavailable server", async (t) => {
  const { boot } = await fixture(t, { createDefaultServer: false });
  const fleet = await boot();
  const expected = {
    status: 200,
    body: { desktop: false, activeServerId: null },
  };
  assert.deepEqual(await fleet.request("/api/desktop/selection"), expected);
  const created = await fleet.request(
    "/api/servers",
    json("POST", { name: "Unavailable fixture", port: 25565 }),
  );
  assert.equal(created.status, 201);
  // An optional app capability must never dispatch into a selected server.
  const runtime = fleet.runtimes.get(created.body.server.id);
  runtime.app = (_req, res) =>
    res.status(409).json({ error: "Imported folder unavailable." });
  assert.equal((await fleet.request("/api/server")).status, 409);
  assert.deepEqual(await fleet.request("/api/desktop/selection"), expected);
  assert.deepEqual(
    await fleet.request("/api/desktop/selection", {}, "missing-server"),
    expected,
  );
});

test("server registration accepts only live runtimes and leaves new servers stopped", async (t) => {
  const { boot } = await fixture(t, { createDefaultServer: false });
  const panel = await boot();
  const rejected = await panel.request(
    "/api/servers",
    json("POST", { name: "Unsupported", mode: "demo" }),
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual((await panel.request("/api/servers")).body.servers, []);
  const created = await panel.request(
    "/api/servers",
    json("POST", { name: "Configured server" }),
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.server.mode, "live");
  assert.equal(created.body.server.status, "offline");
  const id = created.body.server.id;
  assert.equal(
    (await panel.request(`/api/servers/${id}`, json("PATCH", { mode: "demo" })))
      .status,
    400,
  );
  assert.equal((await panel.request("/api/server", {}, id)).body.mode, "live");
  assert.deepEqual(
    (await panel.request("/api/server", {}, id)).body.players,
    [],
  );
  const files = await fs.readdir(panel.runtimes.get(id).serverDir);
  assert.deepEqual(files.sort(), ["eula.txt", "server.properties"]);
  assert.equal(
    (
      await panel.request(
        "/api/console/command",
        json("POST", { command: "list" }),
        id,
      )
    ).status,
    409,
  );
});

test("fleet scopes files, console, backups, schedules, users and player permissions", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const { request, base, tick } = panel;
  const first = (await request("/api/servers")).body.defaultServerId;
  const created = await request(
    "/api/servers",
    json("POST", {
      name: "Creative",
      mode: "live",
      port: 25566,
      memoryLimitMB: 2048,
    }),
  );
  assert.equal(created.status, 201);
  const second = created.body.server.id;
  assert.notEqual(second, first);
  assert.equal(
    (await request("/api/server", {}, second)).body.name,
    "Creative",
  );
  assert.equal((await request("/api/server")).body.name, "The Overworld");
  await request(
    "/api/files",
    json("POST", {
      name: "private.txt",
      type: "file",
      content: "first server only",
    }),
    first,
  );
  assert.equal(
    (await request("/api/files/content?path=private.txt", {}, second)).status,
    404,
  );
  assert.equal(
    await (
      await fetch(
        `${base}/api/files/download?path=private.txt&serverId=${first}`,
      )
    ).text(),
    "first server only",
  );
  assert.equal(
    (
      await fetch(
        `${base}/api/files/download?path=private.txt&serverId=${second}`,
      )
    ).status,
    404,
  );
  await startAndWait(panel, first);
  const said = await request(
    "/api/console/command",
    json("POST", { command: "say isolated first server" }),
    first,
  );
  assert.equal(said.status, 200);
  await waitFor(async () =>
    (await request("/api/console", {}, first)).body.lines.some((line) =>
      line.message.includes("isolated first server"),
    ),
  );
  assert.ok(
    !(await request("/api/console", {}, second)).body.lines.some((line) =>
      line.message.includes("isolated first server"),
    ),
  );
  const backup = await request(
    "/api/backups",
    json("POST", { name: "World snapshot" }),
    first,
  );
  assert.equal(
    (await request(`/api/backups/${backup.body.id}/download`, {}, second))
      .status,
    404,
  );
  assert.equal(
    (await request("/api/backups", {}, second)).body.backups.length,
    0,
  );
  const schedule = await request(
    "/api/backups/schedule",
    json("PUT", {
      enabled: true,
      type: "interval",
      intervalHours: 1,
      retention: 2,
    }),
    first,
  );
  assert.equal(
    (await request("/api/backups", {}, second)).body.schedule.enabled,
    false,
  );
  await tick(new Date(new Date(schedule.body.schedule.nextRun).getTime() + 10));
  assert.equal(
    (await request("/api/backups", {}, first)).body.backups.length,
    2,
  );
  assert.equal(
    (await request("/api/backups", {}, second)).body.backups.length,
    0,
  );
  const user = await request(
    "/api/subusers",
    json("POST", { email: "admin@example.com", role: "admin" }),
    first,
  );
  assert.equal(
    (
      await request(
        `/api/subusers/${user.body.id}`,
        { method: "DELETE" },
        second,
      )
    ).status,
    404,
  );
  assert.deepEqual((await request("/api/subusers", {}, second)).body.users, []);
  const operated = await request(
    "/api/players/op",
    json("POST", { name: "BuilderOne" }),
    first,
  );
  assert.equal(operated.status, 200);
  assert.match(operated.body.message, /Requested op BuilderOne/);
  await waitFor(async () => {
    const result = await request("/api/players", {}, first);
    // The subprocess can briefly leave ops.json empty while rewriting it.
    if (result.status === 409) {
      assert.match(result.body.error, /ops\.json contains invalid JSON/);
      return false;
    }
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(
      Array.isArray(result.body.operators),
      JSON.stringify(result.body),
    );
    return result.body.operators.some((entry) => entry.name === "BuilderOne");
  });
  assert.equal(
    (await request("/api/players", {}, first)).body.operators[0].name,
    "BuilderOne",
  );
  assert.deepEqual(
    (await request("/api/players", {}, second)).body.operators,
    [],
  );
  assert.equal(
    JSON.parse(
      (await request("/api/files/content?path=ops.json", {}, first)).body
        .content,
    )[0].name,
    "BuilderOne",
  );
  assert.ok(
    !(await request("/api/audit", {}, second)).body.entries.some(
      (entry) => entry.category === "player" || entry.category === "backup",
    ),
  );
});

test("unknown and conflicting selectors fail closed, including direct downloads", async (t) => {
  const { boot } = await fixture(t);
  const { request } = await boot();
  const id = (await request("/api/servers")).body.defaultServerId;
  assert.equal((await request("/api/server", {}, "unknown")).status, 404);
  assert.equal(
    (
      await request(
        "/api/files/download?path=server.properties&serverId=unknown",
      )
    ).status,
    404,
  );
  assert.equal(
    (await request(`/api/server?serverId=${id}`, {}, "unknown")).status,
    400,
  );
  assert.equal((await request("/api/server?serverId=")).status, 404);
  assert.equal(
    (await request("/api/server?serverId=a&serverId=b")).status,
    404,
  );
  assert.equal(
    (
      await request("/api/servers", {
        ...json("POST", { name: "Cross site" }),
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
});

test("legacy data stays in place, rename and saved operators persist across restarts", async (t) => {
  const { dataDir, boot } = await fixture(t);
  const legacy = await createPanel({
    dataDir,
    useEnvironment: false,
    scheduler: false,
  });
  await legacy.audit("server", "Legacy data", "Must remain here");
  await legacy.close();
  await fs.writeFile(
    path.join(dataDir, "server", "precious.txt"),
    "world data",
  );
  const panel = await boot({ name: "Original env name" });
  const id = (await panel.request("/api/servers")).body.defaultServerId;
  assert.equal(
    (
      await panel.request(
        `/api/servers/${id}`,
        json("PATCH", { name: "Renamed world" }),
      )
    ).status,
    200,
  );
  await fs.writeFile(
    path.join(panel.runtimes.get(id).serverDir, "ops.json"),
    JSON.stringify([
      {
        name: "BuilderOne",
        uuid: "12345678-1234-1234-1234-123456789abc",
        level: 4,
      },
    ]),
  );
  const second = (
    await panel.request(
      "/api/servers",
      json("POST", { name: "Second", mode: "live", port: 25566 }),
    )
  ).body.server;
  await panel.close();
  const restarted = await boot({ name: "Changed env ignored", port: 29999 });
  const registry = (await restarted.request("/api/servers")).body;
  assert.equal(registry.defaultServerId, id);
  assert.equal(registry.servers.length, 2);
  assert.equal(registry.servers[0].name, "Renamed world");
  assert.equal(registry.servers[0].port, 25565);
  assert.equal(registry.servers[1].id, second.id);
  assert.equal(
    (await restarted.request("/api/players", {}, id)).body.operators[0].name,
    "BuilderOne",
  );
  assert.equal(
    (await restarted.request("/api/players", {}, second.id)).body.operators
      .length,
    0,
  );
  assert.equal(
    await fs.readFile(path.join(dataDir, "server", "precious.txt"), "utf8"),
    "world data",
  );
  assert.ok(
    (await restarted.request("/api/audit", {}, id)).body.entries.some(
      (entry) => entry.action === "Legacy data",
    ),
  );
});

test("concurrent creation reserves unique ports; config edits need a stopped server", async (t) => {
  const { boot, dataDir } = await fixture(t);
  const panel = await boot();
  const { request } = panel;
  const results = await Promise.all(
    ["One", "Two"].map((name) =>
      request(
        "/api/servers",
        json("POST", { name, mode: "live", port: 25566 }),
      ),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const live = results.find((result) => result.status === 201).body.server;
  assert.equal(
    (await request(`/api/servers/${live.id}`, json("PATCH", { port: 25565 })))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        `/api/servers/${live.id}`,
        json("PATCH", {
          port: 25567,
          memoryLimitMB: 2048,
          motd: "Creative builds",
        }),
      )
    ).status,
    200,
  );
  const contents = (
    await request("/api/files/content?path=server.properties", {}, live.id)
  ).body.content;
  assert.match(contents, /server-port=25567/);
  assert.match(contents, /motd=Creative builds/);
  assert.match(
    (await request("/api/files/content?path=eula.txt", {}, live.id)).body
      .content,
    /eula=false/,
  );
  const id = (await request("/api/servers")).body.defaultServerId;
  await startAndWait(panel, id);
  assert.equal(
    (
      await request(
        `/api/servers/${id}`,
        json("PATCH", { name: "Allowed while running" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/api/servers/${id}`,
        json("PATCH", { memoryLimitMB: 2048 }),
      )
    ).status,
    409,
  );
  for (const invalid of [
    { name: "\nInjected" },
    { port: 22 },
    { port: "25570" },
    { mode: "other" },
    { jar: "../escape.jar" },
    { javaPath: "java\nstop" },
    { memoryLimitMB: 255 },
    { motd: "hello\nserver-port=22" },
    { serverDir: "../" },
  ])
    assert.equal(
      (await request(`/api/servers/${live.id}`, json("PATCH", invalid))).status,
      400,
    );
  const registry = JSON.parse(
    await fs.readFile(path.join(dataDir, "servers.json"), "utf8"),
  );
  assert.equal(
    registry.servers.find((entry) => entry.id === live.id).port,
    25567,
  );
});

test("live player actions send validated single commands; ops.json remains authoritative", async (t) => {
  const commands = [];
  let launches = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 1);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      commands.push(chunk.toString());
      if (chunk.toString() === "stop\n")
        setImmediate(() => child.emit("close", 0));
      callback();
    },
  });
  const { boot } = await fixture(t, {
    spawnServer: (executable, args, options) => {
      launches++;
      assert.equal(executable, "java");
      assert.equal(options.shell, false);
      assert.ok(args.includes("-Xmx4096M"));
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (1.24s)! For help, type "help"\n',
        ),
      );
      return child;
    },
  });
  const { request } = await boot();
  const live = (
    await request(
      "/api/servers",
      json("POST", { name: "Live", mode: "live", port: 25566 }),
    )
  ).body.server;
  assert.equal(
    (
      await request(
        "/api/players/op",
        json("POST", { name: "BuilderOne" }),
        live.id,
      )
    ).status,
    409,
  );
  await request(
    "/api/files",
    json("POST", {
      name: "server.jar",
      type: "file",
      content: "never executed",
    }),
    live.id,
  );
  await request(
    "/api/files/content",
    json("PUT", {
      path: "eula.txt",
      ...(await request("/api/files/content?path=eula.txt", {}, live.id)).body,
      content: "eula=true\n",
    }),
    live.id,
  );
  const starts = await Promise.all(
    [1, 2].map(() =>
      request("/api/server/power", json("POST", { action: "start" }), live.id),
    ),
  );
  assert.deepEqual(starts.map((result) => result.status).sort(), [200, 409]);
  assert.equal(launches, 1);
  child.stdout.write("[12:00:00 INFO]: BuilderOne joined the game\n");
  assert.deepEqual((await request("/api/server", {}, live.id)).body.players, [
    { name: "BuilderOne" },
  ]);
  assert.deepEqual((await request("/api/server")).body.players, []);
  assert.equal(
    (
      await request(
        `/api/servers/${live.id}`,
        json("PATCH", { name: "Renamed live" }),
      )
    ).status,
    200,
  );
  assert.equal(launches, 1);
  for (const name of [
    "x",
    "a".repeat(17),
    "Player\nstop",
    "Player;stop",
    "Player Other",
    "/op Player",
  ])
    assert.equal(
      (await request("/api/players/op", json("POST", { name }), live.id))
        .status,
      400,
    );
  const opped = await request(
    "/api/players/op",
    json("POST", { name: "BuilderOne" }),
    live.id,
  );
  assert.equal(opped.status, 200);
  assert.match(opped.body.message, /Requested op BuilderOne/);
  assert.deepEqual(
    (await request("/api/players", {}, live.id)).body.operators,
    [],
  );
  assert.equal(
    (
      await request(
        "/api/players/deop",
        json("POST", { name: "BuilderTwo" }),
        live.id,
      )
    ).status,
    200,
  );
  assert.deepEqual(commands, ["op BuilderOne\n", "deop BuilderTwo\n"]);
  const operators = [
    {
      name: "BuilderOne",
      uuid: "12345678-1234-1234-1234-123456789abc",
      level: 4,
    },
  ];
  await request(
    "/api/files",
    json("POST", {
      name: "ops.json",
      type: "file",
      content: JSON.stringify(operators),
    }),
    live.id,
  );
  assert.deepEqual(
    (await request("/api/players", {}, live.id)).body.operators,
    operators,
  );
  await request(
    "/api/files/content",
    json("PUT", {
      path: "ops.json",
      ...(await request("/api/files/content?path=ops.json", {}, live.id)).body,
      content: "[broken",
    }),
    live.id,
  );
  assert.equal((await request("/api/players", {}, live.id)).status, 409);
});

test("fleet rejects junctions connecting another instance's private directories", async (t) => {
  const { boot, dataDir } = await fixture(t);
  const panel = await boot();
  const second = (
    await panel.request(
      "/api/servers",
      json("POST", { name: "Second", port: 25566 }),
    )
  ).body.server;
  await panel.close();
  const secondDir = path.join(dataDir, "instances", second.id);
  const backupDir = path.join(secondDir, "backups");
  assert.equal(path.dirname(backupDir), secondDir);
  await fs.rmdir(backupDir);
  await fs.symlink(
    path.join(dataDir, "backups"),
    backupDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    createFleet({ dataDir, scheduler: false, useEnvironment: false }),
    /Symbolic links/,
  );
});

test("a failed registry write rolls server.properties back and leaves active settings unchanged", async (t) => {
  const { boot } = await fixture(t);
  const { request, runtimes } = await boot();
  const live = (
    await request(
      "/api/servers",
      json("POST", { name: "Offline", mode: "live", port: 25566 }),
    )
  ).body.server;
  const runtime = runtimes.get(live.id);
  const target = path.join(runtime.serverDir, "server.properties");
  const original = await fs.readFile(target, "utf8");
  await assert.rejects(
    runtime.updateConfiguration(
      { ...runtime.descriptor(), port: 25567, motd: "Must roll back" },
      async () => {
        throw new Error("Fixture disk failure");
      },
    ),
    /Fixture disk failure/,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
  assert.equal(runtime.descriptor().port, 25566);
  assert.equal(runtime.descriptor().motd, live.motd);
  assert.equal(
    (
      await request(
        `/api/servers/${live.id}`,
        json("PATCH", { name: "Still editable" }),
      )
    ).status,
    200,
  );
});

test("explicit saved-server recovery preserves its original identity, files and backups", async (t) => {
  const { boot } = await fixture(t);
  const fleet = await boot();
  const created = (
    await fleet.request(
      "/api/servers",
      json("POST", { name: "Saved world", port: 25577 }),
    )
  ).body.server;
  const runtime = fleet.runtimes.get(created.id);
  await fs.writeFile(
    path.join(runtime.serverDir, "server.jar"),
    "fixture never executed",
  );
  await fs.writeFile(
    path.join(runtime.serverDir, "precious-world.txt"),
    "keep my world",
  );
  const properties = await fs.readFile(
    path.join(runtime.serverDir, "server.properties"),
  );
  const backup = await fleet.request(
    "/api/backups",
    json("POST", { name: "Keep backup" }),
    created.id,
  );
  assert.equal(backup.status, 201);
  const backupFiles = await fs.readdir(path.join(runtime.dataDir, "backups"));
  assert.equal(
    (await fleet.request(`/api/servers/${created.id}`, { method: "DELETE" }))
      .status,
    200,
  );
  const candidates = await fleet.request("/api/server-recovery");
  assert.ok(
    candidates.body.candidates.some((entry) => entry.id === created.id),
  );
  const inspected = (await fleet.request(`/api/server-recovery/${created.id}`))
    .body;
  const input = {
    confirmed: true,
    revision: inspected.revision,
    name: "Recovered world",
    port: 25577,
    jar: "server.jar",
  };
  assert.equal(
    (
      await fleet.request(
        `/api/server-recovery/${created.id}`,
        json("POST", { ...input, confirmed: false }),
      )
    ).status,
    400,
  );
  await fs.writeFile(
    path.join(runtime.serverDir, "changed.txt"),
    "external change",
  );
  assert.equal(
    (
      await fleet.request(
        `/api/server-recovery/${created.id}`,
        json("POST", input),
      )
    ).status,
    409,
  );
  input.revision = (
    await fleet.request(`/api/server-recovery/${created.id}`)
  ).body.revision;
  assert.equal(
    (
      await fleet.request(
        `/api/server-recovery/${created.id}`,
        json("POST", { ...input, port: 25565 }),
      )
    ).status,
    409,
  );
  const recovered = await fleet.request(
    `/api/server-recovery/${created.id}`,
    json("POST", input),
  );
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal(recovered.body.server.id, created.id);
  assert.equal(recovered.body.server.status, "offline");
  assert.deepEqual(
    await fs.readFile(path.join(runtime.serverDir, "server.properties")),
    properties,
  );
  assert.equal(
    await fs.readFile(
      path.join(runtime.serverDir, "precious-world.txt"),
      "utf8",
    ),
    "keep my world",
  );
  assert.deepEqual(
    await fs.readdir(path.join(runtime.dataDir, "backups")),
    backupFiles,
  );
  assert.equal(
    (await fleet.request("/api/backups", {}, created.id)).body.backups.length,
    1,
  );
  assert.ok(
    !(await fleet.request("/api/server-recovery")).body.candidates.some(
      (entry) => entry.id === created.id,
    ),
  );
});

test("failed removal recovery retains an unavailable descriptor and other servers remain usable", async (t) => {
  const { boot } = await fixture(t);
  const fleet = await boot();
  const originalId = (await fleet.request("/api/servers")).body.defaultServerId;
  const created = (
    await fleet.request(
      "/api/servers",
      json("POST", { name: "Disk trouble", port: 25577 }),
    )
  ).body.server;
  const runtime = fleet.runtimes.get(created.id);
  t.mock.method(console, "error", () => {});
  t.mock.method(runtime, "audit", async () => {
    throw new Error("Fixture audit disk unavailable");
  });
  const mkdir = fs.mkdir.bind(fs);
  const mocked = t.mock.method(fs, "mkdir", async (target, options) => {
    if (target === runtime.dataDir)
      throw Object.assign(new Error("Fixture folder unavailable"), {
        code: "EIO",
      });
    return mkdir(target, options);
  });
  assert.equal(
    (await fleet.request(`/api/servers/${created.id}`, { method: "DELETE" }))
      .status,
    500,
  );
  const unavailable = (await fleet.request("/api/servers")).body.servers.find(
    (entry) => entry.id === created.id,
  );
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.source, "managed");
  assert.equal(
    (await fleet.request("/api/server", {}, originalId)).status,
    200,
  );
  mocked.mock.restore();
  assert.equal(
    (await fleet.request("/api/server", {}, created.id)).status,
    200,
  );
  assert.equal(fleet.runtimes.get(created.id).unavailable, undefined);
});

test("removing the last server preserves its files and backups and leaves an empty registry after restart", async (t) => {
  const { boot, dataDir } = await fixture(t);
  const first = await boot();
  const id = (await first.request("/api/servers")).body.defaultServerId;
  await first.request(
    "/api/files",
    json("POST", {
      name: "kept.txt",
      type: "file",
      content: "do not delete this server's files",
    }),
  );
  const backup = await first.request(
    "/api/backups",
    json("POST", { name: "Retained backup" }),
  );
  await startAndWait(first, id);
  assert.equal(
    (await first.request(`/api/servers/${id}`, { method: "DELETE" })).status,
    409,
  );
  await stopAndWait(first, id);
  const removed = await first.request(`/api/servers/${id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, {
    ok: true,
    serverId: id,
    defaultServerId: null,
    filesPreserved: true,
  });
  assert.equal(first.runtimes.size, 0);
  assert.equal(
    await fs.readFile(path.join(dataDir, "server", "kept.txt"), "utf8"),
    "do not delete this server's files",
  );
  assert.ok(
    (await fs.stat(path.join(dataDir, "backups", `${backup.body.id}.tar.gz`)))
      .size > 0,
  );
  assert.deepEqual((await first.request("/api/servers")).body, {
    servers: [],
    defaultServerId: null,
  });
  assert.equal((await first.request("/api/server")).status, 404);
  await first.close();
  const restarted = await boot();
  assert.deepEqual((await restarted.request("/api/servers")).body, {
    servers: [],
    defaultServerId: null,
  });
  assert.equal(restarted.runtimes.size, 0);
  const explicit = await restarted.request(
    "/api/servers",
    json("POST", { name: "My real server" }),
  );
  assert.equal(explicit.body.server.mode, "live");
  assert.equal(explicit.body.server.port, 25565);
  assert.equal(
    (await restarted.request("/api/servers")).body.defaultServerId,
    explicit.body.server.id,
  );
  assert.equal(
    (
      await restarted.request(`/api/servers/${explicit.body.server.id}`, {
        method: "DELETE",
      })
    ).status,
    200,
  );
});

test("removing a legacy default retains another server's instance storage across default reassignment", async (t) => {
  const { boot, dataDir } = await fixture(t);
  const original = await boot();
  const legacyId = (await original.request("/api/servers")).body
    .defaultServerId;
  const live = (
    await original.request(
      "/api/servers",
      json("POST", { name: "Keep this world", mode: "live", port: 25566 }),
    )
  ).body.server;
  await original.request(
    "/api/files",
    json("POST", {
      name: "world-proof.txt",
      type: "file",
      content: "instance data stays here",
    }),
    live.id,
  );
  await original.request(
    "/api/subusers",
    json("POST", { email: "kept@example.com", role: "viewer" }),
    live.id,
  );
  const backup = await original.request(
    "/api/backups",
    json("POST", { name: "Instance backup" }),
    live.id,
  );
  const instanceDir = original.runtimes.get(live.id).dataDir;
  await original.close();
  // Simulate a registry written by the previously installed app, before storage tags existed.
  const registryPath = path.join(dataDir, "servers.json");
  const oldRegistry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  for (const entry of oldRegistry.servers) delete entry.storage;
  await fs.writeFile(registryPath, JSON.stringify(oldRegistry));
  const upgraded = await boot({ createDefaultServer: false });
  await stopAndWait(upgraded, legacyId);
  assert.equal(
    (await upgraded.request(`/api/servers/${legacyId}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal(
    (await upgraded.request("/api/servers")).body.defaultServerId,
    live.id,
  );
  assert.equal(
    (await upgraded.request("/api/files/content?path=world-proof.txt")).body
      .content,
    "instance data stays here",
  );
  await upgraded.close();
  const restarted = await boot({ createDefaultServer: false });
  assert.equal(restarted.runtimes.get(live.id).dataDir, instanceDir);
  assert.equal(
    (await restarted.request("/api/files/content?path=world-proof.txt")).body
      .content,
    "instance data stays here",
  );
  assert.equal(
    (await restarted.request("/api/backups")).body.backups[0].id,
    backup.body.id,
  );
  assert.equal(
    (await restarted.request("/api/subusers")).body.users[0].email,
    "kept@example.com",
  );
  assert.ok(
    (
      await fs.stat(
        path.join(instanceDir, "backups", `${backup.body.id}.tar.gz`),
      )
    ).size > 0,
  );
});

test("clean-start option imports recognizable pre-registry workspaces without deleting existing files", async (t) => {
  const { boot, dataDir } = await fixture(t);
  const legacy = await createPanel({
    dataDir,
    useEnvironment: false,
    scheduler: false,
  });
  await fs.writeFile(
    path.join(legacy.serverDir, "precious.txt"),
    "pre-registry world",
  );
  await legacy.audit("file", "Existing world", "Keep all legacy data");
  await legacy.close();
  const imported = await boot({ createDefaultServer: false });
  assert.equal((await imported.request("/api/servers")).body.servers.length, 1);
  assert.equal(
    (await imported.request("/api/files/content?path=precious.txt")).body
      .content,
    "pre-registry world",
  );
  assert.ok(
    (await imported.request("/api/audit")).body.entries.some(
      (entry) => entry.action === "Existing world",
    ),
  );
});

test("removing an imported live server preserves its original world, backups and recycled files across restart", async (t) => {
  const { boot } = await fixture(t);
  const sourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-removal-source-"),
  );
  const directory = path.join(sourceRoot, "Existing world");
  t.after(async () => {
    assert.equal(
      path.dirname(path.resolve(sourceRoot)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(sourceRoot).startsWith("mc-removal-source-"));
    assert.equal((await fs.lstat(sourceRoot)).isSymbolicLink(), false);
    await fs.rm(sourceRoot, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, "world"), { recursive: true });
  const originals = {
    "server.properties":
      "server-port=25575\nmotd=Keep this world\nlevel-name=world\n",
    "eula.txt": "# Original decision\neula=false\n",
    "server.jar": "An inert test fixture, never executed",
    "world/level.dat": "Original world bytes",
  };
  for (const [name, contents] of Object.entries(originals))
    await fs.writeFile(path.join(directory, name), contents);
  const panel = await boot({ createDefaultServer: false });
  const imported = await panel.request(
    "/api/server-import",
    json("POST", {
      directory,
      name: "Imported world",
      jar: "server.jar",
      port: 25575,
      memoryLimitMB: 1024,
      javaPath: "java",
    }),
  );
  assert.equal(imported.status, 201);
  const id = imported.body.server.id;
  const runtime = panel.runtimes.get(id);
  await panel.request(
    "/api/files",
    json("POST", { name: "recycled.txt", type: "file", content: "recover me" }),
    id,
  );
  const recycled = await panel.request(
    "/api/files?path=recycled.txt",
    { method: "DELETE" },
    id,
  );
  assert.equal(recycled.status, 200);
  const backup = await panel.request(
    "/api/backups",
    json("POST", { name: "Retain this archive" }),
    id,
  );
  assert.equal(backup.status, 201);
  await panel.request(
    "/api/backups/schedule",
    json("PUT", {
      enabled: true,
      type: "interval",
      intervalHours: 1,
      time: "03:00",
      dayOfWeek: 0,
      retention: 7,
    }),
    id,
  );
  const removed = await panel.request(`/api/servers/${id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.filesPreserved, true);
  assert.equal(panel.runtimes.size, 0);
  for (const [name, contents] of Object.entries(originals))
    assert.equal(
      await fs.readFile(path.join(directory, name), "utf8"),
      contents,
    );
  assert.ok(
    (
      await fs.stat(
        path.join(runtime.dataDir, "backups", `${backup.body.id}.tar.gz`),
      )
    ).size > 0,
  );
  assert.equal(
    await fs.readFile(
      path.join(
        runtime.dataDir,
        "recycle-bin",
        recycled.body.recycled.id,
        "content",
      ),
      "utf8",
    ),
    "recover me",
  );
  await panel.tick(new Date(Date.now() + 2 * 60 * 60 * 1000));
  assert.equal(
    (await fs.readdir(path.join(runtime.dataDir, "backups"))).length,
    1,
  );
  await panel.close();
  const restarted = await boot({ createDefaultServer: false });
  assert.deepEqual((await restarted.request("/api/servers")).body, {
    servers: [],
    defaultServerId: null,
  });
  assert.equal((await restarted.request("/api/server", {}, id)).status, 404);
  assert.equal(
    await fs.readFile(path.join(directory, "world", "level.dat"), "utf8"),
    originals["world/level.dat"],
  );
});

test("server removal rejects ongoing configuration work without closing the server runtime", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot({ createDefaultServer: false });
  const created = await panel.request(
    "/api/servers",
    json("POST", { name: "Busy offline server", mode: "live", port: 25576 }),
  );
  const id = created.body.server.id;
  const runtime = panel.runtimes.get(id);
  let entered;
  let release;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const saving = runtime.updateConfiguration(
    { ...runtime.descriptor(), name: "Pending rename" },
    async () => {
      entered();
      await gate;
    },
  );
  try {
    await reached;
    const rejected = await panel.request(`/api/servers/${id}`, {
      method: "DELETE",
    });
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error, /current operation/);
    assert.equal(panel.runtimes.get(id), runtime);
    assert.equal((await panel.request("/api/server", {}, id)).status, 200);
  } finally {
    release();
    await saving;
  }
  assert.equal(
    (await panel.request(`/api/servers/${id}`, { method: "DELETE" })).status,
    200,
  );
  assert.equal(
    (await panel.request(`/api/servers/${id}`, { method: "DELETE" })).status,
    404,
  );
});
