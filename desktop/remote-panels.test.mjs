import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";
import { createRemotePanelController } from "./remote-panels.mjs";
import { DESKTOP_COOKIE_NAME, startDesktopRuntime } from "./runtime.mjs";
import { requiredPermissions } from "../server/remote-access.mjs";

const invite = "a".repeat(43);
const origin = "https://panel.example:3002";

function harness({ responses = [], load } = {}) {
  const windows = [];
  const partitions = [];
  const prompts = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => {
        this.popup = handler;
      };
      windows.push(this);
    }
    setMenu(value) {
      this.menu = value;
    }
    isDestroyed() {
      return Boolean(this.destroyed);
    }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    async loadURL(url) {
      this.url = url;
      await load?.(this);
    }
  }
  const controller = createRemotePanelController({
    BrowserWindow: FakeWindow,
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
  return { controller, windows, partitions, prompts };
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

test("remote windows isolate sessions, reject external navigation, and scope downloads", async () => {
  const h = harness();
  assert.deepEqual(await h.controller.open(`${origin}/#invite=${invite}`), {
    opened: true,
    url: `${origin}/#invite=${invite}`,
  });
  await h.controller.open(origin);
  const [first, second] = h.windows;
  const [firstSession, secondSession] = h.partitions;
  assert.notEqual(firstSession.name, secondSession.name);
  assert.ok(h.partitions.every((value) => !value.name.startsWith("persist:")));
  assert.deepEqual(first.options.webPreferences, {
    session: firstSession,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
  });
  assert.equal(first.menu, null);
  const titleChange = event();
  first.emit("page-title-updated", titleChange, "Untrusted title");
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
  first.destroy();
  assert.equal(second.isDestroyed(), false);
  assert.equal(firstSession.cleared, true);
  assert.equal(firstSession.disconnected, true);
  h.controller.close();
  assert.equal(second.isDestroyed(), true);
  await assert.rejects(h.controller.open(origin), { status: 503 });
});

test("certificate trust is explicit, per-window, and tied to the valid leaf and host", async () => {
  const [cert, changed, wrongHost] = await Promise.all([
    certificate(),
    certificate(),
    certificate("other.example"),
  ]);
  const h = harness({ responses: [1, 0, 0] });
  await h.controller.open(origin);
  const first = h.windows[0];
  assert.equal(await verify(first, cert), true);
  assert.equal(h.prompts.length, 1);
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
  await h.controller.open(origin);
  assert.equal(await verify(h.windows[1], cert), false);
  assert.equal(h.prompts.length, 3);
  h.controller.close();
});

test("canceled trust fails opening and destroys the isolated window", async () => {
  const cert = await certificate();
  const h = harness({
    load: async (window) => {
      if (!(await verify(window, cert)))
        throw new Error("Certificate rejected");
    },
  });
  await assert.rejects(h.controller.open(origin), { status: 409 });
  assert.equal(h.windows[0].isDestroyed(), true);
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
