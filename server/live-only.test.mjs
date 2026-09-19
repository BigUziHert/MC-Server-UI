import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createFleet,
  createPanel,
  validateServerConfiguration,
} from "./index.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const publicAddress = { resolve: async () => null };

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-live-only-"));
  const running = [];
  const boot = async (factory = createPanel, options = {}) => {
    const panel = await factory({
      dataDir,
      scheduler: false,
      useEnvironment: false,
      publicAddress,
      ...options,
    });
    const listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
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
      return { status: response.status, body: await response.json() };
    };
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await panel.close();
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    };
    running.push(close);
    return { ...panel, request, close };
  };
  t.after(async () => {
    for (const close of running) await close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("mc-live-only-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, boot };
}

test("runtime defaults to an offline live server without fabricated files, logs, metrics, or players", async (t) => {
  const { dataDir, boot } = await fixture(t);
  const panel = await boot();
  const { body: server } = await panel.request("/api/server");
  assert.equal(server.mode, "live");
  assert.equal(server.status, "offline");
  assert.equal(server.software, "Java");
  assert.equal(server.version, "Configured JAR");
  assert.equal(server.cpu, 0);
  assert.equal(server.memory, 0);
  assert.equal(server.uptime, 0);
  assert.equal(server.processCount, 0);
  assert.deepEqual(server.players, []);
  assert.deepEqual(await fs.readdir(panel.serverDir), []);
  await assert.rejects(fs.stat(path.join(dataDir, ".seeded")), {
    code: "ENOENT",
  });
  const { body: console } = await panel.request("/api/console");
  assert.equal(console.lines.length, 1);
  assert.match(console.lines[0].message, /startup files and EULA/);
  assert.doesNotMatch(JSON.stringify(console), /demo|simulat|Done \(/i);
  const command = await panel.request(
    "/api/console/command",
    json("POST", { command: "list" }),
  );
  assert.equal(command.status, 409);
  const start = await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
  );
  assert.equal(start.status, 400);
  assert.match(start.body.error, /JAR does not exist/);
  assert.equal((await panel.request("/api/server")).body.status, "offline");
});

test("configuration entry points reject demo rather than accepting or silently converting new requests", async (t) => {
  const { dataDir, boot } = await fixture(t);
  assert.equal(validateServerConfiguration({}).mode, "live");
  assert.throws(
    () => validateServerConfiguration({ mode: "demo" }),
    /Only live/,
  );
  for (const factory of [createPanel, createFleet])
    await assert.rejects(
      factory({ dataDir, mode: "demo", useEnvironment: false }),
      /Only live/,
    );
  const fleet = await boot(createFleet, { createDefaultServer: false });
  const invalid = await fleet.request(
    "/api/servers",
    json("POST", { name: "Rejected", mode: "demo" }),
  );
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Only live/);
  assert.deepEqual((await fleet.request("/api/servers")).body.servers, []);
  const created = await fleet.request(
    "/api/servers",
    json("POST", { name: "Real server" }),
  );
  assert.equal(created.status, 201);
  const server = created.body.server;
  assert.equal(server.mode, "live");
  assert.equal(server.status, "offline");
  const rejectedUpdate = await fleet.request(
    `/api/servers/${server.id}`,
    json("PATCH", { mode: "demo" }),
  );
  assert.equal(rejectedUpdate.status, 400);
  assert.equal(
    (await fleet.request("/api/server", {}, server.id)).body.mode,
    "live",
  );
  const eula = await fs.readFile(
    path.join(dataDir, "instances", server.id, "server", "eula.txt"),
    "utf8",
  );
  assert.match(eula, /eula=false/);
});

test("saved demo registries migrate once to live/offline while retaining files, backups, selection, and real metadata", async (t) => {
  const { dataDir, boot } = await fixture(t);
  const id = randomUUID();
  const actualId = randomUUID();
  const player = { name: "Real_Player", uuid: randomUUID(), level: 3 };
  const serverDir = path.join(dataDir, "server");
  await fs.mkdir(serverDir);
  await fs.mkdir(path.join(dataDir, "backups"));
  const originalFiles = {
    "eula.txt": "# Preserve my decision\neula=false\n",
    "world.dat": "existing world bytes",
    "server.properties": "server-port=25565\nwhite-list=false\n",
    "ops.json": JSON.stringify([player]),
    "whitelist.json": "[]",
  };
  for (const [filename, contents] of Object.entries(originalFiles))
    await fs.writeFile(path.join(serverDir, filename), contents);
  await fs.writeFile(
    path.join(dataDir, "backups", "kept.tar.gz"),
    "backup bytes",
  );
  await fs.writeFile(
    path.join(dataDir, "panel.json"),
    JSON.stringify({
      backups: [{ id: "kept", name: "Existing backup", size: 12 }],
      demoOperators: [{ name: "Fake_Player", level: 4 }],
      demoWhitelist: [{ name: "Fake_Whitelist" }],
      demoWhitelistEnabled: true,
      demoPlayerBans: [{ name: "Fake_Ban", banned: true }],
    }),
  );
  await fs.writeFile(
    path.join(dataDir, "servers.json"),
    JSON.stringify({
      version: 1,
      defaultServerId: id,
      servers: [
        {
          id,
          name: "Kept server",
          mode: "demo",
          status: "running",
          port: 25565,
          storage: "legacy",
          serverDir,
          version: "1.21.4",
          software: "Paper",
        },
        {
          id: actualId,
          name: "Installed server",
          mode: "demo",
          port: 25566,
          storage: "instance",
          software: "Fabric",
          version: "0.16.10",
          minecraftVersion: "1.21.5",
        },
      ],
    }),
  );
  const fleet = await boot(createFleet);
  const { body: servers } = await fleet.request("/api/servers");
  assert.equal(servers.defaultServerId, id);
  assert.deepEqual(
    servers.servers.map((entry) => [entry.id, entry.mode, entry.status]),
    [
      [id, "live", "offline"],
      [actualId, "live", "offline"],
    ],
  );
  assert.equal(servers.servers[0].software, "Java");
  assert.equal(servers.servers[0].version, "Configured JAR");
  assert.equal(servers.servers[1].software, "Fabric");
  assert.equal(servers.servers[1].version, "0.16.10");
  const players = (await fleet.request("/api/players", {}, id)).body;
  assert.deepEqual(players.operators, [player]);
  assert.deepEqual(players.whitelist, []);
  assert.deepEqual(players.banned, []);
  assert.equal(players.whitelistEnabled, false);
  const saved = JSON.parse(
    await fs.readFile(path.join(dataDir, "servers.json"), "utf8"),
  );
  assert.equal(saved.defaultServerId, id);
  assert.equal(saved.servers[0].mode, "live");
  assert.equal(saved.servers[0].status, "offline");
  assert.equal(saved.servers[0].serverDir, serverDir);
  assert.equal(saved.servers[1].minecraftVersion, "1.21.5");
  for (const [filename, contents] of Object.entries(originalFiles))
    assert.equal(
      await fs.readFile(path.join(serverDir, filename), "utf8"),
      contents,
    );
  assert.equal(
    await fs.readFile(path.join(dataDir, "backups", "kept.tar.gz"), "utf8"),
    "backup bytes",
  );
  assert.equal(
    (await fleet.request("/api/backups", {}, id)).body.backups[0].id,
    "kept",
  );
  const missingJar = await fleet.request(
    "/api/server/power",
    json("POST", { action: "start" }),
    id,
  );
  assert.equal(missingJar.status, 400);
  assert.match(missingJar.body.error, /JAR does not exist/);
  await fleet.close();
  const reopened = await boot(createFleet);
  assert.equal(
    (await reopened.request("/api/server", {}, id)).body.status,
    "offline",
  );
  assert.equal(
    await fs.readFile(path.join(serverDir, "eula.txt"), "utf8"),
    originalFiles["eula.txt"],
  );
});

test("legacy seeded directories open offline without altering their files or accepting the EULA", async (t) => {
  const { dataDir, boot } = await fixture(t);
  await fs.mkdir(path.join(dataDir, "server"));
  await fs.writeFile(path.join(dataDir, ".seeded"), "Demo data initialized.\n");
  await fs.writeFile(
    path.join(dataDir, "server", "server.properties"),
    "motd=My existing world\nserver-port=25570\n",
  );
  await fs.writeFile(path.join(dataDir, "server", "eula.txt"), "eula=false\n");
  const fleet = await boot(createFleet, { createDefaultServer: false });
  const { body } = await fleet.request("/api/servers");
  assert.equal(body.servers.length, 1);
  assert.equal(body.servers[0].mode, "live");
  assert.equal(body.servers[0].status, "offline");
  assert.equal(body.servers[0].port, 25570);
  assert.equal(body.servers[0].motd, "My existing world");
  assert.equal(body.servers[0].software, "Java");
  assert.equal(
    await fs.readFile(path.join(dataDir, "server", "eula.txt"), "utf8"),
    "eula=false\n",
  );
  assert.deepEqual((await fs.readdir(path.join(dataDir, "server"))).sort(), [
    "eula.txt",
    "server.properties",
  ]);
});

test("startup, commands, readiness, and telemetry use the owned process and still require EULA acceptance", async (t) => {
  const { dataDir, boot } = await fixture(t);
  const serverDir = path.join(dataDir, "server");
  await fs.mkdir(serverDir);
  // A test subprocess uses the normal executable launch path. Production has
  // no alternate startup or command implementation for fixtures.
  await fs.writeFile(
    path.join(serverDir, "process.mjs"),
    `
    import { createInterface } from "node:readline";
    console.log('[Server thread/INFO]: Done (0.01s)! For help, type "help"');
    createInterface({ input: process.stdin }).on("line", (command) => {
      if (command === "stop") process.exit(0);
      console.log("received:" + command);
    });
  `,
  );
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=false\n");
  const children = [];
  const sampled = [];
  const panel = await boot(createPanel, {
    launchType: "executable",
    launchExecutable: process.execPath,
    launchArgs: ["process.mjs"],
    spawnServer: (...args) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    },
    telemetry: {
      reset() {},
      sample: async (pid) => {
        sampled.push(pid);
        return { available: true, cpu: 4.25, memory: 123456, processCount: 1 };
      },
    },
  });
  const start = () =>
    panel.request("/api/server/power", json("POST", { action: "start" }));
  const rejected = await start();
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /EULA/);
  assert.equal(children.length, 0);
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  assert.equal((await start()).status, 200);
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("The owned fixture process did not report the expected state.");
  };
  await waitFor(
    async () => (await panel.request("/api/server")).body.status === "running",
  );
  assert.equal(children.length, 1);
  assert.ok(Number.isInteger(children[0].pid));
  const metrics = (await panel.request("/api/server")).body;
  assert.equal(metrics.cpu, 4.25);
  assert.equal(metrics.memory, 123456);
  assert.ok(sampled.length > 0);
  assert.ok(sampled.every((pid) => pid === children[0].pid));
  assert.equal(
    (
      await panel.request(
        "/api/console/command",
        json("POST", { command: "say process-probe" }),
      )
    ).status,
    200,
  );
  await waitFor(async () =>
    (await panel.request("/api/console")).body.lines.some(
      (line) => line.message === "received:say process-probe",
    ),
  );
  const op = await panel.request(
    "/api/players/op",
    json("POST", { name: "Real_Player" }),
  );
  assert.equal(op.status, 200);
  assert.equal(Object.hasOwn(op.body, "simulated"), false);
  assert.match(op.body.message, /Requested op Real_Player/);
  assert.deepEqual((await panel.request("/api/players")).body.operators, []);
  assert.equal(
    (await panel.request("/api/server/power", json("POST", { action: "stop" })))
      .status,
    200,
  );
  await waitFor(
    async () => (await panel.request("/api/server")).body.status === "offline",
  );
  assert.equal((await panel.request("/api/server")).body.memory, 0);
});
