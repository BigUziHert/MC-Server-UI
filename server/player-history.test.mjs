import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createPanel } from "./index.mjs";
import { createPlayerHistory, moderationCommand } from "./player-history.mjs";

const uuid = "12345678-1234-1234-1234-123456789abc";
const profile = { name: "History_Player", uuid };
const json = (method, body) => ({ method, body: JSON.stringify(body) });

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

async function fixture(t, mode = "demo") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-player-history-"));
  const commands = [];
  let child;
  const options = {
    dataDir: root,
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

test("demo cache history and ban overrides persist across restart without touching Minecraft files", async (t) => {
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
    (await panel.request("/api/players/kick", json("POST", profile))).status,
    409,
  );
  const banned = await panel.request(
    "/api/players/ban",
    json("POST", { ...profile, reason: "Fixture reason" }),
  );
  assert.equal(banned.status, 200);
  assert.equal(banned.body.simulated, true);
  await panel.restart();
  data = (await panel.request("/api/players")).body;
  assert.equal(data.history[0].banned, true);
  assert.equal(data.history[0].banReason, "Fixture reason");
  assert.equal(
    (await panel.request("/api/players/unban", json("POST", profile))).status,
    200,
  );
  assert.equal(
    (await panel.request("/api/players")).body.history[0].banned,
    false,
  );
  assert.equal(
    await fs.readFile(
      path.join(panel.serverDir, "banned-players.json"),
      "utf8",
    ),
    "[]\n",
  );
  assert.equal(
    await fs.readFile(path.join(panel.serverDir, "usercache.json"), "utf8"),
    cache,
  );
});

test("operator requests from a known-player row validate its UUID and remain isolated demo changes", async (t) => {
  const panel = await fixture(t);
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
  assert.equal(grant.body.simulated, true);
  assert.equal(
    (await panel.request("/api/players")).body.operators[0].name,
    profile.name,
  );
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
  assert.equal(ban.body.simulated, false);
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
  await panel.restart();
  data = (await panel.request("/api/players")).body;
  assert.equal(data.status, "offline");
  assert.equal(data.history[0].online, false);
  assert.ok(data.history[0].lastSeen);
  assert.equal(
    (await panel.request("/api/players/ban", json("POST", profile))).status,
    409,
  );
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
