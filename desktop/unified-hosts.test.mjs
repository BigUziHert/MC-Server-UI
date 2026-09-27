import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { createFleet } from "../server/index.mjs";
import { startDesktopRuntime } from "./runtime.mjs";
import { createUnifiedPanelController } from "./unified-panels.mjs";

const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const listen = (app) =>
  new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
const stop = async (listener) => {
  listener.closeAllConnections();
  await new Promise((resolve) => listener.close(resolve));
};

// These are real independent host APIs and stores. Only HTTPS transport is
// adapted to loopback HTTP; unified-panels.smoke verifies Electron's real TLS.
test("unified bridge preserves real host permissions and filesystem isolation across colliding servers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-unified-hosts-"));
  const hosts = new Map();
  let controller, runtime;
  t.after(async () => {
    await controller?.close();
    await runtime?.close();
    for (const host of hosts.values()) {
      await host.fleet.close();
      await stop(host.owner);
      await stop(host.remote);
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-unified-hosts-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of ["a", "c"]) {
    const dataDir = path.join(root, name);
    const options = {
      dataDir,
      useEnvironment: false,
      createDefaultServer: true,
      scheduler: false,
      remoteListen: false,
    };
    const seed = await createFleet(options);
    await seed.close();
    const registryPath = path.join(dataDir, "servers.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    registry.defaultServerId = serverId;
    registry.servers[0].id = serverId;
    registry.servers[0].name = "Same Minecraft server";
    await fs.writeFile(registryPath, JSON.stringify(registry));
    const fleet = await createFleet(options);
    const owner = await listen(fleet.app);
    const remote = await listen(fleet.remoteApp);
    const origin = `https://computer-${name}.example.test`;
    const host = {
      fleet,
      owner,
      remote,
      origin,
      local: (route, options = {}) =>
        fetch(`http://127.0.0.1:${owner.address().port}/api${route}`, options),
    };
    hosts.set(origin, host);
    assert.equal(
      (
        await host.local(
          "/access/settings",
          json("PUT", {
            enabled: true,
            publicUrl: origin,
            transport: "proxy",
          }),
        )
      ).status,
      200,
    );
    const permissions =
      name === "a"
        ? [
            "server.view",
            "file.read",
            "file.read-content",
            "file.create",
            "file.update",
            "backup.read",
          ]
        : ["server.view"];
    const created = await host.local(
      "/subusers",
      json("POST", {
        email: `${name}@example.test`,
        permissions,
      }),
    );
    assert.equal(created.status, 201);
    host.user = await created.json();
    const invitation = await host.local(`/subusers/${host.user.id}/invite`, {
      method: "POST",
    });
    assert.equal(invitation.status, 200);
    host.invitation = new URL(
      (await invitation.json()).invitationUrl,
    ).hash.slice("#invite=".length);
  }
  runtime = await startDesktopRuntime({
    dataDir: path.join(root, "b"),
    scheduler: false,
    proxyRemotePanel: (...args) => controller.proxy(...args),
  });
  controller = createUnifiedPanelController({
    window: { webContents: { isDestroyed: () => false, send() {} } },
    localOrigin: runtime.url,
    pollMs: 60000,
    store: {
      read: async () => ({ panels: [], selectedServer: null }),
      save: async () => {},
      close: async () => {},
    },
    session: {
      fromPartition: () => ({
        setCertificateVerifyProc() {},
        closeAllConnections: async () => {},
        clearStorageData: async () => {},
        fetch(input, options) {
          const url = new URL(input);
          const host = hosts.get(url.origin);
          assert.ok(
            host,
            "Only saved, expected panel origins can be contacted",
          );
          const headers = new Headers(options.headers);
          headers.set("Host", url.host);
          return new Promise((resolve, reject) => {
            const request = http.request(
              `http://127.0.0.1:${host.remote.address().port}${url.pathname}${url.search}`,
              {
                method: options.method,
                headers: Object.fromEntries(headers),
                signal: options.signal,
              },
              (response) =>
                resolve(
                  new Response(Readable.toWeb(response), {
                    status: response.statusCode,
                    headers: Object.fromEntries(
                      Object.entries(response.headers).filter(
                        ([, value]) => typeof value === "string",
                      ),
                    ),
                  }),
                ),
            );
            request.on("error", reject);
            if (options.body instanceof ReadableStream)
              Readable.fromWeb(options.body).pipe(request);
            else request.end(options.body);
          });
        },
      }),
    },
    listLocalServers: () => runtime.listLocalServerRecords(),
  });
  for (const host of hosts.values()) {
    const opened = await controller.open(host.origin);
    host.panelId = opened.panels.find(
      (panel) => panel.origin === host.origin,
    ).id;
    await controller.acceptInvitation(host.panelId, {
      token: host.invitation,
      password: "Correct-fixture-password!",
    });
  }
  const [a, c] = [...hosts.values()];
  const snapshot = (host) =>
    controller.list().panels.find((panel) => panel.id === host.panelId);
  const through = (host, route, options = {}) => {
    const target = new URL(`/api${route}`, runtime.url);
    if (!target.searchParams.has("serverId"))
      target.searchParams.set("serverId", serverId);
    target.searchParams.set("desktopEpoch", snapshot(host).sessionEpoch);
    return fetch(
      `${runtime.url}/api/desktop/panels/${host.panelId}/proxy${target.pathname}${target.search}`,
      {
        ...options,
        headers: {
          Cookie: `mc-panel-desktop=${runtime.token}`,
          ...options.headers,
        },
      },
    );
  };
  assert.equal(snapshot(a).session.email, "a@example.test");
  assert.equal(snapshot(c).session.email, "c@example.test");
  assert.deepEqual(
    snapshot(a).servers.map((server) => server.id),
    [serverId],
  );
  assert.deepEqual(
    snapshot(c).servers.map((server) => server.id),
    [serverId],
  );
  await controller.selectServer(a.panelId, serverId);
  assert.equal(
    (
      await through(
        a,
        "/files",
        json("POST", {
          name: "bridge.txt",
          type: "file",
          content: "Only on Computer A",
        }),
      )
    ).status,
    201,
  );
  await controller.selectServer(c.panelId, serverId);
  assert.equal(
    (
      await through(
        c,
        "/files",
        json("POST", {
          name: "bridge.txt",
          type: "file",
          content: "Must be denied",
        }),
      )
    ).status,
    403,
  );
  const aFolder = a.fleet.runtimes.get(serverId).serverDir;
  const cFolder = c.fleet.runtimes.get(serverId).serverDir;
  assert.equal(
    await fs.readFile(path.join(aFolder, "bridge.txt"), "utf8"),
    "Only on Computer A",
  );
  await assert.rejects(fs.stat(path.join(cFolder, "bridge.txt")), {
    code: "ENOENT",
  });
  const loaded = await (
    await through(a, "/files/content?path=bridge.txt")
  ).json();
  assert.equal(
    (
      await through(
        a,
        "/files/content",
        json("PUT", {
          ...loaded,
          path: "bridge.txt",
          content: "Still Computer A after selection changed",
        }),
      )
    ).status,
    200,
  );
  const downloaded = await through(a, "/files/download?path=bridge.txt");
  assert.equal(downloaded.status, 200);
  assert.equal(
    await downloaded.text(),
    "Still Computer A after selection changed",
  );
  assert.equal((await through(a, "/backups")).status, 200);
  assert.equal((await through(c, "/backups")).status, 403);
  assert.equal(
    (await through(a, "/server/start", json("POST", {}))).status,
    403,
  );
  assert.equal((await through(a, "/access/settings")).status, 403);
  assert.equal((await through(a, "/server-setup/directories")).status, 403);

  // The host enforces revocation immediately even while the broker retains its
  // previous roster until the next poll. A second host's account is unaffected.
  assert.equal(
    (
      await a.local(
        `/subusers/${a.user.id}`,
        json("PATCH", {
          permissions: ["server.view"],
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await through(
        a,
        "/files/content",
        json("PUT", {
          path: "bridge.txt",
          content: "Revoked write",
        }),
      )
    ).status,
    403,
  );
  await controller.retry(a.panelId);
  assert.deepEqual(snapshot(a).servers[0].accessPermissions, ["server.view"]);
  assert.equal(
    (
      await a.local(
        `/subusers/${a.user.id}`,
        json("PATCH", {
          permissions: ["server.view"],
          hostPermissions: ["server.create"],
        }),
      )
    ).status,
    200,
  );
  await controller.retry(a.panelId);
  assert.equal((await through(a, "/server-setup/directories")).status, 200);
  assert.equal((await through(c, "/server-setup/directories")).status, 403);
  const importedFolder = path.join(root, "a-import");
  await fs.mkdir(importedFolder);
  await fs.writeFile(
    path.join(importedFolder, "server.jar"),
    "disposable fixture",
  );
  await fs.writeFile(
    path.join(importedFolder, "server.properties"),
    "server-port=25566\n",
  );
  assert.equal(
    (
      await through(
        a,
        "/server-import/inspect",
        json("POST", {
          directory: importedFolder,
        }),
      )
    ).status,
    200,
  );
  const imported = await through(
    a,
    "/server-import",
    json("POST", {
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      directory: importedFolder,
      name: "Imported on A",
      jar: "server.jar",
      launchType: "jar",
      javaPath: "java",
      memoryLimitMB: 1024,
      port: 25566,
    }),
  );
  const created = await imported.json();
  assert.equal(imported.status, 201, JSON.stringify(created));
  assert.ok(
    snapshot(a).servers.some((server) => server.id === created.server.id),
  );
  assert.equal(
    (await through(a, `/server?serverId=${created.server.id}`)).status,
    200,
  );
  assert.equal(
    (await through(c, `/server?serverId=${created.server.id}`)).status,
    403,
  );
  assert.equal(c.fleet.runtimes.size, 1);
  await controller.signOut(a.panelId);
  assert.equal(snapshot(a).signedIn, false);
  assert.deepEqual(snapshot(a).servers, []);
  assert.equal(snapshot(c).signedIn, true);
  assert.equal((await through(c, "/server")).status, 200);
  await assert.rejects(
    controller.forget(a.panelId, "signed-out-account"),
    /sign in/i,
  );
  await controller.signIn(a.panelId, {
    email: "a@example.test",
    password: "Correct-fixture-password!",
  });
  assert.equal(
    (
      await a.local(
        "/subusers",
        json("POST", {
          email: "another@example.test",
          permissions: ["server.view"],
        }),
      )
    ).status,
    201,
  );
  await controller.forget(
    a.panelId,
    snapshot(a).session.accountId ?? snapshot(a).session.userId,
  );
  assert.equal(snapshot(a), undefined);
  const remainingAccounts = await (await a.local("/panel-users")).json();
  assert.equal(
    remainingAccounts.users.some((user) => user.email === "a@example.test"),
    false,
  );
  assert.equal(
    remainingAccounts.users.some(
      (user) => user.email === "another@example.test",
    ),
    true,
  );
  assert.equal(snapshot(c).signedIn, true);
  assert.equal((await through(c, "/server")).status, 200);
  assert.equal(
    a.fleet.runtimes.size,
    2,
    "Leaving never removes Minecraft servers",
  );
  assert.equal(
    await fs.readFile(path.join(aFolder, "bridge.txt"), "utf8"),
    "Still Computer A after selection changed",
  );

  // A host-side account revocation reaches the real gateway and removes only
  // that desktop connection, even when an API request discovers it first.
  const savedAddress = (await controller.open(a.origin)).panels.find(
    (panel) => panel.origin === a.origin,
  );
  assert.equal(savedAddress.signedIn, false);
  await controller.selectServer(c.panelId, serverId);
  const cAccounts = await (await c.local("/panel-users")).json();
  const accountId = cAccounts.users.find(
    (user) => user.email === "c@example.test",
  ).id;
  assert.equal(
    (
      await c.local(`/panel-users/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
      })
    ).status,
    200,
  );
  const revoked = await through(c, "/server");
  assert.equal(revoked.status, 401);
  assert.match((await revoked.json()).error, /revoked/i);
  assert.equal(snapshot(c), undefined);
  assert.equal(controller.list().selectedServer, null);
  assert.deepEqual(
    controller.list().panels.map((panel) => panel.id),
    ["local", savedAddress.id],
  );
  assert.equal(
    c.fleet.runtimes.size,
    1,
    "Revocation preserves the host's server",
  );
});
