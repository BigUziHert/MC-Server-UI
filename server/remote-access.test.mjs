import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createFleet } from "./index.mjs";
import { requiredPermissions } from "./remote-access.mjs";
import { processStartup } from "../tests/fixtures/process-options.mjs";

const origin = "https://panel.example.test";
const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-remote-access-"));
  const messages = [];
  const fleet = await createFleet({
    dataDir: root,
    useEnvironment: false,
    createDefaultServer: true,
    scheduler: false,
    remoteListen: false,
    publicAddress: { resolve: async () => null },
    sendMail: async (message) => messages.push(message),
  });
  const listen = (app) =>
    new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
  const owner = await listen(fleet.app),
    remote = await listen(fleet.remoteApp);
  const request =
    (listener, headers) =>
    async (route, options = {}) => {
      return new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${listener.address().port}${route}`,
          {
            method: options.method ?? "GET",
            headers: {
              "Content-Type": "application/json",
              ...headers,
              ...options.headers,
            },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              try {
                resolve({
                  status: res.statusCode,
                  body: JSON.parse(body),
                  cookie: res.headers["set-cookie"]?.[0],
                });
              } catch (cause) {
                reject(cause);
              }
            });
          },
        );
        req.on("error", reject);
        req.end(options.body);
      });
    };
  const local = request(owner, {});
  const guest = request(remote, { Host: "panel.example.test", Origin: origin });
  t.after(async () => {
    await fleet.close();
    for (const listener of [owner, remote]) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-remote-access-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(
    (
      await local(
        "/api/access/settings",
        json("PUT", {
          enabled: true,
          publicUrl: origin,
          from: "panel@example.test",
          apiKey: "fixture-email-key",
        }),
      )
    ).status,
    200,
  );
  const id = (await local("/api/servers")).body.defaultServerId;
  const invite = async (
    permissions,
    email = "sister@example.test",
    serverId = id,
  ) => {
    const response = await local("/api/subusers", {
      ...json("POST", { email, permissions }),
      headers: { "X-Server-Id": serverId },
    });
    assert.equal(response.status, 201);
    const user = response.body;
    const sent = await local(`/api/subusers/${user.id}/invite`, {
      method: "POST",
      headers: { "X-Server-Id": serverId },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const token = /#invite=([A-Za-z0-9_-]+)/.exec(messages.at(-1).text)[1];
    const signed = await guest("/api/access/accept", json("POST", { token }));
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const cookie = signed.cookie.split(";")[0];
    const asUser = request(remote, {
      Host: "panel.example.test",
      Origin: origin,
      Cookie: cookie,
    });
    return { user, cookie, token, asUser };
  };
  return { fleet, root, id, local, guest, invite, messages };
}

test("remote gateway never grants owner access, even with forged headers or a localhost Host", async (t) => {
  const { guest, local } = await fixture(t);
  assert.deepEqual((await local("/api/access/session")).body, {
    role: "owner",
  });
  assert.deepEqual((await guest("/api/access/session")).body, {
    role: "guest",
  });
  for (const route of [
    "/api/servers",
    "/api/access/settings",
    "/api/files/download?path=server.properties",
  ])
    assert.equal(
      (
        await guest(route, {
          headers: {
            "X-Remote-Principal": "owner",
            "X-Forwarded-For": "127.0.0.1",
          },
        })
      ).status,
      401,
    );
  assert.equal(
    (await guest("/api/servers", { headers: { Host: "localhost:3002" } }))
      .status,
    401,
  );
  assert.equal(
    (await guest("/api/access/session", { headers: { Host: "evil.example" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await guest("/api/access/login", {
        ...json("POST", { email: "sister@example.test" }),
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
});

test("invited phone sessions are server-scoped, honor changed permissions, and revoke immediately", async (t) => {
  const { local, guest, invite, id } = await fixture(t);
  const { user, asUser, token } = await invite([
    "control.console",
    "control.start",
  ]);
  assert.equal(
    (await guest("/api/access/accept", json("POST", { token }))).status,
    401,
  );
  const fleet = (await asUser("/api/servers")).body;
  assert.deepEqual(
    fleet.servers.map((s) => s.id),
    [id],
  );
  assert.deepEqual(fleet.servers[0].accessPermissions, [
    "control.console",
    "control.start",
  ]);
  assert.equal(fleet.servers[0].javaPath, undefined);
  assert.equal(fleet.servers[0].serverDir, undefined);
  assert.equal((await asUser("/api/console")).status, 200);
  for (const action of ["stop", "restart", "force-stop"])
    assert.equal(
      (
        await asUser(
          "/api/server/power",
          json("POST", { action, confirmed: true }),
        )
      ).status,
      403,
    );
  for (const command of ["stop", "/stop", " Stop "])
    assert.equal(
      (await asUser("/api/console/command", json("POST", { command }))).status,
      403,
    );
  for (const route of [
    "/api/files",
    "/api/access/settings",
    "/api/audit?scope=panel",
    "/api/desktop/updates",
    "/api/versions",
  ])
    assert.equal((await asUser(route)).status, 403, route);
  assert.equal(
    (
      await asUser("/api/server", {
        headers: { "X-Server-Id": "unrelated-server" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await asUser(`/api/server?serverId=${id}`, {
        headers: { "X-Server-Id": "unrelated-server" },
      })
    ).status,
    400,
  );
  await local(`/api/subusers/${user.id}`, json("PATCH", { permissions: [] }));
  assert.equal((await asUser("/api/console")).status, 403);
  assert.equal((await asUser("/api/server")).status, 200);
  await local(`/api/subusers/${user.id}`, { method: "DELETE" });
  assert.equal((await asUser("/api/server")).status, 401);
});

test("remote subuser managers cannot escalate through roles, explicit permissions, or encoded target identifiers", async (t) => {
  const { local, invite } = await fixture(t);
  const { asUser, user } = await invite([
    "user.create",
    "user.update",
    "user.delete",
    "user.read",
  ]);
  const privileged = (
    await local(
      "/api/subusers",
      json("POST", { email: "admin@example.test", role: "admin" }),
    )
  ).body;
  assert.equal(
    (
      await asUser(
        "/api/subusers",
        json("POST", { email: "escalation@example.test", role: "admin" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await asUser(
        `/api/subusers/${user.id}`,
        json("PATCH", { permissions: ["control.start"] }),
      )
    ).status,
    403,
  );
  const encoded = `%${privileged.id.charCodeAt(0).toString(16)}${privileged.id.slice(1)}`;
  for (const id of [privileged.id, encoded]) {
    assert.equal(
      (await asUser(`/api/subusers/${id}`, json("PATCH", { permissions: [] })))
        .status,
      403,
    );
    assert.equal(
      (await asUser(`/api/subusers/${id}`, { method: "DELETE" })).status,
      403,
    );
    assert.equal(
      (await asUser(`/api/subusers/${id}/invite`, { method: "POST" })).status,
      403,
    );
  }
  assert.equal(
    (
      await asUser(
        "/api/subusers",
        json("POST", {
          email: "limited@example.test",
          permissions: ["user.read"],
        }),
      )
    ).status,
    201,
  );
});

test("remote power controls reach the actual server process and record the subuser actor", async (t) => {
  const { local, invite, fleet, id } = await fixture(t);
  await local(`/api/servers/${id}`, json("PATCH", processStartup));
  await fs.writeFile(
    path.join(fleet.runtimes.get(id).serverDir, "eula.txt"),
    "eula=true\n",
  );
  const { asUser } = await invite([
    "control.console",
    "control.start",
    "control.stop",
    "audit.read",
  ]);
  assert.equal(
    (await asUser("/api/server/power", json("POST", { action: "start" })))
      .status,
    200,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await asUser("/api/server")).body.status === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await asUser("/api/server")).body.status, "running");
  assert.equal(
    (
      await asUser(
        "/api/console/command",
        json("POST", { command: "say Hello from phone" }),
      )
    ).status,
    200,
  );
  const entries = (await asUser("/api/audit")).body.entries;
  assert.ok(
    entries.some(
      (entry) =>
        entry.actor === "sister@example.test" &&
        entry.detail === "say Hello from phone",
    ),
  );
  assert.equal(
    (await asUser("/api/server/power", json("POST", { action: "stop" })))
      .status,
    200,
  );
});

test("remote file creation and download use distinct permissions and logout invalidates the cookie", async (t) => {
  const { invite } = await fixture(t);
  const { asUser } = await invite(["file.create"]);
  assert.equal(
    (
      await asUser(
        "/api/files",
        json("POST", { name: "phone.txt", type: "file", content: "hello" }),
      )
    ).status,
    201,
  );
  assert.equal((await asUser("/api/files/content?path=phone.txt")).status, 403);
  assert.equal(
    (
      await asUser(
        "/api/files/content",
        json("PUT", { path: "phone.txt", content: "changed" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await asUser("/api/access/logout", { method: "POST" })).status,
    200,
  );
  assert.equal((await asUser("/api/server")).status, 401);
});

test("remote route permissions fail closed for unassigned routes and distinguish destructive storage actions", () => {
  const routes = [
    ["GET", "/api/files/download", ["file.read-content"]],
    ["POST", "/api/files/upload", ["file.create"]],
    ["PUT", "/api/backups/schedule", ["backup.update"]],
    ["GET", "/api/backups/id/download", ["backup.download"]],
    ["DELETE", "/api/backups/id", ["backup.delete"]],
    ["POST", "/api/databases", ["database.create"]],
    ["GET", "/api/databases/id/download", ["database.download"]],
    ["DELETE", "/api/databases/id", ["database.delete"]],
    [
      "POST",
      "/api/files/recycle-bin/id/restore",
      ["file.create", "backup.create"],
    ],
    ["DELETE", "/api/files/recycle-bin/id", ["file.delete", "backup.delete"]],
  ];
  for (const [method, path, expected] of routes)
    assert.deepEqual(
      requiredPermissions({ method, path, query: {} }),
      expected,
    );
  for (const path of [
    "/api/servers",
    "/api/server-import",
    "/api/launchpad/install",
    "/api/minecraft/properties/save",
    "/api/server/icon",
    "/api/future-feature",
  ])
    assert.throws(
      () => requiredPermissions({ method: "POST", path, query: {} }),
      { status: 403 },
    );
});
