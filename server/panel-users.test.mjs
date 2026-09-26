import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createFleet } from "./index.mjs";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

const origin = "https://panel-accounts.example.test";
const password = "Panel-account-test-password!";
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const scoped = (serverId, options = {}) => ({
  ...options,
  headers: { ...options.headers, "X-Server-Id": serverId },
});

async function fixture(t, { createDefaultServer = true } = {}) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-panel-users-"));
  const closers = [];
  let nextPort = 25700;
  const boot = async () => {
    const fleet = await createFleet({
      dataDir: root,
      useEnvironment: false,
      createDefaultServer,
      scheduler: false,
      remoteListen: false,
      publicAddress: { resolve: async () => null },
      javaProbe: async () => ({
        available: true,
        majorVersion: 21,
        version: "21",
        path: "java",
      }),
    });
    const listen = (app) =>
      new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
    const owner = await listen(fleet.app);
    const remote = await listen(fleet.remoteApp);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await fleet.close();
      } finally {
        for (const listener of [owner, remote]) {
          listener.closeAllConnections();
          await new Promise((resolve) => listener.close(resolve));
        }
      }
    };
    closers.push(close);
    const request =
      (listener, headers = {}) =>
      (route, options = {}) =>
        new Promise((resolve, reject) => {
          const outgoing = http.request(
            `http://127.0.0.1:${listener.address().port}${route}`,
            {
              method: options.method ?? "GET",
              headers: {
                "Content-Type": "application/json",
                ...(options.body === undefined
                  ? {}
                  : { "Content-Length": Buffer.byteLength(options.body) }),
                ...headers,
                ...options.headers,
              },
            },
            (response) => {
              let raw = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => (raw += chunk));
              response.on("end", () => {
                try {
                  resolve({
                    status: response.statusCode,
                    body: raw ? JSON.parse(raw) : undefined,
                    cookie: response.headers["set-cookie"]?.[0]?.split(";")[0],
                  });
                } catch (cause) {
                  reject(
                    new Error(`${route} returned non-JSON: ${raw}`, { cause }),
                  );
                }
              });
            },
          );
          outgoing.on("error", reject);
          outgoing.end(options.body);
        });
    const local = request(owner);
    const signed = (cookie) =>
      request(remote, {
        Host: "panel-accounts.example.test",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      });
    const configured = await local(
      "/api/access/settings",
      json("PUT", {
        enabled: true,
        publicUrl: origin,
        transport: "proxy",
      }),
    );
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    const createServer = async (name) => {
      const result = await local(
        "/api/servers",
        json("POST", { name, port: nextPort++ }),
      );
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body.server;
    };
    const invite = async (input = {}) => {
      const created = await local(
        "/api/panel-users",
        json("POST", {
          email: "account@example.test",
          permissions: ["control.console"],
          hostPermissions: [],
          accessMode: "all",
          ...input,
        }),
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const user = created.body.user ?? created.body;
      const invited = await local(
        `/api/panel-users/${user.id}/invite`,
        json("POST", {}),
      );
      assert.equal(invited.status, 200, JSON.stringify(invited.body));
      assert.equal(invited.body.user.id, user.id);
      const token = new URL(invited.body.invitationUrl).hash.slice(
        "#invite=".length,
      );
      const accepted = await signed()(
        "/api/access/accept",
        json("POST", { token, password }),
      );
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(accepted.body.accountId, user.id);
      assert.equal(accepted.body.userId, user.id);
      assert.ok(accepted.cookie);
      return {
        user,
        cookie: accepted.cookie,
        session: accepted.body,
        request: signed(accepted.cookie),
      };
    };
    return { fleet, local, signed, close, createServer, invite };
  };
  t.after(async () => {
    for (const close of closers) await close();
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-panel-users-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, boot };
}

async function roster(actor) {
  const result = await actor.request("/api/servers");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

test("one panel account sees existing and future servers and survives per-server revocation with the same cookie", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const first = (await panel.local("/api/servers")).body.servers[0];
  const second = await panel.createServer("Existing creative");
  const actor = await panel.invite({ hostPermissions: ["server.create"] });
  assert.deepEqual(
    (await roster(actor)).servers.map((server) => server.id).sort(),
    [first.id, second.id].sort(),
  );
  const third = await panel.createServer("Future adventure");
  assert.deepEqual(
    (await roster(actor)).servers.map((server) => server.id).sort(),
    [first.id, second.id, third.id].sort(),
  );
  assert.equal(
    (await actor.request("/api/server", scoped(third.id))).status,
    200,
  );

  const update = async (input) => {
    const result = await panel.local(
      `/api/panel-users/${actor.user.id}`,
      json("PATCH", input),
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  await update({ excludedServerIds: [first.id] });
  assert.deepEqual(
    (await roster(actor)).servers.map((server) => server.id).sort(),
    [second.id, third.id].sort(),
  );
  assert.equal(
    (await actor.request("/api/server", scoped(first.id))).status,
    403,
  );
  assert.equal(
    (await actor.request("/api/server", scoped(second.id))).status,
    200,
  );
  const session = await actor.request("/api/access/session");
  assert.equal(session.body.accountId, actor.user.id);
  assert.notEqual(session.body.serverId, first.id);

  await update({
    accessMode: "selected",
    serverIds: [],
    excludedServerIds: [],
  });
  const empty = await roster(actor);
  assert.deepEqual(empty.servers, []);
  assert.equal(empty.defaultServerId, null);
  assert.deepEqual(empty.hostPermissions, ["server.create"]);
  const emptySession = await actor.request("/api/access/session");
  assert.equal(emptySession.status, 200);
  assert.equal(emptySession.body.accountId, actor.user.id);
  assert.equal(emptySession.body.serverId, null);
  assert.deepEqual(emptySession.body.permissions, []);
  assert.equal(
    (await actor.request("/api/server", scoped(second.id))).status,
    403,
  );

  await update({ serverIds: [second.id], hostPermissions: [] });
  const regranted = await roster(actor);
  assert.deepEqual(
    regranted.servers.map((server) => server.id),
    [second.id],
  );
  assert.deepEqual(regranted.hostPermissions, []);
  assert.equal(
    (await actor.request("/api/server", scoped(second.id))).status,
    200,
  );
});

test("an account created before the first server stays signed in across restart and later gains new servers", async (t) => {
  const { boot } = await fixture(t, { createDefaultServer: false });
  let panel = await boot();
  const actor = await panel.invite();
  assert.equal(actor.session.serverId, null);
  assert.deepEqual((await roster(actor)).servers, []);
  await panel.close();
  panel = await boot();
  actor.request = panel.signed(actor.cookie);
  assert.equal(
    (await actor.request("/api/access/session")).body.accountId,
    actor.user.id,
  );
  assert.deepEqual((await roster(actor)).servers, []);
  const created = await panel.createServer("First shared world");
  assert.deepEqual(
    (await roster(actor)).servers.map((server) => server.id),
    [created.id],
  );
  const login = await panel.signed()(
    "/api/access/login",
    json("POST", { email: actor.user.email, password }),
  );
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.accountId, actor.user.id);
  assert.equal(login.body.serverId, created.id);
});

test("server administration grants never permit remote management of panel-wide accounts", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite({
    permissions: catalog.roleDefaults.admin,
    hostPermissions: ["server.create"],
  });
  const id = actor.user.id;
  for (const [method, route, body] of [
    ["GET", "/api/panel-users"],
    ["HEAD", "/api/panel-users"],
    [
      "POST",
      "/api/panel-users",
      {
        email: "escalation@example.test",
        permissions: catalog.roleDefaults.admin,
      },
    ],
    ["PATCH", `/api/panel-users/${id}`, { accessMode: "all" }],
    ["DELETE", `/api/panel-users/${id}`],
    ["POST", `/api/panel-users/${id}/invite`, {}],
  ]) {
    const result = await actor.request(route, {
      ...(body === undefined ? { method } : json(method, body)),
      headers: {
        "X-Remote-Principal": "owner",
        "X-Forwarded-For": "127.0.0.1",
      },
    });
    assert.equal(
      result.status,
      403,
      `${method} ${route}: ${JSON.stringify(result.body)}`,
    );
  }
  const accounts = await panel.local("/api/panel-users");
  assert.deepEqual(
    accounts.body.users.map((user) => user.id),
    [id],
  );
  assert.ok(accounts.body.servers.length);
  for (const user of accounts.body.users) {
    assert.equal(Object.hasOwn(user, "password"), false);
    assert.equal(Object.hasOwn(user, "authRevision"), false);
  }
});

test("virtual panel-account memberships support scoped rename and same-PC copy with live source revocation", async (t) => {
  const { root, boot } = await fixture(t);
  const panel = await boot();
  const source = (await panel.local("/api/servers")).body.servers[0];
  const destination = await panel.createServer("Copy destination");
  const actor = await panel.invite({
    permissions: [],
    serverOverrides: {
      [source.id]: { permissions: ["file.read-content"] },
      [destination.id]: { permissions: ["file.create", "server.update"] },
    },
  });
  const sourceDir = panel.fleet.runtimes.get(source.id).serverDir;
  const destinationDir = panel.fleet.runtimes.get(destination.id).serverDir;
  await fs.writeFile(
    path.join(sourceDir, "source.txt"),
    "Content shared through a panel account.",
  );
  const renamed = await actor.request(
    "/api/server/settings",
    scoped(destination.id, json("PATCH", { name: "Renamed destination" })),
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.server.name, "Renamed destination");
  assert.equal(
    (
      await actor.request(
        "/api/server/settings",
        scoped(source.id, json("PATCH", { name: "Denied rename" })),
      )
    ).status,
    403,
  );
  const requestId = randomUUID();
  const copy = () =>
    actor.request(
      "/api/files/copy",
      scoped(
        destination.id,
        json("POST", {
          requestId,
          sourceServerId: source.id,
          paths: ["source.txt"],
          destinationPath: "",
        }),
      ),
    );
  const copied = await copy();
  assert.equal(copied.status, 201, JSON.stringify(copied.body));
  assert.equal(copied.body.copiedFiles, 1);
  const original = await fs.readFile(
    path.join(sourceDir, "source.txt"),
    "utf8",
  );
  assert.equal(
    await fs.readFile(path.join(destinationDir, "source.txt"), "utf8"),
    original,
  );
  const progress = await actor.request(
    `/api/files/copy-operation?requestId=${requestId}`,
    scoped(destination.id),
  );
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  assert.equal(progress.body.operation.status, "completed");

  const revoked = await panel.local(
    `/api/panel-users/${actor.user.id}`,
    json("PATCH", { excludedServerIds: [source.id] }),
  );
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(
    (await copy()).status,
    403,
    "completed copy replay must recheck source access",
  );
  assert.equal(
    (await actor.request("/api/server/settings", scoped(destination.id)))
      .status,
    200,
  );
  const registry = JSON.parse(
    await fs.readFile(path.join(root, "servers.json"), "utf8"),
  );
  assert.equal(
    registry.servers.find((server) => server.id === destination.id).name,
    "Renamed destination",
  );
  for (const runtime of panel.fleet.runtimes.values()) {
    const state = JSON.parse(
      await fs
        .readFile(path.join(runtime.dataDir, "panel.json"), "utf8")
        .catch((error) => {
          if (error.code === "ENOENT") return '{"users":[]}';
          throw error;
        }),
    );
    assert.equal(
      state.users.some((user) => user.id === actor.user.id),
      false,
      "panel accounts must not require duplicate per-server user records",
    );
  }
});

test("an account without shared servers can create only with an explicit host grant and cannot replay a revoked creator grant", async (t) => {
  const { boot } = await fixture(t, { createDefaultServer: false });
  const panel = await boot();
  const actor = await panel.invite({
    accessMode: "selected",
    serverIds: [],
    permissions: [],
    hostPermissions: [],
  });
  const input = {
    requestId: randomUUID(),
    confirmed: true,
    acceptedEula: true,
    configuration: {
      name: "Created from an empty account",
      mode: "live",
      port: 25701,
      memoryLimitMB: 2048,
    },
  };
  const create = () => actor.request("/api/server-setup", json("POST", input));
  const denied = await create();
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.deepEqual((await panel.local("/api/servers")).body.servers, []);
  const granted = await panel.local(
    `/api/panel-users/${actor.user.id}`,
    json("PATCH", { hostPermissions: ["server.create"] }),
  );
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const created = await create();
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    [...created.body.server.accessPermissions].sort(),
    [...catalog.roleDefaults.admin].sort(),
  );
  const retried = await create();
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.server.id, created.body.server.id);
  await panel.createServer("Unrelated owner server");
  assert.deepEqual(
    (await roster(actor)).servers.map((server) => server.id),
    [created.body.server.id],
    "a selected-only account must not inherit unrelated future servers",
  );
  const revoked = await panel.local(
    `/api/panel-users/${actor.user.id}`,
    json("PATCH", { serverIds: [] }),
  );
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.deepEqual((await roster(actor)).servers, []);
  assert.deepEqual((await roster(actor)).hostPermissions, ["server.create"]);
  const revokedRetry = await create();
  assert.equal(revokedRetry.status, 403, JSON.stringify(revokedRetry.body));
  assert.deepEqual((await roster(actor)).servers, []);
  assert.equal((await panel.local("/api/servers")).body.servers.length, 2);
});

test("reset and acceptance of a panel account cannot authorize its already-running old copy request", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const source = (await panel.local("/api/servers")).body.servers[0];
  const destination = await panel.createServer("Reset destination");
  const actor = await panel.invite({
    permissions: ["file.read-content", "file.create"],
  });
  const sourceFile = path.join(
    panel.fleet.runtimes.get(source.id).serverDir,
    "held-copy.bin",
  );
  const targetFile = path.join(
    panel.fleet.runtimes.get(destination.id).serverDir,
    "held-copy.bin",
  );
  const original = Buffer.alloc(2 * 1024 * 1024, 57);
  await fs.writeFile(sourceFile, original);
  let entered;
  let release;
  const reading = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const open = fs.open;
  let blocked = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (args[0] === sourceFile && args[1] === "r" && !blocked) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...readArgs) => {
        const result = await read(...readArgs);
        if (!blocked) {
          blocked = true;
          entered();
          await held;
        }
        return result;
      });
    }
    return handle;
  });
  const copy = (request) =>
    request(
      "/api/files/copy",
      scoped(
        destination.id,
        json("POST", {
          requestId: randomUUID(),
          sourceServerId: source.id,
          paths: ["held-copy.bin"],
          destinationPath: "",
        }),
      ),
    );
  const copying = copy(actor.request);
  let newCookie;
  try {
    await Promise.race([
      reading,
      copying.then((response) => {
        throw new Error(
          `Copy finished before the held read: ${JSON.stringify(response)}`,
        );
      }),
    ]);
    const reset = await panel.local(
      `/api/panel-users/${actor.user.id}/invite`,
      json("POST", {}),
    );
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const accepted = await panel.signed()(
      "/api/access/accept",
      json("POST", {
        token: new URL(reset.body.invitationUrl).hash.slice("#invite=".length),
        password: "Replacement-panel-account-password!",
      }),
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    newCookie = accepted.cookie;
  } finally {
    release();
  }
  const result = await copying;
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.copiedFiles, 0);
  await assert.rejects(fs.stat(targetFile), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(sourceFile), original);
  assert.equal((await actor.request("/api/servers")).status, 401);
  const currentCopy = await copy(panel.signed(newCookie));
  assert.equal(currentCopy.status, 201, JSON.stringify(currentCopy.body));
  assert.deepEqual(await fs.readFile(targetFile), original);
});

test("a delegated server administrator cannot edit a promoted legacy account through its old per-server user ID", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const serverId = (await panel.local("/api/servers")).body.defaultServerId;
  const email = "legacy-member@example.test";
  const created = await panel.local(
    "/api/subusers",
    scoped(serverId, json("POST", { email, permissions: ["control.console"] })),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const legacyId = created.body.id;
  const actor = await panel.invite({ permissions: catalog.roleDefaults.admin });
  const promoted = await panel.local(
    `/api/panel-users/${encodeURIComponent(`legacy:${email}`)}`,
    json("PATCH", { accessMode: "selected", serverIds: [serverId] }),
  );
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.notEqual(promoted.body.id, legacyId);
  const users = await actor.request("/api/subusers", scoped(serverId));
  assert.equal(users.status, 200, JSON.stringify(users.body));
  const target = users.body.users.find((user) => user.email === email);
  assert.equal(target.panelAccount, true);
  for (const [route, options] of [
    [
      `/api/subusers/${legacyId}`,
      json("PATCH", { permissions: catalog.roleDefaults.admin }),
    ],
    [`/api/subusers/${legacyId}`, { method: "DELETE" }],
    [`/api/subusers/${legacyId}/invite`, json("POST", {})],
  ]) {
    const denied = await actor.request(route, scoped(serverId, options));
    assert.equal(
      denied.status,
      403,
      `${options.method} ${route}: ${JSON.stringify(denied.body)}`,
    );
  }
  const accounts = await panel.local("/api/panel-users");
  const unchanged = accounts.body.users.find(
    (user) => user.id === promoted.body.id,
  );
  assert.deepEqual(unchanged.serverIds, [serverId]);
  assert.deepEqual(unchanged.serverOverrides[serverId].permissions, [
    "control.console",
  ]);
  assert.ok(
    panel.fleet.runtimes
      .get(serverId)
      .subusers()
      .some((user) => user.id === legacyId),
  );
});
