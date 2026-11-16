import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createPanel } from "./index.mjs";
import {
  createPlayerHistory,
  moderationCommand,
  playerCommandAudit,
} from "./player-history.mjs";

const uuid = "12345678-1234-1234-1234-123456789abc";
const profile = { name: "History_Player", uuid };
const json = (method, body) => ({ method, body: JSON.stringify(body) });

test("moderation audit labels describe commands sent to Minecraft", () => {
  for (const [command, action] of [
    ["op Builder", "Player op requested"],
    ["deop Builder", "Player deop requested"],
    ["ban Builder griefing", "Player ban requested"],
    ["pardon Builder", "Player unban requested"],
    ["kick Builder reconnect", "Player kick requested"],
    ["whitelist add Builder", "Whitelist addition requested"],
    ["whitelist remove Builder", "Whitelist removal requested"],
    ["whitelist on", "Whitelist enable requested"],
    ["whitelist off", "Whitelist disable requested"],
    ["minecraft:op Builder", "Player op requested"],
  ]) {
    const event = playerCommandAudit(command);
    assert.equal(event.action, action);
    assert.match(event.detail, /Sent to Minecraft:/);
  }

  assert.equal(playerCommandAudit("say op Builder"), null);
  assert.equal(playerCommandAudit("whitelist list"), null);
  for (const command of [
    "constructor",
    "toString",
    "__proto__",
    "whitelist constructor",
  ])
    assert.equal(playerCommandAudit(command), null);
});

test("cached profiles never invent login dates; observations persist once and repeated polls stay clean", async () => {
  const snapshots = [];
  let now = "2026-09-12T10:00:00.000Z";
  const history = createPlayerHistory({
    persist: async (records) => snapshots.push(records),
    now: () => now,
    delayMs: 60000,
  });
  history.seed([{ ...profile, expiresOn: "2099-01-01T00:00:00Z" }], "cache");
  let entry = history.snapshot(new Map(), [])[0];
  assert.equal(entry.firstSeen, null);
  assert.equal(entry.lastSeen, null);
  await history.flush();
  for (let n = 0; n < 4; n++) {
    history.seed([profile], "cache");
    history.snapshot(new Map(), []);
  }
  await history.flush();
  assert.equal(snapshots.length, 1);
  history.observe(profile);
  now = "2026-09-12T11:00:00.000Z";
  history.observe(profile);
  await history.flush();
  assert.equal(snapshots.length, 2);
  const restored = createPlayerHistory({
    records: snapshots.at(-1),
    persist: async () => {},
  });
  entry = restored.snapshot(new Map(), [])[0];
  assert.equal(entry.firstSeen, "2026-09-12T10:00:00.000Z");
  assert.equal(entry.lastSeen, now);
  assert.equal(entry.online, false);
  assert.equal(entry.source, "observed");
});

test("UUID identity merges renamed profiles without a stale ban restoring their old name", async () => {
  const history = createPlayerHistory({
    persist: async () => {},
    delayMs: 60000,
  });
  history.observe(profile);
  history.observe({ ...profile, name: "New_Name" });
  history.seed([profile], "cache");
  history.seed([profile], "banned");
  const entries = history.snapshot(new Map(), [profile]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "New_Name");
  assert.equal(entries[0].banned, true);
  await history.flush();
});

test("large profile and ban lists merge through indexes without repeated persistence", async () => {
  let writes = 0;
  const history = createPlayerHistory({
    persist: async () => {
      writes++;
    },
    delayMs: 60000,
  });
  const profiles = Array.from({ length: 50000 }, (_, index) => ({
    name: `Player_${index}`,
    uuid: `12345678-1234-1234-1234-${index.toString(16).padStart(12, "0")}`,
  }));
  history.seed(profiles, "cache");
  await history.flush();
  history.seed(profiles, "cache");
  history.seed(profiles, "banned");
  const snapshot = history.snapshot(new Map(), profiles);
  await history.flush();
  assert.equal(snapshot.length, profiles.length);
  assert.equal(
    snapshot.filter((entry) => entry.banned).length,
    profiles.length,
  );
  assert.equal(writes, 1);
});

test("moderation validates Java names, UUIDs and single-line reasons before generating commands", () => {
  assert.equal(
    moderationCommand("kick", { ...profile, reason: "Please stop griefing" }),
    "kick History_Player Please stop griefing",
  );
  assert.equal(moderationCommand("unban", profile), "pardon History_Player");
  for (const reason of [
    "test\nstop",
    "test\rban Someone",
    "\0",
    "\t",
    "\u2028stop",
    "a".repeat(201),
    {},
  ])
    assert.throws(() => moderationCommand("ban", { ...profile, reason }), {
      status: 400,
    });
  for (const name of [
    "@a",
    "AB",
    "Player\nstop",
    "Player one",
    "<player>",
    "a".repeat(17),
  ])
    assert.throws(() => moderationCommand("kick", { name }), { status: 400 });
  assert.throws(() => moderationCommand("ban", { ...profile, uuid: "bad" }), {
    status: 400,
  });
});

async function fixture(t, mode = "live", { varyPathCase = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-player-history-"));
  const commands = [];
  let child;
  const options = {
    dataDir: root,
    // Windows TEMP may use a different spelling than fs.realpath returns.
    // Exercise the same distinction without depending on the runner's account.
    serverDir:
      varyPathCase && process.platform === "win32"
        ? path.join(root, "server").toUpperCase()
        : undefined,
    mode,
    useEnvironment: false,
    scheduler: false,
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
  let panel;
  let listener;
  const open = async () => {
    panel = await createPanel(options);
    await fs
      .writeFile(
        path.join(panel.serverDir, "server.properties"),
        "white-list=false\n",
        { flag: "wx" },
      )
      .catch((cause) => {
        if (cause.code !== "EEXIST") throw cause;
      });
    listener = await new Promise((resolve) => {
      const value = panel.app.listen(0, "127.0.0.1", () => resolve(value));
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
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-player-history-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    get serverDir() {
      return panel.serverDir;
    },
    commands,
    waitForExit() {
      return once(child, "close");
    },
    output(line) {
      child.stdout.write(line + "\n");
    },
    async restart() {
      await close();
      await open();
    },
    async request(route, options = {}) {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        { ...options, headers: { "Content-Type": "application/json" } },
      );
      return { status: response.status, body: await response.json() };
    },
    async start() {
      await fs.writeFile(
        path.join(panel.serverDir, "server.jar"),
        "synthetic JAR never executed",
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
      for (let i = 0; i < 20; i++) {
        if ((await this.request("/api/server")).body.status === "running")
          return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Synthetic server did not start");
    },
  };
}

test("offline ban edits and authoritative files persist across restart", async (t) => {
  const panel = await fixture(t);
  const cache = JSON.stringify([
    { ...profile, expiresOn: "2099-01-01 00:00:00 +0000" },
  ]);
  await fs.writeFile(path.join(panel.serverDir, "usercache.json"), cache);
  await fs.writeFile(path.join(panel.serverDir, "banned-players.json"), "[]\n");
  let data = (await panel.request("/api/players")).body;
  assert.equal(data.history[0].lastSeen, null);
  assert.equal(data.history[0].online, false);
  assert.equal(
    (
      await panel.request(
        "/api/players/ban",
        json("POST", { ...profile, reason: "Fixture reason" }),
      )
    ).status,
    200,
  );
  assert.deepEqual(panel.commands, []);
  await panel.restart();
  data = (await panel.request("/api/players")).body;
  assert.equal(data.history[0].banned, true);
  assert.equal(data.history[0].banReason, "Fixture reason");
  await panel.start();
  assert.equal(
    (await panel.request("/api/players/unban", json("POST", profile))).status,
    200,
  );
  assert.equal(panel.commands.at(-1), "pardon History_Player\n");
  assert.equal(
    (await panel.request("/api/players")).body.history[0].banned,
    true,
  );
  await fs.writeFile(path.join(panel.serverDir, "banned-players.json"), "[]\n");
  assert.equal(
    (await panel.request("/api/players")).body.history[0].banned,
    false,
  );
  assert.equal(
    await fs.readFile(path.join(panel.serverDir, "usercache.json"), "utf8"),
    cache,
  );
});

test("operator requests validate current UUIDs and wait for authoritative files", async (t) => {
  const panel = await fixture(t);
  await panel.start();
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([profile]),
  );
  await fs.writeFile(path.join(panel.serverDir, "ops.json"), "[]\n");
  assert.equal(
    (
      await panel.request(
        "/api/players/op",
        json("POST", { ...profile, uuid: "bad" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await panel.request(
        "/api/players/op",
        json("POST", {
          ...profile,
          uuid: "22345678-1234-1234-1234-123456789abc",
        }),
      )
    ).status,
    409,
  );
  const grant = await panel.request("/api/players/op", json("POST", profile));
  assert.equal(grant.status, 200);
  assert.equal(panel.commands.at(-1), "op History_Player\n");
  assert.deepEqual((await panel.request("/api/players")).body.operators, []);
  assert.equal(
    await fs.readFile(path.join(panel.serverDir, "ops.json"), "utf8"),
    "[]\n",
  );
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([
      { ...profile, uuid: "32345678-1234-1234-1234-123456789abc" },
    ]),
  );
  assert.equal(
    (await panel.request("/api/players/op", json("POST", profile))).status,
    409,
    "a reassigned username cannot grant permissions to a stale row identity",
  );
});

test("live logger history ignores chat, supports Forge prefixes, and live moderation waits for authoritative files", async (t) => {
  const panel = await fixture(t, "live");
  await panel.start();
  panel.output(
    `[User Authenticator #1/INFO]: UUID of player ${profile.name} is ${uuid}`,
  );
  panel.output(
    `[Server thread/INFO] [minecraft/MinecraftServer]: ${profile.name} joined the game`,
  );
  panel.output("[Server thread/INFO]: <Attacker> Fake_Player joined the game");
  panel.output("[Server thread/INFO]: [Server] Fake_Player joined the game");
  let data = (await panel.request("/api/players")).body;
  assert.equal(data.history.length, 1);
  assert.equal(data.history[0].online, true);
  assert.equal(data.history[0].uuid, uuid);
  assert.ok(data.history[0].lastSeen);
  assert.equal(
    (
      await panel.request(
        "/api/players/kick",
        json("POST", { ...profile, reason: "Test kick" }),
      )
    ).status,
    200,
  );
  assert.equal(panel.commands.at(-1), "kick History_Player Test kick\n");
  assert.equal(
    (await panel.request("/api/players")).body.history[0].online,
    true,
    "command request does not fake a disconnect",
  );
  panel.output(`[Server thread/INFO]: ${profile.name} left the game`);
  assert.equal(
    (await panel.request("/api/players/kick", json("POST", profile))).status,
    409,
  );
  const ban = await panel.request(
    "/api/players/ban",
    json("POST", { ...profile, reason: "Test ban" }),
  );
  assert.equal(ban.status, 200);
  assert.equal(panel.commands.at(-1), "ban History_Player Test ban\n");
  assert.equal(
    (await panel.request("/api/players")).body.history[0].banned,
    false,
  );
  await fs.writeFile(
    path.join(panel.serverDir, "banned-players.json"),
    JSON.stringify([{ ...profile, reason: "Test ban" }]),
  );
  assert.equal(
    (await panel.request("/api/players")).body.history[0].banned,
    true,
  );
  assert.equal(
    (await panel.request("/api/players/unban", json("POST", profile))).status,
    200,
  );
  assert.equal(panel.commands.at(-1), "pardon History_Player\n");
  assert.equal(
    (
      await panel.request(
        "/api/console/command",
        json("POST", { command: `op ${profile.name}` }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await panel.request(
        "/api/console/command",
        json("POST", { command: `whitelist add ${profile.name}` }),
      )
    ).status,
    200,
  );
  const audit = (await panel.request("/api/audit")).body.entries;
  const playerActions = audit
    .filter((entry) => entry.category === "player")
    .map((entry) => entry.action);
  assert.deepEqual(playerActions, [
    "Whitelist addition requested",
    "Player op requested",
    "Player unban requested",
    "Player ban requested",
    "Player kick requested",
  ]);
  assert.equal(
    audit.filter((entry) => entry.action === "Console command").length,
    0,
  );
  await panel.restart();
  data = (await panel.request("/api/players")).body;
  assert.equal(data.status, "offline");
  assert.equal(data.history[0].online, false);
  assert.ok(data.history[0].lastSeen);
  assert.equal(
    (await panel.request("/api/players/ban", json("POST", profile))).status,
    200,
  );
});

test("offline operator, whitelist and ban edits preserve other records and persist without commands", async (t) => {
  const panel = await fixture(t);
  const other = {
    name: "Other_Player",
    uuid: "22345678-1234-1234-1234-123456789abc",
  };
  const otherOperator = {
    ...other,
    level: 2,
    bypassesPlayerLimit: true,
    pluginMetadata: "keep",
  };
  const otherBan = {
    ...other,
    created: "2026-09-29 12:00:00 +0000",
    source: "Console",
    expires: "2027-01-01 12:00:00 +0000",
    reason: "Keep this ban",
  };
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([profile, other]),
  );
  await fs.writeFile(
    path.join(panel.serverDir, "ops.json"),
    JSON.stringify([otherOperator]),
  );
  await fs.writeFile(
    path.join(panel.serverDir, "banned-players.json"),
    JSON.stringify([otherBan]),
  );
  await fs.writeFile(
    path.join(panel.serverDir, "server.properties"),
    "# Preserve this comment\r\nwhite-list=false\r\nop-permission-level=3\r\nmotd=Keep this value\r\n",
  );
  for (const [route, body] of [
    ["op", { name: profile.name }],
    ["whitelist/add", profile],
    ["whitelist/state", { enabled: true }],
    ["ban", { ...profile, reason: "Offline moderation" }],
  ]) {
    const response = await panel.request(
      `/api/players/${route}`,
      json("POST", body),
    );
    assert.equal(response.status, 200, response.body.error);
    assert.equal(response.body.saved, true);
    assert.match(response.body.message, /Saved .*server next starts/);
  }
  const read = async (filename) =>
    JSON.parse(await fs.readFile(path.join(panel.serverDir, filename), "utf8"));
  assert.deepEqual(await read("ops.json"), [
    otherOperator,
    { ...profile, level: 3, bypassesPlayerLimit: false },
  ]);
  const bans = await read("banned-players.json");
  assert.deepEqual(bans[0], otherBan);
  assert.equal(bans[1].reason, "Offline moderation");
  assert.equal(bans[1].expires, "forever");
  assert.match(bans[1].created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+0000$/);
  assert.deepEqual(await read("whitelist.json"), [profile]);
  assert.equal(
    await fs.readFile(path.join(panel.serverDir, "server.properties"), "utf8"),
    "# Preserve this comment\r\nwhite-list=true\r\nop-permission-level=3\r\nmotd=Keep this value\r\n",
  );
  assert.deepEqual(panel.commands, []);
  await panel.restart();
  const snapshot = (await panel.request("/api/players")).body;
  assert.equal(snapshot.whitelistEnabled, true);
  assert.equal(
    snapshot.operators.find((entry) => entry.uuid === uuid).level,
    3,
  );
  assert.equal(
    snapshot.history.find((entry) => entry.uuid === uuid).banned,
    true,
  );
  for (const route of ["deop", "whitelist/remove", "unban"])
    assert.equal(
      (await panel.request(`/api/players/${route}`, json("POST", profile)))
        .status,
      200,
    );
  assert.deepEqual(await read("ops.json"), [otherOperator]);
  assert.deepEqual(await read("banned-players.json"), [otherBan]);
  assert.deepEqual(await read("whitelist.json"), []);
  assert.equal(
    (await panel.request("/api/players/kick", json("POST", profile))).status,
    409,
  );
  assert.deepEqual(panel.commands, []);
  const events = (await panel.request("/api/audit")).body.entries.filter(
    (entry) => entry.category === "player",
  );
  assert.ok(events.some((entry) => entry.action === "Player op saved"));
});

test("offline access edits reject unknown identities and malformed files without changing them", async (t) => {
  const panel = await fixture(t);
  for (const route of ["op", "whitelist/add"]) {
    const response = await panel.request(
      `/api/players/${route}`,
      json("POST", { name: "Unknown_Player" }),
    );
    assert.equal(response.status, 409);
    assert.match(response.body.error, /no unique saved profile/);
  }
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([profile]),
  );
  for (const [route, filename] of [
    ["op", "ops.json"],
    ["ban", "banned-players.json"],
    ["whitelist/add", "whitelist.json"],
  ]) {
    await fs.writeFile(path.join(panel.serverDir, filename), "invalid");
    assert.equal(
      (await panel.request(`/api/players/${route}`, json("POST", profile)))
        .status,
      409,
    );
    assert.equal(
      await fs.readFile(path.join(panel.serverDir, filename), "utf8"),
      "invalid",
    );
    await fs.writeFile(path.join(panel.serverDir, filename), "[]\n");
  }
  assert.deepEqual(panel.commands, []);
});

test("offline roster writes exclude server starts and concurrent changes until atomic publish", async (t) => {
  const panel = await fixture(t);
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([profile]),
  );
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  const original = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (path.basename(from).startsWith(".panel-players-")) {
      entered();
      await gate;
    }
    return original(from, to);
  });
  const mutation = panel.request("/api/players/op", json("POST", profile));
  try {
    await Promise.race([
      enteredGate,
      mutation.then((response) => assert.fail(JSON.stringify(response))),
    ]);
    for (const [route, body] of [
      ["/api/server/power", { action: "start" }],
      ["/api/players/ban", profile],
      ["/api/files", { name: "ops.json", type: "file", content: "[]" }],
    ])
      assert.equal(
        (await panel.request(route, json("POST", body))).status,
        409,
      );
    assert.equal((await panel.request("/api/players")).body.status, "offline");
  } finally {
    release();
    assert.equal((await mutation).status, 200);
  }
  assert.equal(
    (await panel.request("/api/players/ban", json("POST", profile))).status,
    200,
  );
  assert.deepEqual(panel.commands, []);
});

test("a live moderation request never switches to offline file writes after the process stops", async (t) => {
  const panel = await fixture(t, "live", { varyPathCase: true });
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([profile]),
  );
  await fs.writeFile(path.join(panel.serverDir, "banned-players.json"), "[]\n");
  await panel.start();
  const cachePath = path.join(
    await fs.realpath(panel.serverDir),
    "usercache.json",
  );
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  const original = fs.readFile;
  t.mock.method(fs, "readFile", async (filename, ...args) => {
    if (filename === cachePath) {
      entered();
      await gate;
    }
    return original(filename, ...args);
  });
  const mutation = panel.request("/api/players/ban", json("POST", profile));
  let response;
  try {
    await Promise.race([
      enteredGate,
      mutation.then((response) => assert.fail(JSON.stringify(response))),
    ]);
    const exited = panel.waitForExit();
    assert.equal(
      (
        await panel.request(
          "/api/server/power",
          json("POST", { action: "stop" }),
        )
      ).status,
      200,
    );
    await exited;
    assert.equal((await panel.request("/api/server")).body.status, "offline");
  } finally {
    release();
    // Drain the request on failure too, without replacing a failed gate/setup
    // assertion with a secondary status assertion.
    response = await mutation;
  }
  assert.equal(response.status, 409);
  assert.equal(
    await fs.readFile(
      path.join(panel.serverDir, "banned-players.json"),
      "utf8",
    ),
    "[]\n",
  );
  assert.deepEqual(panel.commands, ["stop\n"]);
});

test("malformed files preserve known history, disable bans, and reject stale UUIDs and command injection", async (t) => {
  const panel = await fixture(t);
  await fs.writeFile(
    path.join(panel.serverDir, "usercache.json"),
    JSON.stringify([profile]),
  );
  await panel.request("/api/players");
  for (const input of [
    { ...profile, name: "Name\nstop" },
    { ...profile, reason: "why\nstop" },
    { ...profile, uuid: "bad" },
  ])
    assert.equal(
      (await panel.request("/api/players/ban", json("POST", input))).status,
      400,
    );
  assert.equal(
    (
      await panel.request(
        "/api/players/ban",
        json("POST", {
          ...profile,
          uuid: "22345678-1234-1234-1234-123456789abc",
        }),
      )
    ).status,
    409,
  );
  await fs.writeFile(path.join(panel.serverDir, "usercache.json"), "invalid");
  await fs.writeFile(
    path.join(panel.serverDir, "banned-players.json"),
    "invalid",
  );
  const data = (await panel.request("/api/players")).body;
  assert.equal(data.history.length, 1);
  assert.equal(data.history[0].banned, null);
  assert.equal(data.warnings.length, 2);
  assert.equal(data.bansAvailable, false);
  assert.equal(
    (await panel.request("/api/players/ban", json("POST", profile))).status,
    409,
  );
});
