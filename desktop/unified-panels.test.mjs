import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
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
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send() {},
    getURL: () => runtime.url,
  });
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
          if (value === null)
            cleanup.push({ action: "certificate", partition });
        },
        clearStorageData: async () =>
          cleanup.push({ action: "storage", partition }),
        closeAllConnections: async () =>
          cleanup.push({ action: "connections", partition }),
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
            return response({
              left: true,
              requestId: JSON.parse(options.body).requestId,
            });
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
    try {
      await controller.close();
    } finally {
      await runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
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
  const savedSignedOut = async (origin) => {
    const panel = await signIn(origin);
    await controller.signOut(panel.id);
    return controller.list().panels.find((entry) => entry.id === panel.id);
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
    savedSignedOut,
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
    new TextEncoder().encode(
      JSON.stringify({ error: "Old account revoked", accessRevoked: true }),
    ),
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
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const authenticating = new Promise((resolve) => {
    entered = resolve;
  });
  const refreshed = new Promise((resolve) => {
    resumed = resolve;
  });
  let signedOut = false;
  const h = await harness(t, {
    pollMs: 20,
    behavior: async (url, options) => {
      if (url.pathname === "/api/access/accept") {
        entered();
        await gate;
        return response({ ...account, sessionToken: token });
      }
      if (
        signedOut &&
        url.pathname === "/api/access/session" &&
        !new Headers(options.headers).has("Authorization")
      )
        resumed();
    },
  });
  const panel = await h.signIn("https://a.example.test");
  const accepting = h.controller.acceptInvitation(panel.id, {
    token: "b".repeat(43),
    password: "fixture-password",
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
        timeout = setTimeout(
          () =>
            reject(
              new Error("Background refresh stayed paused after sign-out."),
            ),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    release();
    await rejected;
  }
  assert.equal(
    h.controller.list().panels.find((entry) => entry.id === panel.id).signedIn,
    false,
  );
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
      assert.equal(
        h.persisted.at(-1).panels.find((panel) => panel.origin === url.origin)
          .pendingLeave.requestId,
        requestId,
      );
      assert.equal(
        new Headers(options.headers).get("Authorization"),
        `Bearer ${token}`,
      );
      return response({ left: true, requestId });
    },
  });
  const a = await h.signIn("https://a.example.test");
  const c = await h.signIn("https://c.example.test");
  await h.controller.selectServer(a.id, "same-id");
  await h.controller.forget(a.id, account.accountId);
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  assert.equal(
    h.controller.list().panels.some((panel) => panel.id === a.id),
    false,
  );
  assert.equal(
    h.controller.list().panels.find((panel) => panel.id === c.id).signedIn,
    true,
  );
  assert.equal(
    h.persisted.at(-1).panels.some((panel) => panel.id === a.id),
    false,
  );
  assert.equal(
    h.calls.some((call) => /power/.test(call.url.pathname)),
    false,
  );
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
  await assert.rejects(
    h.controller.forget(panel.id, account.accountId),
    /retry proof.*Lost success response/,
  );
  const pending = h.controller
    .list()
    .panels.find((entry) => entry.id === panel.id);
  assert.equal(pending.pendingLeave, true);
  assert.equal(pending.signedIn, true);
  assert.equal(pending.connectionState, "unavailable");
  assert.equal(
    (await h.proxy(pending, "/server?serverId=same-id")).status,
    409,
  );
  await assert.rejects(h.controller.signOut(panel.id), /Retry Forget/);
  await assert.rejects(
    h.controller.signIn(panel.id, {
      email: account.email,
      password: "password",
    }),
    /Retry Forget/,
  );
  await assert.rejects(h.controller.retry(panel.id), /Retry Forget/);
  await assert.rejects(
    h.controller.removeSavedConnection(panel.id, pending.sessionEpoch),
    /Retry Forget/,
  );
  const calls = h.calls.length;
  await h.controller.restore();
  assert.equal(h.calls.length, calls);
  const saved = {
    selectedServer: h.persisted.at(-1).selectedServer,
    panels: h.persisted
      .at(-1)
      .panels.map(({ id, origin, token, session, servers, pendingLeave }) => ({
        id,
        origin,
        token,
        session,
        servers,
        pendingLeave,
      })),
  };
  await h.controller.close();
  const restored = await harness(t, {
    storeRead: async () => saved,
    behavior: async (url, options) => {
      assert.equal(
        url.pathname,
        "/api/access/leave",
        "pending departure must not refresh its revoked session",
      );
      assert.equal(
        new Headers(options.headers).get("Authorization"),
        originalBearer,
      );
      assert.equal(JSON.parse(options.body).requestId, requestId);
      return response({ left: true, requestId });
    },
  });
  await restored.controller.restore();
  assert.equal(restored.calls.length, 0);
  assert.equal(
    restored.controller.list().panels.find((entry) => entry.id === panel.id)
      .pendingLeave,
    true,
  );
  await restored.controller.forget(panel.id, account.accountId);
  assert.equal(
    restored.controller.list().panels.some((entry) => entry.id === panel.id),
    false,
  );
});

test("definitive Forget rejection permits renewed sign-in and signed-out Forget never claims removal", async (t) => {
  const h = await harness(t, {
    behavior: async (url) =>
      url.pathname === "/api/access/leave"
        ? response({ error: "Session expired" }, 401)
        : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  await assert.rejects(
    h.controller.forget(panel.id, account.accountId),
    /could not confirm access removal.*Session expired/,
  );
  assert.equal(
    h.controller.list().panels.find((entry) => entry.id === panel.id)
      .pendingLeave,
    false,
  );
  assert.equal(h.persisted.at(-1).panels[0].pendingLeave, undefined);
  await h.controller.signIn(panel.id, {
    email: account.email,
    password: "password",
  });
  await h.controller.signOut(panel.id);
  await assert.rejects(
    h.controller.forget(panel.id, account.accountId),
    /Sign in.*before forgetting/,
  );
  assert.equal(
    h.calls.filter((call) => call.url.pathname === "/api/access/leave").length,
    1,
  );
});

test("local removal write failure retains departure proof for the same receipt retry", async (t) => {
  let failRemoval = true;
  const requestIds = [];
  const h = await harness(t, {
    storeSave: async (value) => {
      if (failRemoval && !value.panels.length)
        throw new Error("Fixture disk unavailable");
    },
    behavior: async (url, options) => {
      if (url.pathname !== "/api/access/leave") return;
      const { requestId } = JSON.parse(options.body);
      requestIds.push(requestId);
      return response({ left: true, requestId });
    },
  });
  const panel = await h.signIn("https://a.example.test");
  await assert.rejects(
    h.controller.forget(panel.id, account.accountId),
    /Fixture disk unavailable/,
  );
  assert.equal(
    h.controller.list().panels.find((entry) => entry.id === panel.id)
      .pendingLeave,
    true,
  );
  failRemoval = false;
  await h.controller.forget(panel.id, account.accountId);
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1]);
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === panel.id),
    false,
  );
});

test("Forget rejects a stale confirmed account before changing state or sending the departure", async (t) => {
  let replacement = false;
  const h = await harness(t, {
    behavior: async (url) =>
      replacement &&
      ["/api/access/login", "/api/access/session"].includes(url.pathname)
        ? response({
            ...account,
            accountId: "replacement",
            sessionToken: token,
          })
        : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  replacement = true;
  await h.controller.signIn(panel.id, {
    email: account.email,
    password: "password",
  });
  const before = h.controller.list();
  const calls = h.calls.length;
  await assert.rejects(
    h.controller.forget(panel.id, account.accountId),
    /account changed/,
  );
  await assert.rejects(h.controller.forget(panel.id), /account changed/);
  assert.equal(h.calls.length, calls);
  assert.deepEqual(h.controller.list(), before);
  await h.controller.forget(panel.id, "replacement");
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === panel.id),
    false,
  );
});

test("unified Forget IPC requires and forwards the confirmed account identity", () => {
  const handlers = new Map();
  const calls = [];
  const uninstall = installUnifiedConnectionIpc(
    {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    {
      isManagedSender: (event) => event.trusted === true,
      forget: (...args) => calls.push(args),
    },
  );
  const forget = handlers.get("mc-panel-unified:forget");
  for (const accountId of [undefined, null, "", "x".repeat(129), {}])
    assert.throws(
      () => forget({ trusted: true }, "panel", accountId),
      /Confirm the signed-in account/,
    );
  assert.throws(
    () => forget({ trusted: false }, "panel", "account"),
    /Only this computer/,
  );
  forget({ trusted: true }, "panel", "account");
  assert.deepEqual(calls, [["panel", "account"]]);
  uninstall();
  assert.equal(handlers.size, 0);
});

test("proved revocation removes only that saved panel during refresh and stays removed after restart", async (t) => {
  let revoked = false;
  const h = await harness(t, {
    behavior: async (url) =>
      revoked &&
      url.host === "a.example.test" &&
      url.pathname === "/api/access/session"
        ? response({ role: "guest", accessRevoked: true })
        : undefined,
  });
  const a = await h.signIn("https://a.example.test");
  const c = await h.signIn("https://c.example.test");
  await h.controller.selectServer("local", "same-id");
  revoked = true;
  await h.controller.retry(a.id);
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === a.id),
    false,
  );
  assert.equal(
    h.controller.list().panels.find((entry) => entry.id === c.id).signedIn,
    true,
  );
  assert.deepEqual(h.controller.list().selectedServer, {
    panelId: "local",
    serverId: "same-id",
  });
  assert.equal(
    h.calls.some((call) => call.url.pathname === "/api/access/leave"),
    false,
  );
  assert.ok(
    h.cleanup.some((entry) => entry.action === "legacy" && entry.id === a.id),
  );
  for (const action of ["certificate", "storage", "connections"])
    assert.ok(
      h.cleanup.some(
        (entry) =>
          entry.action === action && entry.partition === `mc-unified-${a.id}`,
      ),
    );
  const saved = h.persisted.at(-1);
  assert.equal(
    saved.panels.some((entry) => entry.id === a.id),
    false,
  );
  const restored = await harness(t, { storeRead: async () => saved });
  await restored.controller.restore();
  assert.equal(
    restored.controller.list().panels.some((entry) => entry.id === a.id),
    false,
  );
  assert.equal(
    restored.calls.some((call) => call.url.origin === a.origin),
    false,
  );
});

test("background discovery automatically removes a revoked account without a manual retry", async (t) => {
  let revoked = false;
  const h = await harness(t, {
    pollMs: 20,
    behavior: async (url) =>
      revoked && url.pathname === "/api/access/session"
        ? response({ role: "guest", accessRevoked: true })
        : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  revoked = true;
  const deadline = Date.now() + 2000;
  while (
    h.controller.list().panels.some((entry) => entry.id === panel.id) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === panel.id),
    false,
  );
  assert.equal(h.persisted.at(-1).panels.length, 0);
});

test("revocation markers on protected roster and proxy responses remove the connection and its selection", async (t) => {
  for (const pathname of ["/api/servers", "/api/server"]) {
    let revoked = false;
    const h = await harness(t, {
      behavior: async (url) =>
        revoked && url.pathname === pathname
          ? response(
              { error: "Panel access revoked", accessRevoked: true },
              401,
            )
          : undefined,
    });
    const panel = await h.signIn("https://a.example.test");
    await h.controller.selectServer(panel.id, "same-id");
    revoked = true;
    if (pathname === "/api/servers") await h.controller.retry(panel.id);
    else
      assert.equal(
        (await h.proxy(panel, "/server?serverId=same-id")).status,
        401,
      );
    assert.equal(
      h.controller.list().panels.some((entry) => entry.id === panel.id),
      false,
    );
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
        if (url.pathname === "/api/access/session" && status === "guest")
          return response({ role: "guest" });
        if (url.pathname === "/api/servers") {
          if (status === "no-servers")
            return response({ servers: [], hostPermissions: [] });
          return response(
            {
              error: "Session expired",
              accessRevoked: status === "string-marker" ? "true" : false,
            },
            401,
          );
        }
      },
    });
    const panel = await h.signIn("https://a.example.test");
    changed = true;
    if (["expired", "string-marker"].includes(status))
      await assert.rejects(h.controller.retry(panel.id), /Session expired/);
    else await h.controller.retry(panel.id);
    const saved = h.controller
      .list()
      .panels.find((entry) => entry.id === panel.id);
    assert.ok(saved, status);
    assert.equal(saved.signedIn, status === "no-servers");
    assert.deepEqual(saved.servers, []);
    assert.equal(h.persisted.at(-1).panels.length, 1);
  }
});

test("automatic revocation cleanup retains its bearer and saved record if disk removal fails", async (t) => {
  let revoked = false,
    failRemoval = false;
  const h = await harness(t, {
    behavior: async (url) =>
      revoked && url.pathname === "/api/access/session"
        ? response({ role: "guest", accessRevoked: true })
        : undefined,
    storeSave: async (value) => {
      if (failRemoval && !value.panels.length)
        throw new Error("Disk unavailable");
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
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === panel.id),
    false,
  );
});

test("a signed-out saved connection can be removed locally without a host request", async (t) => {
  let writing = false,
    release,
    started;
  const blocked = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, {
    storeSave: async (value) => {
      if (writing && !value.panels.length) {
        started();
        await gate;
      }
    },
  });
  const panel = await h.savedSignedOut("https://a.example.test");
  const count = h.calls.length;
  const cleanups = h.cleanup.length;
  writing = true;
  const removing = h.controller.removeSavedConnection(
    panel.id,
    panel.sessionEpoch,
  );
  await blocked;
  assert.equal(
    h.cleanup.length,
    cleanups,
    "cleanup must follow the durable removal write",
  );
  await assert.rejects(
    h.controller.signIn(panel.id, {
      email: account.email,
      password: "password",
    }),
    /no longer available/,
  );
  release();
  await removing;
  assert.equal(h.calls.length, count);
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === panel.id),
    false,
  );
  assert.equal(h.persisted.at(-1).panels.length, 0);
});

test("local saved-connection removal rejects a stale epoch and an in-flight sign-in", async (t) => {
  let hold = false,
    entered,
    release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (hold && url.pathname === "/api/access/login") {
        entered();
        await gate;
      }
    },
  });
  const before = (
    await h.controller.open("https://a.example.test")
  ).panels.find((entry) => !entry.local);
  hold = true;
  const signingIn = h.controller.signIn(before.id, {
    email: account.email,
    password: "password",
  });
  await started;
  await assert.rejects(
    h.controller.removeSavedConnection(before.id, before.sessionEpoch),
    /sign-in changed/,
  );
  release();
  await signingIn;
  await h.controller.signOut(before.id);
  await assert.rejects(
    h.controller.removeSavedConnection(before.id, before.sessionEpoch),
    /sign-in changed/,
  );
  const current = h.controller
    .list()
    .panels.find((entry) => entry.id === before.id);
  await h.controller.removeSavedConnection(current.id, current.sessionEpoch);
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === before.id),
    false,
  );
});

test("local saved-connection removal failure retains the record for a fresh confirmation", async (t) => {
  let failRemoval = false;
  const h = await harness(t, {
    storeSave: async (value) => {
      if (failRemoval && !value.panels.length)
        throw new Error("Disk unavailable");
    },
  });
  const panel = await h.savedSignedOut("https://a.example.test");
  const cleanups = h.cleanup.length;
  failRemoval = true;
  await assert.rejects(
    h.controller.removeSavedConnection(panel.id, panel.sessionEpoch),
    /Disk unavailable/,
  );
  const retained = h.controller
    .list()
    .panels.find((entry) => entry.id === panel.id);
  assert.equal(retained.signedIn, false);
  assert.notEqual(retained.sessionEpoch, panel.sessionEpoch);
  assert.equal(h.cleanup.length, cleanups);
  failRemoval = false;
  await h.controller.removeSavedConnection(retained.id, retained.sessionEpoch);
  assert.equal(h.persisted.at(-1).panels.length, 0);
});

test("local saved-connection IPC requires and forwards the confirmed epoch", () => {
  const handlers = new Map(),
    calls = [];
  const uninstall = installUnifiedConnectionIpc(
    {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    {
      isManagedSender: (event) => event.trusted === true,
      removeSavedConnection: (...args) => calls.push(args),
    },
  );
  const remove = handlers.get("mc-panel-unified:removeSavedConnection");
  for (const epoch of [undefined, null, "", "x".repeat(129), {}])
    assert.throws(
      () => remove({ trusted: true }, "panel", epoch),
      /Confirm the current signed-out/,
    );
  assert.throws(
    () => remove({ trusted: false }, "panel", "epoch"),
    /Only this computer/,
  );
  remove({ trusted: true }, "panel", "epoch");
  assert.deepEqual(calls, [["panel", "epoch"]]);
  uninstall();
  assert.equal(handlers.size, 0);
});

test("a delayed revocation response cannot discard durable pending Leave proof", async (t) => {
  let body, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname === "/api/access/leave")
        throw new Error("Lost departure response");
      if (url.pathname === "/api/server")
        return new Response(
          new ReadableStream({
            start(controller) {
              body = controller;
              entered();
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
    },
  });
  const panel = await h.signIn("https://a.example.test");
  const pending = h.proxy(panel, "/server?serverId=same-id");
  await started;
  await assert.rejects(
    h.controller.forget(panel.id, account.accountId),
    /Lost departure response/,
  );
  const savedProof = h.persisted.at(-1).panels[0].pendingLeave.requestId;
  body.enqueue(
    new TextEncoder().encode(
      JSON.stringify({ error: "Panel access revoked", accessRevoked: true }),
    ),
  );
  body.close();
  assert.equal((await pending).status, 409);
  const retained = h.controller
    .list()
    .panels.find((entry) => entry.id === panel.id);
  assert.equal(retained.pendingLeave, true);
  assert.equal(h.persisted.at(-1).panels[0].pendingLeave.requestId, savedProof);
  assert.equal(h.persisted.at(-1).panels[0].token, token);
});

test("local removal prevents a delayed signed-out refresh from restoring the saved entry", async (t) => {
  let hold = false,
    release,
    entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (hold && url.pathname === "/api/access/session") {
        entered();
        await gate;
      }
    },
  });
  const panel = await h.savedSignedOut("https://a.example.test");
  hold = true;
  const refresh = h.controller.retry(panel.id);
  await started;
  await h.controller.removeSavedConnection(panel.id, panel.sessionEpoch);
  release();
  await refresh;
  await h.controller.close();
  assert.equal(h.persisted.at(-1).panels.length, 0);
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === panel.id),
    false,
  );
});

test("automatic removal invalidates a concurrent sign-in response before it can restore credentials", async (t) => {
  let hold = false,
    release,
    entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (hold && url.pathname === "/api/access/login") {
        entered();
        await gate;
      }
      if (url.pathname === "/api/server")
        return response(
          { error: "Panel access revoked", accessRevoked: true },
          401,
        );
    },
  });
  const panel = await h.signIn("https://a.example.test");
  hold = true;
  const signingIn = h.controller.signIn(panel.id, {
    email: account.email,
    password: "password",
  });
  const rejected = assert.rejects(signingIn, /changed|abort/i);
  await started;
  assert.equal((await h.proxy(panel, "/server?serverId=same-id")).status, 401);
  release();
  await rejected;
  await h.controller.close();
  assert.equal(h.persisted.at(-1).panels.length, 0);
  assert.equal(
    h.controller.list().panels.some((entry) => entry.id === panel.id),
    false,
  );
});

test("an anonymous session marker cannot remove an already signed-out saved connection", async (t) => {
  let marked = false;
  const h = await harness(t, {
    behavior: async (url) =>
      marked && url.pathname === "/api/access/session"
        ? response({ role: "guest", accessRevoked: true })
        : undefined,
  });
  await h.savedSignedOut("https://a.example.test");
  marked = true;
  const opened = await h.controller.open("https://a.example.test");
  assert.equal(opened.panels.filter((entry) => !entry.local).length, 1);
  assert.equal(h.persisted.at(-1).panels.length, 1);
});

test("new panel addresses stay temporary through failed sign-in and are discarded on cancel", async (t) => {
  const h = await harness(t, {
    behavior: async (url) =>
      url.pathname === "/api/access/login"
        ? response({ error: "Invalid email or password" }, 401)
        : undefined,
  });
  const draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => !panel.local,
  );
  assert.equal(draft.temporary, true);
  assert.equal(draft.signedIn, false);
  assert.equal(draft.connectionState, "connecting");
  assert.equal(h.controller.list().panels.length, 1);
  assert.equal(h.persisted.length, 0);
  const count = h.calls.length;
  assert.equal((await h.proxy(draft, "/server?serverId=same-id")).status, 401);
  assert.equal(
    h.calls.length,
    count,
    "drafts cannot send protected API requests",
  );
  await assert.rejects(
    h.controller.signIn(draft.id, { email: account.email, password: "wrong" }),
    /Invalid email/,
  );
  assert.equal(h.controller.list().panels.length, 1);
  assert.equal(h.persisted.length, 0);
  assert.deepEqual(
    h.calls.map((call) => call.url.pathname),
    ["/api/access/session", "/api/access/login"],
  );
  await h.controller.cancelSignIn(draft.id);
  await assert.rejects(
    h.controller.signIn(draft.id, {
      email: account.email,
      password: "password",
    }),
    /no longer available/,
  );
  for (const action of ["certificate", "storage", "connections"])
    assert.ok(
      h.cleanup.some(
        (entry) =>
          entry.action === action &&
          entry.partition === `mc-unified-${draft.id}`,
      ),
    );
  await h.controller.close();
  assert.equal(h.persisted.at(-1).panels.length, 0);
});

test("invitation preview can be cancelled and reopened without accepting or changing existing server grants", async (t) => {
  const invitation = "i".repeat(43),
    expires = new Date(Date.now() + 60000).toISOString();
  const h = await harness(t, {
    behavior: async (url) =>
      url.pathname === "/api/access/invitation"
        ? response({
            email: account.email,
            panelAddress: url.origin,
            inviteExpiresAt: expires,
          })
        : url.pathname === "/api/access/accept"
          ? response({ ...account, sessionToken: token })
          : undefined,
  });
  const other = await h.signIn("https://c.example.test");
  await h.controller.selectServer(other.id, "same-id");
  let draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => panel.temporary,
  );
  assert.deepEqual(
    await h.controller.invitation(draft.id, { token: invitation }),
    {
      email: account.email,
      panelAddress: draft.origin,
      inviteExpiresAt: expires,
    },
  );
  const preview = h.calls.at(-1);
  assert.equal(preview.headers.has("Authorization"), false);
  assert.deepEqual(JSON.parse(preview.body), { token: invitation });
  await h.controller.cancelSignIn(draft.id);
  assert.equal(
    h.calls.some((call) =>
      /\/access\/(accept|leave|logout)$/.test(call.url.pathname),
    ),
    false,
  );
  assert.deepEqual(h.controller.list().selectedServer, {
    panelId: other.id,
    serverId: "same-id",
  });
  assert.equal(
    h.controller.list().panels.filter((panel) => !panel.local).length,
    1,
  );
  draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => panel.temporary,
  );
  await h.controller.invitation(draft.id, { token: invitation });
  await h.controller.acceptInvitation(draft.id, {
    token: invitation,
    password: "new password",
  });
  const snapshot = h.controller.list();
  assert.equal(
    snapshot.panels.filter((panel) => !panel.local && panel.signedIn).length,
    2,
  );
  assert.deepEqual(snapshot.selectedServer, {
    panelId: other.id,
    serverId: "same-id",
  });
  assert.deepEqual(
    await (
      await h.proxy(
        snapshot.panels.find((panel) => panel.id === draft.id),
        "/server?serverId=same-id",
      )
    ).json(),
    {
      host: "a.example.test",
      serverId: "same-id",
    },
  );
});

test("canceling a saved panel attempt rejects late success and preserves both connected panels", async (t) => {
  let hold = false,
    release,
    entered,
    requestSignal;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await harness(t, {
    behavior: async (url, options) => {
      if (hold && url.pathname === "/api/access/accept") {
        requestSignal = options.signal;
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
        return response({
          ...account,
          accountId: "replacement",
          sessionToken: "b".repeat(43),
        });
      }
    },
  });
  const first = await h.signIn("https://a.example.test"),
    other = await h.signIn("https://c.example.test");
  await h.controller.selectServer(first.id, "same-id");
  hold = true;
  const pending = h.controller.acceptInvitation(first.id, {
    token: "i".repeat(43),
    password: "new password",
  });
  const rejected = assert.rejects(pending, /changed|abort/i);
  await started;
  await assert.rejects(
    h.controller.acceptInvitation(first.id, {
      token: "i".repeat(43),
      password: "new password",
    }),
    /already running/,
  );
  await h.controller.cancelSignIn(first.id);
  assert.equal(requestSignal.aborted, true);
  release();
  await rejected;
  const snapshot = h.controller.list();
  const retained = snapshot.panels.find((panel) => panel.id === first.id);
  assert.equal(retained.sessionEpoch, first.sessionEpoch);
  assert.equal(retained.session.accountId, first.session.accountId);
  assert.deepEqual(snapshot.selectedServer, {
    panelId: first.id,
    serverId: "same-id",
  });
  assert.equal(
    snapshot.panels.find((panel) => panel.id === other.id).signedIn,
    true,
  );
  assert.equal((await h.proxy(first, "/server?serverId=same-id")).status, 200);
  assert.equal(
    h.calls.filter((call) => call.url.pathname === "/api/access/accept").length,
    1,
  );
});

test("lost password setup response leaves a draft recoverable by ordinary sign-in", async (t) => {
  let passwordSaved = false;
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname === "/api/access/accept") {
        passwordSaved = true;
        throw new Error("Response lost");
      }
      if (url.pathname === "/api/access/login" && !passwordSaved)
        return response(
          { error: "Finish password setup with the invitation" },
          401,
        );
    },
  });
  let draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => panel.temporary,
  );
  await assert.rejects(
    h.controller.acceptInvitation(draft.id, {
      token: "i".repeat(43),
      password: "new password",
    }),
    /Response lost/,
  );
  assert.equal(h.persisted.length, 0);
  await h.controller.cancelSignIn(draft.id);
  draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => panel.temporary,
  );
  await h.controller.signIn(draft.id, {
    email: account.email,
    password: "new password",
  });
  assert.equal(
    h.controller.list().panels.find((panel) => panel.id === draft.id).signedIn,
    true,
  );
});

test("successful sign-in saves a draft once and later cancellation cannot remove the saved panel", async (t) => {
  const h = await harness(t);
  const draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => !panel.local,
  );
  assert.equal(h.persisted.length, 0);
  await h.controller.signIn(draft.id, {
    email: account.email,
    password: "password",
  });
  const saved = h.controller
    .list()
    .panels.find((panel) => panel.id === draft.id);
  assert.equal(saved.signedIn, true);
  assert.equal(saved.temporary, undefined);
  assert.equal(h.persisted.at(-1).panels.length, 1);
  assert.equal(h.persisted.at(-1).panels[0].token, token);
  await h.controller.cancelSignIn(draft.id);
  assert.equal(
    h.controller.list().panels.some((panel) => panel.id === draft.id),
    true,
  );
  await h.controller.signOut(draft.id);
  const reopened = (
    await h.controller.open("https://a.example.test")
  ).panels.find((panel) => panel.id === draft.id);
  assert.equal(reopened.temporary, undefined);
  await h.controller.cancelSignIn(draft.id);
  assert.equal(h.persisted.at(-1).panels.length, 1);
});

test("cancelling a draft invalidates a late successful authentication response", async (t) => {
  let started, release;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname === "/api/access/login") {
        started();
        await held;
      }
    },
  });
  const draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => !panel.local,
  );
  const signingIn = h.controller.signIn(draft.id, {
    email: account.email,
    password: "password",
  });
  const rejected = assert.rejects(signingIn, /changed|abort/i);
  await entered;
  await h.controller.cancelSignIn(draft.id);
  release();
  await rejected;
  assert.equal(h.persisted.length, 0);
  assert.equal(h.controller.list().panels.length, 1);
});

test("failed contact and failed credential storage never save a new panel", async (t) => {
  let offline = true,
    failSave = true;
  const h = await harness(t, {
    behavior: async () => {
      if (offline) throw new Error("Host offline");
    },
    storeSave: async (value) => {
      if (failSave && value.panels.length) throw new Error("Disk unavailable");
    },
  });
  await assert.rejects(
    h.controller.open("https://a.example.test"),
    /unavailable/i,
  );
  assert.equal(h.controller.list().panels.length, 1);
  assert.equal(h.persisted.length, 0);
  offline = false;
  const draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => !panel.local,
  );
  await assert.rejects(
    h.controller.signIn(draft.id, {
      email: account.email,
      password: "password",
    }),
    /Disk unavailable/,
  );
  assert.equal(h.controller.list().panels.length, 1);
  assert.equal(h.persisted.length, 0);
  failSave = false;
  await h.controller.signIn(draft.id, {
    email: account.email,
    password: "password",
  });
  assert.equal(
    h.controller.list().panels.find((panel) => panel.id === draft.id).signedIn,
    true,
  );
});

test("draft cancellation IPC remains restricted to the trusted local frame", () => {
  const handlers = new Map(),
    calls = [];
  const uninstall = installUnifiedConnectionIpc(
    {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    {
      isManagedSender: (event) => event.trusted === true,
      cancelSignIn: (id) => calls.push(id),
    },
  );
  const cancel = handlers.get("mc-panel-unified:cancelSignIn");
  assert.throws(
    () => cancel({ trusted: false }, "draft"),
    /Only this computer/,
  );
  assert.throws(() => cancel({ trusted: true }, {}), /valid panel/);
  cancel({ trusted: true }, "draft");
  assert.deepEqual(calls, ["draft"]);
  uninstall();
});

test("a roster outage after successful authentication keeps the saved sign-in and reports an unavailable host", async (t) => {
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname === "/api/servers") throw new Error("Host offline");
    },
  });
  const draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => !panel.local,
  );
  const signedIn = await h.controller.signIn(draft.id, {
    email: account.email,
    password: "password",
  });
  const saved = signedIn.panels.find((panel) => panel.id === draft.id);
  assert.equal(saved.signedIn, true);
  assert.equal(saved.temporary, undefined);
  assert.equal(saved.connectionState, "unavailable");
  assert.equal(h.persisted.at(-1).panels[0].token, token);
});

test("cancellation invalidates draft promotion queued behind a different workspace write", async (t) => {
  let release, entered, authenticated;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const writing = new Promise((resolve) => {
    entered = resolve;
  });
  const authenticatedResponse = new Promise((resolve) => {
    authenticated = resolve;
  });
  let block = true;
  const h = await harness(t, {
    storeSave: async () => {
      if (block) {
        entered();
        await held;
      }
    },
    behavior: async (url) => {
      if (url.pathname === "/api/access/login") authenticated();
    },
  });
  const draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => !panel.local,
  );
  const selection = h.controller.selectServer("local", "same-id");
  await writing;
  const signingIn = h.controller.signIn(draft.id, {
    email: account.email,
    password: "password",
  });
  const rejected = assert.rejects(signingIn, /changed|abort/i);
  try {
    await authenticatedResponse;
    // Let the successful response reach the save queue while its preceding
    // local selection write remains deliberately blocked.
    await new Promise((resolve) => setImmediate(resolve));
    await h.controller.cancelSignIn(draft.id);
  } finally {
    block = false;
    release();
  }
  await selection;
  await rejected;
  assert.equal(
    h.persisted.some((snapshot) => snapshot.panels.length),
    false,
  );
  assert.equal(h.controller.list().panels.length, 1);
});

test("separate sign-in forms own separate drafts for the same address", async (t) => {
  const h = await harness(t);
  const first = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => !panel.local,
  );
  const second = (
    await h.controller.open("https://a.example.test")
  ).panels.find((panel) => !panel.local);
  assert.notEqual(first.id, second.id);
  await h.controller.cancelSignIn(first.id);
  await h.controller.signIn(second.id, {
    email: account.email,
    password: "password",
  });
  await assert.rejects(
    h.controller.signIn(first.id, {
      email: account.email,
      password: "password",
    }),
    /no longer available/,
  );
  const reopened = (
    await h.controller.open("https://a.example.test")
  ).panels.find((panel) => !panel.local);
  assert.equal(reopened.id, second.id);
  assert.equal(reopened.temporary, undefined);
  assert.equal(h.persisted.at(-1).panels.length, 1);
});

test("a draft cannot overwrite another form's newly saved account", async (t) => {
  const h = await harness(t);
  const first = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => !panel.local,
  );
  const second = (
    await h.controller.open("https://a.example.test")
  ).panels.find((panel) => !panel.local);
  await h.controller.signIn(first.id, {
    email: account.email,
    password: "password",
  });
  await assert.rejects(
    h.controller.signIn(second.id, {
      email: account.email,
      password: "password",
    }),
    /already saved/,
  );
  assert.deepEqual(
    h.controller
      .list()
      .panels.filter((panel) => !panel.local)
      .map((panel) => panel.id),
    [first.id],
  );
  await h.controller.cancelSignIn(second.id);
  assert.equal(h.persisted.at(-1).panels.length, 1);
});

test("workspace reload cancels temporary and saved authentication without touching other panels", async (t) => {
  let release,
    entered,
    hold = false;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (hold && url.pathname === "/api/access/login") {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    },
  });
  const other = await h.signIn("https://c.example.test");
  const draft = (await h.controller.open("https://a.example.test")).panels.find(
    (panel) => panel.temporary,
  );
  hold = true;
  const pending = h.controller.signIn(draft.id, {
    email: account.email,
    password: "password",
  });
  const rejected = assert.rejects(pending, /changed|abort/i);
  await started;
  h.contents.emit("did-start-navigation", {}, h.runtime.url, false, false);
  assert.equal(
    h.calls.filter((call) => call.url.pathname === "/api/access/login").length,
    2,
  );
  h.contents.emit("did-start-navigation", {}, h.runtime.url, false, true);
  release();
  await rejected;
  assert.equal(
    h.controller.list().panels.filter((panel) => !panel.local).length,
    1,
  );
  assert.equal(
    h.controller.list().panels.find((panel) => panel.id === other.id).signedIn,
    true,
  );
  assert.equal(
    h.persisted.at(-1).panels.some((panel) => panel.id === draft.id),
    false,
  );
  await assert.rejects(
    h.controller.signIn(draft.id, {
      email: account.email,
      password: "password",
    }),
    /no longer available/,
  );
});

test("invitation preview IPC is restricted to the workspace and cannot be called by updater frames", () => {
  const handlers = new Map(),
    calls = [];
  const uninstall = installUnifiedConnectionIpc(
    {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    {
      isManagedSender: (event) => event.workspace === true,
      invitation: (id, input) => calls.push({ id, input }),
    },
  );
  const preview = handlers.get("mc-panel-unified:invitation");
  assert.throws(
    () => preview({ workspace: false }, "panel", { token: "i".repeat(43) }),
    /Only this computer/,
  );
  preview({ workspace: true }, "panel", { token: "i".repeat(43) });
  assert.deepEqual(calls, [{ id: "panel", input: { token: "i".repeat(43) } }]);
  uninstall();
});

test("canceling saved authentication queued behind persistence preserves the prior account and epoch", async (t) => {
  let block = false,
    entered,
    release,
    authenticated;
  const writing = new Promise((resolve) => {
    entered = resolve;
  });
  const responseReady = new Promise((resolve) => {
    authenticated = resolve;
  });
  const h = await harness(t, {
    storeSave: async () => {
      if (block) {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    },
    behavior: async (url) => {
      if (block && url.pathname === "/api/access/login") {
        authenticated();
        return response({
          ...account,
          accountId: "replacement",
          sessionToken: "b".repeat(43),
        });
      }
    },
  });
  const first = await h.signIn("https://a.example.test"),
    other = await h.signIn("https://c.example.test");
  block = true;
  const selection = h.controller.selectServer(first.id, "same-id");
  await writing;
  const pending = h.controller.signIn(first.id, {
    email: account.email,
    password: "password",
  });
  const rejected = assert.rejects(pending, /changed|abort/i);
  await responseReady;
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = h.controller
    .list()
    .panels.find((panel) => panel.id === first.id);
  assert.equal(waiting.sessionEpoch, first.sessionEpoch);
  assert.equal(waiting.session.accountId, first.session.accountId);
  assert.equal(waiting.servers.length, 1);
  await h.controller.cancelSignIn(first.id);
  block = false;
  release();
  await selection;
  await rejected;
  const snapshot = h.controller.list();
  assert.equal(
    snapshot.panels.find((panel) => panel.id === first.id).sessionEpoch,
    first.sessionEpoch,
  );
  assert.equal(
    snapshot.panels.find((panel) => panel.id === other.id).signedIn,
    true,
  );
  assert.deepEqual(snapshot.selectedServer, {
    panelId: first.id,
    serverId: "same-id",
  });
  assert.equal(
    h.persisted.at(-1).panels.find((panel) => panel.id === first.id).token,
    token,
  );
});

test("failed saved authentication storage retains the previous usable account", async (t) => {
  let failSave = false;
  const h = await harness(t, {
    storeSave: async () => {
      if (failSave) throw new Error("Disk unavailable");
    },
    behavior: async (url) =>
      failSave && url.pathname === "/api/access/login"
        ? response({
            ...account,
            accountId: "replacement",
            sessionToken: "b".repeat(43),
          })
        : undefined,
  });
  const first = await h.signIn("https://a.example.test");
  failSave = true;
  await assert.rejects(
    h.controller.signIn(first.id, {
      email: account.email,
      password: "password",
    }),
    /Disk unavailable/,
  );
  failSave = false;
  const retained = h.controller
    .list()
    .panels.find((panel) => panel.id === first.id);
  assert.equal(retained.sessionEpoch, first.sessionEpoch);
  assert.equal(retained.session.accountId, first.session.accountId);
  assert.equal(retained.servers.length, 1);
  assert.equal((await h.proxy(first, "/server?serverId=same-id")).status, 200);
});

test("native revocation sequences remove a signed-out account without disturbing colliding servers on another panel", async (t) => {
  for (const sequence of [
    "signout-revoke",
    "revoke-signout",
    "expired-revoke",
    "restart-revoke",
  ]) {
    await t.test(sequence, async (t) => {
      const revoked = new Set(),
        expired = new Set(),
        proofs = new Map([
          ["https://a.example.test", "r".repeat(43)],
          ["https://c.example.test", "s".repeat(43)],
        ]);
      const behavior = async (url, options) => {
        if (url.pathname === "/api/access/login")
          return response({
            ...account,
            sessionToken: token,
            revocationToken: proofs.get(url.origin),
          });
        if (url.pathname === "/api/access/logout")
          return response({
            ok: true,
            revocationToken: proofs.get(url.origin),
            accessRevoked: revoked.has(url.origin),
          });
        if (url.pathname === "/api/access/status") {
          assert.equal(
            new Headers(options.headers).has("Authorization"),
            false,
          );
          assert.equal(JSON.parse(options.body).token, proofs.get(url.origin));
          return response({ accessRevoked: revoked.has(url.origin) });
        }
        if (url.pathname === "/api/access/session" && expired.has(url.origin))
          return response({ role: "guest" });
      };
      const h = await harness(t, { behavior }),
        first = await h.signIn("https://a.example.test"),
        other = await h.signIn("https://c.example.test");
      assert.equal(
        JSON.stringify(h.controller.list()).includes(proofs.get(first.origin)),
        false,
      );
      await h.controller.selectServer(first.id, "same-id");
      if (sequence === "revoke-signout") revoked.add(first.origin);
      if (sequence === "expired-revoke") {
        expired.add(first.origin);
        await h.controller.retry(first.id);
      } else {
        await Promise.all([
          h.controller.signOut(first.id),
          h.controller.signOut(first.id),
        ]);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(h.controller.list().selectedServer, null);
      await h.controller.selectServer(other.id, "same-id");
      if (sequence !== "revoke-signout") {
        const retained = h.persisted
          .at(-1)
          .panels.find((panel) => panel.id === first.id);
        assert.equal(retained.token, null);
        assert.equal(retained.session, undefined);
        assert.deepEqual(retained.servers, []);
        assert.equal(retained.revocationToken, proofs.get(first.origin));
      }
      revoked.add(first.origin);
      let controller = h.controller;
      if (sequence === "restart-revoke") {
        await controller.close();
        const state = h.persisted.at(-1);
        const restarted = await harness(t, {
          behavior,
          storeRead: async () => state,
        });
        controller = restarted.controller;
        await controller.restore();
      } else if (
        controller.list().panels.some((panel) => panel.id === first.id)
      )
        await controller.retry(first.id);
      const snapshot = controller.list();
      assert.equal(
        snapshot.panels.some((panel) => panel.id === first.id),
        false,
      );
      assert.equal(
        snapshot.panels.find((panel) => panel.id === other.id).signedIn,
        true,
      );
      assert.deepEqual(snapshot.selectedServer, {
        panelId: other.id,
        serverId: "same-id",
      });
    });
  }
});

test("native signed-out status errors retain the connection until explicit proof confirms revocation", async (t) => {
  let state = "unknown";
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname === "/api/access/login")
        return response({
          ...account,
          sessionToken: token,
          revocationToken: "r".repeat(43),
        });
      if (url.pathname !== "/api/access/status") return;
      if (state === "offline") throw new Error("offline");
      if (typeof state === "number")
        return response({ error: "Unavailable", accessRevoked: true }, state);
      return response({
        accessRevoked: state === "string-marker" ? "true" : state === "revoked",
      });
    },
  });
  const panel = await h.signIn("https://a.example.test");
  await h.controller.signOut(panel.id);
  await new Promise((resolve) => setImmediate(resolve));
  for (state of ["offline", 429, 401, 403, "unknown", "string-marker"]) {
    if (state === "offline" || typeof state === "number")
      await assert.rejects(h.controller.retry(panel.id));
    else await h.controller.retry(panel.id);
    const retained = h.controller
      .list()
      .panels.find((row) => row.id === panel.id);
    assert.ok(retained, String(state));
    assert.equal(retained.signedIn, false);
    assert.deepEqual(retained.servers, []);
  }
  state = "revoked";
  await h.controller.retry(panel.id);
  assert.equal(
    h.controller.list().panels.some((row) => row.id === panel.id),
    false,
  );
});

test("late native logout confirmation cannot remove a replacement account or its new status proof", async (t) => {
  let entered,
    release,
    replacement = false;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname === "/api/access/login")
        return response({
          ...account,
          sessionToken: token,
          revocationToken: (replacement ? "n" : "r").repeat(43),
        });
      if (url.pathname === "/api/access/status")
        return response({ accessRevoked: false });
      if (url.pathname === "/api/access/logout") {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
        return response({
          ok: true,
          accessRevoked: true,
          revocationToken: "r".repeat(43),
        });
      }
    },
  });
  const first = await h.signIn("https://a.example.test");
  await h.controller.signOut(first.id);
  await started;
  replacement = true;
  await h.controller.signIn(first.id, {
    email: account.email,
    password: "password",
  });
  const next = h.controller
    .list()
    .panels.find((panel) => panel.id === first.id);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.controller.list().panels.find((panel) => panel.id === first.id)
      .sessionEpoch,
    next.sessionEpoch,
  );
  assert.equal(
    h.persisted.at(-1).panels.find((panel) => panel.id === first.id)
      .revocationToken,
    "n".repeat(43),
  );
});

test("legacy native sign-out learns a status proof without keeping a sign-in credential", async (t) => {
  const h = await harness(t, {
    behavior: async (url) =>
      url.pathname === "/api/access/logout"
        ? response({ ok: true, revocationToken: "r".repeat(43) })
        : url.pathname === "/api/access/status"
          ? response({ accessRevoked: true })
          : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  await h.controller.signOut(panel.id);
  await new Promise((resolve) => setImmediate(resolve));
  const saved = h.persisted.at(-1).panels.find((row) => row.id === panel.id);
  assert.equal(saved.token, null);
  assert.equal(saved.revocationToken, "r".repeat(43));
  await h.controller.retry(panel.id);
  assert.equal(
    h.controller.list().panels.some((row) => row.id === panel.id),
    false,
  );
});

test("native background polling removes revoked membership after normal sign-out without a retry", async (t) => {
  let revoked = false;
  const h = await harness(t, {
    pollMs: 20,
    behavior: async (url) =>
      url.pathname === "/api/access/login"
        ? response({
            ...account,
            sessionToken: token,
            revocationToken: "r".repeat(43),
          })
        : url.pathname === "/api/access/status"
          ? response({ accessRevoked: revoked })
          : undefined,
  });
  const panel = await h.signIn("https://a.example.test");
  await h.controller.signOut(panel.id);
  revoked = true;
  const deadline = Date.now() + 2000;
  while (
    h.controller.list().panels.some((row) => row.id === panel.id) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    h.controller.list().panels.some((row) => row.id === panel.id),
    false,
  );
  assert.equal(h.persisted.at(-1).panels.length, 0);
});

test("a native guest session drops stale credentials before a failing optional status probe", async (t) => {
  for (const failure of [404, 429, "offline"]) {
    let expired = false;
    const h = await harness(t, {
      behavior: async (url) => {
        if (url.pathname === "/api/access/login")
          return response({
            ...account,
            sessionToken: token,
            revocationToken: "r".repeat(43),
          });
        if (!expired) return;
        if (url.pathname === "/api/access/session")
          return response({ role: "guest" });
        if (url.pathname === "/api/access/status") {
          if (failure === "offline") throw new Error("offline");
          return response({ error: "Retry later" }, failure);
        }
      },
    });
    const panel = await h.signIn("https://a.example.test");
    expired = true;
    await assert.rejects(h.controller.retry(panel.id));
    const retained = h.controller
        .list()
        .panels.find((row) => row.id === panel.id),
      saved = h.persisted.at(-1).panels[0];
    assert.equal(retained.signedIn, false);
    assert.equal(retained.session, undefined);
    assert.deepEqual(retained.servers, []);
    assert.equal(saved.token, null);
    assert.equal(saved.revocationToken, "r".repeat(43));
  }
});

test("native old-account logout confirmation waits for a queued replacement outcome", async (t) => {
  for (const outcome of ["success", "cancel"])
    await t.test(outcome, async (t) => {
      let block = false,
        releaseWrite,
        writing,
        releaseLogout,
        logoutStarted,
        authenticated;
      const writingReady = new Promise((resolve) => {
          writing = resolve;
        }),
        loggingOut = new Promise((resolve) => {
          logoutStarted = resolve;
        }),
        responseReady = new Promise((resolve) => {
          authenticated = resolve;
        });
      const h = await harness(t, {
        storeSave: async () => {
          if (block) {
            writing();
            await new Promise((resolve) => {
              releaseWrite = resolve;
            });
          }
        },
        behavior: async (url, options) => {
          if (url.pathname === "/api/access/login" && block) {
            authenticated();
            return response({
              ...account,
              accountId: "replacement",
              sessionToken: "b".repeat(43),
              revocationToken: "n".repeat(43),
            });
          }
          if (
            url.pathname === "/api/access/session" &&
            new Headers(options.headers).get("Authorization") ===
              `Bearer ${"b".repeat(43)}`
          )
            return response({ ...account, accountId: "replacement" });
          if (url.pathname !== "/api/access/logout") return;
          logoutStarted();
          await new Promise((resolve) => {
            releaseLogout = resolve;
          });
          return response({ ok: true, accessRevoked: true });
        },
      });
      const panel = await h.signIn("https://a.example.test");
      await h.controller.signOut(panel.id);
      await loggingOut;
      block = true;
      const selecting = h.controller.selectServer("local", "same-id");
      await writingReady;
      const signingIn = h.controller.signIn(panel.id, {
        email: account.email,
        password: "password",
      });
      const settled =
        outcome === "cancel"
          ? assert.rejects(signingIn, /changed|abort/i)
          : signingIn;
      await responseReady;
      await new Promise((resolve) => setImmediate(resolve));
      releaseLogout();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        h.controller.list().panels.some((row) => row.id === panel.id),
        true,
      );
      const cancelling =
        outcome === "cancel"
          ? h.controller.cancelSignIn(panel.id)
          : Promise.resolve();
      block = false;
      releaseWrite();
      await Promise.all([selecting, settled, cancelling]);
      const retained = h.controller
        .list()
        .panels.find((row) => row.id === panel.id);
      if (outcome === "success")
        assert.equal(retained.session.accountId, "replacement");
      else assert.equal(retained, undefined);
    });
});

test("overlapping native opens identify their own draft after another form saves the same origin", async (t) => {
  let entered,
    release,
    first = true;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (url.pathname !== "/api/access/session" || !first) return;
      first = false;
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      return response({ role: "guest" });
    },
  });
  const opening = h.controller.open("https://a.example.test");
  await started;
  const second = await h.controller.open("https://a.example.test"),
    target = second.panels.find((panel) => panel.id === second.openedPanelId);
  assert.equal(target.temporary, true);
  await h.controller.signIn(target.id, {
    email: account.email,
    password: "password",
  });
  release();
  const stale = await opening,
    owned = stale.panels.find((panel) => panel.id === stale.openedPanelId);
  assert.notEqual(stale.openedPanelId, second.openedPanelId);
  assert.equal(owned.temporary, true);
  assert.equal(
    stale.panels.find((panel) => panel.origin === target.origin).id,
    target.id,
    "origin matching would select the newer saved panel",
  );
  await h.controller.cancelSignIn(owned.id);
  const retained = h.controller
    .list()
    .panels.find((panel) => panel.id === target.id);
  assert.equal(retained.signedIn, true);
  assert.ok(
    h.cleanup.some((entry) => entry.partition === `mc-unified-${owned.id}`),
  );
  assert.equal(
    h.cleanup.some((entry) => entry.partition === `mc-unified-${target.id}`),
    false,
  );
  const reopened = await h.controller.open(target.origin);
  assert.equal(reopened.openedPanelId, target.id);
  await assert.rejects(
    h.controller.signIn(owned.id, {
      email: account.email,
      password: "password",
    }),
    /no longer available/,
  );
});

test("a failed native saved-address probe cannot cancel another form's queued sign-in", async (t) => {
  let hold = false,
    entered,
    release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const h = await harness(t, {
    behavior: async (url) => {
      if (!hold || url.pathname !== "/api/access/session") return;
      hold = false;
      entered();
      await new Promise((_, reject) => {
        release = () => reject(new Error("Host temporarily offline"));
      });
    },
  });
  const panel = await h.savedSignedOut("https://a.example.test");
  hold = true;
  const opening = h.controller.open(panel.origin);
  const rejected = assert.rejects(opening, /unavailable/i);
  await started;
  const signingIn = h.controller.signIn(panel.id, {
    email: account.email,
    password: "password",
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await rejected;
  await signingIn;
  assert.equal(
    h.controller.list().panels.find((row) => row.id === panel.id).signedIn,
    true,
  );
  assert.equal(
    h.persisted.at(-1).panels.find((row) => row.id === panel.id).token,
    token,
  );
});
