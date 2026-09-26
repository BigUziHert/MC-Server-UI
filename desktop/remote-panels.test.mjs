import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";
import { Resvg } from "@resvg/resvg-js";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";
import { createRemotePanelController } from "./remote-panels.mjs";
import {
  installConnectionIpc,
  CONNECTION_CHANNELS,
} from "./connections-ipc.mjs";
import { DESKTOP_COOKIE_NAME, startDesktopRuntime } from "./runtime.mjs";
import { requiredPermissions } from "../server/remote-access.mjs";

const invite = "a".repeat(43);
const origin = "https://panel.example:3002";

function harness({
  responses = [],
  load,
  localServers = [],
  selectLocalServer,
  store,
  restoreTimeoutMs,
  onError,
  remoteFrontend,
  openUpdatesOverlay,
} = {}) {
  const views = [];
  const partitions = [];
  const prompts = [];
  const openedWebsites = [];
  const contents = () => {
    const value = new EventEmitter();
    value.url = "";
    value.mainFrame = { url: "", origin: "null" };
    value.getURL = () => value.url;
    value.isDestroyed = () => Boolean(value.destroyed);
    value.isLoadingMainFrame = () => Boolean(value.loading);
    value.stop = () => {
      value.stopped = true;
    };
    value.focus = () => {
      value.focused = true;
    };
    value.sent = [];
    value.send = (...args) => value.sent.push(args);
    value.close = () => {
      value.destroyed = true;
      value.emit("destroyed");
    };
    return value;
  };
  const owner = new EventEmitter();
  owner.webContents = contents();
  owner.webContents.url = "http://127.0.0.1:3001/";
  owner.webContents.mainFrame = {
    url: owner.webContents.url,
    origin: "http://127.0.0.1:3001",
  };
  owner.isDestroyed = () => false;
  owner.getContentSize = () => [1200, 800];
  owner.setTitle = (value) => {
    owner.title = value;
  };
  owner.contentView = {
    children: [],
    addChildView(view) {
      this.children.push(view);
    },
    removeChildView(view) {
      this.children = this.children.filter((item) => item !== view);
    },
  };
  class FakeView {
    constructor(options) {
      this.options = options;
      this.webContents = contents();
      this.webContents.setWindowOpenHandler = (handler) => {
        this.popup = handler;
      };
      this.webContents.loadURL = async (url) => {
        this.webContents.url = url;
        this.webContents.mainFrame = { url, origin: new URL(url).origin };
        this.loads = [...(this.loads || []), url];
        await load?.(this);
      };
      views.push(this);
    }
    setBackgroundColor() {}
    setBounds(bounds) {
      this.bounds = bounds;
    }
  }
  const controller = createRemotePanelController({
    window: owner,
    localOrigin: "http://127.0.0.1:3001",
    WebContentsView: FakeView,
    preload: "/desktop/connections-preload.cjs",
    openWebsite: (url) => openedWebsites.push(url),
    listLocalServers: () => localServers,
    selectLocalServer,
    store,
    restoreTimeoutMs,
    onError,
    remoteFrontend,
    openUpdatesOverlay,
    session: {
      fromPartition(name) {
        const value = new EventEmitter();
        value.name = name;
        value.webRequest = {
          onBeforeRequest: (handler) => {
            value.before = handler;
          },
        };
        value.setPermissionRequestHandler = (handler) => {
          value.permission = handler;
        };
        value.setPermissionCheckHandler = (handler) => {
          value.check = handler;
        };
        value.setCertificateVerifyProc = (handler) => {
          value.verifyCertificate = handler;
        };
        value.clearStorageData = async () => {
          value.cleared = true;
        };
        value.clearCache = async () => {
          value.cacheCleared = true;
        };
        value.closeAllConnections = async () => {
          value.disconnected = true;
        };
        value.flushStorageData = () => {
          value.storageFlushed = true;
        };
        value.cookies = {
          flushStore: async () => {
            value.cookiesFlushed = true;
          },
        };
        partitions.push(value);
        return value;
      },
    },
    dialog: {
      async showMessageBox(window, options) {
        prompts.push({ window, options });
        return { response: responses.shift() ?? 0 };
      },
    },
    downloadsDirectory: path.join(os.tmpdir(), "remote-downloads"),
  });
  return { controller, views, owner, partitions, prompts, openedWebsites };
}

function memoryStore(snapshot = { activeId: "local", panels: [] }) {
  return {
    snapshot: structuredClone(snapshot),
    read: async () => structuredClone(snapshot),
    async save(value) {
      this.snapshot = structuredClone(value);
    },
    async close() {
      this.closed = true;
    },
  };
}

function event() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function verify(
  window,
  cert,
  url = `${origin}/`,
  error = "net::ERR_CERT_AUTHORITY_INVALID",
) {
  const attempt = event();
  const result = new Promise((resolve) => {
    window.webContents.emit(
      "certificate-error",
      attempt,
      url,
      error,
      { data: cert },
      resolve,
    );
  });
  assert.equal(attempt.prevented, true);
  return result;
}

function verifyNetwork(
  session,
  cert,
  hostname = "panel.example",
  verificationResult = "net::ERR_CERT_AUTHORITY_INVALID",
) {
  return new Promise((resolve) => {
    session.verifyCertificate(
      { hostname, verificationResult, certificate: { data: cert } },
      resolve,
    );
  });
}

async function certificate(hostname = "panel.example") {
  const result = await selfsigned.generate(
    [{ name: "commonName", value: hostname }],
    {
      keySize: 2048,
      algorithm: "sha256",
      notBeforeDate: new Date(Date.now() - 60000),
      notAfterDate: new Date(Date.now() + 86400000),
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 2, value: hostname }] },
      ],
    },
  );
  return result.cert;
}

test("panel addresses accept only HTTPS roots and complete invitations", () => {
  assert.equal(
    normalizePanelConnectionUrl(" https://PANEL.example:3002 "),
    `${origin}/`,
  );
  assert.equal(
    normalizePanelConnectionUrl(`${origin}/#invite=${invite}`),
    `${origin}/#invite=${invite}`,
  );
  assert.equal(
    normalizePanelConnectionUrl("https://[::1]:3002"),
    "https://[::1]:3002/",
  );
  for (const input of [
    undefined,
    null,
    {},
    [],
    "",
    "panel.example",
    "http://panel.example",
    "file:///test",
    "javascript:alert(1)",
    "https://owner:password@panel.example",
    "https://@panel.example",
    `${origin}/files`,
    `${origin}/foo/../`,
    `${origin}?`,
    `${origin}?token=secret`,
    `${origin}#`,
    `${origin}#settings`,
    `${origin}/#invite=${invite}&next=evil`,
    `${origin}/#invite=short`,
    `${origin}/#INVITE=${invite}`,
    "https://panel.example\\@evil.example",
    "https://panel.\nexample",
    `https://${"a".repeat(2050)}.example`,
  ])
    assert.throws(
      () => normalizePanelConnectionUrl(input),
      { status: 400 },
      String(input),
    );
});

test("remote views share one window, isolate sessions, reject external navigation, and scope downloads", async () => {
  const h = harness();
  const connected = await h.controller.open(`${origin}/#invite=${invite}`);
  const firstId = connected.activeId;
  assert.deepEqual(connected.panels, [
    {
      id: "local",
      label: "This computer",
      origin: "http://127.0.0.1:3001",
      local: true,
    },
    {
      id: firstId,
      label: "panel.example:3002",
      origin,
      local: false,
      servers: [],
    },
  ]);
  const secondContext = await h.controller.open("https://other.example:3002/");
  const secondId = secondContext.activeId;
  const [first, second] = h.views;
  const [firstSession, secondSession] = h.partitions;
  assert.notEqual(firstSession.name, secondSession.name);
  assert.ok(h.partitions.every((value) => !value.name.startsWith("persist:")));
  assert.deepEqual(first.options.webPreferences, {
    session: firstSession,
    preload: "/desktop/connections-preload.cjs",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
  });
  assert.deepEqual(h.owner.contentView.children, [second]);
  assert.equal(h.owner.webContents.isDestroyed(), false);
  assert.deepEqual(second.bounds, { x: 0, y: 0, width: 1200, height: 800 });
  h.controller.activate("local");
  assert.deepEqual(h.owner.contentView.children, []);
  h.controller.activate(firstId);
  assert.deepEqual(h.owner.contentView.children, [first]);
  await h.controller.open(origin);
  assert.equal(
    h.views.length,
    2,
    "reopening an origin reuses its existing view and session",
  );
  assert.equal(first.loads.length, 1, "switching does not reload or sign out");
  await h.controller.open(`${origin}/#invite=${"b".repeat(43)}`);
  assert.equal(
    first.loads.length,
    2,
    "new invitation navigates the existing connection",
  );
  const titleChange = event();
  first.webContents.emit("page-title-updated", titleChange, "Untrusted title");
  assert.equal(titleChange.prevented, true);
  assert.equal(
    firstSession.check(null, "openExternal", "https://evil.example"),
    false,
  );
  let permission;
  firstSession.permission(first.webContents, "media", (value) => {
    permission = value;
  });
  assert.equal(permission, false);
  assert.deepEqual(first.popup({ url: origin }), { action: "deny" });
  for (const name of [
    "will-navigate",
    "will-frame-navigate",
    "will-redirect",
  ]) {
    for (const url of [
      `${origin}/login`,
      "https://evil.example/",
      "http://127.0.0.1:3001/",
      "file:///test",
      `blob:${origin}/fake-document`,
      `https://name:password@panel.example:3002/`,
    ]) {
      const navigation = Object.assign(event(), { url });
      first.webContents.emit(name, navigation, url);
      assert.equal(
        navigation.prevented,
        url !== `${origin}/login`,
        `${name}: ${url}`,
      );
    }
  }
  const webview = event();
  first.webContents.emit("will-attach-webview", webview);
  assert.equal(webview.prevented, true);
  for (const url of [`${origin}/login`, "https://evil.example/"]) {
    let response;
    firstSession.before({ resourceType: "mainFrame", url }, (value) => {
      response = value;
    });
    assert.equal(response.cancel, url !== `${origin}/login`);
  }
  for (const chain of [
    [`${origin}/api/files/download`],
    ["https://evil.example/", `${origin}/file`],
  ]) {
    const download = event();
    let options;
    firstSession.emit("will-download", download, {
      getURL: () => chain.at(-1),
      getURLChain: () => chain,
      getFilename: () => "../../world.zip",
      setSaveDialogOptions: (value) => {
        options = value;
      },
    });
    assert.equal(download.prevented, chain.length > 1);
    if (options)
      assert.equal(
        options.defaultPath,
        path.join(os.tmpdir(), "remote-downloads", "world.zip"),
      );
  }
  await h.controller.disconnect(firstId);
  assert.equal(h.controller.list().activeId, "local");
  assert.equal(first.webContents.isDestroyed(), true);
  assert.equal(second.webContents.isDestroyed(), false);
  assert.equal(firstSession.cleared, true);
  assert.equal(firstSession.cacheCleared, true);
  assert.equal(firstSession.disconnected, true);
  assert.equal(h.owner.webContents.isDestroyed(), false);
  h.controller.activate(secondId);
  await h.controller.close();
  assert.equal(second.webContents.isDestroyed(), true);
  assert.equal(h.owner.webContents.isDestroyed(), false);
  await assert.rejects(h.controller.open(origin), { status: 503 });
});

test("remote console downloads accept panel-owned blobs without weakening navigation or redirect checks", async () => {
  const h = harness();
  await h.controller.open(origin);
  const remoteSession = h.partitions[0];
  const blob = `blob:${origin}/console-export`;
  for (const { url, chain = [url], allowed = false } of [
    { url: blob, allowed: true },
    { url: blob, chain: [], allowed: true },
    { url: blob, chain: [`${origin}/api/console`, blob], allowed: true },
    { url: `${origin}/api/files/download`, allowed: true },
    { url: `${origin}/api/backups/archive/download`, allowed: true },
    { url: blob, chain: ["https://evil.example/redirect", blob] },
    { url: blob, chain: [`blob:https://evil.example/export`, blob] },
    { url: `${origin}/file`, chain: [blob, `${origin}/file`] },
    { url: "blob:https://evil.example/export" },
    { url: "blob:null/export" },
    { url: "blob:file:///export" },
    { url: "blob:https://name:password@panel.example:3002/export" },
    { url: "data:text/plain,console" },
    { url: "file:///console.log" },
    { url: "invalid" },
  ]) {
    const download = event();
    let options;
    remoteSession.emit("will-download", download, {
      getURL: () => url,
      getURLChain: () => chain,
      getFilename: () => "../../server-console.log",
      setSaveDialogOptions: (value) => {
        options = value;
      },
    });
    assert.equal(download.prevented, !allowed, `${url}: ${chain.join(", ")}`);
    assert.equal(Boolean(options), allowed);
    if (allowed)
      assert.equal(
        options.defaultPath,
        path.join(os.tmpdir(), "remote-downloads", "server-console.log"),
      );
  }
  const navigation = Object.assign(event(), { url: blob });
  h.views[0].webContents.emit("will-navigate", navigation, blob);
  assert.equal(navigation.prevented, true);
  await h.controller.close();
});

test("remote official links open only allowlisted sites externally without replacing the panel", async () => {
  const h = harness();
  const context = await h.controller.open(origin);
  const view = h.views[0];
  const allowed = "https://modrinth.com/mod/sodium";
  assert.deepEqual(view.popup({ url: allowed }), { action: "deny" });
  const navigation = event();
  view.webContents.emit(
    "will-navigate",
    navigation,
    "https://papermc.io/downloads",
  );
  assert.equal(navigation.prevented, true);
  assert.deepEqual(h.openedWebsites, [allowed, "https://papermc.io/downloads"]);
  for (const url of [
    "https://evil.example/",
    "http://modrinth.com/",
    "https://modrinth.com:8443/",
    "https://user:password@modrinth.com/",
    "file:///C:/Windows/system32/calc.exe",
    "javascript:alert(1)",
  ]) {
    assert.deepEqual(view.popup({ url }), { action: "deny" });
    const blocked = event();
    view.webContents.emit("will-navigate", blocked, url);
    assert.equal(blocked.prevented, true);
  }
  for (const name of ["will-frame-navigate", "will-redirect"]) {
    const blocked = Object.assign(event(), { url: allowed });
    view.webContents.emit(name, blocked, allowed);
    assert.equal(
      blocked.prevented,
      true,
      "subframe and redirect cannot escape the panel",
    );
  }
  assert.equal(h.openedWebsites.length, 2);
  assert.equal(h.controller.list().activeId, context.activeId);
  assert.equal(view.webContents.getURL(), `${origin}/`);
  assert.equal(view.loads.length, 1);
  assert.deepEqual(h.owner.contentView.children, [view]);
  await h.controller.close();
});

test("certificate trust is explicit, per-connection, and tied to the valid leaf and host", async () => {
  const [cert, changed, wrongHost] = await Promise.all([
    certificate(),
    certificate(),
    certificate("other.example"),
  ]);
  const h = harness({ responses: [1, 0, 0] });
  await h.controller.open(origin);
  const first = h.views[0];
  assert.equal(await verify(first, cert), true);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].window, h.owner);
  assert.equal(h.prompts[0].options.defaultId, 0);
  assert.equal(h.prompts[0].options.cancelId, 0);
  assert.match(h.prompts[0].options.detail, /(?:[0-9A-F]{2}:){31}[0-9A-F]{2}/);
  assert.equal(await verify(first, cert, `${origin}/api/access/login`), true);
  assert.equal(h.prompts.length, 1);
  assert.equal(await verify(first, cert, "https://evil.example/"), false);
  assert.equal(
    await verify(first, cert, `${origin}/`, "net::ERR_CERT_DATE_INVALID"),
    false,
  );
  assert.equal(await verify(first, wrongHost), false);
  assert.equal(await verify(first, "malformed"), false);
  assert.equal(h.prompts.length, 1);
  assert.equal(await verify(first, changed), false);
  assert.match(h.prompts[1].options.detail, /certificate has changed/);
  const id = h.controller.list().activeId;
  h.controller.activate("local");
  await h.controller.open(origin);
  assert.equal(
    await verify(first, cert),
    true,
    "switching preserves certificate decision",
  );
  await h.controller.disconnect(id);
  await h.controller.open(origin);
  assert.equal(await verify(h.views[1], cert), false);
  assert.equal(h.prompts.length, 3);
  await h.controller.close();
});

test("bundled remote frontend network verification keeps certificate consent and isolates its cleanup", async () => {
  const [cert, changed, wrongHost] = await Promise.all([
    certificate(),
    certificate(),
    certificate("other.example"),
  ]);
  const installations = [];
  const h = harness({
    responses: [1, 0],
    remoteFrontend: {
      install(session, target) {
        const installed = { session, target, removed: 0 };
        installations.push(installed);
        return () => installed.removed++;
      },
    },
    load: async (view) => {
      const session = view.options.webPreferences.session;
      assert.equal(installations.at(-1).session, session);
      assert.equal(installations.at(-1).target, origin);
      assert.equal(await verifyNetwork(session, cert), 0);
    },
  });
  const opened = await h.controller.open(origin);
  const session = h.partitions[0];
  assert.equal(h.prompts.length, 1);
  assert.equal(await verifyNetwork(session, cert), 0);
  assert.equal(await verify(h.views[0], cert), true);
  assert.equal(h.prompts.length, 1, "both network paths share the same trust");
  assert.equal(
    await verifyNetwork(session, "", "images.example", "net::OK"),
    -3,
    "publicly valid certificates use normal Chromium verification",
  );
  assert.equal(await verifyNetwork(session, cert, "other.example"), -2);
  assert.equal(await verifyNetwork(session, wrongHost), -2);
  assert.equal(await verifyNetwork(session, "malformed"), -2);
  assert.equal(
    await verifyNetwork(
      session,
      cert,
      "panel.example",
      "net::ERR_CERT_DATE_INVALID",
    ),
    -2,
  );
  assert.equal(h.prompts.length, 1);
  assert.equal(await verifyNetwork(session, changed), -2);
  assert.match(h.prompts[1].options.detail, /certificate has changed/);
  h.controller.activate("local");
  await h.controller.open(origin);
  assert.equal(
    installations.length,
    1,
    "switching reuses the installed frontend",
  );
  await h.controller.disconnect(opened.activeId);
  assert.equal(installations[0].removed, 1);
  assert.equal(session.verifyCertificate, null);
  assert.equal(session.cleared, true);
  assert.equal(h.owner.webContents.isDestroyed(), false);
  await h.controller.close();
  assert.equal(installations[0].removed, 1);
});

test("bundled remote frontend cleanup preserves saved sessions on close", async () => {
  let removed = 0;
  const store = memoryStore();
  const h = harness({
    store,
    remoteFrontend: {
      install() {
        return () => removed++;
      },
    },
  });
  await h.controller.open(origin);
  await h.controller.close();
  assert.equal(removed, 1);
  assert.equal(h.partitions[0].verifyCertificate, null);
  assert.equal(h.partitions[0].storageFlushed, true);
  assert.equal(h.partitions[0].cookiesFlushed, true);
  assert.equal(h.partitions[0].cleared, undefined);
  assert.equal(store.snapshot.panels.length, 1);
  assert.equal(h.owner.webContents.isDestroyed(), false);
});

test("restored frontend network requests reject changed certificates quietly until an explicit retry", async () => {
  const [trusted, changed] = await Promise.all([certificate(), certificate()]);
  const id = randomUUID();
  const store = memoryStore({
    activeId: id,
    panels: [
      {
        id,
        origin,
        trustedFingerprint: new X509Certificate(trusted).fingerprint256,
      },
    ],
  });
  let installations = 0;
  const h = harness({
    store,
    responses: [1],
    remoteFrontend: {
      install() {
        installations++;
        return () => {};
      },
    },
    load: async (view) => {
      if (
        (await verifyNetwork(view.options.webPreferences.session, changed)) !==
        0
      )
        throw new Error("Certificate rejected");
    },
  });
  await h.controller.restore();
  assert.equal(h.prompts.length, 0);
  assert.equal(h.views[0].webContents.isDestroyed(), false);
  assert.equal(h.controller.list().panels.length, 2);
  await h.controller.open(origin);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].options.detail, /certificate has changed/);
  assert.equal(installations, 1);
  assert.equal(h.controller.list().activeId, id);
  await h.controller.close();
  assert.equal(
    store.snapshot.panels[0].trustedFingerprint,
    new X509Certificate(changed).fingerprint256,
  );
});

test("a failed remote frontend install removes its verifier and isolated view", async () => {
  const h = harness({
    remoteFrontend: {
      install() {
        throw new Error("Could not install the frontend protocol");
      },
    },
  });
  await assert.rejects(h.controller.open(origin), /frontend protocol/);
  assert.equal(
    h.views[0].loads,
    undefined,
    "failed setup never loads remote code",
  );
  assert.equal(h.views[0].webContents.isDestroyed(), true);
  assert.equal(h.partitions[0].verifyCertificate, null);
  assert.equal(h.partitions[0].cleared, true);
  assert.equal(h.partitions[0].disconnected, true);
  assert.equal(h.controller.list().panels.length, 1);
  assert.equal(h.owner.webContents.isDestroyed(), false);
  await h.controller.close();
});

test("canceled trust fails opening and destroys only the isolated view", async () => {
  const cert = await certificate();
  const h = harness({
    load: async (window) => {
      if (!(await verify(window, cert)))
        throw new Error("Certificate rejected");
    },
  });
  await assert.rejects(h.controller.open(origin), { status: 409 });
  assert.equal(h.views[0].webContents.isDestroyed(), true);
  assert.equal(h.partitions[0].cleared, true);
  assert.equal(h.owner.webContents.isDestroyed(), false);
  assert.equal(h.controller.list().activeId, "local");
  assert.equal(h.controller.list().panels.length, 1);
});

test("local server selection exposes only display fields and notifies only the owner after saving", async () => {
  let finishSave;
  const saved = [];
  const localServers = [
    {
      id: "local-a",
      name: "Survival",
      status: "running",
      software: "Paper",
      minecraftVersion: "1.21.8",
      serverDir: "C:/private/world",
      address: "192.0.2.1",
      password: "private",
    },
    {
      id: "local-b",
      name: "Creative",
      status: "offline",
      software: null,
      minecraftVersion: null,
    },
    { id: "invalid", name: { private: "data" }, status: "offline" },
  ];
  const h = harness({
    localServers,
    selectLocalServer: (id) =>
      new Promise((resolve) => {
        saved.push(id);
        finishSave = resolve;
      }),
  });
  const handlers = new Map();
  installConnectionIpc(
    { handle: (channel, callback) => handlers.set(channel, callback) },
    h.controller,
  );
  await h.controller.open(origin);
  const remote = h.views[0].webContents;
  const sender = { sender: remote, senderFrame: remote.mainFrame };
  const snapshot = handlers.get(CONNECTION_CHANNELS.list)(sender);
  assert.deepEqual(snapshot.localServers, [
    {
      id: "local-a",
      name: "Survival",
      status: "running",
      software: "Paper",
      minecraftVersion: "1.21.8",
    },
    { id: "local-b", name: "Creative", status: "offline" },
  ]);
  const select = handlers.get(CONNECTION_CHANNELS.selectLocalServer);
  await assert.rejects(select(sender, "missing"), { status: 400 });
  assert.deepEqual(saved, []);
  assert.throws(
    () =>
      select({ ...sender, senderFrame: { ...remote.mainFrame } }, "local-a"),
    /cannot manage/,
  );
  const pending = select(sender, "local-a");
  assert.equal(
    h.controller.list().activeId,
    snapshot.activeId,
    "keep current panel visible until persistence succeeds",
  );
  assert.ok(
    h.owner.webContents.sent.every(
      ([channel]) => channel !== "mc-panel-local-server-selected",
    ),
  );
  finishSave();
  assert.equal((await pending).activeId, "local");
  assert.deepEqual(saved, ["local-a"]);
  assert.deepEqual(
    h.owner.webContents.sent.filter(
      ([channel]) => channel === "mc-panel-local-server-selected",
    ),
    [["mc-panel-local-server-selected", "local-a"]],
  );
  assert.ok(
    remote.sent.every(
      ([channel]) => channel !== "mc-panel-local-server-selected",
    ),
  );
  assert.equal(remote.isDestroyed(), false);
  await h.controller.close();
});

test("pending local server selection preserves a newer panel activation", async () => {
  let finishSave;
  const h = harness({
    localServers: [{ id: "local-a", name: "Local world", status: "offline" }],
    selectLocalServer: () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  });
  const first = await h.controller.open(origin);
  const second = await h.controller.open("https://second.example:3002");
  h.controller.activate(first.activeId);

  const pending = h.controller.selectLocalServer("local-a");
  h.controller.activate(second.activeId);
  finishSave();

  assert.equal((await pending).activeId, second.activeId);
  assert.equal(h.controller.list().activeId, second.activeId);
  assert.deepEqual(h.owner.contentView.children, [h.views[1]]);
  assert.deepEqual(
    h.owner.webContents.sent.filter(
      ([channel]) => channel === "mc-panel-local-server-selected",
    ),
    [["mc-panel-local-server-selected", "local-a"]],
    "the saved local selection still reaches its own background renderer",
  );
  await h.controller.close();
});

test("remote rosters stay with their sending sessions across local switches and clear only on that session's signout", async () => {
  const h = harness();
  const handlers = new Map();
  installConnectionIpc(
    { handle: (channel, callback) => handlers.set(channel, callback) },
    h.controller,
  );
  const first = await h.controller.open(origin);
  const firstContents = h.views[0].webContents;
  const second = await h.controller.open("https://other.example:3002");
  const secondContents = h.views[1].webContents;
  const invoke = (action, sender, value, other) =>
    handlers.get(CONNECTION_CHANNELS[action])(
      { sender, senderFrame: sender.mainFrame },
      value,
      other,
    );
  const changedCount = () =>
    h.owner.webContents.sent.filter(
      ([channel]) => channel === "mc-panel-connections:changed",
    ).length;
  const roster = (id) =>
    h.controller.list().panels.find((panel) => panel.id === id)?.servers;
  const firstServer = {
    id: "shared-id",
    name: "Survival",
    status: "running",
    software: "Paper",
    minecraftVersion: "1.21.8",
  };
  const secondServer = { id: "shared-id", name: "Creative", status: "offline" };
  const beforeReport = changedCount();
  assert.equal(
    invoke("reportServers", firstContents, [
      {
        ...firstServer,
        serverDir: "C:/private/world",
        address: "192.0.2.1",
        token: "private-token",
      },
      firstServer,
    ]),
    undefined,
  );
  assert.equal(changedCount(), beforeReport + 1);
  assert.deepEqual(roster(first.activeId), [firstServer]);
  assert.deepEqual(
    roster(second.activeId),
    [],
    "the active panel must not acquire another sender's roster",
  );
  invoke("reportServers", secondContents, [
    { ...secondServer, software: null, minecraftVersion: null },
  ]);
  h.controller.activate("local");
  assert.deepEqual(roster(first.activeId), [firstServer]);
  assert.deepEqual(roster(second.activeId), [secondServer]);
  const beforeSame = changedCount();
  invoke("reportServers", firstContents, [firstServer]);
  assert.equal(
    changedCount(),
    beforeSame,
    "unchanged polling must not create a changed-event feedback loop",
  );
  const copy = h.controller.list();
  copy.panels.find((panel) => panel.id === first.activeId).servers[0].name =
    "modified outside controller";
  assert.deepEqual(roster(first.activeId), [firstServer]);
  const selected = invoke(
    "selectRemoteServer",
    h.owner.webContents,
    first.activeId,
    "shared-id",
  );
  assert.equal(selected.activeId, first.activeId);
  assert.deepEqual(
    firstContents.sent.filter(
      ([channel]) => channel === "mc-panel-remote-server-selected",
    ),
    [["mc-panel-remote-server-selected", "shared-id"]],
  );
  assert.ok(
    secondContents.sent.every(
      ([channel]) => channel !== "mc-panel-remote-server-selected",
    ),
  );
  assert.ok(
    h.owner.webContents.sent.every(
      ([channel]) => channel !== "mc-panel-remote-server-selected",
    ),
  );
  assert.equal(firstContents.isDestroyed(), false);
  assert.equal(h.views[0].loads.length, 1);
  assert.equal(h.partitions[0].cleared, undefined);
  h.controller.activate("local");
  invoke("reportServers", firstContents, null);
  assert.deepEqual(roster(first.activeId), []);
  assert.deepEqual(roster(second.activeId), [secondServer]);
  const beforeClearAgain = changedCount();
  invoke("reportServers", firstContents, null);
  assert.equal(changedCount(), beforeClearAgain);
  assert.throws(
    () =>
      invoke(
        "selectRemoteServer",
        h.owner.webContents,
        first.activeId,
        "shared-id",
      ),
    { status: 404 },
  );
  assert.throws(
    () =>
      invoke("selectRemoteServer", h.owner.webContents, "local", "shared-id"),
    { status: 404 },
  );
  assert.throws(
    () =>
      invoke("selectRemoteServer", h.owner.webContents, "missing", "shared-id"),
    { status: 404 },
  );
  assert.throws(
    () =>
      invoke(
        "selectRemoteServer",
        h.owner.webContents,
        second.activeId,
        "missing",
      ),
    { status: 404 },
  );
  assert.equal(h.controller.list().activeId, "local");
  await h.controller.disconnect(second.activeId);
  assert.throws(
    () => invoke("reportServers", secondContents, [secondServer]),
    /cannot manage/,
  );
  const reconnected = await h.controller.open("https://other.example:3002");
  assert.deepEqual(roster(reconnected.activeId), []);
  await h.controller.close();
});

test("a connected panel discovers new grants after an empty roster without dropping its session or other servers", async () => {
  const h = harness();
  const connected = await h.controller.open(origin);
  const remote = h.views[0].webContents;
  const sender = { sender: remote, senderFrame: remote.mainFrame };
  const roster = () =>
    h.controller.list().panels.find((panel) => panel.id === connected.activeId)
      .servers;
  const survival = { id: "survival", name: "Survival", status: "offline" };
  const creative = { id: "creative", name: "Creative", status: "offline" };

  h.controller.activate("local");
  h.controller.reportServers(sender, []);
  h.controller.reportServers(sender, [survival]);
  h.controller.reportServers(sender, [survival, creative]);
  assert.deepEqual(roster(), [survival, creative]);
  assert.equal(h.controller.list().activeId, "local");
  h.controller.reportServers(sender, [creative]);
  assert.deepEqual(roster(), [creative]);
  assert.throws(
    () => h.controller.selectRemoteServer(connected.activeId, survival.id),
    { status: 404 },
  );
  h.controller.reportServers(sender, []);
  assert.deepEqual(roster(), []);
  assert.equal(remote.isDestroyed(), false);
  assert.equal(h.partitions[0].cleared, undefined);

  h.controller.reportServers(sender, [survival, creative]);
  h.controller.selectRemoteServer(connected.activeId, survival.id);
  assert.deepEqual(
    remote.sent.filter(
      ([channel]) => channel === "mc-panel-remote-server-selected",
    ),
    [["mc-panel-remote-server-selected", survival.id]],
  );
  assert.equal(
    h.views[0].loads.length,
    1,
    "new grants do not require signing in again",
  );
  await h.controller.close();
});

test("sign-in state distinguishes empty authenticated rosters from signout without disrupting other sessions", async () => {
  const h = harness();
  const first = await h.controller.open(origin);
  const second = await h.controller.open("https://other.example:3002");
  const state = (id) =>
    h.controller.list().panels.find((panel) => panel.id === id);
  const report = (index, value) => {
    const sender = h.views[index].webContents;
    h.controller.reportServers(
      { sender, senderFrame: sender.mainFrame },
      value,
    );
  };
  const changedCount = () =>
    h.owner.webContents.sent.filter(
      ([channel]) => channel === "mc-panel-connections:changed",
    ).length;
  assert.equal(Object.hasOwn(state(first.activeId), "signedIn"), false);
  assert.equal(Object.hasOwn(state("local"), "signedIn"), false);
  report(0, []);
  report(1, [{ id: "world", name: "Survival", status: "offline" }]);
  const secondState = state(second.activeId);
  h.controller.activate(first.activeId);
  const beforeSignout = changedCount();
  report(0, null);
  assert.equal(state(first.activeId).signedIn, false);
  assert.deepEqual(state(first.activeId).servers, []);
  assert.equal(changedCount(), beforeSignout + 1);
  assert.deepEqual(state(second.activeId), secondState);
  assert.equal(h.controller.list().activeId, first.activeId);
  assert.equal(h.views[0].webContents.isDestroyed(), false);
  assert.equal(h.partitions[0].cleared, undefined);
  report(0, null);
  assert.equal(changedCount(), beforeSignout + 1);
  report(0, []);
  assert.equal(state(first.activeId).signedIn, true);
  assert.equal(changedCount(), beforeSignout + 2);
  report(0, []);
  assert.equal(changedCount(), beforeSignout + 2);
  assert.equal(h.views[0].loads.length, 1);
  await h.controller.close();
});

test("selector icons stay with their host for colliding IDs and reject unsafe image sources", async () => {
  const icon = (fill) =>
    `data:image/png;base64,${new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${fill}"/></svg>`).render().asPng().toString("base64")}`;
  const record = { id: "same-id", name: "World", status: "offline" };
  const localIcon = icon("red"),
    firstIcon = icon("blue"),
    secondIcon = icon("green");
  const h = harness({ localServers: [{ ...record, iconDataUrl: localIcon }] });
  const first = await h.controller.open(origin);
  const second = await h.controller.open("https://other.example:3002");
  const report = (index, iconDataUrl) => {
    const contents = h.views[index].webContents;
    h.controller.reportServers(
      { sender: contents, senderFrame: contents.mainFrame },
      [{ ...record, iconDataUrl }],
    );
  };
  const roster = (id) =>
    h.controller.list().panels.find((panel) => panel.id === id).servers;
  report(0, firstIcon);
  report(1, secondIcon);
  for (const id of ["local", first.activeId, second.activeId, "local"]) {
    h.controller.activate(id);
    assert.equal(h.controller.list().localServers[0].iconDataUrl, localIcon);
    assert.equal(roster(first.activeId)[0].iconDataUrl, firstIcon);
    assert.equal(roster(second.activeId)[0].iconDataUrl, secondIcon);
  }
  for (const unsafe of [
    "https://private.example/icon?token=secret",
    "file:///private/icon.png",
    "data:image/svg+xml,<svg/>",
    "data:image/png;base64,AAAA",
    `data:image/png;base64,${"A".repeat(350000)}`,
  ]) {
    report(0, unsafe);
    assert.deepEqual(roster(first.activeId), [record]);
    assert.equal(roster(second.activeId)[0].iconDataUrl, secondIcon);
  }
  report(0, firstIcon);
  const contents = h.views[0].webContents;
  h.controller.reportServers(
    { sender: contents, senderFrame: contents.mainFrame },
    null,
  );
  assert.deepEqual(roster(first.activeId), []);
  assert.equal(roster(second.activeId)[0].iconDataUrl, secondIcon);
  await h.controller.close();
});

test("remote server selections queued during reload wait for an authenticated renderer report and clear on signout", async () => {
  const h = harness();
  const connected = await h.controller.open(origin);
  const contents = h.views[0].webContents;
  const sender = { sender: contents, senderFrame: contents.mainFrame };
  const servers = [
    { id: "a", name: "A", status: "offline" },
    { id: "b", name: "B", status: "offline" },
  ];
  h.controller.reportServers(sender, servers);
  contents.loading = true;
  h.controller.selectRemoteServer(connected.activeId, "a");
  h.controller.selectRemoteServer(connected.activeId, "b");
  const events = () =>
    contents.sent.filter(
      ([channel]) => channel === "mc-panel-remote-server-selected",
    );
  assert.deepEqual(events(), []);
  contents.loading = false;
  contents.emit("did-finish-load");
  assert.deepEqual(
    events(),
    [],
    "native load completion does not prove React's selection listener is mounted",
  );
  const beforeReady = h.owner.webContents.sent.length;
  h.controller.reportServers(sender, servers);
  assert.deepEqual(events(), [["mc-panel-remote-server-selected", "b"]]);
  assert.equal(
    h.owner.webContents.sent.length,
    beforeReady,
    "an unchanged readiness report must not broadcast a roster change",
  );
  h.controller.reportServers(sender, servers);
  assert.equal(
    events().length,
    1,
    "readiness delivery must not repeat on the next poll",
  );
  contents.loading = true;
  h.controller.selectRemoteServer(connected.activeId, "a");
  h.controller.reportServers(sender, null);
  contents.loading = false;
  contents.emit("did-finish-load");
  assert.equal(events().length, 1, "signout clears a pending selection");
  h.controller.reportServers(sender, servers);
  assert.equal(
    events().length,
    1,
    "a later login must not replay the signed-out user's pending selection",
  );
  contents.loading = true;
  h.controller.selectRemoteServer(connected.activeId, "a");
  contents.loading = false;
  h.controller.reportServers(
    sender,
    servers.filter((server) => server.id !== "a"),
  );
  assert.equal(
    events().length,
    1,
    "a refreshed roster must still contain the queued target",
  );
  h.controller.reportServers(sender, servers);
  contents.loading = true;
  h.controller.selectRemoteServer(connected.activeId, "a");
  contents.mainFrame.origin = "https://evil.example";
  contents.loading = false;
  contents.emit("did-finish-load");
  assert.throws(() => h.controller.reportServers(sender, servers), {
    status: 403,
  });
  assert.equal(
    events().length,
    1,
    "a different document origin must never receive the target server ID",
  );
  await h.controller.close();
});

test("remote roster reports and selection reject untrusted scopes and invalid bounded fields without mutating cache", async () => {
  const h = harness();
  const handlers = new Map();
  installConnectionIpc(
    { handle: (channel, callback) => handlers.set(channel, callback) },
    h.controller,
  );
  const connected = await h.controller.open(origin);
  const remote = h.views[0].webContents;
  const sender = { sender: remote, senderFrame: remote.mainFrame };
  const report = handlers.get(CONNECTION_CHANNELS.reportServers);
  const server = { id: "world", name: "Survival", status: "offline" };
  report(sender, [server]);
  const snapshot = h.controller.list();
  for (const value of [
    undefined,
    {},
    "servers",
    1,
    [null],
    [[]],
    [{}],
    Array(501).fill(server),
    [{ ...server, id: "" }],
    [{ ...server, id: "a".repeat(129) }],
    [{ ...server, name: "a".repeat(181) }],
    [{ ...server, status: "a".repeat(33) }],
    [{ ...server, software: { secret: true } }],
    [{ ...server, minecraftVersion: "a".repeat(129) }],
  ])
    assert.throws(() => report(sender, value), { status: 400 });
  assert.throws(
    () =>
      report(
        {
          sender: h.owner.webContents,
          senderFrame: h.owner.webContents.mainFrame,
        },
        null,
      ),
    { status: 403 },
  );
  assert.throws(
    () => report({ ...sender, senderFrame: { ...remote.mainFrame } }, [server]),
    /cannot manage/,
  );
  const oldOrigin = remote.mainFrame.origin;
  remote.mainFrame.origin = "https://evil.example";
  assert.throws(() => report(sender, [server]), /cannot manage/);
  remote.mainFrame.origin = oldOrigin;
  assert.throws(
    () =>
      report({ sender: { ...remote }, senderFrame: remote.mainFrame }, [
        server,
      ]),
    /cannot manage/,
  );
  const select = handlers.get(CONNECTION_CHANNELS.selectRemoteServer);
  for (const args of [
    [null, "world"],
    [connected.activeId, {}],
    [connected.activeId, "x".repeat(129)],
  ])
    assert.throws(() => select(sender, ...args), /valid remote panel/);
  assert.throws(
    () => select({ ...sender, senderFrame: null }, connected.activeId, "world"),
    /cannot manage/,
  );
  assert.deepEqual(h.controller.list(), snapshot);
  await h.controller.close();
});

test("opening app updates preserves the active remote panel and saved selection", async () => {
  let opened = 0;
  let fail = false;
  const store = memoryStore();
  const h = harness({
    store,
    openUpdatesOverlay: () => {
      if (fail) throw new Error("Updates window could not load.");
      opened += 1;
    },
  });
  const handlers = new Map();
  const remove = installConnectionIpc(
    {
      handle: (channel, callback) => handlers.set(channel, callback),
      removeHandler: (channel) => handlers.delete(channel),
    },
    h.controller,
  );
  const connection = await h.controller.open(origin);
  const remote = h.views[0].webContents;
  const openUpdates = () =>
    handlers.get(CONNECTION_CHANNELS.openUpdates)({
      sender: remote,
      senderFrame: remote.mainFrame,
    });
  const before = h.controller.list();
  assert.deepEqual(before.localServers, []);
  assert.equal(openUpdates(), undefined);
  assert.equal(opened, 1);
  assert.deepEqual(h.controller.list(), before);
  assert.deepEqual(h.owner.contentView.children, [h.views[0]]);
  assert.equal(remote.isDestroyed(), false);
  assert.ok(
    !remote.sent.some(([channel]) => channel === "mc-panel-updates-open"),
  );
  fail = true;
  assert.throws(openUpdates, /could not load/);
  assert.deepEqual(h.controller.list(), before);
  // Opening updates does not depend on the hidden local Welcome renderer.
  fail = false;
  h.owner.webContents.loading = true;
  assert.equal(openUpdates(), undefined);
  assert.equal(opened, 2);
  await h.controller.close();
  assert.equal(store.snapshot.activeId, connection.activeId);
  assert.throws(() => h.controller.openUpdates(), /shutting down/);
  remove();
});

test("connection IPC validates managed sender, main frame, origin and bounded arguments", async () => {
  const h = harness();
  const handlers = new Map();
  const remove = installConnectionIpc(
    {
      handle: (channel, callback) => handlers.set(channel, callback),
      removeHandler: (channel) => handlers.delete(channel),
    },
    h.controller,
  );
  const invoke = (action, sender, value, senderFrame = sender.mainFrame) =>
    handlers.get(CONNECTION_CHANNELS[action])({ sender, senderFrame }, value);
  const local = h.owner.webContents;
  assert.equal(invoke("list", local).activeId, "local");
  await invoke("open", local, origin);
  const remote = h.views[0].webContents;
  const remoteId = invoke("list", remote).activeId;
  assert.equal(invoke("activate", remote, "local").activeId, "local");
  assert.equal(invoke("activate", local, remoteId).activeId, remoteId);
  const rejectsSender = (sender, senderFrame = sender.mainFrame) => {
    for (const action of ["list", "openUpdates"])
      assert.throws(
        () => invoke(action, sender, undefined, senderFrame),
        /cannot manage/,
      );
  };
  for (const senderFrame of [
    null,
    { ...remote.mainFrame },
    { url: "about:blank", origin },
  ])
    rejectsSender(remote, senderFrame);
  for (const bad of [
    "https://evil.example",
    "null",
    "http://panel.example:3002",
  ]) {
    const before = remote.mainFrame;
    remote.mainFrame = { ...before, origin: bad };
    rejectsSender(remote);
    remote.mainFrame = before;
  }
  remote.url = "https://evil.example/";
  rejectsSender(remote);
  remote.url = origin;
  const impostor = { ...remote, mainFrame: remote.mainFrame };
  rejectsSender(impostor);
  for (const value of [null, {}, 12, "a".repeat(4097)])
    assert.throws(() => invoke("open", local, value), /valid panel address/);
  await assert.rejects(invoke("disconnect", local, "local"), { status: 400 });
  await invoke("disconnect", local, remoteId);
  rejectsSender(remote);
  await h.controller.close();
  rejectsSender(local);
  remove();
  assert.equal(handlers.size, 0);
});

test("persistent connections save origins/trust and preserve the same partitions through shutdown and restore", async () => {
  const cert = await certificate();
  const store = memoryStore();
  const h = harness({
    store,
    responses: [1],
    load: async (view) => {
      assert.equal(await verify(view, cert), true);
    },
  });
  const connected = await h.controller.open(`${origin}/#invite=${invite}`);
  await h.controller.close();
  assert.deepEqual(store.snapshot, {
    activeId: connected.activeId,
    panels: [
      {
        id: connected.activeId,
        origin,
        trustedFingerprint: new X509Certificate(cert).fingerprint256,
      },
    ],
  });
  assert.equal(h.partitions[0].name, `persist:mc-remote-${connected.activeId}`);
  assert.equal(h.partitions[0].cookiesFlushed, true);
  assert.equal(h.partitions[0].storageFlushed, true);
  assert.equal(h.partitions[0].cleared, undefined);
  assert.equal(h.partitions[0].cacheCleared, undefined);
  assert.equal(h.views[0].webContents.isDestroyed(), true);
  assert.equal(store.closed, true);
  const secondStore = memoryStore(store.snapshot);
  const second = harness({
    store: secondStore,
    load: async (view) => {
      assert.equal(await verify(view, cert), true);
    },
  });
  const restored = await second.controller.restore();
  assert.equal(restored.activeId, connected.activeId);
  assert.equal(second.partitions[0].name, h.partitions[0].name);
  assert.deepEqual(
    second.views[0].loads,
    [`${origin}/`],
    "invitation hashes never restore",
  );
  assert.deepEqual(
    second.prompts,
    [],
    "matching valid remembered certificate needs no new prompt",
  );
  assert.ok(
    restored.panels.every(
      (entry) => !Object.hasOwn(entry, "trustedFingerprint"),
    ),
  );
  await second.controller.disconnect(connected.activeId);
  assert.deepEqual(secondStore.snapshot, { activeId: "local", panels: [] });
  assert.equal(second.partitions[0].cleared, true);
  assert.equal(second.partitions[0].cacheCleared, true);
  await second.controller.close();
});

test("offline restores keep retryable entries, suppress certificate dialogs, and preserve other connections", async () => {
  const cert = await certificate();
  const id = randomUUID();
  const other = randomUUID();
  let online = false;
  const store = memoryStore({
    activeId: id,
    panels: [
      { id, origin, trustedFingerprint: "AA:".repeat(31) + "AA" },
      { id: other, origin: "https://other.example:3002" },
    ],
  });
  const h = harness({
    store,
    responses: [1],
    load: async (view) => {
      if (view.webContents.getURL().startsWith(origin)) {
        if (!online) throw new Error("Offline");
        if (!(await verify(view, cert)))
          throw new Error("Certificate rejected");
      }
    },
  });
  const restored = await h.controller.restore();
  assert.equal(restored.activeId, "local");
  assert.equal(restored.panels.length, 3);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.partitions[0].cleared, undefined);
  online = true;
  const retried = await h.controller.activate(id);
  assert.equal(retried.activeId, id);
  assert.equal(
    h.prompts.length,
    1,
    "explicit retry asks about a changed certificate",
  );
  assert.equal(h.views.length, 2);
  await h.controller.close();
  assert.equal(store.snapshot.panels.length, 2);
});

test("signout is saved only on session changes and remains known through offline restore and re-login", async () => {
  const store = memoryStore();
  const save = store.save;
  let writes = 0;
  store.save = async function (value) {
    writes++;
    return save.call(this, value);
  };
  const h = harness({ store });
  const first = await h.controller.open(origin);
  const second = await h.controller.open("https://other.example:3002");
  const report = (controller, contents, value) =>
    controller.reportServers(
      { sender: contents, senderFrame: contents.mainFrame },
      value,
    );
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  report(h.controller, h.views[0].webContents, []);
  report(h.controller, h.views[1].webContents, []);
  await flush();
  const beforeSignout = writes;
  report(h.controller, h.views[0].webContents, null);
  await flush();
  assert.equal(writes, beforeSignout + 1);
  report(h.controller, h.views[0].webContents, null);
  report(h.controller, h.views[1].webContents, [
    { id: "world", name: "Survival", status: "offline" },
  ]);
  await flush();
  assert.equal(writes, beforeSignout + 1);
  await h.controller.close();
  assert.deepEqual(store.snapshot.panels, [
    { id: first.activeId, origin, signedIn: false },
    {
      id: second.activeId,
      origin: "https://other.example:3002",
      signedIn: true,
    },
  ]);
  const restartedStore = memoryStore(store.snapshot);
  let online = false;
  const restarted = harness({
    store: restartedStore,
    load: async () => {
      if (!online) throw new Error("Offline");
    },
  });
  const restored = await restarted.controller.restore();
  assert.equal(restored.activeId, "local");
  assert.deepEqual(
    restored.panels
      .filter((panel) => !panel.local)
      .map(({ id, signedIn }) => ({
        id,
        signedIn,
      })),
    [
      { id: first.activeId, signedIn: false },
      { id: second.activeId, signedIn: true },
    ],
  );
  online = true;
  await restarted.controller.open(origin);
  report(restarted.controller, restarted.views[0].webContents, []);
  await restarted.controller.close();
  assert.equal(restartedStore.snapshot.panels[0].signedIn, true);
  assert.equal(restarted.partitions[0].name, h.partitions[0].name);
});

test("background certificate changes are rejected without prompts until an explicit retry", async () => {
  const cert = await certificate();
  const id = randomUUID();
  const store = memoryStore({
    activeId: id,
    panels: [{ id, origin, trustedFingerprint: "AA:".repeat(31) + "AA" }],
  });
  const h = harness({
    store,
    responses: [1],
    load: async (view) => {
      if (!(await verify(view, cert))) throw new Error("Certificate rejected");
    },
  });
  await h.controller.restore();
  assert.equal(h.prompts.length, 0);
  assert.equal(h.controller.list().activeId, "local");
  assert.equal((await h.controller.open(origin)).activeId, id);
  assert.equal(h.prompts.length, 1);
  await h.controller.close();
});

test("restore and retry completion cannot steal focus after newer user navigation", async () => {
  const id = randomUUID();
  const saved = { activeId: id, panels: [{ id, origin }] };
  let finishRead;
  const store = memoryStore(saved);
  store.read = () =>
    new Promise((resolve) => {
      finishRead = resolve;
    });
  const h = harness({ store });
  const restoring = h.controller.restore();
  h.controller.activate("local");
  finishRead(saved);
  await restoring;
  assert.equal(h.controller.list().activeId, "local");
  await h.controller.close();
  assert.equal(store.snapshot.activeId, "local");

  let finishLoad;
  let failing = true;
  const second = harness({
    store: memoryStore(saved),
    load: async () => {
      if (failing) throw new Error("Offline");
      await new Promise((resolve) => {
        finishLoad = resolve;
      });
    },
  });
  await second.controller.restore();
  failing = false;
  const retry = second.controller.activate(id);
  await new Promise((resolve) => setImmediate(resolve));
  second.controller.activate("local");
  finishLoad();
  await retry;
  assert.equal(second.controller.list().activeId, "local");
  await second.controller.close();
});

test("quitting during the initial registry read preserves saved hosts without creating views", async () => {
  const id = randomUUID();
  const saved = { activeId: id, panels: [{ id, origin }] };
  const store = memoryStore(saved);
  let finishRead;
  store.read = () =>
    new Promise((resolve) => {
      finishRead = resolve;
    });
  const h = harness({ store });
  const restoring = assert.rejects(h.controller.restore(), { status: 503 });
  const closing = h.controller.close();
  finishRead(saved);
  await Promise.all([restoring, closing]);
  assert.deepEqual(store.snapshot, saved);
  assert.equal(store.closed, true);
  assert.equal(h.views.length, 0);
});

test("opening a new host while the registry loads merges saved hosts and retains the newer selection", async () => {
  const id = randomUUID();
  const saved = { activeId: id, panels: [{ id, origin }] };
  const store = memoryStore(saved);
  let finishRead;
  store.read = () =>
    new Promise((resolve) => {
      finishRead = resolve;
    });
  const h = harness({ store });
  const restoring = h.controller.restore();
  const opening = h.controller.open("https://new.example:3002");
  finishRead(saved);
  const [, connected] = await Promise.all([restoring, opening]);
  await h.controller.close();
  assert.equal(store.snapshot.activeId, connected.activeId);
  assert.notEqual(connected.activeId, id);
  assert.deepEqual(
    new Set(store.snapshot.panels.map((entry) => entry.origin)),
    new Set([origin, "https://new.example:3002"]),
  );
  assert.ok(store.snapshot.panels.some((entry) => entry.id === id));

  const selectedLocal = harness({ store: memoryStore(saved) });
  selectedLocal.controller.activate("local");
  await selectedLocal.controller.restore();
  assert.equal(selectedLocal.controller.list().activeId, "local");
  await selectedLocal.controller.close();
});

test("unreadable saved connections cannot be overwritten and read errors stay out of renderer responses", async () => {
  const privateFailure = new Error(
    "Cannot read C:/private/profile/desktop-connections.json",
  );
  const errors = [];
  const store = memoryStore();
  let writes = 0;
  store.read = async () => {
    throw privateFailure;
  };
  store.save = async () => {
    writes += 1;
  };
  const h = harness({ store, onError: (error) => errors.push(error) });
  await assert.rejects(h.controller.restore(), privateFailure);
  await assert.rejects(h.controller.open(origin), (error) => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /private|profile|\.json/);
    return true;
  });
  await assert.rejects(h.controller.close(), privateFailure);
  assert.equal(writes, 0);
  assert.equal(store.closed, true);
  assert.equal(h.views.length, 0);
  assert.deepEqual(errors, [privateFailure]);
});

test("shutdown flushes persistent sessions after save failures and disconnect hides private failure details", async () => {
  const privateFailure = new Error(
    "Cannot write C:/private/profile/desktop-connections.json",
  );
  const store = memoryStore();
  const h = harness({ store });
  await h.controller.open(origin);
  store.save = async () => {
    throw privateFailure;
  };
  await assert.rejects(h.controller.close(), privateFailure);
  assert.equal(h.views[0].webContents.isDestroyed(), true);
  assert.equal(h.partitions[0].storageFlushed, true);
  assert.equal(h.partitions[0].cookiesFlushed, true);
  assert.equal(h.partitions[0].disconnected, true);
  assert.equal(h.partitions[0].cleared, undefined);
  assert.equal(store.closed, true);

  const secondStore = memoryStore();
  const errors = [];
  const second = harness({
    store: secondStore,
    onError: (error) => errors.push(error),
  });
  const connected = await second.controller.open(origin);
  secondStore.save = async () => {
    throw privateFailure;
  };
  await assert.rejects(
    second.controller.disconnect(connected.activeId),
    (error) => {
      assert.equal(error.status, 500);
      assert.doesNotMatch(error.message, /private|profile|\.json/);
      return true;
    },
  );
  assert.equal(second.views[0].webContents.isDestroyed(), true);
  assert.equal(second.partitions[0].cleared, true);
  assert.equal(second.partitions[0].cacheCleared, true);
  assert.ok(errors.includes(privateFailure));
  await assert.rejects(second.controller.close(), privateFailure);
});

test("disconnect during a restored host load cannot recreate the forgotten registry entry", async () => {
  const id = randomUUID();
  const saved = { activeId: id, panels: [{ id, origin }] };
  const store = memoryStore(saved);
  let finishLoad;
  let finishSave;
  const saving = new Promise((resolve) => {
    finishSave = resolve;
  });
  store.save = async (snapshot) => {
    await saving;
    store.snapshot = structuredClone(snapshot);
  };
  const h = harness({
    store,
    load: () =>
      new Promise((resolve) => {
        finishLoad = resolve;
      }),
  });
  const restoring = h.controller.restore();
  await new Promise((resolve) => setImmediate(resolve));
  const disconnecting = h.controller.disconnect(id);
  finishLoad();
  await new Promise((resolve) => setImmediate(resolve));
  finishSave();
  await Promise.all([restoring, disconnecting]);
  await h.controller.close();
  assert.deepEqual(store.snapshot, { activeId: "local", panels: [] });
  assert.equal(h.controller.list().panels.length, 1);
  assert.equal(h.partitions[0].cleared, true);
});

test("desktop connection endpoint requires owner session, valid origin, method, and address", async (t) => {
  assert.throws(
    () =>
      requiredPermissions({
        method: "POST",
        path: "/api/desktop/connections/open",
      }),
    { status: 403 },
  );
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-remote-endpoint-"),
  );
  const opened = [];
  const runtime = await startDesktopRuntime({
    dataDir: path.join(directory, "panel"),
    scheduler: false,
    openRemotePanel: async (url) => {
      opened.push(url);
    },
  });
  t.after(async () => {
    await runtime.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("mc-remote-endpoint-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `${runtime.url}/api/desktop/connections/open`;
  const request = (options = {}) =>
    fetch(url, {
      method: "POST",
      body: JSON.stringify({ url: origin }),
      ...options,
      headers: {
        "Content-Type": "application/json",
        Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
        Origin: runtime.url,
        ...options.headers,
      },
    });
  assert.equal((await request({ headers: { Cookie: "" } })).status, 401);
  assert.equal(
    (await request({ headers: { Origin: "https://evil.example" } })).status,
    403,
  );
  assert.equal(
    (await request({ headers: { "Sec-Fetch-Site": "cross-site" } })).status,
    403,
  );
  assert.equal((await request({ method: "GET", body: undefined })).status, 405);
  assert.equal(
    (await request({ body: JSON.stringify({ url: "http://127.0.0.1:3001" }) }))
      .status,
    400,
  );
  assert.equal((await request({ body: "{" })).status, 400);
  assert.equal(
    (await request({ body: JSON.stringify({ url: "a".repeat(5000) }) })).status,
    413,
  );
  assert.deepEqual(opened, []);
  const result = await request({
    body: JSON.stringify({ url: `${origin}/#invite=${invite}` }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    opened: true,
    url: `${origin}/#invite=${invite}`,
  });
  assert.deepEqual(opened, [`${origin}/#invite=${invite}`]);
  assert.equal(runtime.fleet.runtimes.size, 0);
});
