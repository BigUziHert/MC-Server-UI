import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createFleet } from "./index.mjs";

const listen = (app) =>
  new Promise((resolve) => {
    const server = http
      .createServer(app)
      .listen(0, "127.0.0.1", () => resolve(server));
  });
const stop = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const request = (port, route, { method = "GET", body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (raw += chunk));
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(raw) });
          } catch (cause) {
            reject(cause);
          }
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(data);
  });

test("managed HTTPS gates real invitation routes while preserving the remote authentication boundary", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-managed-access-"));
  const temporary = await listen((_req, res) => res.end());
  const upstreamPort = temporary.address().port;
  await stop(temporary);
  let ready = false,
    enabled = false,
    closed = false,
    publicUrl;
  const managedHttps = {
    async configure(value) {
      enabled = value.enabled;
      publicUrl = value.enabled ? value.publicUrl : undefined;
    },
    status: () => ({
      ready: enabled && ready,
      state: enabled ? (ready ? "ready" : "provisioning") : "disabled",
      message: "Fixture certificate state",
      publicUrl,
    }),
    async close() {
      enabled = false;
      closed = true;
    },
  };
  const fleet = await createFleet({
    dataDir: root,
    useEnvironment: false,
    createDefaultServer: false,
    scheduler: false,
    managedHttps,
    publicAddress: { resolve: async () => null },
  });
  const owner = await listen(fleet.app);
  t.after(async () => {
    await stop(owner);
    await fleet.close();
    assert.equal(closed, true);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-managed-access-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const local = (route, options) =>
    request(owner.address().port, route, options);
  const remote = (route, options = {}) =>
    request(upstreamPort, route, {
      ...options,
      headers: {
        Host: "panel.example.com",
        Origin: "https://panel.example.com",
        ...options.headers,
      },
    });
  const configured = await local("/api/access/settings", {
    method: "PUT",
    body: {
      enabled: true,
      transport: "managed",
      publicUrl: "https://panel.example.com",
      port: upstreamPort,
    },
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.ready, false);
  assert.equal(configured.body.managedHttps.state, "provisioning");
  const account = await local("/api/panel-users", {
    method: "POST",
    body: { email: "invited@example.com" },
  });
  assert.equal(account.status, 201);
  assert.equal(
    (
      await local(`/api/panel-users/${account.body.id}/invite`, {
        method: "POST",
        body: {},
      })
    ).status,
    409,
  );
  assert.equal((await remote("/api/access/session")).body.role, "guest");
  for (const route of [
    "/api/access/settings",
    "/api/panel-users",
    "/api/desktop/updates",
  ])
    assert.equal(
      (await remote(route)).status,
      401,
      `${route} cannot expose owner capabilities`,
    );
  assert.equal(
    (
      await remote("/api/access/login", {
        method: "POST",
        body: {
          email: "unknown@example.com",
          password: "unknown long password",
        },
      })
    ).status,
    401,
  );
  ready = true;
  assert.equal((await local("/api/access/settings")).body.ready, true);
  const invitation = await local(`/api/panel-users/${account.body.id}/invite`, {
    method: "POST",
    body: {},
  });
  assert.equal(invitation.status, 200);
  const token = invitation.body.invitationUrl.split("#invite=")[1];
  ready = false;
  assert.equal(
    (
      await local(`/api/panel-users/${account.body.id}/invite`, {
        method: "POST",
        body: {},
      })
    ).status,
    409,
  );
  ready = true;
  const accepted = await remote("/api/access/accept", {
    method: "POST",
    body: { token, password: "A new secure password!" },
  });
  assert.equal(accepted.status, 200);
  const signedHeaders = {
    Authorization: `Bearer ${accepted.body.sessionToken}`,
  };
  const servers = await remote("/api/servers", { headers: signedHeaders });
  assert.equal(servers.status, 200);
  assert.deepEqual(servers.body.servers, []);
  for (const route of [
    "/api/access/settings",
    "/api/panel-users",
    "/api/desktop/updates",
  ])
    assert.equal(
      (await remote(route, { headers: signedHeaders })).status,
      403,
      `${route} remains owner-only after sign-in`,
    );
  const users = await local("/api/panel-users");
  assert.equal(users.body.users.length, 1);
  assert.equal(users.body.users[0].id, account.body.id);
});
