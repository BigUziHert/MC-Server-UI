import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createPanel, createFleet } from "./index.mjs";
import { whitelistCommand, createPlayerHistory } from "./player-history.mjs";

const blue = {
  name: "Blue_Player",
  uuid: "12345678-1234-1234-1234-123456789abc",
};
const white = {
  name: "White_Player",
  uuid: "22345678-1234-1234-1234-123456789abc",
};
const operator = {
  name: "Operator_Player",
  uuid: "32345678-1234-1234-1234-123456789abc",
  level: 4,
};
const banned = {
  name: "Banned_Player",
  uuid: "42345678-1234-1234-1234-123456789abc",
  reason: "Fixture ban",
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });

async function fixture(t, mode = "live", fleet = false) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-whitelist-")),
  );
  const commands = [];
  let child;
  let panel;
  let listener;
  const settings = {
    dataDir: root,
    mode,
    scheduler: false,
    useEnvironment: false,
    telemetry: { reset() {}, sample: async () => ({ available: false }) },
    publicAddress: { resolve: async () => null },
    spawnServer: () => {
      child = new EventEmitter();
      child.pid = 12345;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.exitCode = 0;
        child.emit("close", 0);
      };
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          commands.push(chunk.toString());
          if (chunk.toString() === "stop\n") setImmediate(child.kill);
          done();
        },
      });
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (1.0s)! For help, type "help"\n',
        ),
      );
      return child;
    },
  };
  const open = async () => {
    panel = await (fleet ? createFleet(settings) : createPanel(settings));
    listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
  };
  const close = async () => {
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  };
  await open();
  t.after(async () => {
    await close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-whitelist-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    commands,
    get serverDir() {
      return panel.serverDir;
    },
    output(line) {
      child.stdout.write(`${line}\n`);
    },
    async request(route, init = {}, id) {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...(id ? { "X-Server-Id": id } : {}),
          },
        },
      );
      return { status: response.status, body: await response.json() };
    },
    async restart() {
      await close();
      await open();
    },
    async start() {
      await fs.writeFile(
        path.join(panel.serverDir, "server.jar"),
        "never executed fixture JAR",
      );
      await fs.writeFile(path.join(panel.serverDir, "eula.txt"), "eula=true\n");
      assert.equal(
        (
          await this.request(
            "/api/server/power",
            json("POST", { action: "start" }),
          )
        ).status,
        200,
      );
      for (let attempt = 0; attempt < 30; attempt++) {
        if ((await this.request("/api/server")).body.status === "running")
          return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("Fixture server did not start");
    },
  };
}

test("whitelist command builder rejects malformed names, UUIDs, actions and boolean strings", () => {
  assert.equal(whitelistCommand("add", blue), "whitelist add Blue_Player");
  assert.equal(
    whitelistCommand("remove", blue),
    "whitelist remove Blue_Player",
  );
  assert.equal(whitelistCommand("state", { enabled: true }), "whitelist on");
  assert.equal(whitelistCommand("state", { enabled: false }), "whitelist off");
  for (const name of [
    "@a",
    "ab",
    "Player\nstop",
    "Player\rstop",
    "Player Other",
    "a".repeat(17),
  ])
    assert.throws(() => whitelistCommand("add", { name }), { status: 400 });
  for (const enabled of ["true", 1, null, undefined])
    assert.throws(() => whitelistCommand("state", { enabled }), {
      status: 400,
    });
  assert.throws(() => whitelistCommand("add", { ...blue, uuid: "invalid" }), {
    status: 400,
  });
  assert.throws(() => whitelistCommand("reload", {}), { status: 400 });
});

test("history merges operator/whitelist identities without fabricated visits or repeated dirty writes", async () => {
  let writes = 0;
  const history = createPlayerHistory({
    persist: async () => writes++,
    delayMs: 60000,
  });
  for (let round = 0; round < 3; round++) {
    history.seed([blue], "operator");
    history.seed([{ ...blue, name: "Older_Name" }], "whitelist");
    await history.flush();
  }
  const [entry] = history.snapshot(new Map(), [], true, {
    operators: [blue],
    whitelist: [blue],
  });
  assert.equal(entry.name, blue.name);
  assert.equal(entry.source, "operator");
  assert.equal(entry.firstSeen, null);
  assert.equal(entry.lastSeen, null);
  assert.equal(entry.operator, true);
  assert.equal(entry.whitelisted, true);
  assert.equal(writes, 1);
});

test("live rosters and whitelist toggle read authoritative files; requests never fake confirmation", async (t) => {
  const panel = await fixture(t);
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([blue]),
  );
  await fs.writeFile(
    path.join(panel.serverDir, "ops.json"),
    JSON.stringify([operator]),
  );
  await fs.writeFile(
    path.join(panel.serverDir, "banned-players.json"),
    JSON.stringify([banned]),
  );
  await fs.writeFile(
    path.join(panel.serverDir, "whitelist.json"),
    JSON.stringify([white]),
  );
  await fs.writeFile(
    path.join(panel.serverDir, "server.properties"),
    "# Keep this comment\nwhite-list=false\nserver-port=25565\n",
  );
  await panel.start();
  const originalProperties = await fs.readFile(
    path.join(panel.serverDir, "server.properties"),
    "utf8",
  );
  panel.output(
    `[User Authenticator #1/INFO]: UUID of player ${blue.name} is ${blue.uuid}`,
  );
  panel.output(`[Server thread/INFO]: ${blue.name} joined the game`);
  let data = (await panel.request("/api/players")).body;
  assert.equal(data.maxPlayers, 20);
  assert.deepEqual(
    data.online.map((player) => player.name),
    [blue.name],
  );
  assert.deepEqual(
    data.banned.map((player) => player.name),
    [banned.name],
  );
  assert.deepEqual(data.operators, [operator]);
  assert.equal(data.whitelist[0].uuid, white.uuid);
  assert.equal(data.whitelistEnabled, false);
  assert.equal(
    data.history.find((player) => player.uuid === white.uuid).firstSeen,
    null,
  );
  const add = await panel.request(
    "/api/players/whitelist/add",
    json("POST", blue),
  );
  assert.equal(add.status, 200);
  assert.equal(add.body.simulated, false);
  assert.match(add.body.message, /Requested whitelist add/);
  assert.equal(panel.commands.at(-1), "whitelist add Blue_Player\n");
  assert.equal((await panel.request("/api/players")).body.whitelist.length, 1);
  await fs.writeFile(
    path.join(panel.serverDir, "whitelist.json"),
    JSON.stringify([white, blue]),
  );
  data = (await panel.request("/api/players")).body;
  assert.equal(
    data.whitelist.find((player) => player.uuid === blue.uuid).online,
    true,
  );
  assert.equal(
    data.history.find((player) => player.uuid === blue.uuid).whitelisted,
    true,
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/state",
        json("POST", { enabled: true }),
      )
    ).status,
    200,
  );
  assert.equal(panel.commands.at(-1), "whitelist on\n");
  assert.equal(
    (await panel.request("/api/players")).body.whitelistEnabled,
    false,
  );
  assert.equal(
    await fs.readFile(path.join(panel.serverDir, "server.properties"), "utf8"),
    originalProperties,
  );
  await fs.writeFile(
    path.join(panel.serverDir, "server.properties"),
    originalProperties.replace("white-list=false", "white-list=true"),
  );
  assert.equal(
    (await panel.request("/api/players")).body.whitelistEnabled,
    true,
  );
  assert.equal(
    (await panel.request("/api/players/whitelist/remove", json("POST", blue)))
      .status,
    200,
  );
  assert.equal(panel.commands.at(-1), "whitelist remove Blue_Player\n");
  assert.equal((await panel.request("/api/players")).body.whitelist.length, 2);
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/add",
        json("POST", { name: "First_Timer" }),
      )
    ).status,
    200,
  );
  assert.equal(panel.commands.at(-1), "whitelist add First_Timer\n");
});

test("live whitelist rejects stale UUIDs and malformed lists/settings without hiding other roster data", async (t) => {
  const panel = await fixture(t);
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/add",
        json("POST", { name: "First_Timer" }),
      )
    ).status,
    409,
  );
  await panel.start();
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([blue]),
  );
  await fs.writeFile(
    path.join(panel.serverDir, "whitelist.json"),
    JSON.stringify([blue]),
  );
  await panel.request("/api/players");
  for (const body of [{ name: "Blue_Player\nstop" }, { ...blue, uuid: "bad" }])
    assert.equal(
      (await panel.request("/api/players/whitelist/add", json("POST", body)))
        .status,
      400,
    );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/state",
        json("POST", { enabled: "true" }),
      )
    ).status,
    400,
  );
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([{ ...blue, uuid: white.uuid }]),
  );
  for (const action of ["add", "remove"])
    assert.equal(
      (
        await panel.request(
          `/api/players/whitelist/${action}`,
          json("POST", blue),
        )
      ).status,
      409,
    );
  assert.equal(
    (await panel.request("/api/players/whitelist/remove", json("POST", white)))
      .status,
    409,
  );
  assert.deepEqual(panel.commands, []);
  await fs.writeFile(path.join(panel.serverDir, "whitelist.json"), "[broken");
  let data = (await panel.request("/api/players")).body;
  assert.equal(data.whitelistAvailable, false);
  assert.ok(data.history.length > 0);
  assert.ok(data.history.every((player) => player.whitelisted === null));
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/add",
        json("POST", { name: "First_Timer" }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/state",
        json("POST", { enabled: true }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/state",
        json("POST", { enabled: false }),
      )
    ).status,
    200,
  );
  await fs.writeFile(
    path.join(panel.serverDir, "server.properties"),
    "white-list=maybe\n",
  );
  data = (await panel.request("/api/players")).body;
  assert.equal(data.whitelistEnabled, null);
  assert.equal(data.whitelistSettingsAvailable, false);
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/state",
        json("POST", { enabled: false }),
      )
    ).status,
    409,
  );
});

test("demo whitelist and operator UUID changes persist separately from Minecraft files", async (t) => {
  const panel = await fixture(t, "demo");
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([blue]),
  );
  const before = await Promise.all(
    ["whitelist.json", "ops.json", "server.properties"].map((name) =>
      fs.readFile(path.join(panel.serverDir, name), "utf8"),
    ),
  );
  assert.equal(
    (await panel.request("/api/players/whitelist/add", json("POST", blue)))
      .status,
    200,
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/add",
        json("POST", { name: "First_Timer" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/state",
        json("POST", { enabled: true }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await panel.request("/api/players/op", json("POST", blue))).status,
    200,
  );
  await panel.restart();
  const data = (await panel.request("/api/players")).body;
  assert.equal(data.whitelistEnabled, true);
  assert.equal(data.whitelist.length, 2);
  assert.equal(
    data.whitelist.find((player) => player.name === blue.name).uuid,
    blue.uuid,
  );
  assert.equal(data.operators[0].uuid, blue.uuid);
  assert.equal(
    (await panel.request("/api/players/deop", json("POST", blue))).status,
    200,
  );
  assert.equal(
    (await panel.request("/api/players/whitelist/remove", json("POST", blue)))
      .status,
    200,
  );
  assert.deepEqual(
    await Promise.all(
      ["whitelist.json", "ops.json", "server.properties"].map((name) =>
        fs.readFile(path.join(panel.serverDir, name), "utf8"),
      ),
    ),
    before,
  );
});

test("deop UUID validation uses the current authoritative operator list", async (t) => {
  const panel = await fixture(t);
  await panel.start();
  await fs.writeFile(
    path.join(panel.serverDir, "ops.json"),
    JSON.stringify([{ ...blue, level: 4 }]),
  );
  assert.equal(
    (await panel.request("/api/players/deop", json("POST", blue))).status,
    200,
  );
  assert.equal(panel.commands.at(-1), "deop Blue_Player\n");
  await fs.writeFile(path.join(panel.serverDir, "ops.json"), "[]\n");
  assert.equal(
    (await panel.request("/api/players/deop", json("POST", blue))).status,
    409,
  );
  assert.equal(panel.commands.length, 1);
});

test("online roster does not duplicate a reused name whose live UUID is not yet known", async (t) => {
  const panel = await fixture(t);
  await panel.start();
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([blue]),
  );
  await panel.request("/api/players");
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([{ ...blue, uuid: white.uuid }]),
  );
  await panel.request("/api/players");
  panel.output(`[Server thread/INFO]: ${blue.name} joined the game`);
  const data = (await panel.request("/api/players")).body;
  assert.equal(data.history.length, 2);
  assert.equal(data.online.length, 1);
  assert.equal(data.online[0].name, blue.name);
  assert.equal(data.online[0].uuid, undefined);
});

test("whitelist reads reject junctions and valid actions respect the backup mutation lock", async (t) => {
  const panel = await fixture(t);
  await panel.start();
  const outside = path.join(panel.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "proof"), "untouched");
  await fs.symlink(
    outside,
    path.join(panel.serverDir, "whitelist.json"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    (await panel.request("/api/players")).body.whitelistAvailable,
    false,
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/add",
        json("POST", { name: "First_Timer" }),
      )
    ).status,
    409,
  );
  assert.equal(
    await fs.readFile(path.join(outside, "proof"), "utf8"),
    "untouched",
  );
  await fs.unlink(path.join(panel.serverDir, "whitelist.json"));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  const original = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (from.endsWith(".tar.gz.tmp")) {
      entered();
      await gate;
    }
    return original(from, to);
  });
  // The fixture acknowledges only this exact server save request.
  const flushing = setInterval(() => {
    if (panel.commands.includes("save-all flush\n")) {
      panel.output("[Server thread/INFO]: Saved the game");
      clearInterval(flushing);
    }
  }, 5);
  const backup = panel.request(
    "/api/backups",
    json("POST", { name: "Blocked whitelist fixture" }),
  );
  try {
    await Promise.race([
      enteredGate,
      backup.then((result) =>
        assert.fail(`Backup completed before gate: ${JSON.stringify(result)}`),
      ),
    ]);
    assert.equal(
      (
        await panel.request(
          "/api/players/whitelist/add",
          json("POST", { name: "First_Timer" }),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await panel.request(
          "/api/players/whitelist/state",
          json("POST", { enabled: true }),
        )
      ).status,
      409,
    );
    assert.ok(
      panel.commands.every((command) => !command.startsWith("whitelist ")),
    );
  } finally {
    clearInterval(flushing);
    release();
    await backup;
  }
});

test("whitelist settings and records stay selected-server scoped across a fleet restart", async (t) => {
  const panel = await fixture(t, "demo", true);
  const first = (await panel.request("/api/servers")).body.defaultServerId;
  const added = await panel.request(
    "/api/servers",
    json("POST", { name: "Other world", mode: "demo", port: 25566 }),
  );
  assert.equal(added.status, 201);
  const second = added.body.server.id;
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/add",
        json("POST", { name: "First_Timer" }),
        first,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/state",
        json("POST", { enabled: true }),
        first,
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await panel.request("/api/players", {}, second)).body.whitelist,
    [],
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/whitelist/remove",
        json("POST", { name: "First_Timer" }),
        second,
      )
    ).status,
    409,
  );
  await panel.restart();
  assert.equal(
    (await panel.request("/api/players", {}, first)).body.whitelistEnabled,
    true,
  );
  assert.equal(
    (await panel.request("/api/players", {}, second)).body.whitelistEnabled,
    false,
  );
  assert.equal(
    (await panel.request("/api/players", {}, first)).body.whitelist[0].name,
    "First_Timer",
  );
});
