import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createFleet } from "./index.mjs";
import { processStartup } from "../tests/fixtures/process-options.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-auth-transport-"));
  const fleet = await createFleet({
    dataDir: path.join(root, "panel"),
    useEnvironment: false,
    createDefaultServer: true,
    scheduler: false,
    remoteListen: false,
    publicAddress: { resolve: async () => null },
  });
  const listen = (app) =>
    new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
  const owner = await listen(fleet.app),
    remote = await listen(fleet.remoteApp);
  t.after(async () => {
    await fleet.close();
    for (const server of [owner, remote]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-auth-transport-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const request =
    (server, headers = {}) =>
    (route, method = "GET", body, extra = {}) =>
      new Promise((resolve, reject) => {
        const bytes = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
          `http://127.0.0.1:${server.address().port}${route}`,
          {
            method,
            headers: {
              "Content-Type": "application/json",
              ...headers,
              ...extra,
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (part) => (text += part));
            res.on("end", () => {
              let value = text;
              try {
                value = JSON.parse(text);
              } catch {
                /* file download */
              }
              resolve({
                status: res.statusCode,
                body: value,
                headers: res.headers,
              });
            });
          },
        );
        req.on("error", reject);
        req.end(bytes);
      });
  const local = request(owner);
  const remoteHeaders = {
    Host: "auth.example.test",
    Origin: "https://auth.example.test",
  };
  const guest = request(remote, remoteHeaders);
  assert.equal(
    (
      await local("/api/access/settings", "PUT", {
        enabled: true,
        publicUrl: remoteHeaders.Origin,
        transport: "proxy",
      })
    ).status,
    200,
  );
  const id = (await local("/api/servers")).body.defaultServerId;
  async function invite(
    permissions,
    hostPermissions = [],
    email = "delegate@example.test",
  ) {
    const user = await local("/api/subusers", "POST", {
      email,
      permissions: ["server.view", ...permissions],
      hostPermissions,
    });
    assert.equal(user.status, 201);
    const link = await local(`/api/subusers/${user.body.id}/invite`, "POST");
    assert.equal(link.status, 200);
    const accepted = await guest("/api/access/accept", "POST", {
      token: new URL(link.body.invitationUrl).hash.slice("#invite=".length),
      password: "Regression-only-password!",
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers["set-cookie"], undefined);
    return {
      user: user.body,
      token: accepted.body.sessionToken,
      request: request(remote, {
        ...remoteHeaders,
        Authorization: `Bearer ${accepted.body.sessionToken}`,
      }),
    };
  }
  return { fleet, root, id, local, guest, invite };
}

test("delegated identity creation rejects existing and retired panel identities without hidden rows", async (t) => {
  const { local, invite, fleet, id } = await fixture(t);
  const account = await local("/api/panel-users", "POST", {
    email: "existing@example.test",
  });
  assert.equal(account.status, 201);
  const delegate = await invite(["user.read", "user.create"]);
  for (const retired of [false, true]) {
    if (retired)
      assert.equal(
        (await local(`/api/panel-users/${account.body.id}`, "DELETE")).status,
        200,
      );
    const created = await delegate.request("/api/subusers", "POST", {
      email: "existing@example.test",
      permissions: ["server.view"],
    });
    assert.equal(created.status, 409);
    assert.match(created.body.error, /panel owner/);
    assert.equal(
      fleet.runtimes
        .get(id)
        .subusers()
        .some((user) => user.email === "existing@example.test"),
      false,
    );
  }
});

test("revoking a migrated computer permission denies real import while retaining server access", async (t) => {
  const { local, invite, root } = await fixture(t);
  const delegate = await invite([], ["server.create"]);
  assert.equal((await delegate.request("/api/server-import")).status, 200);
  let account = (await local("/api/panel-users")).body.users.find(
    (user) => user.email === "delegate@example.test",
  );
  assert.deepEqual(account.effectiveHostPermissions, ["server.create"]);
  const enabled = await local(
    `/api/panel-users/${encodeURIComponent(account.id)}`,
    "PATCH",
    { hostPermissions: ["server.create"] },
  );
  assert.equal(enabled.status, 200);
  account = enabled.body;
  const disabled = await local(`/api/panel-users/${account.id}`, "PATCH", {
    hostPermissions: [],
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.body.effectiveHostPermissions, []);
  assert.equal((await delegate.request("/api/server-import")).status, 403);
  const roster = (await delegate.request("/api/servers")).body;
  assert.deepEqual(roster.hostPermissions, []);
  assert.equal(roster.servers.length, 1);
  const directory = path.join(root, "after-revoke");
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "server.jar"),
    "disposable; never launched",
  );
  const imported = await delegate.request("/api/server-import", "POST", {
    requestId: randomUUID(),
    directory,
    jar: "server.jar",
    port: 27777,
  });
  assert.equal(imported.status, 403);
  assert.equal((await local("/api/servers")).body.servers.length, 1);
  const saved = JSON.parse(
    await fs.readFile(path.join(root, "panel", "remote-access.json"), "utf8"),
  );
  assert.deepEqual(saved.accounts[0].hostPermissions, []);
  assert.ok(
    Object.values(saved.accounts[0].serverOverrides).every(
      (value) => value.hostPermissions.length === 0,
    ),
  );
});

test("bearer sessions reject cookie replay and downloads use revocable one-use resource tickets", async (t) => {
  const { local, guest, invite, id } = await fixture(t);
  const delegate = await invite(["file.read-content"]);
  assert.equal(
    (
      await guest("/api/access/session", "GET", undefined, {
        Cookie: `__Host-mc-subuser=${delegate.token}`,
      })
    ).body.role,
    "guest",
  );
  assert.equal(
    (await delegate.request("/api/access/session")).body.role,
    "subuser",
  );
  await local("/api/files", "POST", {
    name: "private file.txt",
    type: "file",
    content: "private bytes",
  });
  const target = "/api/files/download?path=private%20file.txt";
  assert.equal((await guest(target)).status, 401);
  const issue = () =>
    delegate.request("/api/access/download", "POST", { url: target });
  const first = await issue();
  assert.equal(first.status, 200);
  assert.equal(
    new URL(first.body.url, "https://panel.test").searchParams.get("serverId"),
    id,
  );
  assert.equal(first.body.url.includes(delegate.token), false);
  assert.equal(
    (
      await guest(
        first.body.url.replace("private+file.txt", "server.properties"),
      )
    ).status,
    401,
  );
  const downloaded = await guest(first.body.url);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.body, "private bytes");
  assert.equal((await guest(first.body.url)).status, 401);
  const second = await issue();
  await local(`/api/subusers/${delegate.user.id}`, "PATCH", {
    permissions: ["server.view"],
  });
  assert.equal((await guest(second.body.url)).status, 403);
  assert.equal((await issue()).status, 403);
  await local(`/api/subusers/${delegate.user.id}`, "PATCH", {
    permissions: ["server.view", "file.read-content"],
  });
  const third = await issue();
  await delegate.request("/api/access/logout", "POST");
  assert.equal((await guest(third.body.url)).status, 401);
  for (const url of [
    "https://other.test/api/files/download",
    "/api/server/power",
    "/api/files/download?downloadTicket=old",
  ])
    assert.equal(
      (await guest("/api/access/download", "POST", { url })).status,
      401,
    );
});

test("download tickets require target access and quota stays isolated across accounts and sign-ins", async (t) => {
  const { local, guest, invite, fleet } = await fixture(t);
  const empty = await fleet.access.createAccount({
    email: "unshared@example.test",
  });
  const invitation = await fleet.access.inviteAccount(empty.id);
  const accepted = await guest("/api/access/accept", "POST", {
    token: new URL(invitation.invitationUrl).hash.slice("#invite=".length),
    password: "Regression-only-password!",
  });
  assert.equal(accepted.status, 200);
  const target = "/api/files/download?path=quota.txt";
  const issueAs = (token, url = target) =>
    guest(
      "/api/access/download",
      "POST",
      { url },
      {
        Authorization: `Bearer ${token}`,
      },
    );
  assert.equal((await issueAs(accepted.body.sessionToken)).status, 403);
  const first = await invite(["file.read-content"]);
  const other = await invite(["file.read-content"], [], "other@example.test");
  await local("/api/files", "POST", {
    name: "quota.txt",
    type: "file",
    content: "allowed bytes",
  });
  for (const url of [
    `${target}&serverId=unshared-server`,
    "/api/backups/unshared-backup/download",
  ])
    assert.equal((await issueAs(first.token, url)).status, 403);
  assert.equal(
    (await issueAs(first.token, `${target}&serverId=one&serverId=two`)).status,
    400,
  );
  const tickets = await Promise.all(
    Array.from({ length: 32 }, () => issueAs(first.token)),
  );
  assert.ok(tickets.every((result) => result.status === 200));
  assert.equal((await issueAs(first.token)).status, 429);
  const signedInAgain = await guest("/api/access/login", "POST", {
    email: "delegate@example.test",
    password: "Regression-only-password!",
  });
  assert.equal(signedInAgain.status, 200);
  assert.equal((await issueAs(signedInAgain.body.sessionToken)).status, 429);
  assert.equal((await issueAs(other.token)).status, 200);
  const download = await guest(tickets[0].body.url);
  assert.equal(download.status, 200);
  assert.equal(download.body, "allowed bytes");
  assert.equal((await issueAs(signedInAgain.body.sessionToken)).status, 200);
});

test("trusted Console can stop Minecraft while dedicated Stop remains a separate panel control", async (t) => {
  const { local, invite, fleet, id } = await fixture(t);
  assert.equal(
    (await local(`/api/servers/${id}`, "PATCH", processStartup)).status,
    200,
  );
  await fs.writeFile(
    path.join(fleet.runtimes.get(id).serverDir, "eula.txt"),
    "eula=true\n",
  );
  const delegate = await invite(["control.console"]);
  assert.equal(
    (await local("/api/server/power", "POST", { action: "start" })).status,
    200,
  );
  for (
    let i = 0;
    i < 100 && (await local("/api/server")).body.status !== "running";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await local("/api/server")).body.status, "running");
  assert.equal(
    (await delegate.request("/api/server/power", "POST", { action: "stop" }))
      .status,
    403,
  );
  assert.equal(
    (
      await delegate.request("/api/console/command", "POST", {
        command: "stop",
      })
    ).status,
    200,
  );
  for (
    let i = 0;
    i < 100 && (await local("/api/server")).body.status !== "offline";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await local("/api/server")).body.status, "offline");
});
