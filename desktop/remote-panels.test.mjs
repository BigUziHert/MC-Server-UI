import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";
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

function harness({ responses = [], load } = {}) {
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
    value.focus = () => {
      value.focused = true;
    };
    value.send = () => {};
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
        value.clearStorageData = async () => {
          value.cleared = true;
        };
        value.clearCache = async () => {
          value.cacheCleared = true;
        };
        value.closeAllConnections = async () => {
          value.disconnected = true;
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
    { id: firstId, label: "panel.example:3002", origin, local: false },
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
  for (const senderFrame of [
    null,
    { ...remote.mainFrame },
    { url: "about:blank", origin },
  ])
    assert.throws(
      () => invoke("list", remote, undefined, senderFrame),
      /cannot manage/,
    );
  for (const bad of [
    "https://evil.example",
    "null",
    "http://panel.example:3002",
  ]) {
    const before = remote.mainFrame;
    remote.mainFrame = { ...before, origin: bad };
    assert.throws(() => invoke("list", remote), /cannot manage/);
    remote.mainFrame = before;
  }
  remote.url = "https://evil.example/";
  assert.throws(() => invoke("list", remote), /cannot manage/);
  remote.url = origin;
  const impostor = { ...remote, mainFrame: remote.mainFrame };
  assert.throws(() => invoke("list", impostor), /cannot manage/);
  for (const value of [null, {}, 12, "a".repeat(4097)])
    assert.throws(() => invoke("open", local, value), /valid panel address/);
  await assert.rejects(invoke("disconnect", local, "local"), { status: 400 });
  await invoke("disconnect", local, remoteId);
  assert.throws(() => invoke("list", remote), /cannot manage/);
  await h.controller.close();
  assert.throws(() => invoke("list", local), /cannot manage/);
  remove();
  assert.equal(handlers.size, 0);
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
