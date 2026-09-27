import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUnifiedPanelController } from "./unified-panels.mjs";
import { createUnifiedConnectionStore } from "./unified-connection-store.mjs";
import { startDesktopRuntime } from "./runtime.mjs";
import { installUnifiedConnectionIpc } from "./connections-ipc.mjs";

const account = {
  role: "subuser",
  email: "friend@example.test",
  userId: "friend",
  accountId: "account",
  serverId: "same-id",
  permissions: ["server.view"],
  hostPermissions: [],
};
const token = "a".repeat(43);
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function harness(
  t,
  { hostPermissions = [], behavior, storeRead, storeSave, pollMs = 60000 } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-unified-test-"));
  let controller;
  const calls = [],
    persisted = [],
    cleanup = [];
  const runtime = await startDesktopRuntime({
    dataDir: root,
    scheduler: false,
    proxyRemotePanel: (...args) => controller.proxy(...args),
  });
  const contents = {
    isDestroyed: () => false,
    send() {},
    getURL: () => runtime.url,
  };
  contents.mainFrame = { origin: runtime.url, url: `${runtime.url}/` };
  const window = { webContents: contents };
  controller = createUnifiedPanelController({
    window,
    localOrigin: runtime.url,
    pollMs,
    store: {
      read: storeRead ?? (async () => ({ panels: [], selectedServer: null })),
      save: async (value) => {
        await storeSave?.(value);
        persisted.push(value);
      },
      close: async () => {},
      forgetLegacy: async (id) => cleanup.push({ action: "legacy", id }),
    },
    session: {
      fromPartition: (partition) => ({
        setCertificateVerifyProc(value) {
          if (value === null) cleanup.push({ action: "certificate", partition });
        },
        clearStorageData: async () => cleanup.push({ action: "storage", partition }),
        closeAllConnections: async () => cleanup.push({ action: "connections", partition }),
        fetch: async (input, options) => {
          const url = new URL(input),
            headers = new Headers(options.headers);
          calls.push({
            url,
            headers,
            method: options.method,
            body: options.body,
          });
          if (behavior) {
            const result = await behavior(url, options);
            if (result) return result;
          }
          if (url.pathname === "/api/access/login")
            return response({ ...account, sessionToken: token });
          if (url.pathname === "/api/access/session")
            return response(
              headers.has("Authorization")
                ? { ...account, hostPermissions }
                : { role: "guest" },
            );
          if (url.pathname === "/api/servers")
            return response({
              servers: [
                {
                  id: "same-id",
                  name: url.host,
                  status: "offline",
                  accessPermissions: ["server.view"],
                  serverDir: "C:/remote/private",
                },
              ],
              hostPermissions,
            });
          if (url.pathname === "/api/access/logout")
            return response({ ok: true });
          if (url.pathname === "/api/access/leave")
            return response({ left: true, requestId: JSON.parse(options.body).requestId });
          if (url.pathname === "/api/server")
            return response({
              host: url.host,
              serverId: headers.get("X-Server-Id"),
            });
          if (url.pathname === "/api/files/upload") {
            const bytes = Buffer.from(
              await new Response(options.body).arrayBuffer(),
            );
            return response({
              size: bytes.length,
              contentType: headers.get("Content-Type"),
              text: bytes.toString("utf8"),
            });
          }
          if (url.pathname === "/api/files/download")
            return new Response("remote bytes", {
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": 'attachment; filename="world.zip"',
              },
            });
          return response({ error: "Not found" }, 404);
        },
      }),
    },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    listLocalServers: () => [
      { id: "same-id", name: "Local", status: "offline" },
    ],
  });
  t.after(async () => {
    await controller.close();
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const signIn = async (origin) => {
    const opened = await controller.open(origin);
    const id = opened.panels.find((panel) => panel.origin === origin).id;
    await controller.signIn(id, {
      email: account.email,
      password: "fixture-password",
    });
    return controller.list().panels.find((panel) => panel.id === id);
  };
  const proxy = (panel, target, options = {}) =>
    fetch(
      `${runtime.url}/api/desktop/panels/${panel.id}/proxy/api${target}${target.includes("?") ? "&" : "?"}desktopEpoch=${panel.sessionEpoch}`,
      {
        ...options,
        headers: {
          Cookie: `mc-panel-desktop=${runtime.token}`,
          ...options.headers,
        },
      },
    );
  return {
    root,
    runtime,
    controller,
    calls,
    persisted,
    cleanup,
    signIn,
    proxy,
    contents,
  };
}

test("unified proxy binds colliding server IDs to panel and epoch without moving the renderer", async (t) => {
  const h = await harness(t);
  const a = await h.signIn("https://a.example.test"),
    c = await h.signIn("https://c.example.test");
  await h.controller.selectServer(a.id, "same-id");
  const result = await h.proxy(c, "/server?serverId=same-id", {
    headers: { Authorization: "Bearer attacker", "X-Server-Id": "same-id" },
  });
  assert.deepEqual(await result.json(), {
    host: "c.example.test",
    serverId: "same-id",
  });
  assert.deepEqual(h.controller.list().selectedServer, {
    panelId: a.id,
    serverId: "same-id",
  });
  const call = h.calls.at(-1);
  assert.equal(call.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(call.headers.get("Cookie"), null);
  assert.equal(call.headers.get("Origin"), c.origin);
  assert.equal(call.url.searchParams.has("desktopEpoch"), false);
  assert.equal(h.contents.getURL(), h.runtime.url);
  assert.equal(
    (
      await h.proxy(c, "/server?serverId=same-id", {
        headers: { "X-Server-Id": "different" },
      })
    ).status,
    400,
  );
  assert.equal((await h.proxy(c, "/server?serverId=unknown")).status, 403);
  assert.equal(
    (await h.proxy(c, "/desktop/settings?serverId=same-id")).status,
    403,
  );
  await h.controller.signOut(c.id);
  assert.equal((await h.proxy(c, "/server?serverId=same-id")).status, 409);
  assert.equal(
    h.controller.list().panels.find((panel) => panel.id === a.id).signedIn,
    true,
  );
});

test("unified runtime streams multipart uploads and attachment bytes through local owner authentication", async (t) => {
  const h = await harness(t);
  const panel = await h.signIn("https://a.example.test");
  const form = new FormData();
  form.set("file", new Blob(["payload".repeat(20000)]), "remote.txt");
  form.set("path", "world");
  const upload = await h.proxy(panel, "/files/upload?serverId=same-id", {
    method: "POST",
    body: form,
  });
  const received = await upload.json();
  assert.equal(upload.status, 200);
  assert.ok(received.size > 140000);
  assert.match(received.contentType, /^multipart\/form-data; boundary=/);
  assert.match(received.text, /name="path"\r\n\r\nworld/);
  const download = await h.proxy(
    panel,
    "/files/download?serverId=same-id&path=world",
  );
  assert.equal(await download.text(), "remote bytes");
  assert.match(download.headers.get("Content-Disposition"), /world.zip/);
  const anonymous = await fetch(
    `${h.runtime.url}/api/desktop/panels/${panel.id}/proxy/api/server?desktopEpoch=${panel.sessionEpoch}&serverId=same-id`,
  );
  assert.equal(anonymous.status, 401);
  assert.equal(
    (
      await h.proxy(panel, "/server-setup", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
    403,
  );
});

test("unified offline state retains display-only identity and blocks requests until live retry", async (t) => {
  let offline = false;
  const h = await harness(t, {
    behavior: async () => {
      if (offline) throw new Error("offline");
    },
  });
  const panel = await h.signIn("https://a.example.test");
  offline = true;
  await assert.rejects(h.controller.retry(panel.id), /unavailable/);
  const saved = h.controller.list().panels.find((item) => item.id === panel.id);
  assert.equal(saved.signedIn, true);
  assert.equal(saved.connectionState, "unavailable");
  assert.equal(saved.servers[0].accessPermissions, undefined);
  assert.equal(saved.servers[0].serverDir, undefined);
  assert.equal((await h.proxy(panel, "/server?serverId=same-id")).status, 503);
  offline = false;
  await h.controller.retry(panel.id);
  assert.equal((await h.proxy(panel, "/server?serverId=same-id")).status, 200);
});

test("initial selection waits for saved connections and closing before initialization does not overwrite them", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const remote = {
    id: "00000000-0000-4000-8000-000000000001",
    origin: "https://saved.example.test",
    servers: [],
  };
  const h = await harness(t, { storeRead: () => gate });
  assert.equal(h.controller.list().ready, false);
  const selecting = h.controller.selectServer("local", "same-id");
  assert.equal(h.persisted.length, 0);
  release({
    panels: [remote],
    selectedServer: { panelId: remote.id, serverId: "old-id" },
  });
  await selecting;
  assert.equal(h.controller.list().ready, true);
  assert.equal(h.persisted.at(-1).panels[0].id, remote.id);
  const unopened = await harness(t);
  await unopened.controller.close();
  assert.equal(unopened.persisted.length, 0);
});

test("failed invitations preserve the account lease and protected route spelling cannot expose credentials", async (t) => {
  const h = await harness(t, {
    behavior: async (url) =>
      url.pathname === "/api/access/accept"
        ? response({ error: "Invitation expired" }, 400)
        : undefined,
  });
  const before = await h.signIn("https://a.example.test");
  await assert.rejects(
    h.controller.acceptInvitation(before.id, {
      token: "b".repeat(43),
      password: "fixture-password",
    }),
    /expired/,
  );
  const after = h.controller
    .list()
    .panels.find((panel) => panel.id === before.id);
  assert.equal(after.sessionEpoch, before.sessionEpoch);
  assert.equal(after.signedIn, true);
  for (const target of [
    "/access/login/",
    "/access/LOGIN",
    "/access/accept/",
    "/access/LEAVE/",
    "/desktop/settings/",
    "/panel-users/",
  ]) {
    assert.equal(
      (
        await h.proxy(after, `${target}?serverId=same-id`, {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        })
      ).status,
      403,
    );
  }
});

test("a delayed prior-session revocation body cannot remove a replacement session", async (t) => {
  let body, markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname !== "/api/server") return;
      return new Response(
        new ReadableStream({
          start(controller) {
            body = controller;
            markStarted();
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const before = await h.signIn("https://a.example.test");
  const pending = h.proxy(before, "/server?serverId=same-id");
  await started;
  await h.controller.signIn(before.id, {
    email: account.email,
    password: "replacement-password",
  });
  body.enqueue(
    new TextEncoder().encode(JSON.stringify({ error: "Old account revoked", accessRevoked: true })),
  );
  body.close();
  assert.equal((await pending).status, 409);
  const after = h.controller
    .list()
    .panels.find((panel) => panel.id === before.id);
  assert.equal(after.signedIn, true);
  assert.notEqual(after.sessionEpoch, before.sessionEpoch);
});

test("host creation waits for a post-registration roster rather than coalescing an older poll", async (t) => {
  let hold = false,
    created = false,
    release,
    markBlocked;
  const blocked = new Promise((resolve) => {
    markBlocked = resolve;
  });
  const h = await harness(t, {
    hostPermissions: ["server.create"],
    pollMs: 20,
    behavior: async (url) => {
      if (url.pathname === "/api/servers") {
        const servers = [
          {
            id: "same-id",
            name: "Existing",
            status: "offline",
            accessPermissions: ["server.view"],
          },
          ...(created
            ? [
                {
                  id: "created",
                  name: "Created",
                  status: "offline",
                  accessPermissions: ["server.view"],
                },
              ]
            : []),
        ];
        if (hold) {
          hold = false;
          markBlocked();
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return response({ servers, hostPermissions: ["server.create"] });
      }
      if (url.pathname === "/api/server-setup") {
        created = true;
        return response({ server: { id: "created" } }, 201);
      }
    },
  });
  const panel = await h.signIn("https://a.example.test");
  hold = true;
  await blocked;
  const setup = h.proxy(panel, "/server-setup", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  while (!created) await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  assert.equal((await setup).status, 201);
  assert.equal(
    h.controller
      .list()
      .panels.find((entry) => entry.id === panel.id)
      .servers.some((server) => server.id === "created"),
    true,
  );
  assert.equal((await h.proxy(panel, "/server?serverId=created")).status, 200);
});

test("sign-out hides cached rows before a stalled remote logout completes", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname === "/api/access/logout") {
        await gate;
        return response({ ok: true });
      }
    },
  });
  const panel = await h.signIn("https://a.example.test");
  await h.controller.signOut(panel.id);
  const signedOut = h.controller
    .list()
    .panels.find((entry) => entry.id === panel.id);
  assert.equal(signedOut.signedIn, false);
  assert.deepEqual(signedOut.servers, []);
  assert.equal(h.persisted.at(-1).panels[0].token, null);
  release();
});

test("revocation clears persisted credentials and signed-out cached records never expose a roster", async (t) => {
  let revoked = false;
  const h = await harness(t, {
    behavior: async (url) =>
      revoked && url.pathname === "/api/servers"
        ? response({ error: "Session revoked" }, 401)
        : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  revoked = true;
  await assert.rejects(h.controller.retry(panel.id), /revoked/);
  assert.equal(h.persisted.at(-1).panels[0].token, null);
  assert.deepEqual(h.persisted.at(-1).panels[0].servers, []);
  const cached = await harness(t, {
    storeRead: async () => ({
      selectedServer: null,
      panels: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          origin: "https://cached.example.test",
          servers: [{ id: "private", name: "Private", status: "offline" }],
        },
      ],
    }),
  });
  await cached.controller.initialize();
  const record = cached.controller.list().panels.find((item) => !item.local);
  assert.equal(record.signedIn, false);
  assert.deepEqual(record.servers, []);
});

test("a sign-in queued behind roster refresh cannot start after sign-out", async (t) => {
  let hold = false,
    release,
    markBlocked;
  const blocked = new Promise((resolve) => {
    markBlocked = resolve;
  });
  const h = await harness(t, {
    pollMs: 20,
    behavior: async (url) => {
      if (hold && url.pathname === "/api/access/session") {
        hold = false;
        markBlocked();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    },
  });
  const panel = await h.signIn("https://a.example.test");
  hold = true;
  await blocked;
  const accepting = h.controller.acceptInvitation(panel.id, {
    token: "b".repeat(43),
    password: "fixture-password",
  });
  const rejected = assert.rejects(accepting, /sign-in changed/);
  await new Promise((resolve) => setImmediate(resolve));
  await h.controller.signOut(panel.id);
  release();
  await rejected;
  assert.equal(
    h.calls.filter((call) => call.url.pathname === "/api/access/accept").length,
    0,
  );
});

test("sign-out resumes background refresh after an in-flight invitation is cancelled", async (t) => {
  let release, entered, resumed;
  const gate = new Promise((resolve) => { release = resolve; });
  const authenticating = new Promise((resolve) => { entered = resolve; });
  const refreshed = new Promise((resolve) => { resumed = resolve; });
  let signedOut = false;
  const h = await harness(t, {
    pollMs: 20,
    behavior: async (url, options) => {
      if (url.pathname === "/api/access/accept") {
        entered();
        await gate;
        return response({ ...account, sessionToken: token });
      }
      if (signedOut && url.pathname === "/api/access/session" &&
          !new Headers(options.headers).has("Authorization")) resumed();
    },
  });
  const panel = await h.signIn("https://a.example.test");
  const accepting = h.controller.acceptInvitation(panel.id, {
    token: "b".repeat(43), password: "fixture-password",
  });
  const rejected = assert.rejects(accepting, /changed|abort/i);
  await authenticating;
  await h.controller.signOut(panel.id);
  signedOut = true;
  let timeout;
  try {
    await Promise.race([
      refreshed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Background refresh stayed paused after sign-out.")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    release();
    await rejected;
  }
  assert.equal(h.controller.list().panels.find((entry) => entry.id === panel.id).signedIn, false);
});

test("unified credentials are encrypted and offline roster persistence excludes paths and permissions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-unified-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Deterministic fake encryption verifies the store contract; native smoke
  // exercises Electron safeStorage under an isolated Windows profile.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split("").reverse().join("")),
    decryptString: (value) => value.toString().split("").reverse().join(""),
  };
  const store = createUnifiedConnectionStore({ dataDir: root, safeStorage });
  const id = "00000000-0000-4000-8000-000000000001";
  await store.save({
    selectedServer: { panelId: id, serverId: "same-id" },
    panels: [
      {
        id,
        origin: "https://a.example.test",
        token,
        session: account,
        servers: [
          {
            id: "same-id",
            name: "Private world",
            status: "running",
            serverDir: "C:/private",
            accessPermissions: ["file.update"],
          },
        ],
      },
    ],
  });
  const bytes = await fs.readFile(
    path.join(root, "desktop-workspace.json"),
    "utf8",
  );
  assert.ok(!bytes.includes(token));
  assert.ok(!bytes.includes("C:/private"));
  assert.ok(!bytes.includes("file.update"));
  const saved = await store.read();
  assert.equal(saved.panels[0].token, token);
  assert.equal(saved.panels[0].session.email, account.email);
  assert.equal(saved.panels[0].servers[0].status, "unavailable");
});

test("Forget confirms whole-panel departure before removing only the intended saved connection", async (t) => {
  let h, requestId;
  h = await harness(t, {
    behavior: async (url, options) => {
      if (url.pathname !== "/api/access/leave") return;
      const body = JSON.parse(options.body);
      assert.equal(body.confirmed, true);
      requestId = body.requestId;
      assert.equal(h.persisted.at(-1).panels.find((panel) => panel.origin === url.origin).pendingLeave.requestId, requestId);
      assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${token}`);
      return response({ left: true, requestId });
    },
  });
  const a = await h.signIn("https://a.example.test");
  const c = await h.signIn("https://c.example.test");
  await h.controller.selectServer(a.id, "same-id");
  await h.controller.forget(a.id, account.accountId);
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  assert.equal(h.controller.list().panels.some((panel) => panel.id === a.id), false);
  assert.equal(h.controller.list().panels.find((panel) => panel.id === c.id).signedIn, true);
  assert.equal(h.persisted.at(-1).panels.some((panel) => panel.id === a.id), false);
  assert.equal(h.calls.some((call) => /power/.test(call.url.pathname)), false);
});

test("lost Forget response retains original proof across restart and blocks operations until receipt retry", async (t) => {
  let requestId, originalBearer;
  const h = await harness(t, {
    behavior: async (url, options) => {
      if (url.pathname !== "/api/access/leave") return;
      requestId = JSON.parse(options.body).requestId;
      originalBearer = new Headers(options.headers).get("Authorization");
      throw new Error("Lost success response");
    },
  });
  const panel = await h.signIn("https://a.example.test");
  await assert.rejects(h.controller.forget(panel.id, account.accountId), /retry proof.*Lost success response/);
  const pending = h.controller.list().panels.find((entry) => entry.id === panel.id);
  assert.equal(pending.pendingLeave, true);
  assert.equal(pending.signedIn, true);
  assert.equal(pending.connectionState, "unavailable");
  assert.equal((await h.proxy(pending, "/server?serverId=same-id")).status, 409);
  await assert.rejects(h.controller.signOut(panel.id), /Retry Forget/);
  await assert.rejects(h.controller.signIn(panel.id, { email: account.email, password: "password" }), /Retry Forget/);
  await assert.rejects(h.controller.retry(panel.id), /Retry Forget/);
  await assert.rejects(h.controller.removeSavedConnection(panel.id, pending.sessionEpoch), /Retry Forget/);
  const calls = h.calls.length;
  await h.controller.restore();
  assert.equal(h.calls.length, calls);
  const saved = {
    selectedServer: h.persisted.at(-1).selectedServer,
    panels: h.persisted.at(-1).panels.map(({ id, origin, token, session, servers, pendingLeave }) =>
      ({ id, origin, token, session, servers, pendingLeave })),
  };
  await h.controller.close();
  const restored = await harness(t, {
    storeRead: async () => saved,
    behavior: async (url, options) => {
      assert.equal(url.pathname, "/api/access/leave", "pending departure must not refresh its revoked session");
      assert.equal(new Headers(options.headers).get("Authorization"), originalBearer);
      assert.equal(JSON.parse(options.body).requestId, requestId);
      return response({ left: true, requestId });
    },
  });
  await restored.controller.restore();
  assert.equal(restored.calls.length, 0);
  assert.equal(restored.controller.list().panels.find((entry) => entry.id === panel.id).pendingLeave, true);
  await restored.controller.forget(panel.id, account.accountId);
  assert.equal(restored.controller.list().panels.some((entry) => entry.id === panel.id), false);
});

test("definitive Forget rejection permits renewed sign-in and signed-out Forget never claims removal", async (t) => {
  const h = await harness(t, {
    behavior: async (url) => url.pathname === "/api/access/leave"
      ? response({ error: "Session expired" }, 401) : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  await assert.rejects(h.controller.forget(panel.id, account.accountId), /could not confirm access removal.*Session expired/);
  assert.equal(h.controller.list().panels.find((entry) => entry.id === panel.id).pendingLeave, false);
  assert.equal(h.persisted.at(-1).panels[0].pendingLeave, undefined);
  await h.controller.signIn(panel.id, { email: account.email, password: "password" });
  await h.controller.signOut(panel.id);
  await assert.rejects(h.controller.forget(panel.id, account.accountId), /Sign in.*before forgetting/);
  assert.equal(h.calls.filter((call) => call.url.pathname === "/api/access/leave").length, 1);
});

test("local removal write failure retains departure proof for the same receipt retry", async (t) => {
  let failRemoval = true;
  const requestIds = [];
  const h = await harness(t, {
    storeSave: async (value) => {
      if (failRemoval && !value.panels.length) throw new Error("Fixture disk unavailable");
    },
    behavior: async (url, options) => {
      if (url.pathname !== "/api/access/leave") return;
      const { requestId } = JSON.parse(options.body);
      requestIds.push(requestId);
      return response({ left: true, requestId });
    },
  });
  const panel = await h.signIn("https://a.example.test");
  await assert.rejects(h.controller.forget(panel.id, account.accountId), /Fixture disk unavailable/);
  assert.equal(h.controller.list().panels.find((entry) => entry.id === panel.id).pendingLeave, true);
  failRemoval = false;
  await h.controller.forget(panel.id, account.accountId);
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1]);
  assert.equal(h.controller.list().panels.some((entry) => entry.id === panel.id), false);
});

test("Forget rejects a stale confirmed account before changing state or sending the departure", async (t) => {
  let replacement = false;
  const h = await harness(t, {
    behavior: async (url) => replacement && ["/api/access/login", "/api/access/session"].includes(url.pathname)
      ? response({ ...account, accountId: "replacement", sessionToken: token }) : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  replacement = true;
  await h.controller.signIn(panel.id, { email: account.email, password: "password" });
  const before = h.controller.list();
  const calls = h.calls.length;
  await assert.rejects(h.controller.forget(panel.id, account.accountId), /account changed/);
  await assert.rejects(h.controller.forget(panel.id), /account changed/);
  assert.equal(h.calls.length, calls);
  assert.deepEqual(h.controller.list(), before);
  await h.controller.forget(panel.id, "replacement");
  assert.equal(h.controller.list().panels.some((entry) => entry.id === panel.id), false);
});

test("unified Forget IPC requires and forwards the confirmed account identity", () => {
  const handlers = new Map();
  const calls = [];
  const uninstall = installUnifiedConnectionIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  }, {
    isManagedSender: (event) => event.trusted === true,
    forget: (...args) => calls.push(args),
  });
  const forget = handlers.get("mc-panel-unified:forget");
  for (const accountId of [undefined, null, "", "x".repeat(129), {}])
    assert.throws(() => forget({ trusted: true }, "panel", accountId), /Confirm the signed-in account/);
  assert.throws(() => forget({ trusted: false }, "panel", "account"), /Only this computer/);
  forget({ trusted: true }, "panel", "account");
  assert.deepEqual(calls, [["panel", "account"]]);
  uninstall();
  assert.equal(handlers.size, 0);
});

test("proved revocation removes only that saved panel during refresh and stays removed after restart", async (t) => {
  let revoked = false;
  const h = await harness(t, {
    behavior: async (url) => revoked && url.host === "a.example.test" && url.pathname === "/api/access/session"
      ? response({ role: "guest", accessRevoked: true }) : undefined,
  });
  const a = await h.signIn("https://a.example.test");
  const c = await h.signIn("https://c.example.test");
  await h.controller.selectServer("local", "same-id");
  revoked = true;
  await h.controller.retry(a.id);
  assert.equal(h.controller.list().panels.some((entry) => entry.id === a.id), false);
  assert.equal(h.controller.list().panels.find((entry) => entry.id === c.id).signedIn, true);
  assert.deepEqual(h.controller.list().selectedServer, { panelId: "local", serverId: "same-id" });
  assert.equal(h.calls.some((call) => call.url.pathname === "/api/access/leave"), false);
  assert.ok(h.cleanup.some((entry) => entry.action === "legacy" && entry.id === a.id));
  for (const action of ["certificate", "storage", "connections"])
    assert.ok(h.cleanup.some((entry) => entry.action === action && entry.partition === `persist:mc-unified-${a.id}`));
  const saved = h.persisted.at(-1);
  assert.equal(saved.panels.some((entry) => entry.id === a.id), false);
  const restored = await harness(t, { storeRead: async () => saved });
  await restored.controller.restore();
  assert.equal(restored.controller.list().panels.some((entry) => entry.id === a.id), false);
  assert.equal(restored.calls.some((call) => call.url.origin === a.origin), false);
});

test("background discovery automatically removes a revoked account without a manual retry", async (t) => {
  let revoked = false;
  const h = await harness(t, {
    pollMs: 20,
    behavior: async (url) => revoked && url.pathname === "/api/access/session"
      ? response({ role: "guest", accessRevoked: true }) : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  revoked = true;
  const deadline = Date.now() + 2000;
  while (h.controller.list().panels.some((entry) => entry.id === panel.id) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.controller.list().panels.some((entry) => entry.id === panel.id), false);
  assert.equal(h.persisted.at(-1).panels.length, 0);
});

test("revocation markers on protected roster and proxy responses remove the connection and its selection", async (t) => {
  for (const pathname of ["/api/servers", "/api/server"]) {
    let revoked = false;
    const h = await harness(t, {
      behavior: async (url) => revoked && url.pathname === pathname
        ? response({ error: "Panel access revoked", accessRevoked: true }, 401) : undefined,
    });
    const panel = await h.signIn("https://a.example.test");
    await h.controller.selectServer(panel.id, "same-id");
    revoked = true;
    if (pathname === "/api/servers") await h.controller.retry(panel.id);
    else assert.equal((await h.proxy(panel, "/server?serverId=same-id")).status, 401);
    assert.equal(h.controller.list().panels.some((entry) => entry.id === panel.id), false);
    assert.equal(h.controller.list().selectedServer, null);
    assert.equal(h.persisted.at(-1).panels.length, 0);
  }
});

test("ordinary expired sessions and an empty authorized roster retain the saved panel", async (t) => {
  for (const status of ["guest", "expired", "string-marker", "no-servers"]) {
    let changed = false;
    const h = await harness(t, {
      behavior: async (url) => {
        if (!changed) return;
        if (url.pathname === "/api/access/session" && status === "guest") return response({ role: "guest" });
        if (url.pathname === "/api/servers") {
          if (status === "no-servers") return response({ servers: [], hostPermissions: [] });
          return response({ error: "Session expired", accessRevoked: status === "string-marker" ? "true" : false }, 401);
        }
      },
    });
    const panel = await h.signIn("https://a.example.test");
    changed = true;
    if (["expired", "string-marker"].includes(status)) await assert.rejects(h.controller.retry(panel.id), /Session expired/);
    else await h.controller.retry(panel.id);
    const saved = h.controller.list().panels.find((entry) => entry.id === panel.id);
    assert.ok(saved, status);
    assert.equal(saved.signedIn, status === "no-servers");
    assert.deepEqual(saved.servers, []);
    assert.equal(h.persisted.at(-1).panels.length, 1);
  }
});

test("automatic revocation cleanup retains its bearer and saved record if disk removal fails", async (t) => {
  let revoked = false, failRemoval = false;
  const h = await harness(t, {
    behavior: async (url) => revoked && url.pathname === "/api/access/session"
      ? response({ role: "guest", accessRevoked: true }) : undefined,
    storeSave: async (value) => {
      if (failRemoval && !value.panels.length) throw new Error("Disk unavailable");
    },
  });
  const panel = await h.signIn("https://a.example.test");
  revoked = failRemoval = true;
  await assert.rejects(h.controller.retry(panel.id), /Disk unavailable/);
  assert.ok(h.controller.list().panels.some((entry) => entry.id === panel.id));
  assert.equal(h.persisted.at(-1).panels[0].token, token);
  assert.equal(h.cleanup.length, 0);
  failRemoval = false;
  await h.controller.retry(panel.id);
  assert.equal(h.controller.list().panels.some((entry) => entry.id === panel.id), false);
});

test("a signed-out saved connection can be removed locally without a host request", async (t) => {
  let writing = false, release, started;
  const blocked = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, {
    storeSave: async (value) => {
      if (writing && !value.panels.length) {
        started();
        await gate;
      }
    },
  });
  const opened = await h.controller.open("https://a.example.test");
  const panel = opened.panels.find((entry) => !entry.local);
  const count = h.calls.length;
  writing = true;
  const removing = h.controller.removeSavedConnection(panel.id, panel.sessionEpoch);
  await blocked;
  assert.equal(h.cleanup.length, 0, "cleanup must follow the durable removal write");
  await assert.rejects(h.controller.signIn(panel.id, { email: account.email, password: "password" }), /no longer available/);
  release();
  await removing;
  assert.equal(h.calls.length, count);
  assert.equal(h.controller.list().panels.some((entry) => entry.id === panel.id), false);
  assert.equal(h.persisted.at(-1).panels.length, 0);
});

test("local saved-connection removal rejects a stale epoch and an in-flight sign-in", async (t) => {
  let hold = false, entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, {
    behavior: async (url) => {
      if (hold && url.pathname === "/api/access/login") { entered(); await gate; }
    },
  });
  const before = (await h.controller.open("https://a.example.test")).panels.find((entry) => !entry.local);
  hold = true;
  const signingIn = h.controller.signIn(before.id, { email: account.email, password: "password" });
  await started;
  await assert.rejects(h.controller.removeSavedConnection(before.id, before.sessionEpoch), /sign-in changed/);
  release();
  await signingIn;
  await h.controller.signOut(before.id);
  await assert.rejects(h.controller.removeSavedConnection(before.id, before.sessionEpoch), /sign-in changed/);
  const current = h.controller.list().panels.find((entry) => entry.id === before.id);
  await h.controller.removeSavedConnection(current.id, current.sessionEpoch);
  assert.equal(h.controller.list().panels.some((entry) => entry.id === before.id), false);
});

test("local saved-connection removal failure retains the record for a fresh confirmation", async (t) => {
  let failRemoval = false;
  const h = await harness(t, {
    storeSave: async (value) => {
      if (failRemoval && !value.panels.length) throw new Error("Disk unavailable");
    },
  });
  const panel = (await h.controller.open("https://a.example.test")).panels.find((entry) => !entry.local);
  failRemoval = true;
  await assert.rejects(h.controller.removeSavedConnection(panel.id, panel.sessionEpoch), /Disk unavailable/);
  const retained = h.controller.list().panels.find((entry) => entry.id === panel.id);
  assert.equal(retained.signedIn, false);
  assert.notEqual(retained.sessionEpoch, panel.sessionEpoch);
  assert.equal(h.cleanup.length, 0);
  failRemoval = false;
  await h.controller.removeSavedConnection(retained.id, retained.sessionEpoch);
  assert.equal(h.persisted.at(-1).panels.length, 0);
});

test("local saved-connection IPC requires and forwards the confirmed epoch", () => {
  const handlers = new Map(), calls = [];
  const uninstall = installUnifiedConnectionIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  }, {
    isManagedSender: (event) => event.trusted === true,
    removeSavedConnection: (...args) => calls.push(args),
  });
  const remove = handlers.get("mc-panel-unified:removeSavedConnection");
  for (const epoch of [undefined, null, "", "x".repeat(129), {}])
    assert.throws(() => remove({ trusted: true }, "panel", epoch), /Confirm the current signed-out/);
  assert.throws(() => remove({ trusted: false }, "panel", "epoch"), /Only this computer/);
  remove({ trusted: true }, "panel", "epoch");
  assert.deepEqual(calls, [["panel", "epoch"]]);
  uninstall();
  assert.equal(handlers.size, 0);
});

test("a delayed revocation response cannot discard durable pending Leave proof", async (t) => {
  let body, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname === "/api/access/leave") throw new Error("Lost departure response");
      if (url.pathname === "/api/server") return new Response(new ReadableStream({
        start(controller) { body = controller; entered(); },
      }), { status: 401, headers: { "Content-Type": "application/json" } });
    },
  });
  const panel = await h.signIn("https://a.example.test");
  const pending = h.proxy(panel, "/server?serverId=same-id");
  await started;
  await assert.rejects(h.controller.forget(panel.id, account.accountId), /Lost departure response/);
  const savedProof = h.persisted.at(-1).panels[0].pendingLeave.requestId;
  body.enqueue(new TextEncoder().encode(JSON.stringify({ error: "Panel access revoked", accessRevoked: true })));
  body.close();
  assert.equal((await pending).status, 409);
  const retained = h.controller.list().panels.find((entry) => entry.id === panel.id);
  assert.equal(retained.pendingLeave, true);
  assert.equal(h.persisted.at(-1).panels[0].pendingLeave.requestId, savedProof);
  assert.equal(h.persisted.at(-1).panels[0].token, token);
});

test("local removal prevents a delayed signed-out refresh from restoring the saved entry", async (t) => {
  let hold = false, release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, {
    behavior: async (url) => {
      if (hold && url.pathname === "/api/access/session") { entered(); await gate; }
    },
  });
  const panel = (await h.controller.open("https://a.example.test")).panels.find((entry) => !entry.local);
  hold = true;
  const refresh = h.controller.retry(panel.id);
  await started;
  await h.controller.removeSavedConnection(panel.id, panel.sessionEpoch);
  release();
  await refresh;
  await h.controller.close();
  assert.equal(h.persisted.at(-1).panels.length, 0);
  assert.equal(h.controller.list().panels.some((entry) => entry.id === panel.id), false);
});

test("automatic removal invalidates a concurrent sign-in response before it can restore credentials", async (t) => {
  let hold = false, release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, {
    behavior: async (url) => {
      if (hold && url.pathname === "/api/access/login") { entered(); await gate; }
      if (url.pathname === "/api/server") return response({ error: "Panel access revoked", accessRevoked: true }, 401);
    },
  });
  const panel = await h.signIn("https://a.example.test");
  hold = true;
  const signingIn = h.controller.signIn(panel.id, { email: account.email, password: "password" });
  const rejected = assert.rejects(signingIn, /changed|abort/i);
  await started;
  assert.equal((await h.proxy(panel, "/server?serverId=same-id")).status, 401);
  release();
  await rejected;
  await h.controller.close();
  assert.equal(h.persisted.at(-1).panels.length, 0);
  assert.equal(h.controller.list().panels.some((entry) => entry.id === panel.id), false);
});

test("an anonymous session marker cannot remove an already signed-out saved connection", async (t) => {
  const h = await harness(t, {
    behavior: async (url) => url.pathname === "/api/access/session"
      ? response({ role: "guest", accessRevoked: true }) : undefined,
  });
  const opened = await h.controller.open("https://a.example.test");
  assert.equal(opened.panels.filter((entry) => !entry.local).length, 1);
  assert.equal(h.persisted.at(-1).panels.length, 1);
});
