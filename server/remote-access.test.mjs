import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createFleet } from "./index.mjs";
import { requiredPermissions } from "./remote-access.mjs";
import { createAccessService } from "./access.mjs";
import { processStartup } from "../tests/fixtures/process-options.mjs";

const origin = "https://panel.example.test";
const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-remote-access-"));
  const fleet = await createFleet({
    dataDir: root,
    useEnvironment: false,
    createDefaultServer: true,
    scheduler: false,
    remoteListen: false,
    publicAddress: { resolve: async () => "203.0.113.4" },
    localAddresses: () => ["192.168.1.50"],
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
          transport: "proxy",
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
    password = "Correct-test-password!",
    existingCookie,
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
    const token = new URL(sent.body.invitationUrl).hash.slice(
      "#invite=".length,
    );
    const signed = await guest("/api/access/accept", {
      ...json("POST", { token, password }),
      ...(existingCookie ? { headers: { Cookie: existingCookie } } : {}),
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const cookie = signed.cookie.split(";")[0];
    const asUser = request(remote, {
      Host: "panel.example.test",
      Origin: origin,
      Cookie: cookie,
    });
    return { user, cookie, token, asUser, session: signed.body };
  };
  return { fleet, root, id, local, guest, invite };
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
    "/api/access/network",
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

test("host folder browsing is local-only even for an authenticated user with file access", async (t) => {
  const { local, guest, invite, root } = await fixture(t);
  const directory = await fs.realpath(root);
  const route = `/api/server-setup/directories?${new URLSearchParams({ directory })}`;
  const localResponse = await local(route);
  assert.equal(localResponse.status, 200, JSON.stringify(localResponse.body));
  assert.equal((await guest(route)).status, 401);
  const { asUser } = await invite(["file.read", "file.read-content"]);
  const response = await asUser(route);
  assert.equal(response.status, 403);
  assert.equal(Object.hasOwn(response.body, "folders"), false);
});

test("remote settings require an explicit grant and only update the selected server's safe configuration", async (t) => {
  const { local, invite, id, root, fleet } = await fixture(t);
  const first = await invite(["control.console"]);
  assert.equal((await first.asUser("/api/server/settings")).status, 403);
  assert.equal(
    (
      await first.asUser(
        "/api/server/settings",
        json("PATCH", { name: "Denied" }),
      )
    ).status,
    403,
  );
  const created = await local(
    "/api/servers",
    json("POST", { name: "Creative", port: 25566 }),
  );
  assert.equal(created.status, 201);
  const secondId = created.body.server.id;
  const second = await invite(
    ["server.update"],
    "sister@example.test",
    secondId,
    "Another-test-password!",
    first.cookie,
  );
  const scoped = (body) => ({
    ...json("PATCH", body),
    headers: { "X-Server-Id": secondId },
  });
  const visible = await second.asUser("/api/server/settings", {
    headers: { "X-Server-Id": secondId },
  });
  assert.equal(visible.status, 200, JSON.stringify(visible.body));
  assert.deepEqual(visible.body.server.accessPermissions, ["server.update"]);
  for (const field of [
    "javaPath",
    "jar",
    "launchScript",
    "launchExecutable",
    "launchArgs",
    "serverDir",
    "dataDir",
  ])
    assert.equal(Object.hasOwn(visible.body.server, field), false, field);
  for (const unsafe of [
    { javaPath: "other" },
    { launchExecutable: "other" },
    { jar: "other.jar" },
    { serverDir: root },
    { mode: "live" },
    { hostPermissions: ["server.create"] },
  ])
    assert.equal(
      (
        await second.asUser(
          "/api/server/settings",
          scoped({ name: "Unsafe", ...unsafe }),
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await second.asUser(
        `/api/servers/${secondId}`,
        scoped({ name: "Owner route" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await second.asUser("/api/server/settings", {
        ...json("PATCH", { name: "Wrong membership" }),
        headers: { "X-Server-Id": id },
      })
    ).status,
    403,
  );
  assert.equal(
    (await second.asUser("/api/server/settings", scoped({ port: 25565 })))
      .status,
    409,
  );
  const saved = await second.asUser(
    "/api/server/settings",
    scoped({
      name: "Creative renamed",
      connectionHost: "play.example.test",
      port: 25567,
      memoryLimitMB: 3072,
      motd: "Shared creative world",
    }),
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.server.name, "Creative renamed");
  assert.equal(saved.body.server.jar, undefined);
  assert.deepEqual(saved.body.server.accessPermissions, ["server.update"]);
  const registry = JSON.parse(
    await fs.readFile(path.join(root, "servers.json"), "utf8"),
  );
  assert.equal(
    registry.servers.find((entry) => entry.id === secondId).name,
    "Creative renamed",
  );
  assert.equal(registry.servers.find((entry) => entry.id === id).port, 25565);
  const properties = await fs.readFile(
    path.join(fleet.runtimes.get(secondId).serverDir, "server.properties"),
    "utf8",
  );
  assert.match(properties, /server-port=25567/);
  assert.match(properties, /motd=Shared creative world/);
  assert.equal(
    (
      await local(`/api/subusers/${second.user.id}`, {
        ...json("PATCH", { permissions: [] }),
        headers: { "X-Server-Id": secondId },
      })
    ).status,
    200,
  );
  assert.equal(
    (await second.asUser("/api/server/settings", scoped({ name: "Revoked" })))
      .status,
    403,
  );
});

test("remote copy checks proven source read access and destination create access independently", async (t) => {
  const { local, invite, id, fleet } = await fixture(t);
  const created = await local(
    "/api/servers",
    json("POST", { name: "Copy destination", port: 25566 }),
  );
  const targetId = created.body.server.id;
  const sourceDir = fleet.runtimes.get(id).serverDir;
  const targetDir = fleet.runtimes.get(targetId).serverDir;
  await fs.writeFile(
    path.join(sourceDir, "source.txt"),
    "Only proven readers can copy this.",
  );
  const source = await invite(["file.read-content"]);
  const unprovenTarget = await invite(
    ["file.create"],
    "sister@example.test",
    targetId,
    "Destination-test-password!",
  );
  const request = (paths = ["source.txt"]) => ({
    ...json("POST", {
      sourceServerId: id,
      paths,
      destinationPath: "",
      requestId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    }),
    headers: {
      "X-Server-Id": targetId,
      "X-Copy-Source-Server-Id": id,
      "X-Copy-Source-User-Id": source.user.id,
    },
  });
  assert.equal(
    (await unprovenTarget.asUser("/api/files/copy", request())).status,
    403,
  );
  // Accept a new invitation with the proven source cookie to join both scopes.
  const invitation = await local(
    `/api/subusers/${unprovenTarget.user.id}/invite`,
    { method: "POST", headers: { "X-Server-Id": targetId } },
  );
  const token = new URL(invitation.body.invitationUrl).hash.slice(
    "#invite=".length,
  );
  const accepted = await source.asUser(
    "/api/access/accept",
    json("POST", { token, password: "Destination-test-password!" }),
  );
  assert.equal(accepted.status, 200);
  const cookie = accepted.cookie.split(";")[0];
  const asBoth = (route, options = {}) =>
    source.asUser(route, {
      ...options,
      headers: { ...options.headers, Cookie: cookie },
    });
  const copied = await asBoth("/api/files/copy", request());
  assert.equal(copied.status, 201, JSON.stringify(copied.body));
  assert.equal(copied.body.copiedFiles, 1);
  assert.equal(
    await fs.readFile(path.join(targetDir, "source.txt"), "utf8"),
    await fs.readFile(path.join(sourceDir, "source.txt"), "utf8"),
  );
  const progress = await asBoth("/api/files/copy-operation", {
    headers: { "X-Server-Id": targetId },
  });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.operation.status, "completed");
  assert.equal(
    (
      await asBoth("/api/files/copy-operation", {
        headers: { "X-Server-Id": id },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await asBoth("/api/files/copy", {
        ...request(),
        headers: { "X-Server-Id": id },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await local(
        `/api/subusers/${source.user.id}`,
        json("PATCH", { permissions: [] }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await asBoth("/api/files/copy", request())).status,
    403,
    "Completed requests cannot be replayed after source permission is revoked.",
  );
  await local(`/api/subusers/${unprovenTarget.user.id}`, {
    ...json("PATCH", { permissions: ["file.read"] }),
    headers: { "X-Server-Id": targetId },
  });
  assert.equal(
    (
      await asBoth("/api/files/copy-operation", {
        headers: { "X-Server-Id": targetId },
      })
    ).status,
    403,
  );
});

test("remote settings recheck a grant after entering the fleet update operation", async (t) => {
  const { local, invite, fleet } = await fixture(t);
  const { asUser, user } = await invite(["server.update"]);
  const authenticate = fleet.access.authenticate;
  let calls = 0;
  let reached;
  let release;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(fleet.access, "authenticate", async (req) => {
    if (req.path === "/api/server/settings" && ++calls === 2) {
      reached();
      await held;
    }
    return authenticate(req);
  });
  const saving = asUser(
    "/api/server/settings",
    json("PATCH", { name: "Must not be saved" }),
  );
  try {
    await entered;
    assert.equal(
      (
        await local(
          `/api/subusers/${user.id}`,
          json("PATCH", { permissions: [] }),
        )
      ).status,
      200,
    );
  } finally {
    release();
  }
  const result = await saving;
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.notEqual(
    (await local("/api/servers")).body.servers[0].name,
    "Must not be saved",
  );
});

for (const resetScope of ["source", "target"]) {
  test(`a running remote copy stops when the ${resetScope} invitation is reset`, async (t) => {
    const { local, invite, id, fleet } = await fixture(t);
    const created = await local(
      "/api/servers",
      json("POST", { name: "Reset destination", port: 25566 }),
    );
    const targetId = created.body.server.id;
    const sourceFile = path.join(
      fleet.runtimes.get(id).serverDir,
      "large-copy.bin",
    );
    const targetFile = path.join(
      fleet.runtimes.get(targetId).serverDir,
      "large-copy.bin",
    );
    const originalBytes = Buffer.alloc(2 * 1024 * 1024, 91);
    await fs.writeFile(sourceFile, originalBytes);
    const source = await invite(["file.read-content"]);
    const target = await invite(
      ["file.create"],
      "sister@example.test",
      targetId,
      "Reset-test-password!",
      source.cookie,
    );
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
    const copying = target.asUser("/api/files/copy", {
      ...json("POST", {
        sourceServerId: id,
        paths: ["large-copy.bin"],
        destinationPath: "",
      }),
      headers: { "X-Server-Id": targetId },
    });
    try {
      await Promise.race([
        reading,
        copying.then((response) => {
          throw new Error(
            `Copy finished before the held read: ${JSON.stringify(response)}`,
          );
        }),
      ]);
      const membership = resetScope === "source" ? source : target;
      const reset = await local(`/api/subusers/${membership.user.id}/invite`, {
        method: "POST",
        headers: { "X-Server-Id": resetScope === "source" ? id : targetId },
      });
      assert.equal(reset.status, 200, JSON.stringify(reset.body));
    } finally {
      release();
    }
    const result = await copying;
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(result.body.copiedFiles, 0);
    await assert.rejects(fs.stat(targetFile), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(sourceFile), originalBytes);
  });
}

test("invited phone sessions are server-scoped, honor changed permissions, and revoke immediately", async (t) => {
  const { local, guest, invite, id } = await fixture(t);
  const { user, asUser, token } = await invite([
    "control.console",
    "control.start",
  ]);
  assert.equal(
    (
      await guest(
        "/api/access/accept",
        json("POST", { token, password: "Correct-test-password!" }),
      )
    ).status,
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
    "/api/server-recovery",
    `/api/server-recovery/${id}`,
    "/api/versions",
  ])
    assert.equal((await asUser(route)).status, 403, route);
  assert.equal(
    (
      await asUser(
        `/api/server-recovery/${id}`,
        json("POST", { confirmed: true, revision: "forged" }),
      )
    ).status,
    403,
  );
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

test("remote server rosters retain the Minecraft release separately from the loader build", async (t) => {
  const { fleet, local, invite, id } = await fixture(t);
  const { asUser } = await invite([]);
  const initial = (await asUser("/api/servers")).body.servers[0];
  assert.equal(initial.minecraftVersion, null);

  const argumentFile = "libraries/net/neoforged/neoforge/21.1.251/win_args.txt";
  const target = path.join(fleet.runtimes.get(id).serverDir, argumentFile);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "net.fixture.Main\n");
  const configured = await local(
    `/api/servers/${id}`,
    json("PATCH", {
      launchType: "java-args",
      launchArgs: [`@${argumentFile}`, "nogui"],
    }),
  );
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const roster = await asUser("/api/servers");
  const selected = await asUser("/api/server");
  assert.equal(roster.status, 200);
  assert.equal(selected.status, 200);
  for (const server of [roster.body.servers[0], selected.body]) {
    assert.equal(server.id, id);
    assert.equal(server.software, "NeoForge");
    assert.equal(server.version, "21.1.251");
    assert.equal(server.minecraftVersion, "1.21.1");
  }
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
    ["GET", "/api/files/recycle-operation", ["file.read"]],
    ["HEAD", "/api/files/recycle-operation", ["file.read"]],
    ["GET", "/api/server/settings", ["server.update"]],
    ["HEAD", "/api/server/settings", ["server.update"]],
    ["PATCH", "/api/server/settings", ["server.update"]],
    ["POST", "/api/files/copy", ["file.create"]],
    ["GET", "/api/files/copy-operation", ["file.create"]],
    ["HEAD", "/api/files/copy-operation", ["file.create"]],
    ["GET", "/api/files/download", ["file.read-content"]],
    ["POST", "/api/files/upload", ["file.create"]],
    ["PUT", "/api/backups/schedule", ["backup.update"]],
    ["GET", "/api/backups/id/download", ["backup.download"]],
    ["DELETE", "/api/backups/id", ["backup.delete"]],
    ["GET", "/api/players", []],
    ["POST", "/api/players/ban", ["control.console"]],
    ["POST", "/api/players/whitelist/state", ["control.console"]],
    ["GET", "/api/versions", ["file.read"]],
    ["GET", "/api/versions/jobs/job-id", ["file.read"]],
    ["GET", "/api/launchpad/installed", ["file.read"]],
    ["GET", "/api/launchpad/jobs/job-id", ["file.read"]],
    ["GET", "/api/minecraft/properties/file", ["file.read-content"]],
    ["POST", "/api/minecraft/properties/save", ["file.update"]],
    ...[
      "/api/versions/install",
      "/api/launchpad/install",
      "/api/launchpad/preview",
      "/api/launchpad/remove",
    ].map((path) => [
      "POST",
      path,
      [
        "file.create",
        "file.update",
        "file.delete",
        "control.start",
        "control.stop",
      ],
    ]),
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
    "/api/launchpad/settings",
    "/api/server/icon",
    "/api/future-feature",
  ])
    assert.throws(
      () => requiredPermissions({ method: "POST", path, query: {} }),
      { status: 403 },
    );
});

test("the shared panel exposes standard pages within the user's file and console grants", async (t) => {
  const { invite, local } = await fixture(t);
  assert.equal(
    (
      await local(
        "/api/files",
        json("POST", {
          name: "server.properties",
          type: "file",
          content: "motd=Shared test server\n",
        }),
      )
    ).status,
    201,
  );
  const { asUser } = await invite(["file.read", "file.read-content"]);
  assert.equal((await asUser("/api/players")).status, 200);
  assert.equal((await asUser("/api/versions")).status, 200);
  const properties = await asUser("/api/minecraft/properties");
  assert.equal(properties.status, 200);
  assert.ok(
    properties.body.files.some((file) => file.path === "server.properties"),
  );
  assert.equal(
    (await asUser("/api/minecraft/properties/file?path=server.properties"))
      .status,
    200,
  );
  for (const route of [
    "/api/players/op",
    "/api/minecraft/properties/save",
    "/api/versions/install",
    "/api/launchpad/preview",
    "/api/launchpad/remove",
  ])
    assert.equal((await asUser(route, json("POST", {}))).status, 403, route);
  assert.equal(
    (
      await asUser(
        "/api/launchpad/settings",
        json("PUT", { curseforgeApiKey: "not-saved" }),
      )
    ).status,
    403,
  );
  const { asUser: restricted } = await invite([], "restricted@example.test");
  for (const route of [
    "/api/versions",
    "/api/launchpad",
    "/api/minecraft/properties",
    "/api/minecraft/properties/file?path=server.properties",
  ])
    assert.equal((await restricted(route)).status, 403, route);
});

test("remote recycle progress is readable only within the current live file-reading grant", async (t) => {
  const { fleet, id, local, invite } = await fixture(t);
  const runtime = fleet.runtimes.get(id);
  const source = path.join(runtime.serverDir, "tacz");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "pack.json"), '{"fixture":true}');
  const other = await local(
    "/api/servers",
    json("POST", { name: "Private server", port: 25566 }),
  );
  assert.equal(other.status, 201);
  const reader = await invite(["file.read"], "reader@example.test");
  const deleter = await invite(["file.delete"], "deleter@example.test");
  assert.deepEqual((await reader.asUser("/api/files/recycle-operation")).body, {
    operation: null,
  });
  assert.equal(
    (await deleter.asUser("/api/files/recycle-operation")).status,
    403,
  );
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const checkpoint = new Promise((resolve) => {
    entered = resolve;
  });
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (from === source && path.basename(to) === "content") {
      entered();
      await gate;
    }
    return rename(from, to);
  });
  const deletion = deleter.asUser("/api/files?path=tacz", { method: "DELETE" });
  try {
    await checkpoint;
    const running = await reader.asUser("/api/files/recycle-operation");
    assert.equal(running.status, 200, JSON.stringify(running.body));
    assert.equal(running.body.operation.path, "tacz");
    assert.equal(running.body.operation.status, "running");
    const serialized = JSON.stringify(running.body);
    for (const privatePath of [runtime.serverDir, runtime.dataDir])
      assert.equal(
        serialized.includes(JSON.stringify(privatePath).slice(1, -1)),
        false,
        "Progress never exposes host filesystem roots.",
      );
    assert.equal(Object.hasOwn(running.body.operation, "backup"), false);
    for (const request of [
      { headers: { "X-Server-Id": other.body.server.id } },
      {
        route: `/api/files/recycle-operation?serverId=${other.body.server.id}`,
      },
    ]) {
      assert.equal(
        (
          await reader.asUser(
            request.route ?? "/api/files/recycle-operation",
            request,
          )
        ).status,
        403,
      );
    }
    assert.deepEqual(
      (
        await local("/api/files/recycle-operation", {
          headers: { "X-Server-Id": other.body.server.id },
        })
      ).body,
      { operation: null },
    );
    assert.equal(
      (
        await local(`/api/subusers/${reader.user.id}`, {
          ...json("PATCH", { permissions: [] }),
          headers: { "X-Server-Id": id },
        })
      ).status,
      200,
    );
    assert.equal(
      (await reader.asUser("/api/files/recycle-operation")).status,
      403,
    );
    assert.equal(
      (
        await local(`/api/subusers/${reader.user.id}`, {
          ...json("PATCH", { permissions: ["file.read"] }),
          headers: { "X-Server-Id": id },
        })
      ).status,
      200,
    );
  } finally {
    release();
  }
  const result = await deletion;
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const completed = await reader.asUser("/api/files/recycle-operation");
  assert.equal(completed.status, 200);
  assert.equal(completed.body.operation.status, "completed");
  assert.equal(completed.body.operation.path, "tacz");
  assert.equal(
    completed.body.operation.recycled.kind,
    undefined,
    "File progress cannot expose backup recovery metadata.",
  );
  assert.equal(completed.body.operation.recycled.backup, undefined);
  const firstId = completed.body.operation.id;
  await fs.writeFile(
    path.join(runtime.serverDir, "second.txt"),
    "second fixture",
  );
  assert.equal(
    (await deleter.asUser("/api/files?path=second.txt", { method: "DELETE" }))
      .status,
    200,
  );
  const retained = await reader.asUser(
    `/api/files/recycle-operation?requestId=${firstId.toUpperCase()}`,
  );
  assert.equal(retained.status, 200);
  assert.equal(retained.body.operation.id, firstId);
  assert.equal(retained.body.operation.path, "tacz");
  assert.equal(retained.body.operation.status, "completed");
  assert.deepEqual(
    (
      await reader.asUser(
        "/api/files/recycle-operation?requestId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      )
    ).body,
    { operation: null },
  );
  assert.equal(
    (await reader.asUser("/api/files/recycle-operation?requestId=invalid"))
      .status,
    400,
  );
  assert.equal(
    (
      await reader.asUser(`/api/files/recycle-operation?requestId=${firstId}`, {
        headers: { "X-Server-Id": other.body.server.id },
      })
    ).status,
    403,
  );
  assert.deepEqual(
    (
      await local(`/api/files/recycle-operation?requestId=${firstId}`, {
        headers: { "X-Server-Id": other.body.server.id },
      })
    ).body,
    { operation: null },
  );
});

test("remote recycle failure progress never exposes host paths or records invalid path requests", async (t) => {
  const { fleet, id, invite } = await fixture(t);
  t.mock.method(console, "error", () => {});
  const runtime = fleet.runtimes.get(id);
  const source = path.join(runtime.serverDir, "locked.txt");
  await fs.writeFile(source, "fixture contents are retained");
  const { asUser } = await invite(["file.read", "file.delete"]);
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (from === source && path.basename(to) === "content")
      throw Object.assign(
        new Error(`EPERM: cannot rename '${source}' to '${to}'`),
        { code: "EPERM" },
      );
    return rename(from, to);
  });
  const failure = await asUser("/api/files?path=locked.txt", {
    method: "DELETE",
  });
  assert.ok(failure.status >= 400);
  const progress = await asUser("/api/files/recycle-operation");
  assert.equal(progress.status, 200);
  assert.equal(progress.body.operation.status, "failed");
  assert.equal(progress.body.operation.path, "locked.txt");
  assert.equal(typeof progress.body.operation.error, "string");
  const serialized = JSON.stringify(progress.body);
  for (const privatePath of [runtime.serverDir, runtime.dataDir, source])
    assert.equal(
      serialized.includes(JSON.stringify(privatePath).slice(1, -1)),
      false,
      "An OS failure must not expose absolute host paths.",
    );
  const failedId = progress.body.operation.id;
  for (const invalid of [
    encodeURIComponent(source),
    "..%2Foutside",
    "x&path=y",
  ])
    assert.equal(
      (await asUser(`/api/files?path=${invalid}`, { method: "DELETE" })).status,
      400,
    );
  const retained = await asUser("/api/files/recycle-operation");
  assert.equal(retained.body.operation.id, failedId);
  assert.equal(
    await fs.readFile(source, "utf8"),
    "fixture contents are retained",
  );
});

test("network discovery is owner-only and does not claim the forwarded port is reachable", async (t) => {
  const { local, invite } = await fixture(t);
  assert.deepEqual((await local("/api/access/network")).body, {
    publicIp: "203.0.113.4",
    localAddresses: ["192.168.1.50"],
    port: 3002,
  });
  const { asUser } = await invite([]);
  assert.equal((await asUser("/api/access/network")).status, 403);
});

test("manual invitations never grant other servers merely because their email matches", async (t) => {
  const { local, invite, id, guest } = await fixture(t);
  const created = await local(
    "/api/servers",
    json("POST", { name: "Private world", port: 25566 }),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const secondId = created.body.server.id;
  const first = await invite(["control.console"]);
  const second = await invite(
    ["control.console"],
    "sister@example.test",
    secondId,
    "Different-test-password!",
  );
  for (const [member, expectedId, deniedId] of [
    [first, id, secondId],
    [second, secondId, id],
  ]) {
    assert.deepEqual(
      (await member.asUser("/api/servers")).body.servers.map(
        (server) => server.id,
      ),
      [expectedId],
    );
    assert.equal(
      (
        await member.asUser("/api/console", {
          headers: { "X-Server-Id": deniedId },
        })
      ).status,
      403,
    );
  }
  const login = await guest(
    "/api/access/login",
    json("POST", {
      email: "sister@example.test",
      password: "Correct-test-password!",
    }),
  );
  assert.equal(login.status, 200);
  assert.deepEqual(login.body.memberships, [
    { serverId: id, userId: first.user.id },
  ]);
});

test("a second invitation in the same browser keeps both servers with independent permissions", async (t) => {
  const { local, invite, id } = await fixture(t);
  const first = await invite(["control.console"]);
  const created = await local(
    "/api/servers",
    json("POST", { name: "Modded world", port: 25566 }),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const secondId = created.body.server.id;
  const second = await invite(
    ["file.read"],
    "sister@example.test",
    secondId,
    "Different-test-password!",
    first.cookie,
  );
  assert.deepEqual(second.session.memberships, [
    { serverId: secondId, userId: second.user.id },
    { serverId: id, userId: first.user.id },
  ]);
  const roster = (await second.asUser("/api/servers")).body;
  assert.deepEqual(
    roster.servers.map((server) => server.id),
    [id, secondId],
  );
  assert.deepEqual(
    roster.servers.map((server) => server.accessPermissions),
    [["control.console"], ["file.read"]],
  );
  assert.equal(roster.defaultServerId, secondId);
  for (const [serverId, consoleStatus, filesStatus] of [
    [id, 200, 403],
    [secondId, 403, 200],
  ]) {
    assert.equal(
      (
        await second.asUser("/api/console", {
          headers: { "X-Server-Id": serverId },
        })
      ).status,
      consoleStatus,
    );
    assert.equal(
      (
        await second.asUser("/api/files", {
          headers: { "X-Server-Id": serverId },
        })
      ).status,
      filesStatus,
    );
  }
  assert.equal((await first.asUser("/api/servers")).status, 401);
  assert.equal((await local("/api/servers")).body.servers.length, 2);
});

test("proxy sign-in isolates account limits without trusting forwarded addresses", async (t) => {
  const { guest, invite } = await fixture(t);
  await invite([]);
  for (let index = 0; index < 9; index++) {
    const result = await guest(
      "/api/access/login",
      json("POST", {
        email: `unknown-${index}@example.test`,
        password: "Wrong-test-password!",
      }),
    );
    assert.equal(result.status, 401);
  }
  assert.equal(
    (
      await guest(
        "/api/access/login",
        json("POST", {
          email: "sister@example.test",
          password: "Correct-test-password!",
        }),
      )
    ).status,
    200,
  );
  for (let index = 0; index < 8; index++) {
    assert.equal(
      (
        await guest("/api/access/login", {
          ...json("POST", {
            email:
              index % 2 ? " LIMITED@example.test " : "limited@example.test",
            password: "Wrong-test-password!",
          }),
          headers: { "X-Forwarded-For": `192.0.2.${index}` },
        })
      ).status,
      401,
    );
  }
  assert.equal(
    (
      await guest(
        "/api/access/login",
        json("POST", {
          email: "limited@example.test",
          password: "Wrong-test-password!",
        }),
      )
    ).status,
    429,
  );
});

test("remote users cannot reset their own access and retain their session", async (t) => {
  const { invite, local } = await fixture(t);
  const { user, asUser } = await invite(["user.create"]);
  const result = await asUser(`/api/subusers/${user.id}/invite`, {
    method: "POST",
  });
  assert.equal(result.status, 403);
  assert.match(result.body.error, /owner.*own access/);
  assert.equal((await asUser("/api/server")).status, 200);
  assert.equal(
    (await local("/api/subusers")).body.users[0].inviteStatus,
    "accepted",
  );
});

test("subuser creation and permission changes publish only after persistence succeeds", async (t) => {
  const { fleet, id, local } = await fixture(t);
  const statePath = path.join(fleet.runtimes.get(id).dataDir, "panel.json");
  const rename = fs.rename;
  let fail = true;
  t.mock.method(console, "error", () => {});
  t.mock.method(fs, "rename", async (from, to) => {
    if (fail && to === statePath) {
      fail = false;
      throw Object.assign(new Error("Fixture disk unavailable"), {
        code: "EACCES",
      });
    }
    return rename(from, to);
  });
  const input = json("POST", { email: "helper@example.test", permissions: [] });
  assert.equal((await local("/api/subusers", input)).status, 500);
  assert.deepEqual((await local("/api/subusers")).body.users, []);
  const created = await local("/api/subusers", input);
  assert.equal(created.status, 201);
  fail = true;
  assert.equal(
    (
      await local(
        `/api/subusers/${created.body.id}`,
        json("PATCH", {
          permissions: ["control.start"],
        }),
      )
    ).status,
    500,
  );
  assert.deepEqual(
    (await local("/api/subusers")).body.users[0].permissions,
    [],
  );
  assert.equal(
    (
      await local(
        `/api/subusers/${created.body.id}`,
        json("PATCH", {
          permissions: ["control.start"],
        }),
      )
    ).status,
    200,
  );
});

test("failed subuser revocation stays retryable and never restores revoked credentials", async (t) => {
  const { fleet, id, local, invite } = await fixture(t);
  const { user, cookie, asUser } = await invite([]);
  const statePath = path.join(fleet.runtimes.get(id).dataDir, "panel.json");
  const accessPath = path.join(fleet.dataDir, "remote-access.json");
  const rename = fs.rename;
  let failingPath = accessPath;
  t.mock.method(console, "error", () => {});
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === failingPath) {
      failingPath = null;
      throw Object.assign(new Error("Fixture disk unavailable"), {
        code: "EACCES",
      });
    }
    return rename(from, to);
  });
  const remove = () => local(`/api/subusers/${user.id}`, { method: "DELETE" });
  assert.equal((await remove()).status, 500);
  assert.equal((await local("/api/subusers")).body.users[0].id, user.id);
  assert.equal((await asUser("/api/server")).status, 200);
  failingPath = statePath;
  assert.equal((await remove()).status, 500);
  assert.equal((await local("/api/subusers")).body.users[0].id, user.id);
  assert.equal((await asUser("/api/server")).status, 401);
  const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(persisted.users[0].id, user.id);
  const reloaded = await createAccessService({
    dataDir: fleet.dataDir,
    getUser: (serverId, userId) =>
      serverId === id
        ? persisted.users.find((entry) => entry.id === userId)
        : null,
  });
  assert.equal(await reloaded.authenticate({ headers: { cookie } }), null);
  await assert.rejects(
    reloaded.login({ email: user.email, password: "Correct-test-password!" }),
    { status: 401 },
  );
  await reloaded.close();
  assert.equal((await remove()).status, 200);
  assert.deepEqual((await local("/api/subusers")).body.users, []);
});

test("an overlapping audit save preserves a committed subuser transaction", async (t) => {
  const { fleet, id, local } = await fixture(t);
  const runtime = fleet.runtimes.get(id);
  const statePath = path.join(runtime.dataDir, "panel.json");
  const rename = fs.rename;
  let entered,
    release,
    paused = false;
  const writing = new Promise((resolve) => {
    entered = resolve;
  });
  const resume = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(fs, "rename", async (from, to) => {
    if (!paused && to === statePath) {
      paused = true;
      entered();
      await resume;
    }
    return rename(from, to);
  });
  const creating = local(
    "/api/subusers",
    json("POST", {
      email: "helper@example.test",
      permissions: [],
    }),
  );
  await writing;
  const auditing = runtime.audit(
    "file",
    "Overlapping file event",
    "A concurrent operation finished.",
  );
  release();
  assert.equal((await creating).status, 201);
  await auditing;
  const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(persisted.users[0].email, "helper@example.test");
  assert.ok(persisted.audit.some((entry) => entry.action === "Subuser added"));
  assert.ok(
    persisted.audit.some((entry) => entry.action === "Overlapping file event"),
  );
});

test("committed invitations return their link even when the audit save fails", async (t) => {
  const { fleet, id, local, guest } = await fixture(t);
  const created = await local(
    "/api/subusers",
    json("POST", {
      email: "helper@example.test",
      permissions: [],
    }),
  );
  const runtime = fleet.runtimes.get(id);
  const statePath = path.join(runtime.dataDir, "panel.json");
  const rename = fs.rename;
  let fail = true;
  t.mock.method(console, "error", () => {});
  t.mock.method(fs, "rename", async (from, to) => {
    if (fail && to === statePath) {
      fail = false;
      throw Object.assign(new Error("Fixture disk unavailable"), {
        code: "EACCES",
      });
    }
    return rename(from, to);
  });
  const invitation = await local(`/api/subusers/${created.body.id}/invite`, {
    method: "POST",
  });
  assert.equal(invitation.status, 200);
  assert.match(invitation.body.warning, /audit history could not be saved/);
  const token = new URL(invitation.body.invitationUrl).hash.slice(
    "#invite=".length,
  );
  assert.equal(
    (
      await guest(
        "/api/access/accept",
        json("POST", {
          token,
          password: "Correct-test-password!",
        }),
      )
    ).status,
    200,
  );
  await runtime.audit("user", "Audit recovered", "Fixture disk is available.");
});

test("remote Launchpad removals persist the subuser actor", async (t) => {
  const { fleet, id, invite } = await fixture(t);
  const runtime = fleet.runtimes.get(id);
  await fs.mkdir(path.join(runtime.serverDir, "plugins"));
  await fs.writeFile(
    path.join(runtime.serverDir, "plugins", "unmanaged.jar"),
    "fixture plugin",
  );
  const { user, asUser } = await invite([
    "file.create",
    "file.update",
    "file.delete",
    "control.start",
    "control.stop",
    "audit.read",
  ]);
  const preview = await asUser(
    "/api/launchpad/removal-preview",
    json("POST", {
      type: "plugin",
      path: "plugins/unmanaged.jar",
    }),
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const removed = await asUser(
    "/api/launchpad/remove",
    json("POST", {
      planId: preview.body.planId,
      confirmed: true,
    }),
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const saved = JSON.parse(
    await fs.readFile(path.join(runtime.dataDir, "panel.json"), "utf8"),
  );
  assert.equal(
    saved.audit.find((entry) => entry.action === "Plugin deleted").actor,
    user.email,
  );
});
