import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { crc32 } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { createFleet } from "./index.mjs";
import {
  createPublicAddressResolver,
  advertisedConnection,
  connectionAddress,
  validateConnectionHost,
  legacyConnectionHost,
} from "./connection.mjs";
import { validateIcon, decodeIcon } from "./server-icon.mjs";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const png = (fill = "#00aa00", size = 64) =>
  new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${fill}"/></svg>`,
  )
    .render()
    .asPng();
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString("base64")}`;
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-customization-"));
  const dataDir = path.join(root, "panel");
  const fleets = [];
  const listeners = [];
  const cleanup = [];
  const boot = async () => {
    const fleet = await createFleet({
      dataDir,
      createDefaultServer: false,
      scheduler: false,
      useEnvironment: false,
      publicAddress: { resolve: async () => "8.8.8.8" },
      telemetry: {
        sample: async () => ({
          available: false,
          cpu: null,
          memory: null,
          processCount: 0,
        }),
        reset: () => {},
        close: () => {},
      },
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
      if (response.headers.get("Content-Type")?.includes("image/png"))
        return {
          status: response.status,
          bytes: Buffer.from(await response.arrayBuffer()),
          headers: response.headers,
        };
      return {
        status: response.status,
        body: await response.json(),
        headers: response.headers,
      };
    };
    const create = async (port = 25565, mode = "live") => {
      const result = await request(
        "/api/servers",
        json("POST", { name: "Our server", mode, port }),
      );
      assert.equal(result.status, 201);
      return result.body.server.id;
    };
    return { ...fleet, request, create };
  };
  t.after(async () => {
    for (const callback of cleanup) callback();
    for (const fleet of fleets) await fleet.close();
    for (const listener of listeners) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-customization-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, boot, cleanup };
}

test("public address lookup coalesces concurrent requests, caches successes and retries cached failures", async () => {
  let at = 0;
  let requests = 0;
  let healthy = true;
  const gate = deferred();
  const resolver = createPublicAddressResolver({
    now: () => at,
    fetchAddress: async (url, options) => {
      requests++;
      assert.equal(url, "https://api.ipify.org?format=json");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      await gate.promise;
      if (!healthy) throw new Error("offline");
      return Response.json({ ip: "8.8.8.8" });
    },
  });
  const pending = [resolver.resolve(), resolver.resolve()];
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), ["8.8.8.8", "8.8.8.8"]);
  assert.equal(requests, 1);
  at = 599999;
  assert.equal(await resolver.resolve(), "8.8.8.8");
  assert.equal(requests, 1);
  at = 600000;
  healthy = false;
  assert.equal(await resolver.resolve(), null);
  assert.equal(requests, 2);
  at = 629999;
  healthy = true;
  assert.equal(await resolver.resolve(), null);
  assert.equal(requests, 2);
  at = 630000;
  assert.equal(await resolver.resolve(), "8.8.8.8");
  assert.equal(requests, 3);
});

test("public lookup rejects local, malformed, oversized and failed responses", async () => {
  for (const response of [
    Response.json({ ip: "127.0.0.1" }),
    Response.json({ ip: "10.1.2.3" }),
    Response.json({ ip: "100.64.1.2" }),
    Response.json({ ip: "192.168.1.2" }),
    Response.json({ ip: "169.254.1.2" }),
    Response.json({ ip: "::1" }),
    Response.json({ ip: "8.8.8.8:25565" }),
    Response.json({ ip: "https://example.com" }),
    new Response('{"ip":"not finished'),
    new Response("x".repeat(1025)),
    new Response("unavailable", { status: 503 }),
  ]) {
    const resolver = createPublicAddressResolver({
      fetchAddress: async () => response,
    });
    assert.equal(await resolver.resolve(), null);
  }
});

test("connection addresses handle hostnames and IPv6 without changing the game port or bind address", async () => {
  assert.equal(
    validateConnectionHost(" play.example.com "),
    "play.example.com",
  );
  assert.equal(
    validateConnectionHost("[2001:4860:4860::8888]"),
    "2001:4860:4860::8888",
  );
  assert.equal(
    connectionAddress("2001:4860:4860::8888", 25571),
    "[2001:4860:4860::8888]:25571",
  );
  for (const value of [
    "https://play.example.com",
    "play.example.com:25565",
    "host/name",
    "bad host",
    "-bad.example",
    "a".repeat(254),
  ])
    assert.throws(() => validateConnectionHost(value));
  assert.equal(legacyConnectionHost("192.168.1.1:25565"), "");
  assert.equal(
    legacyConnectionHost("play.example.com:25565"),
    "play.example.com",
  );
  const noLookup = {
    resolve: () => assert.fail("Custom addresses do not need public lookup"),
  };
  assert.equal(
    (
      await advertisedConnection(
        { connectionHost: "play.example.com", port: 25571 },
        noLookup,
      )
    ).address,
    "play.example.com:25571",
  );
  assert.equal(
    (
      await advertisedConnection(
        { mode: "live", port: 25565 },
        { resolve: async () => null },
      )
    ).address,
    "localhost:25565",
  );
});

test("server connection overrides, IPv6 and reset-to-auto persist without rewriting server.properties", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const first = await panel.create(25571);
  const second = await panel.create(25572);
  const propertiesPath = path.join(
    panel.runtimes.get(first).serverDir,
    "server.properties",
  );
  await fs.appendFile(
    propertiesPath,
    "server-ip=192.168.1.23\n# preserve this bind\n",
  );
  const before = await fs.readFile(propertiesPath);
  const patch = (connectionHost) =>
    panel.request(`/api/servers/${first}`, json("PATCH", { connectionHost }));
  assert.equal((await patch("play.example.com")).status, 200);
  let state = (await panel.request("/api/server", {}, first)).body;
  assert.equal(state.address, "play.example.com:25571");
  assert.equal(state.addressSource, "custom");
  assert.equal(
    (await panel.request("/api/server", {}, second)).body.address,
    "8.8.8.8:25572",
  );
  assert.equal((await patch("[2001:4860:4860::8888]")).status, 200);
  assert.equal(
    (await panel.request("/api/server", {}, first)).body.address,
    "[2001:4860:4860::8888]:25571",
  );
  assert.equal((await patch("https://bad.example")).status, 400);
  await panel.close();
  const restarted = await boot();
  assert.equal(
    (await restarted.request("/api/server", {}, first)).body.address,
    "[2001:4860:4860::8888]:25571",
  );
  assert.equal(
    (
      await restarted.request(
        `/api/servers/${first}`,
        json("PATCH", { connectionHost: "" }),
      )
    ).status,
    200,
  );
  state = (await restarted.request("/api/server", {}, first)).body;
  assert.equal(state.address, "8.8.8.8:25571");
  assert.equal(state.addressSource, "public");
  assert.deepEqual(await fs.readFile(propertiesPath), before);
});

test("server icon display preferences persist per server without deleting Minecraft icon bytes", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const first = await panel.create();
  const second = await panel.create(25566);
  const green = png();
  const blue = png("#0000ff");
  assert.deepEqual(validateIcon(green), green);
  assert.deepEqual(decodeIcon(dataUrl(green)), green);
  assert.equal(
    (await panel.request("/api/server/icon", {}, first)).status,
    404,
  );
  assert.equal(
    (
      await panel.request(
        "/api/server/icon",
        json("POST", { image: dataUrl(green) }),
        first,
      )
    ).status,
    200,
  );
  const uploaded = await panel.request("/api/server/icon", {}, first);
  assert.deepEqual(uploaded.bytes, green);
  assert.match(uploaded.headers.get("Content-Type"), /image\/png/);
  assert.equal(
    (await panel.request("/api/server/icon", {}, second)).status,
    404,
  );
  const firstVersion = (await panel.request("/api/server", {}, first)).body
    .iconVersion;
  assert.ok(firstVersion);
  assert.equal(
    (
      await panel.request(
        "/api/server/icon",
        json("POST", { image: dataUrl(blue) }),
        first,
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await panel.request("/api/server/icon", {}, first)).bytes,
    blue,
  );
  await panel.close();
  const restarted = await boot();
  assert.deepEqual(
    (await restarted.request("/api/server/icon", {}, first)).bytes,
    blue,
  );
  const iconPath = path.join(
    restarted.runtimes.get(first).serverDir,
    "server-icon.png",
  );
  await restarted.request(
    "/api/server/icon",
    json("POST", { image: dataUrl(green) }),
    second,
  );
  assert.equal(
    (await restarted.request("/api/server/icon", { method: "DELETE" }, first))
      .status,
    200,
  );
  assert.equal(
    (await restarted.request("/api/server", {}, first)).body.iconVersion,
    null,
  );
  assert.deepEqual(
    (await restarted.request("/api/server/icon", {}, first)).bytes,
    blue,
  );
  assert.deepEqual(await fs.readFile(iconPath), blue);
  let displayed = (await restarted.request("/api/server", {}, first)).body;
  assert.equal(displayed.iconPreference, "default");
  assert.ok(displayed.serverIconVersion);
  assert.equal(
    (await restarted.request("/api/server", {}, second)).body.iconPreference,
    "server",
  );
  assert.ok(
    (await restarted.request("/api/server", {}, second)).body.iconVersion,
  );
  await restarted.close();
  const reopened = await boot();
  displayed = (await reopened.request("/api/server", {}, first)).body;
  assert.equal(displayed.iconPreference, "default");
  assert.equal(displayed.iconVersion, null);
  assert.ok(displayed.serverIconVersion);
  assert.deepEqual(await fs.readFile(iconPath), blue);
  assert.equal(
    (
      await reopened.request(
        "/api/server/icon",
        json("PUT", { preference: "invalid" }),
        first,
      )
    ).status,
    400,
  );
  assert.equal(
    (await reopened.request("/api/server", {}, first)).body.iconPreference,
    "default",
  );
  assert.equal(
    (
      await reopened.request(
        "/api/server/icon",
        json("PUT", { preference: "server" }),
        first,
      )
    ).status,
    200,
  );
  displayed = (await reopened.request("/api/server", {}, first)).body;
  assert.equal(displayed.iconPreference, "server");
  assert.equal(displayed.iconVersion, displayed.serverIconVersion);
  assert.deepEqual(await fs.readFile(iconPath), blue);
  await reopened.request("/api/server/icon", { method: "DELETE" }, first);
  await reopened.request(
    "/api/server/icon",
    json("POST", { image: dataUrl(green) }),
    first,
  );
  assert.equal(
    (await reopened.request("/api/server", {}, first)).body.iconPreference,
    "server",
  );
  assert.deepEqual(await fs.readFile(iconPath), green);
  const audit = (await reopened.request("/api/audit", {}, first)).body.entries;
  assert.equal(
    audit.filter((entry) => entry.action === "Server icon updated").length,
    3,
  );
  assert.ok(
    audit.some((entry) => entry.action === "Default panel icon selected"),
  );
  assert.ok(
    audit.some((entry) => entry.action === "Server icon display selected"),
  );
});

test("icon validation rejects invalid size, truncated data, CRC corruption and undecodable image data", () => {
  const good = png();
  for (const bytes of [
    Buffer.from("not an image"),
    png("red", 32),
    Buffer.alloc(262145),
    good.subarray(0, good.length - 1),
  ])
    assert.throws(() => validateIcon(bytes));
  for (const value of [
    undefined,
    "https://example.com/icon.png",
    "data:image/jpeg;base64,AAAA",
    "data:image/png;base64,!bad!",
  ])
    assert.throws(() => decodeIcon(value));
  const corruptCrc = Buffer.from(good);
  corruptCrc[29] ^= 1;
  assert.throws(() => validateIcon(corruptCrc), /PNG|icon/i);
  const corruptData = Buffer.from(good);
  for (let offset = 8; offset + 12 <= corruptData.length;) {
    const length = corruptData.readUInt32BE(offset);
    if (corruptData.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      corruptData.fill(0, offset + 8, offset + 8 + length);
      corruptData.writeUInt32BE(
        crc32(corruptData.subarray(offset + 4, offset + 8 + length)),
        offset + 8 + length,
      );
      break;
    }
    offset += length + 12;
  }
  assert.throws(() => validateIcon(corruptData), /PNG|icon/i);
});

test("bad icon requests leave the previous image intact and cannot follow junctions", async (t) => {
  const { root, boot } = await fixture(t);
  const panel = await boot();
  const id = await panel.create();
  const green = png();
  const serverDir = panel.runtimes.get(id).serverDir;
  await panel.request(
    "/api/server/icon",
    json("POST", { image: dataUrl(green) }),
    id,
  );
  assert.equal(
    (
      await panel.request(
        "/api/server/icon",
        json("POST", { image: dataUrl(png("red", 128)) }),
        id,
      )
    ).status,
    400,
  );
  assert.deepEqual(
    (await panel.request("/api/server/icon", {}, id)).bytes,
    green,
  );
  await panel.request("/api/server/icon", { method: "DELETE" }, id);
  assert.deepEqual(
    await fs.readFile(path.join(serverDir, "server-icon.png")),
    green,
  );
  // Replace only this test fixture's file to exercise path protection.
  await fs.unlink(path.join(serverDir, "server-icon.png"));
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "proof.txt"), "unchanged");
  await fs.symlink(
    outside,
    path.join(serverDir, "server-icon.png"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal((await panel.request("/api/server/icon", {}, id)).status, 404);
  assert.equal(
    (
      await panel.request(
        "/api/server/icon",
        json("POST", { image: dataUrl(green) }),
        id,
      )
    ).status,
    400,
  );
  assert.equal(
    (await panel.request("/api/server/icon", { method: "DELETE" }, id)).status,
    200,
  );
  assert.equal(
    (await fs.lstat(path.join(serverDir, "server-icon.png"))).isSymbolicLink(),
    true,
  );
  assert.equal(
    await fs.readFile(path.join(outside, "proof.txt"), "utf8"),
    "unchanged",
  );
});

test("icon mutations wait for an active world backup", async (t) => {
  const flushing = deferred();
  const release = deferred();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0);
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const command = chunk.toString().trim();
      if (command === "save-all flush") {
        flushing.resolve();
        release.promise.then(() =>
          child.stdout.write("[Server thread/INFO]: Saved the game\n"),
        );
      }
      if (command === "stop") setImmediate(() => child.emit("close", 0));
      done();
    },
  });
  const { boot, cleanup } = await fixture(t, {
    spawnServer: () => {
      setImmediate(() =>
        child.stdout.write("[Server thread/INFO]: Done (1s)!\n"),
      );
      return child;
    },
    backupFlushTimeoutMs: 5000,
  });
  cleanup.push(release.resolve);
  const panel = await boot();
  const id = await panel.create();
  const serverDir = panel.runtimes.get(id).serverDir;
  await fs.writeFile(path.join(serverDir, "server.jar"), "not executed");
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  assert.equal(
    (
      await panel.request(
        "/api/server/power",
        json("POST", { action: "start" }),
        id,
      )
    ).status,
    200,
  );
  const pending = panel.request(
    "/api/backups",
    json("POST", { name: "Held backup" }),
    id,
  );
  await Promise.race([
    flushing.promise,
    pending.then((response) => assert.fail(JSON.stringify(response))),
  ]);
  assert.equal(
    (
      await panel.request(
        "/api/server/icon",
        json("POST", { image: dataUrl(png()) }),
        id,
      )
    ).status,
    409,
  );
  assert.equal(
    (await panel.request("/api/server/icon", { method: "DELETE" }, id)).status,
    409,
  );
  release.resolve();
  assert.equal((await pending).status, 201);
});

test("granular permissions validate, deduplicate, remain scoped, and persist edits", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const first = await panel.create();
  const second = await panel.create(25566);
  const created = await panel.request(
    "/api/subusers",
    json("POST", {
      email: "Builder@example.com",
      permissions: ["control.start", "file.read", "control.start"],
    }),
    first,
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.role, "custom");
  assert.deepEqual(created.body.permissions, ["control.start", "file.read"]);
  assert.equal(
    (await panel.request("/api/subusers", {}, second)).body.users.length,
    0,
  );
  for (const permissions of [
    "control.start",
    ["unknown.permission"],
    [null],
    [42],
    null,
  ]) {
    assert.equal(
      (
        await panel.request(
          "/api/subusers",
          json("POST", { email: "bad@example.com", permissions }),
          first,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await panel.request(
          `/api/subusers/${created.body.id}`,
          json("PATCH", { permissions }),
          first,
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await panel.request(
        `/api/subusers/${created.body.id}`,
        json("PATCH", { permissions: ["backup.read"] }),
        second,
      )
    ).status,
    404,
  );
  const edited = await panel.request(
    `/api/subusers/${created.body.id}`,
    json("PATCH", { permissions: ["backup.read", "backup.download"] }),
    first,
  );
  assert.equal(edited.status, 200);
  assert.equal(edited.body.email, "builder@example.com");
  await panel.close();
  const restarted = await boot();
  assert.deepEqual(
    (await restarted.request("/api/subusers", {}, first)).body.users[0]
      .permissions,
    ["backup.read", "backup.download"],
  );
  assert.equal(
    (await restarted.request("/api/subusers", {}, second)).body.users.length,
    0,
  );
  assert.deepEqual(
    (
      await restarted.request(
        `/api/subusers/${created.body.id}`,
        json("PATCH", { permissions: [] }),
        first,
      )
    ).body.permissions,
    [],
  );
});

test("legacy role-only subusers receive intended permission defaults and can be edited after restart", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const id = await panel.create();
  for (const role of ["admin", "operator", "viewer"]) {
    const created = await panel.request(
      "/api/subusers",
      json("POST", { email: `${role}@example.com`, role }),
      id,
    );
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.permissions, catalog.roleDefaults[role]);
  }
  const statePath = path.join(panel.runtimes.get(id).dataDir, "panel.json");
  await panel.close();
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  for (const user of state.users) delete user.permissions;
  await fs.writeFile(statePath, JSON.stringify(state));
  const restarted = await boot();
  const users = (await restarted.request("/api/subusers", {}, id)).body.users;
  for (const user of users)
    assert.deepEqual(user.permissions, catalog.roleDefaults[user.role]);
  const edited = await restarted.request(
    `/api/subusers/${users[0].id}`,
    json("PATCH", { permissions: ["audit.read"] }),
    id,
  );
  assert.equal(edited.status, 200);
  assert.equal(edited.body.role, "custom");
  assert.deepEqual(edited.body.permissions, ["audit.read"]);
  const audit = (await restarted.request("/api/audit", {}, id)).body.entries;
  assert.ok(
    audit.some(
      (entry) =>
        entry.action === "Subuser permissions updated" &&
        entry.detail.includes("Changes apply to subsequent requests"),
    ),
  );
});
