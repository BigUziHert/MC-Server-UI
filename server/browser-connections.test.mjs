import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  browserConnectionsKey,
  createBrowserConnectionController,
} from "../shared/browser-connections.mjs";

const home = "http://127.0.0.1:5173",
  remote = "https://one.example.test";
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const account = (id = "member") => ({
  role: "subuser",
  userId: id,
  accountId: id,
  email: `${id}@example.test`,
  serverId: "server",
  permissions: ["server.view"],
  hostPermissions: [],
});
async function fixture(t, options = {}) {
  const values = new Map(),
    requests = [],
    sessions = new Map(),
    revoked = new Set(),
    leaveReceipts = new Map(),
    homes = [];
  let failStorage = false,
    owner = options.owner ?? true,
    homeUnavailable = options.homeUnavailable ?? false,
    legacy = options.legacy ?? null,
    legacySelection = options.legacySelection ?? null,
    handler = options.handler;
  if (legacy) sessions.set(legacy, account());
  if (options.legacyRevoked) {
    sessions.delete(legacy);
    revoked.add(legacy);
  }
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failStorage) throw new Error("quota");
      values.set(key, value);
    },
  };
  const fetcher = async (input, init = {}) => {
    const url = new URL(input),
      headers = new Headers(init.headers),
      token = headers.get("Authorization")?.slice(7);
    requests.push({ url, init, token, headers });
    if (
      homeUnavailable &&
      url.origin === home &&
      url.pathname === "/api/access/session"
    )
      throw new TypeError("Home is offline");
    if (handler) {
      const result = await handler(url, init, token);
      if (result) return result;
    }
    if (url.origin === home && owner && url.pathname === "/api/access/session")
      return response({ role: "owner" });
    if (url.origin === home && owner && url.pathname === "/api/servers")
      return response(
        options.ownerRoster ?? {
          servers: [{ id: "server", name: "Minecraft", status: "offline" }],
          defaultServerId: "server",
        },
      );
    if (url.pathname === "/api/access/session")
      return response(
        sessions.get(token) ?? {
          role: "guest",
          ...(revoked.has(token) ? { accessRevoked: true } : {}),
        },
      );
    if (["/api/access/login", "/api/access/accept"].includes(url.pathname)) {
      const body = JSON.parse(init.body);
      if (body.password !== "correct password")
        return response({ error: "wrong password" }, 401);
      const sessionToken = randomBytes(32).toString("base64url"),
        session = account(body.email?.split("@")[0] ?? "member");
      sessions.set(sessionToken, session);
      return response({ ...session, sessionToken });
    }
    if (url.pathname === "/api/access/leave") {
      const { requestId } = JSON.parse(init.body);
      if (!leaveReceipts.has(requestId) && !sessions.has(token))
        return response({ error: "sign in" }, 401);
      leaveReceipts.set(requestId, true);
      sessions.delete(token);
      revoked.add(token);
      return response({ left: true, requestId });
    }
    if (url.pathname === "/api/access/logout") {
      sessions.delete(token);
      return response({ ok: true });
    }
    if (!sessions.has(token))
      return response(
        {
          error: "sign in",
          ...(revoked.has(token) ? { accessRevoked: true } : {}),
        },
        401,
      );
    if (url.pathname === "/api/servers")
      return response({
        servers: [
          {
            id: "server",
            name: "Minecraft",
            status: "offline",
            accessPermissions: ["server.view"],
          },
        ],
      });
    if (url.pathname === "/api/access/download") {
      const target = new URL(JSON.parse(init.body).url, url.origin);
      target.searchParams.set("downloadTicket", "t".repeat(43));
      return response({ url: target.pathname + target.search });
    }
    return response({ ok: true });
  };
  const controllers = [];
  const boot = async () => {
    const controller = createBrowserConnectionController({
      origin: home,
      storage,
      fetch: fetcher,
      pollMs: options.pollMs ?? 60000,
      legacyToken: () => legacy,
      legacySelection: () => legacySelection,
      lock: (operation) =>
        options.lock
          ? options.lock(operation, { values, storage, sessions })
          : operation(),
      homeCredential: (token) => {
        homes.push(token);
        legacy = token;
      },
    });
    controllers.push(controller);
    await controller.initialize();
    return controller;
  };
  t.after(async () => {
    for (const controller of controllers) await controller.close();
  });
  const controller = await boot();
  const connect = async (origin = remote, target = controller) => {
    let snapshot = await target.bridge.open(origin);
    const panel = snapshot.panels.find((item) => item.origin === origin);
    snapshot = await target.bridge.signIn(panel.id, {
      email: "member@example.test",
      password: "correct password",
    });
    return snapshot.panels.find((item) => item.id === panel.id);
  };
  return {
    controller,
    boot,
    connect,
    requests,
    sessions,
    revoked,
    leaveReceipts,
    homes,
    values,
    storage,
    failStorage: (value) => {
      failStorage = value;
    },
    handler: (value) => {
      handler = value;
    },
    owner: (value) => {
      owner = value;
    },
    homeUnavailable: (value) => {
      homeUnavailable = value;
    },
    legacy: (value) => {
      legacy = value;
    },
    legacySelection: (value) => {
      legacySelection = value;
    },
  };
}
const virtual = (panel, path = "/data?serverId=server") =>
  `/api/desktop/panels/${panel.id}/proxy/api${path}${path.includes("?") ? "&" : "?"}desktopEpoch=${panel.sessionEpoch}`;

test("browser controller proves local ownership and preserves separate saved origins and credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.controller.bridge.list()).panels[0].id, "local");
  const first = await f.connect(),
    second = await f.connect("https://two.example.test:3443");
  await (
    await f.controller.fetch(virtual(first), {
      headers: {
        Authorization: "Bearer forged",
        Cookie: "wrong",
        "X-Server-Id": "server",
      },
    })
  ).json();
  await (await f.controller.fetch(virtual(second))).json();
  const calls = f.requests.filter((item) => item.url.pathname === "/api/data");
  assert.deepEqual(
    calls.map((item) => item.url.origin),
    [remote, "https://two.example.test:3443"],
  );
  assert.notEqual(calls[0].token, calls[1].token);
  for (const call of calls) {
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.headers.get("Cookie"), null);
    assert.equal(call.headers.get("X-MC-Panel-Client"), "browser");
    assert.equal(call.url.searchParams.has("desktopEpoch"), false);
  }
  assert.deepEqual(
    f.homes,
    [],
    "other origins never change the legacy home credential",
  );
  const restarted = await f.boot();
  assert.equal(
    (await restarted.bridge.list()).panels.filter(
      (item) => item.signedIn && !item.local,
    ).length,
    2,
  );
});

test("a non-owner home is an ordinary remote account and adopts its existing bearer", async (t) => {
  const f = await fixture(t, { owner: false, legacy: "h".repeat(43) });
  const snapshot = await f.controller.bridge.list();
  assert.equal(
    snapshot.panels.some((item) => item.id === "local"),
    false,
  );
  assert.deepEqual(snapshot.localServers, []);
  assert.equal(snapshot.panels[0].origin, home);
  assert.equal(snapshot.panels[0].signedIn, true);
  await f.controller.bridge.signOut(snapshot.panels[0].id);
  assert.equal(f.homes.at(-1), null);
});

test("guests retain saved addresses, and denied sign-ins preserve an existing account epoch", async (t) => {
  const f = await fixture(t, { owner: false });
  const guest = (await f.controller.bridge.list()).panels[0];
  assert.equal(guest.signedIn, false);
  const panel = await f.connect();
  await assert.rejects(
    f.controller.bridge.signIn(panel.id, {
      email: "wrong@example.test",
      password: "wrong",
    }),
    { status: 401 },
  );
  assert.equal(
    (await f.controller.bridge.list()).panels.find(
      (item) => item.id === panel.id,
    ).sessionEpoch,
    panel.sessionEpoch,
  );
});

test("scoped requests refuse old epochs, escaped paths, mismatched server IDs and owner routes", async (t) => {
  const f = await fixture(t),
    panel = await f.connect();
  for (const url of [
    virtual({ ...panel, sessionEpoch: "old" }),
    virtual(panel, "/desktop/preferences"),
    virtual(panel, "/panel-users"),
    virtual(panel, "/access/login"),
    virtual(panel, "/data?serverId=other"),
    virtual(panel, "/files%2fcontent"),
  ])
    await assert.rejects(f.controller.fetch(url));
  await assert.rejects(
    f.controller.fetch(virtual(panel), { headers: { "X-Server-Id": "other" } }),
  );
});

test("proven revocation removes a saved panel but generic 401 retains its address", async (t) => {
  const f = await fixture(t),
    first = await f.connect(),
    second = await f.connect("https://two.example.test");
  const saved = JSON.parse(f.values.get(browserConnectionsKey));
  const firstToken = saved.panels.find((item) => item.id === first.id).token;
  f.sessions.delete(firstToken);
  f.revoked.add(firstToken);
  assert.equal((await f.controller.fetch(virtual(first))).status, 401);
  assert.equal(
    (await f.controller.bridge.list()).panels.some(
      (item) => item.id === first.id,
    ),
    false,
  );
  const secondToken = saved.panels.find((item) => item.id === second.id).token;
  f.sessions.delete(secondToken);
  assert.equal((await f.controller.fetch(virtual(second))).status, 401);
  const retained = (await f.controller.bridge.list()).panels.find(
    (item) => item.id === second.id,
  );
  assert.ok(retained);
  assert.equal(retained.signedIn, false);
});

test("Forget persists its original proof before sending and retries after a lost response and restart", async (t) => {
  const f = await fixture(t),
    panel = await f.connect();
  let first = true;
  f.handler((url, init) => {
    if (url.pathname !== "/api/access/leave") return;
    const stored = JSON.parse(f.values.get(browserConnectionsKey)).panels.find(
      (item) => item.id === panel.id,
    );
    assert.equal(
      stored.pendingLeave.requestId,
      JSON.parse(init.body).requestId,
    );
    if (first) {
      first = false;
      throw new TypeError("connection lost");
    }
  });
  await assert.rejects(
    f.controller.bridge.forget(panel.id, panel.session.accountId),
    /connection lost/,
  );
  const pending = (await f.controller.bridge.list()).panels.find(
    (item) => item.id === panel.id,
  );
  assert.equal(pending.pendingLeave, true);
  await assert.rejects(f.controller.bridge.signOut(panel.id), { status: 409 });
  await assert.rejects(
    f.controller.bridge.removeSavedConnection(panel.id, pending.sessionEpoch),
  );
  const restarted = await f.boot();
  await restarted.bridge.forget(panel.id, panel.session.accountId);
  assert.equal(
    (await restarted.bridge.list()).panels.some((item) => item.id === panel.id),
    false,
  );
  assert.equal(f.leaveReceipts.size, 1);
});

test("storage failure prevents destructive Forget and does not claim local removal", async (t) => {
  const f = await fixture(t),
    panel = await f.connect();
  f.failStorage(true);
  await assert.rejects(
    f.controller.bridge.forget(panel.id, panel.session.accountId),
    /could not be saved/,
  );
  assert.equal(
    f.requests.some((item) => item.url.pathname === "/api/access/leave"),
    false,
  );
  assert.equal(
    (await f.controller.bridge.list()).panels.find(
      (item) => item.id === panel.id,
    ).signedIn,
    true,
  );
  f.failStorage(false);
  await f.controller.bridge.signOut(panel.id);
  const signedOut = (await f.controller.bridge.list()).panels.find(
    (item) => item.id === panel.id,
  );
  f.failStorage(true);
  await assert.rejects(
    f.controller.bridge.removeSavedConnection(panel.id, signedOut.sessionEpoch),
    /could not be saved/,
  );
  assert.equal(
    (await f.controller.bridge.list()).panels.some(
      (item) => item.id === panel.id,
    ),
    true,
  );
});

test("storage changes invalidate response bodies and stale controls without resurrecting a removed panel", async (t) => {
  const f = await fixture(t),
    panel = await f.connect(),
    other = await f.boot();
  let source;
  f.handler((url) =>
    url.pathname === "/api/stream"
      ? new Response(
          new ReadableStream({
            start(controller) {
              source = controller;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      : undefined,
  );
  const stream = await f.controller.fetch(
    virtual(panel, "/stream?serverId=server"),
  );
  const read = stream.text();
  await other.bridge.signOut(panel.id);
  f.controller.storageChanged();
  source.enqueue(new TextEncoder().encode("stale"));
  source.close();
  await assert.rejects(read, /sign-in changed/);
  await assert.rejects(f.controller.fetch(virtual(panel)), { status: 409 });
  const signedOut = (await other.bridge.list()).panels.find(
    (item) => item.id === panel.id,
  );
  await other.bridge.removeSavedConnection(panel.id, signedOut.sessionEpoch);
  f.controller.storageChanged();
  assert.equal(
    (await f.controller.bridge.list()).panels.some(
      (item) => item.id === panel.id,
    ),
    false,
  );
});

test("download tickets are obtained from the selected origin and cannot redirect to another host", async (t) => {
  const f = await fixture(t),
    panel = await f.connect();
  const url = await f.controller.download(
    virtual(panel, "/files/download?serverId=server&path=world.zip"),
  );
  assert.equal(new URL(url).origin, remote);
  assert.equal(new URL(url).searchParams.get("downloadTicket"), "t".repeat(43));
  assert.equal(url.includes("Bearer"), false);
  f.handler((url) =>
    url.pathname === "/api/access/download"
      ? response({
          url: `https://evil.example/api/files/download?downloadTicket=${"x".repeat(43)}`,
        })
      : undefined,
  );
  await assert.rejects(
    f.controller.download(
      virtual(panel, "/files/download?serverId=server&path=world.zip"),
    ),
    /invalid download destination/,
  );
});

test("uploads pass their original FormData without buffering or sending another panel's credentials", async (t) => {
  const f = await fixture(t),
    panel = await f.connect(),
    data = new FormData();
  data.append("file", new Blob(["contents"]), "test.txt");
  await (
    await f.controller.fetch(virtual(panel, "/files/upload?serverId=server"), {
      method: "POST",
      body: data,
    })
  ).json();
  assert.equal(f.requests.at(-1).init.body, data);
  assert.equal(f.requests.at(-1).headers.has("Content-Type"), false);
});

test("a forgotten home panel is not silently recreated after reopening the workspace", async (t) => {
  const f = await fixture(t, { owner: false, legacy: "h".repeat(43) });
  const panel = (await f.controller.bridge.list()).panels[0];
  await f.controller.bridge.forget(panel.id, panel.session.accountId);
  const restarted = await f.boot();
  assert.equal((await restarted.bridge.list()).panels.length, 0);
});

test("a definitive host leave rejection releases pending state while retaining the saved connection", async (t) => {
  const f = await fixture(t),
    panel = await f.connect();
  f.handler((url) =>
    url.pathname === "/api/access/leave"
      ? response({ error: "Update this host first." }, 404)
      : undefined,
  );
  await assert.rejects(
    f.controller.bridge.forget(panel.id, panel.session.accountId),
    { status: 404 },
  );
  const retained = (await f.controller.bridge.list()).panels.find(
    (item) => item.id === panel.id,
  );
  assert.equal(retained.pendingLeave, false);
  await f.controller.bridge.signOut(panel.id);
});

test("multi-file download query pairs survive and extra returned selectors are rejected", async (t) => {
  const f = await fixture(t),
    panel = await f.connect();
  const input = virtual(
    panel,
    "/files/download?serverId=server&path=first.txt&path=second.txt",
  );
  assert.deepEqual(
    new URL(await f.controller.download(input)).searchParams.getAll("path"),
    ["first.txt", "second.txt"],
  );
  f.handler((url, init) => {
    if (url.pathname !== "/api/access/download") return;
    const target = new URL(JSON.parse(init.body).url, remote);
    target.searchParams.append("path", "secret.txt");
    target.searchParams.set("downloadTicket", "t".repeat(43));
    return response({ url: target.href });
  });
  await assert.rejects(
    f.controller.download(input),
    /changed the download destination/,
  );
});

test("an offline saved host does not delay initialization or authorize its cached roster", async (t) => {
  const f = await fixture(t),
    panel = await f.connect();
  f.handler((url, init) => {
    if (url.origin === remote)
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        );
      });
  });
  let timer;
  const restored = await Promise.race([
    f.boot(),
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Initialization waited for the offline host")),
        500,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  const row = (await restored.bridge.list()).panels.find(
    (item) => item.id === panel.id,
  );
  assert.equal(row.connectionState, "unavailable");
  assert.deepEqual(row.session.permissions, []);
  await assert.rejects(restored.fetch(virtual(row)), { status: 503 });
});

test("retry recovers a proven home owner after the initial session outage without host account actions", async (t) => {
  const f = await fixture(t, { homeUnavailable: true });
  const guest = (await f.controller.bridge.list()).panels[0];
  await f.controller.bridge.retry(guest.id);
  assert.equal(
    (await f.controller.bridge.list()).panels.some((row) => row.local),
    false,
  );
  f.homeUnavailable(false);
  const recovered = await f.controller.bridge.retry(guest.id);
  assert.deepEqual(
    recovered.panels.map((row) => row.id),
    ["local"],
  );
  assert.equal(f.requests.at(-1).init.credentials, "same-origin");
  assert.equal(
    f.requests.some((call) =>
      /\/access\/(?:leave|logout)$/.test(call.url.pathname),
    ),
    false,
  );
  assert.deepEqual(JSON.parse(f.values.get(browserConnectionsKey)).panels, []);
});

test("an existing local selection survives a home outage without granting cached ownership", async (t) => {
  const f = await fixture(t);
  await f.controller.bridge.selectServer("local", "server");
  await f.controller.close();
  f.homeUnavailable(true);
  const restored = await f.boot(),
    unavailable = await restored.bridge.list(),
    retryRow = unavailable.panels.find((row) => row.origin === home);
  assert.deepEqual(unavailable.selectedServer, {
    panelId: "local",
    serverId: "server",
  });
  assert.equal(
    unavailable.panels.some((row) => row.local),
    false,
  );
  assert.equal(retryRow.signedIn, false);
  await assert.rejects(restored.bridge.selectServer("local", "server"), {
    status: 403,
  });
  await restored.bridge.retry(retryRow.id);
  f.homeUnavailable(false);
  const recovered = await restored.bridge.retry(retryRow.id);
  assert.deepEqual(recovered.selectedServer, {
    panelId: "local",
    serverId: "server",
  });
  assert.deepEqual(
    recovered.panels.map((row) => row.id),
    ["local"],
  );
  await restored.close();
  f.owner(false);
  assert.equal((await (await f.boot()).bridge.list()).selectedServer, null);
});

test("a foreign host claiming owner cannot create or replace the local owner panel", async (t) => {
  const f = await fixture(t, { owner: false });
  f.handler((url) =>
    url.origin === remote && url.pathname === "/api/access/session"
      ? response({ role: "owner" })
      : undefined,
  );
  const snapshot = await f.controller.bridge.open(remote);
  assert.equal(
    snapshot.panels.some((row) => row.local),
    false,
  );
  assert.equal(
    snapshot.panels.find((row) => row.origin === remote).connectionState,
    "unavailable",
  );
  assert.equal(f.requests.at(-1).init.credentials, "omit");
  await assert.rejects(f.controller.bridge.selectServer("local", "server"), {
    status: 403,
  });
});

test("owner promotion maps the home selection locally without revoking its saved host account", async (t) => {
  const token = "h".repeat(43),
    f = await fixture(t, { owner: false, legacy: token });
  const panel = (await f.controller.bridge.list()).panels[0];
  await f.controller.bridge.retry(panel.id);
  await f.controller.bridge.selectServer(panel.id, "server");
  await f.controller.close();
  f.owner(true);
  const restored = await f.boot(),
    snapshot = await restored.bridge.list();
  assert.deepEqual(
    snapshot.panels.map((row) => row.id),
    ["local"],
  );
  assert.deepEqual(snapshot.selectedServer, {
    panelId: "local",
    serverId: "server",
  });
  assert.equal(f.sessions.has(token), true);
  assert.equal(
    f.requests.some((call) =>
      /\/access\/(?:leave|logout)$/.test(call.url.pathname),
    ),
    false,
  );
  assert.equal(f.homes.at(-1), null);
});

test("proven home ownership preserves an unresolved saved leave proof", async (t) => {
  const f = await fixture(t, { owner: false, legacy: "h".repeat(43) });
  const panel = (await f.controller.bridge.list()).panels[0];
  f.handler((url) => {
    if (url.pathname === "/api/access/leave") throw new TypeError("lost reply");
  });
  await assert.rejects(
    f.controller.bridge.forget(panel.id, panel.session.accountId),
  );
  const original = JSON.parse(f.values.get(browserConnectionsKey)).panels[0];
  await f.controller.close();
  f.owner(true);
  const snapshot = await (await f.boot()).bridge.list();
  assert.equal(
    snapshot.panels.some((row) => row.local),
    true,
  );
  assert.equal(
    snapshot.panels.find((row) => row.id === panel.id).pendingLeave,
    true,
  );
  assert.deepEqual(
    JSON.parse(f.values.get(browserConnectionsKey)).panels[0].pendingLeave,
    original.pendingLeave,
  );
  assert.equal(
    f.requests.filter((call) => call.url.pathname === "/api/access/leave")
      .length,
    1,
  );
});

test("restoration preserves the selected panel and server tuple while that host is offline", async (t) => {
  const f = await fixture(t),
    first = await f.connect(),
    second = await f.connect("https://two.example.test");
  await f.controller.bridge.selectServer(second.id, "server");
  await f.controller.close();
  f.handler((url) => {
    if (url.origin === second.origin)
      throw new TypeError("Second host offline");
  });
  const restored = await f.boot();
  await restored.bridge.retry(first.id);
  const snapshot = await restored.bridge.list();
  assert.deepEqual(snapshot.selectedServer, {
    panelId: second.id,
    serverId: "server",
  });
  assert.equal(
    snapshot.panels.find((row) => row.id === second.id).connectionState,
    "unavailable",
  );
});

test("an initial revoked legacy bearer leaves a durable home tombstone while a generic guest retains its address", async (t) => {
  const f = await fixture(t, {
    owner: false,
    legacy: "r".repeat(43),
    legacyRevoked: true,
  });
  assert.deepEqual((await f.controller.bridge.list()).panels, []);
  assert.equal(f.homes.at(-1), null);
  assert.equal(
    JSON.parse(f.values.get(browserConnectionsKey)).homeBootstrapped,
    true,
  );
  assert.deepEqual((await (await f.boot()).bridge.list()).panels, []);
  const guest = await fixture(t, {
    owner: false,
    legacy: "g".repeat(43),
    handler: (url) =>
      url.pathname === "/api/access/session"
        ? response({ role: "guest" })
        : undefined,
  });
  const saved = (await guest.controller.bridge.list()).panels;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].origin, home);
  assert.equal(saved[0].signedIn, false);
});

test("a revoked stale legacy bearer cannot erase a newer saved home account", async (t) => {
  const f = await fixture(t, { owner: false, legacy: "n".repeat(43) }),
    panel = (await f.controller.bridge.list()).panels[0];
  await f.controller.bridge.retry(panel.id);
  await f.controller.close();
  f.legacy("o".repeat(43));
  f.revoked.add("o".repeat(43));
  const restored = await f.boot();
  await restored.bridge.retry(panel.id);
  const saved = (await restored.bridge.list()).panels.find(
    (row) => row.id === panel.id,
  );
  assert.equal(saved.signedIn, true);
  assert.equal(
    JSON.parse(f.values.get(browserConnectionsKey)).panels[0].token,
    "n".repeat(43),
  );
});

test("home bootstrap rechecks current storage inside the cross-tab mutation lock", async (t) => {
  const token = "n".repeat(43),
    id = randomUUID(),
    epoch = randomUUID();
  let injected = false;
  const f = await fixture(t, {
    owner: false,
    lock: async (operation, { storage, sessions }) => {
      if (!injected) {
        injected = true;
        sessions.set(token, account());
        storage.setItem(
          browserConnectionsKey,
          JSON.stringify({
            version: 1,
            revision: 1,
            homeBootstrapped: true,
            panels: [
              {
                id,
                epoch,
                origin: home,
                token,
                session: account(),
                servers: [
                  { id: "server", name: "Minecraft", status: "offline" },
                ],
              },
            ],
            selectedServer: { panelId: id, serverId: "server" },
          }),
        );
      }
      return operation();
    },
  });
  const snapshot = await f.controller.bridge.list();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.panels.length, 1);
  assert.equal(snapshot.panels[0].id, id);
  assert.equal(snapshot.panels[0].sessionEpoch, epoch);
  assert.deepEqual(snapshot.selectedServer, {
    panelId: id,
    serverId: "server",
  });
  assert.equal(
    JSON.parse(f.values.get(browserConnectionsKey)).panels[0].token,
    token,
  );
});

test("a newer cross-tab remote selection survives the initial non-owner local-selection cleanup", async (t) => {
  let selectedElsewhere;
  const f = await fixture(t, {
    lock: async (operation, { storage }) => {
      if (selectedElsewhere) {
        const saved = JSON.parse(storage.getItem(browserConnectionsKey));
        saved.revision++;
        saved.selectedServer = selectedElsewhere;
        storage.setItem(browserConnectionsKey, JSON.stringify(saved));
        selectedElsewhere = undefined;
      }
      return operation();
    },
  });
  const remotePanel = await f.connect();
  await f.controller.bridge.selectServer("local", "server");
  await f.controller.close();
  f.owner(false);
  const expected = { panelId: remotePanel.id, serverId: "server" };
  selectedElsewhere = expected;
  const restarted = await f.boot();
  assert.deepEqual((await restarted.bridge.list()).selectedServer, expected);
  assert.deepEqual(
    JSON.parse(f.values.get(browserConnectionsKey)).selectedServer,
    expected,
  );
});

test("legacy local selection migrates once after live owner roster validation and stale IDs fall back", async (t) => {
  const ownerRoster = {
    servers: [
      { id: "first", name: "First", status: "offline" },
      { id: "second", name: "Second", status: "offline" },
    ],
    defaultServerId: "second",
  };
  const f = await fixture(t, { legacySelection: "first", ownerRoster });
  assert.deepEqual((await f.controller.bridge.list()).selectedServer, {
    panelId: "local",
    serverId: "first",
  });
  await f.controller.bridge.selectServer("local", "second");
  await f.controller.close();
  assert.deepEqual((await (await f.boot()).bridge.list()).selectedServer, {
    panelId: "local",
    serverId: "second",
  });
  const stale = await fixture(t, { legacySelection: "deleted", ownerRoster });
  assert.deepEqual((await stale.controller.bridge.list()).selectedServer, {
    panelId: "local",
    serverId: "second",
  });
  const nonowner = await fixture(t, {
    owner: false,
    legacySelection: "first",
    ownerRoster,
  });
  assert.equal((await nonowner.controller.bridge.list()).selectedServer, null);
});

test("creating or importing a server drains old roster reads before authorizing its follow-up installation", async (t) => {
  for (const route of ["server-setup", "server-import"]) {
    const f = await fixture(t),
      panel = await f.connect();
    let created = false,
      releaseOldRoster,
      rosterStarted;
    const started = new Promise((resolve) => {
      rosterStarted = resolve;
    });
    const servers = (includeNew) => ({
      servers: [
        { id: "server", name: "Existing", status: "offline" },
        ...(includeNew
          ? [{ id: "created", name: "New", status: "offline" }]
          : []),
      ],
    });
    f.handler((url) => {
      if (url.origin !== remote) return;
      if (url.pathname === `/api/${route}`) {
        created = true;
        return response({ server: { id: "created" } }, 201);
      }
      if (url.pathname === "/api/servers") {
        if (created) return response(servers(true));
        rosterStarted();
        return new Promise((resolve) => {
          releaseOldRoster = () => resolve(response(servers(false)));
        });
      }
    });
    const oldRead = f.controller.bridge.retry(panel.id);
    await started;
    const creation = f.controller.fetch(virtual(panel, `/${route}`), {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    await Promise.resolve();
    releaseOldRoster();
    await oldRead;
    assert.equal((await creation).status, 201);
    const installation = await f.controller.fetch(
      virtual(panel, "/versions/install?serverId=created"),
      { method: "POST", body: "{}" },
    );
    assert.equal(installation.status, 200);
    assert.equal(f.requests.at(-1).headers.get("X-Server-Id"), "created");
  }
});

test("network completion latency does not double the configured refresh interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const f = await fixture(t, { pollMs: 5000 });
  await f.connect();
  const polls = [];
  f.handler((url, _init, token) => {
    if (url.origin !== remote || url.pathname !== "/api/access/session") return;
    polls.push(Date.now());
    if (polls.length === 1)
      return new Promise((resolve) => {
        setTimeout(() => resolve(response(f.sessions.get(token))), 100);
      });
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(polls.length, 1);
  t.mock.timers.tick(100);
  await flush();
  // The completed refresh is due again at 10.1s, just after the original 10s
  // interval boundary. It must run by 11.1s rather than slipping to 15s.
  t.mock.timers.tick(5000);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(polls.length, 2);
  assert.ok(polls[1] >= 10100 && polls[1] <= 11100);
  f.handler((url) => {
    if (url.origin !== remote || url.pathname !== "/api/access/session") return;
    polls.push(Date.now());
    throw new TypeError("Host offline");
  });
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(polls.length, 3);
  t.mock.timers.tick(29000);
  await flush();
  assert.equal(polls.length, 3, "failed hosts retain their 30-second cooldown");
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(polls.length, 4);
});
