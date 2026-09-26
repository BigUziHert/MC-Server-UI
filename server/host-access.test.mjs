import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createFleet } from "./index.mjs";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

const origin = "https://host-permission.example.test";
const password = "Fixture-host-password!";
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const setupInput = (port = 25700) => ({
  requestId: randomUUID(),
  confirmed: true,
  acceptedEula: true,
  configuration: {
    name: "Remote-created server",
    mode: "live",
    port,
    memoryLimitMB: 2048,
  },
});

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-host-access-")),
  );
  const dataDir = path.join(root, "panel");
  const instances = [];
  async function boot() {
    const fleet = await createFleet({
      dataDir,
      useEnvironment: false,
      createDefaultServer: true,
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
    const owner = await listen(fleet.app),
      remote = await listen(fleet.remoteApp);
    const request =
      (listener, defaultHeaders) =>
      async (route, options = {}) =>
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
                ...defaultHeaders,
                ...options.headers,
              },
            },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("end", () => {
                try {
                  resolve({
                    status: response.statusCode,
                    body: JSON.parse(body),
                    cookie: response.headers["set-cookie"]?.[0]?.split(";")[0],
                  });
                } catch (cause) {
                  reject(
                    new Error(
                      `${options.method ?? "GET"} ${route} returned ${response.statusCode} without JSON: ${body}`,
                      { cause },
                    ),
                  );
                }
              });
            },
          );
          outgoing.on("error", reject);
          outgoing.end(options.body);
        });
    const local = request(owner, {});
    const signed = (cookie) =>
      request(remote, {
        Host: "host-permission.example.test",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      });
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
    instances.push(close);
    assert.equal(
      (
        await local(
          "/api/access/settings",
          json("PUT", { enabled: true, publicUrl: origin, transport: "proxy" }),
        )
      ).status,
      200,
    );
    const id = (await local("/api/servers")).body.defaultServerId;
    async function invite({
      email = "creator@example.test",
      hostPermissions = ["server.create"],
      permissions = ["control.start"],
      serverId = id,
      secret = password,
    } = {}) {
      const headers = { "X-Server-Id": serverId };
      const created = await local("/api/subusers", {
        ...json("POST", { email, permissions, hostPermissions }),
        headers,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const invited = await local(`/api/subusers/${created.body.id}/invite`, {
        ...json("POST", {}),
        headers,
      });
      assert.equal(invited.status, 200, JSON.stringify(invited.body));
      const accepted = await signed()(
        "/api/access/accept",
        json("POST", {
          token: new URL(invited.body.invitationUrl).hash.slice(8),
          password: secret,
        }),
      );
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      return {
        user: created.body,
        cookie: accepted.cookie,
        request: signed(accepted.cookie),
      };
    }
    return { fleet, local, signed, invite, close, id };
  }
  t.after(async () => {
    for (const close of instances) await close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-host-access-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, dataDir, boot };
}

test("computer creation is an explicit live owner grant, separate from all server permissions", async (t) => {
  const { boot, root } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite({
    permissions: catalog.roleDefaults.admin,
    hostPermissions: [],
  });
  assert.deepEqual(
    (await actor.request("/api/servers")).body.hostPermissions,
    [],
  );
  for (const route of ["/api/server-setup", "/api/server-import"])
    assert.equal(
      (await actor.request(route, json("POST", setupInput()))).status,
      403,
    );
  const directories = `/api/server-setup/directories?${new URLSearchParams({ directory: root })}`;
  assert.equal((await actor.request(directories)).status, 403);
  const update = (hostPermissions) =>
    panel.local(`/api/subusers/${actor.user.id}`, {
      ...json("PATCH", {
        permissions: actor.user.permissions,
        hostPermissions,
      }),
      headers: { "X-Server-Id": panel.id },
    });
  assert.equal((await update(["server.create"])).status, 200);
  assert.deepEqual((await actor.request("/api/servers")).body.hostPermissions, [
    "server.create",
  ]);
  assert.equal((await actor.request(directories)).status, 200);
  assert.equal((await update([])).status, 200);
  assert.deepEqual(
    (await actor.request("/api/servers")).body.hostPermissions,
    [],
  );
  assert.equal(
    (await actor.request("/api/server-setup", json("POST", setupInput())))
      .status,
    403,
  );
  assert.equal((await panel.local("/api/servers")).body.servers.length, 1);
});

test("created server membership is complete, idempotent, and survives fresh sign-in and panel restart", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite();
  const input = setupInput();
  const created = await actor.request("/api/server-setup", json("POST", input));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.server.id;
  assert.deepEqual(
    created.body.server.accessPermissions.slice().sort(),
    catalog.roleDefaults.admin.slice().sort(),
  );
  const repeated = await actor.request(
    "/api/server-setup",
    json("POST", input),
  );
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.server.id, id);
  assert.equal(repeated.body.reused, true);
  const roster = (await actor.request("/api/servers")).body.servers;
  assert.deepEqual(
    roster.map((server) => server.id).sort(),
    [panel.id, id].sort(),
  );
  assert.deepEqual(
    roster.find((server) => server.id === panel.id).accessPermissions,
    ["control.start"],
  );
  assert.equal(
    (await actor.request("/api/files", { headers: { "X-Server-Id": id } }))
      .status,
    200,
  );
  assert.equal(
    (await actor.request("/api/server", { headers: { "X-Server-Id": id } }))
      .body.status,
    "offline",
  );
  const signIn = (current) =>
    current.signed()(
      "/api/access/login",
      json("POST", { email: actor.user.email, password }),
    );
  assert.equal(
    (await actor.request("/api/access/logout", json("POST", {}))).status,
    200,
  );
  const fresh = await signIn(panel);
  assert.equal(fresh.status, 200);
  assert.deepEqual(
    (await panel.signed(fresh.cookie)("/api/servers")).body.servers
      .map((server) => server.id)
      .sort(),
    [panel.id, id].sort(),
  );
  await panel.close();
  const restarted = await boot();
  const signed = await signIn(restarted);
  assert.equal(signed.status, 200);
  assert.deepEqual(
    (await restarted.signed(signed.cookie)("/api/servers")).body.servers
      .map((server) => server.id)
      .sort(),
    [panel.id, id].sort(),
  );
});

test("host creation never delegates owner settings, grants, recovery, or native dialogs", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const creator = await panel.invite({
    permissions: catalog.roleDefaults.admin,
  });
  const ordinary = await panel.invite({
    email: "ordinary@example.test",
    permissions: catalog.roleDefaults.admin,
    hostPermissions: [],
  });
  for (const [method, route, body] of [
    ["PUT", "/api/access/settings", { enabled: false }],
    ["GET", "/api/access/network"],
    ["POST", "/api/servers", { name: "Bypass creation review" }],
    ["GET", "/api/server-recovery"],
    ["POST", "/api/server-setup/browse", {}],
    ["POST", "/api/server-import/browse", {}],
    [
      "PUT",
      "/api/server-setup/launchpad/settings",
      { curseforgeApiKey: "forged" },
    ],
  ])
    assert.equal(
      (
        await creator.request(
          route,
          body === undefined ? { method } : json(method, body),
        )
      ).status,
      403,
      `${method} ${route}`,
    );
  for (const hostPermissions of [[], ["server.create"]]) {
    assert.equal(
      (
        await creator.request(
          "/api/subusers",
          json("POST", {
            email: "forged@example.test",
            permissions: [],
            hostPermissions,
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await creator.request(
          `/api/subusers/${ordinary.user.id}`,
          json("PATCH", { permissions: [], hostPermissions }),
        )
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await ordinary.request(
        `/api/subusers/${creator.user.id}`,
        json("PATCH", { permissions: [] }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await ordinary.request(
        `/api/subusers/${creator.user.id}`,
        json("DELETE", {}),
      )
    ).status,
    403,
  );
});

test("same-email memberships cannot reuse another creator's request or copied password", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const second = await panel.local(
    "/api/servers",
    json("POST", { name: "Second share", port: 25701 }),
  );
  assert.equal(second.status, 201);
  const firstActor = await panel.invite();
  const secondActor = await panel.invite({
    serverId: second.body.server.id,
    secret: "Second-scope-password!",
  });
  const input = setupInput();
  const created = await firstActor.request(
    "/api/server-setup",
    json("POST", input),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(
    (await secondActor.request("/api/server-setup", json("POST", input)))
      .status,
    409,
  );
  assert.deepEqual(
    (await secondActor.request("/api/servers")).body.servers.map(
      (server) => server.id,
    ),
    [second.body.server.id],
  );
  const secondLogin = await panel.signed()(
    "/api/access/login",
    json("POST", {
      email: firstActor.user.email,
      password: "Second-scope-password!",
    }),
  );
  assert.equal(secondLogin.status, 200);
  assert.deepEqual(
    (await panel.signed(secondLogin.cookie)("/api/servers")).body.servers.map(
      (server) => server.id,
    ),
    [second.body.server.id],
  );
});

test("remote setup reports rejected creation but never calls a committed request uncreated", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite();
  const existing = (await panel.local("/api/servers")).body.servers[0];
  const input = setupInput(existing.port);
  const rejected = await actor.request(
    "/api/server-setup",
    json("POST", input),
  );
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.setupNotCreated, true);
  assert.equal((await panel.local("/api/servers")).body.servers.length, 1);

  input.configuration.port = 25700;
  const created = await actor.request("/api/server-setup", json("POST", input));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const replay = await actor.request("/api/server-setup", json("POST", input));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.server.id, created.body.server.id);
  const changed = await actor.request(
    "/api/server-setup",
    json("POST", {
      ...input,
      configuration: { ...input.configuration, port: 25701 },
    }),
  );
  assert.equal(changed.status, 409);
  assert.equal(changed.body.setupNotCreated, undefined);
  assert.equal((await panel.local("/api/servers")).body.servers.length, 2);
});

test("retry repairs access persistence failure without creating or importing a duplicate server", async (t) => {
  const { boot, dataDir } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite();
  const input = setupInput();
  const rename = fs.rename.bind(fs);
  let failAccess = true;
  t.mock.method(fs, "rename", async (source, target) => {
    if (failAccess && target === path.join(dataDir, "remote-access.json")) {
      failAccess = false;
      throw new Error("Fixture access save failed");
    }
    return rename(source, target);
  });
  const failed = await actor.request("/api/server-setup", json("POST", input));
  assert.equal(failed.status, 500);
  assert.equal(failed.body.setupNotCreated, undefined);
  assert.equal((await panel.local("/api/servers")).body.servers.length, 2);
  assert.equal((await actor.request("/api/servers")).body.servers.length, 1);
  const retry = await actor.request("/api/server-setup", json("POST", input));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.reused, true);
  assert.equal((await actor.request("/api/servers")).body.servers.length, 2);
  assert.equal((await panel.local("/api/servers")).body.servers.length, 2);
});

test("import retry preserves existing files and grants lasting scoped access", async (t) => {
  const { boot, root } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite();
  const directory = path.join(root, "existing-server");
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "server.jar"),
    "fixture server launcher",
  );
  await fs.writeFile(
    path.join(directory, "server.properties"),
    "server-port=25702\nmotd=Original server\n",
  );
  await fs.writeFile(
    path.join(directory, "world.dat"),
    "preserve existing world",
  );
  const input = {
    requestId: randomUUID(),
    directory,
    name: "Remote import",
    jar: "server.jar",
    port: 25702,
  };
  const inspected = await actor.request(
    "/api/server-import/inspect",
    json("POST", { directory }),
  );
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  const created = await actor.request(
    "/api/server-import",
    json("POST", input),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    created.body.server.accessPermissions.slice().sort(),
    catalog.roleDefaults.admin.slice().sort(),
  );
  const again = await actor.request("/api/server-import", json("POST", input));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.server.id, created.body.server.id);
  assert.equal((await panel.local("/api/servers")).body.servers.length, 2);
  assert.equal(
    await fs.readFile(path.join(directory, "world.dat"), "utf8"),
    "preserve existing world",
  );
  assert.equal(
    await fs.readFile(path.join(directory, "server.properties"), "utf8"),
    "server-port=25702\nmotd=Original server\n",
  );
});

test("replaying creation cannot bypass a reset invitation for the created membership", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite();
  const input = setupInput();
  const created = await actor.request("/api/server-setup", json("POST", input));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.server.id;
  const users = await panel.local("/api/subusers", {
    headers: { "X-Server-Id": id },
  });
  assert.equal(users.body.users.length, 1);
  assert.equal(
    (
      await panel.local(`/api/subusers/${users.body.users[0].id}/invite`, {
        ...json("POST", {}),
        headers: { "X-Server-Id": id },
      })
    ).status,
    200,
  );
  const fresh = await panel.signed()(
    "/api/access/login",
    json("POST", { email: actor.user.email, password }),
  );
  assert.equal(fresh.status, 200);
  const requester = panel.signed(fresh.cookie);
  assert.deepEqual(
    (await requester("/api/servers")).body.servers.map((server) => server.id),
    [panel.id],
  );
  assert.equal(
    (await requester("/api/server-setup", json("POST", input))).status,
    403,
  );
  assert.deepEqual(
    (await requester("/api/servers")).body.servers.map((server) => server.id),
    [panel.id],
  );
});

test("membership capacity rejects create and import before adding registry entries or installation files", async (t) => {
  const { boot, dataDir, root } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite();
  await panel.close();
  // Populate only this isolated fixture's enrollment store, including pending
  // shares that count toward the same account limit without proving new access.
  const storage = path.join(dataDir, "remote-access.json");
  const state = JSON.parse(await fs.readFile(storage, "utf8"));
  const source = state.memberships[0];
  for (let index = state.memberships.length; index < 32; index++)
    state.memberships.push({
      serverId: randomUUID(),
      userId: randomUUID(),
      email: source.email,
      invitedAt: Date.now(),
    });
  await fs.writeFile(storage, JSON.stringify(state));
  const restarted = await boot();
  const requester = restarted.signed(actor.cookie);
  assert.deepEqual((await requester("/api/servers")).body.hostPermissions, [
    "server.create",
  ]);
  const installationDirectory = path.join(root, "must-not-be-created");
  const input = setupInput();
  input.configuration.installationDirectory = installationDirectory;
  const existingDirectory = path.join(root, "existing-at-capacity");
  await fs.mkdir(existingDirectory);
  await fs.writeFile(
    path.join(existingDirectory, "server.jar"),
    "fixture launcher",
  );
  await fs.writeFile(
    path.join(existingDirectory, "world.dat"),
    "original world",
  );
  const registryBefore = await fs.readFile(
    path.join(dataDir, "servers.json"),
    "utf8",
  );
  const directoriesBefore = await fs.readdir(root);
  for (const [route, body] of [
    ["/api/server-setup", input],
    [
      "/api/server-import",
      {
        requestId: randomUUID(),
        directory: existingDirectory,
        name: "At capacity",
        jar: "server.jar",
        port: 25700,
      },
    ],
  ]) {
    const rejected = await requester(route, json("POST", body));
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, /32 remote server memberships/);
  }
  assert.equal(
    await fs.readFile(path.join(dataDir, "servers.json"), "utf8"),
    registryBefore,
  );
  assert.deepEqual(await fs.readdir(root), directoriesBefore);
  await assert.rejects(fs.stat(installationDirectory), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(existingDirectory, "world.dat"), "utf8"),
    "original world",
  );
});

test("revocation after a failed creator-ready registry write cannot resurrect the creator on retry", async (t) => {
  const { boot, dataDir } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite();
  const input = setupInput();
  const rename = fs.rename.bind(fs);
  let registryWrites = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    if (target === path.join(dataDir, "servers.json") && ++registryWrites === 2)
      throw new Error(
        "Fixture creator-ready write failed after access enrollment",
      );
    return rename(source, target);
  });
  const failed = await actor.request("/api/server-setup", json("POST", input));
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.setupNotCreated, undefined);
  t.mock.restoreAll();
  const created = (await actor.request("/api/servers")).body.servers.find(
    (server) => server.id !== panel.id,
  );
  assert.ok(
    created,
    "Enrollment succeeded before the final registry write failed.",
  );
  const headers = { "X-Server-Id": created.id };
  const users = (await panel.local("/api/subusers", { headers })).body.users;
  assert.equal(users.length, 1);
  const removed = await panel.local(`/api/subusers/${users[0].id}`, {
    ...json("DELETE", {}),
    headers,
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const fresh = await panel.signed()(
    "/api/access/login",
    json("POST", { email: actor.user.email, password }),
  );
  assert.equal(fresh.status, 200);
  const requester = panel.signed(fresh.cookie);
  const retry = await requester("/api/server-setup", json("POST", input));
  assert.equal(retry.status, 403, JSON.stringify(retry.body));
  assert.equal(retry.body.setupNotCreated, undefined);
  assert.deepEqual(
    (await panel.local("/api/subusers", { headers })).body.users,
    [],
  );
  assert.deepEqual(
    (await requester("/api/servers")).body.servers.map((server) => server.id),
    [panel.id],
  );
  assert.equal((await panel.local("/api/servers")).body.servers.length, 2);
});

test("owner grant input rejects null, malformed values, and unknown computer permissions", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const actor = await panel.invite();
  for (const hostPermissions of [
    null,
    "server.create",
    ["server.delete"],
    ["server.create", 123],
  ]) {
    assert.equal(
      (
        await panel.local(
          "/api/subusers",
          json("POST", {
            email: "invalid@example.test",
            permissions: [],
            hostPermissions,
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await panel.local(
          `/api/subusers/${actor.user.id}`,
          json("PATCH", {
            permissions: actor.user.permissions,
            hostPermissions,
          }),
        )
      ).status,
      400,
    );
  }
  assert.deepEqual((await actor.request("/api/servers")).body.hostPermissions, [
    "server.create",
  ]);
});
