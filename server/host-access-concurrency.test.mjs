import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createFleet } from "./index.mjs";

test("concurrent login skips unavailable memberships while creation owns the fleet queue", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-host-lock-")),
  );
  const dataDir = path.join(root, "panel");
  const external = path.join(root, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "server.jar"), "existing server jar");
  await fs.writeFile(
    path.join(external, "server.properties"),
    "server-port=25891\nmotd=Existing\n",
  );
  const origin = "https://concurrency.example.test";
  let fleet, owner, remote;
  const close = async () => {
    if (!fleet) return;
    await fleet.close();
    for (const listener of [owner, remote]) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    fleet = null;
  };
  t.after(async () => {
    await close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-host-lock-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const boot = async () => {
    fleet = await createFleet({
      dataDir,
      useEnvironment: false,
      createDefaultServer: true,
      scheduler: false,
      remoteListen: false,
      publicAddress: { resolve: async () => null },
    });
    const listen = (app) =>
      new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
    owner = await listen(fleet.app);
    remote = await listen(fleet.remoteApp);
  };
  const request = (
    remoteRequest,
    route,
    { method = "GET", body, cookie, serverId } = {},
  ) =>
    new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        `http://127.0.0.1:${(remoteRequest ? remote : owner).address().port}${route}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(bytes ? { "Content-Length": Buffer.byteLength(bytes) } : {}),
            ...(remoteRequest
              ? { Host: "concurrency.example.test", Origin: origin }
              : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...(serverId ? { "X-Server-Id": serverId } : {}),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (part) => {
            text += part;
          });
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode,
                body: JSON.parse(text),
                cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
              });
            } catch (cause) {
              reject(cause);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(bytes);
    });
  await boot();
  assert.equal(
    (
      await request(false, "/api/access/settings", {
        method: "PUT",
        body: { enabled: true, publicUrl: origin, transport: "proxy" },
      })
    ).status,
    200,
  );
  const sourceId = (await request(false, "/api/servers")).body.defaultServerId;
  const imported = await request(false, "/api/server-import", {
    method: "POST",
    body: { directory: external, jar: "server.jar", port: 25891 },
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const missingId = imported.body.server.id;
  const password = "Concurrency-test-password!";
  const email = "creator@example.test";
  let cookie;
  for (const serverId of [sourceId, missingId]) {
    const user = await request(false, "/api/subusers", {
      method: "POST",
      serverId,
      body: {
        email,
        permissions: ["file.read"],
        hostPermissions: ["server.create"],
      },
    });
    assert.equal(user.status, 201);
    const invite = await request(
      false,
      `/api/subusers/${user.body.id}/invite`,
      { method: "POST", serverId, body: {} },
    );
    const accepted = await request(true, "/api/access/accept", {
      method: "POST",
      body: {
        token: new URL(invite.body.invitationUrl).hash.slice(8),
        password,
      },
    });
    assert.equal(accepted.status, 200);
    if (serverId === sourceId) cookie = accepted.cookie;
  }
  await close();
  await fs.rename(external, `${external}-unplugged`);
  await boot();
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const rename = fs.rename;
  let held = false;
  fs.rename = async (from, to) => {
    if (!held && to === path.join(dataDir, "servers.json")) {
      held = true;
      entered();
      await gate;
    }
    return rename(from, to);
  };
  const bounded = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} waited on a locked fleet queue`)),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let created;
  try {
    created = request(true, "/api/server-setup", {
      method: "POST",
      cookie,
      body: {
        requestId: randomUUID(),
        confirmed: true,
        configuration: {
          name: "Parallel create",
          mode: "live",
          port: 25892,
          memoryLimitMB: 2048,
        },
      },
    });
    await bounded(reached, "Creation checkpoint");
    const login = await bounded(
      request(true, "/api/access/login", {
        method: "POST",
        body: { email, password },
      }),
      "Concurrent login",
    );
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.deepEqual(
      login.body.memberships.map((item) => item.serverId),
      [sourceId],
    );
    assert.equal(
      (
        await request(true, "/api/files", {
          cookie: login.cookie,
          serverId: missingId,
        })
      ).status,
      403,
    );
    release();
    const result = await bounded(created, "Creation completion");
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const visible = await request(true, "/api/servers", { cookie });
    assert.deepEqual(
      new Set(visible.body.servers.map((item) => item.id)),
      new Set([sourceId, result.body.server.id]),
    );
  } finally {
    release();
    fs.rename = rename;
    await created;
  }
});
