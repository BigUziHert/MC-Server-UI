// Opt-in integration check: node desktop/remote-panels.smoke.mjs
// Uses the installed Electron binary, hidden windows, a temporary profile, and
// a generated loopback-only certificate. No user app data or remote host is used.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectDirectory = path.dirname(path.dirname(scriptPath));

async function fixture() {
  const { app, BrowserWindow, session } = await import("electron");
  const { default: selfsigned } = await import("selfsigned");
  const { createRemotePanelController } = await import("./remote-panels.mjs");
  const { installPanelPermissionHandlers } = await import("./permissions.mjs");
  const { startDesktopRuntime, DESKTOP_COOKIE_NAME } =
    await import("./runtime.mjs");
  const root = app.commandLine.getSwitchValue("remote-smoke-root");
  assert.ok(path.isAbsolute(root));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("mc-remote-electron-smoke-"));
  app.setPath("userData", path.join(root, "profile"));
  await app.whenReady();
  const certificate = await selfsigned.generate(
    [{ name: "commonName", value: "127.0.0.1" }],
    {
      keySize: 2048,
      algorithm: "sha256",
      notBeforeDate: new Date(Date.now() - 60000),
      notAfterDate: new Date(Date.now() + 86400000),
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      ],
    },
  );
  const expectedFingerprint = new X509Certificate(certificate.cert)
    .fingerprint256;
  const requests = [];
  const secureServer = https.createServer(
    { key: certificate.private, cert: certificate.cert },
    (req, res) => {
      requests.push({
        path: req.url,
        cookie: req.headers.cookie || "",
        origin: req.headers.origin,
      });
      res.setHeader(
        "Set-Cookie",
        "remote-fixture=fixture-session; Secure; HttpOnly; SameSite=Strict; Path=/",
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<!doctype html><title>Fixture cannot replace native host title</title><h1>Remote fixture panel</h1><p>This page is served by the loopback HTTPS test fixture.</p>" +
          (req.url === "/" ? '<iframe src="/embedded"></iframe>' : ""),
      );
    },
  );
  await new Promise((resolve, reject) => {
    secureServer.once("error", reject);
    secureServer.listen(0, "127.0.0.1", resolve);
  });
  const remoteUrl = `https://127.0.0.1:${secureServer.address().port}/`;
  const remoteWindows = [];
  const prompts = [];
  const answers = [0, 1, 1];
  class HiddenRemoteWindow extends BrowserWindow {
    constructor(options) {
      super({ ...options, show: false });
      remoteWindows.push(this);
    }
  }
  const controller = createRemotePanelController({
    BrowserWindow: HiddenRemoteWindow,
    session,
    downloadsDirectory: path.join(root, "downloads"),
    dialog: {
      async showMessageBox(window, options) {
        assert.ok(remoteWindows.includes(window));
        assert.ok(
          options.detail.includes(expectedFingerprint),
          "Only the known fixture certificate may receive a test answer.",
        );
        assert.equal(options.defaultId, 0);
        assert.equal(options.cancelId, 0);
        assert.ok(answers.length, "Unexpected certificate prompt");
        const response = answers.shift();
        prompts.push(response);
        return { response };
      },
    },
  });
  const runtime = await startDesktopRuntime({
    dataDir: path.join(root, "data"),
    scheduler: false,
    openRemotePanel: (url) => controller.open(url),
  });
  const ownerSession = session.fromPartition("remote-smoke-owner");
  await ownerSession.cookies.set({
    url: runtime.url,
    name: DESKTOP_COOKIE_NAME,
    value: runtime.token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  const ownerWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      session: ownerSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  installPanelPermissionHandlers(
    ownerSession,
    runtime.url,
    () => ownerWindow.webContents,
  );
  await ownerWindow.loadURL(`${runtime.url}/api/access/session`);
  // Query Chromium's real permission path without reading or overwriting the
  // user's OS clipboard. The renderer copy/fallback flow is covered in e2e.
  const clipboardPermissions = (contents) =>
    contents.executeJavaScript(`(async () => ({
      write: (await navigator.permissions.query({name: 'clipboard-write'})).state,
      read: (await navigator.permissions.query({name: 'clipboard-read'})).state,
      embeddedWrite: document.querySelector('iframe')
        ? (await document.querySelector('iframe').contentWindow.navigator.permissions.query({name: 'clipboard-write'})).state
        : null
    }))()`);
  const privateRequest = (route, options = {}) =>
    fetch(runtime.url + route, {
      ...options,
      headers: {
        Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
        Origin: runtime.url,
        "Content-Type": "application/json",
      },
    });
  globalThis.__remotePanelSmoke = {
    ready: true,
    remoteUrl,
    async open() {
      const response = await privateRequest("/api/desktop/connections/open", {
        method: "POST",
        body: JSON.stringify({ url: remoteUrl }),
      });
      return { status: response.status, body: await response.json() };
    },
    async inspect() {
      const window = remoteWindows.at(-1);
      const active = window && !window.isDestroyed();
      const preferences = active
        ? window.webContents.getLastWebPreferences()
        : null;
      return {
        prompts,
        requests,
        windows: remoteWindows.map((item) => ({
          destroyed: item.isDestroyed(),
        })),
        ownerOpen: !ownerWindow.isDestroyed(),
        localStatus: (await privateRequest("/api/servers")).status,
        ownerCookie: (
          await ownerSession.cookies.get({ url: runtime.url })
        ).some((item) => item.name === DESKTOP_COOKIE_NAME),
        cookies: active ? await window.webContents.session.cookies.get({}) : [],
        separateSession: active
          ? window.webContents.session !== ownerSession
          : true,
        title: active ? window.getTitle() : null,
        preferences: preferences && {
          nodeIntegration: preferences.nodeIntegration,
          contextIsolation: preferences.contextIsolation,
          sandbox: preferences.sandbox,
          webSecurity: preferences.webSecurity,
          preload: preferences.preload || "",
        },
        ownerClipboard: await clipboardPermissions(ownerWindow.webContents),
        remoteClipboard: active
          ? await clipboardPermissions(window.webContents)
          : null,
        document: active
          ? await window.webContents.executeJavaScript(
              "({heading:document.querySelector('h1')?.textContent,require:typeof require,process:typeof process})",
            )
          : null,
      };
    },
    closeRemote() {
      const window = remoteWindows.at(-1);
      return new Promise((resolve) => {
        window.once("closed", resolve);
        window.close();
      });
    },
    async stop() {
      controller.close();
      await runtime.close();
      secureServer.closeAllConnections();
      await new Promise((resolve) => secureServer.close(resolve));
      ownerWindow.destroy();
    },
  };
}

async function smoke() {
  const { _electron: electron, expect } = await import("@playwright/test");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-remote-electron-smoke-"),
  );
  const profile = path.join(root, "profile");
  await fs.mkdir(profile);
  let application;
  let stderr = "";
  try {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.NODE_OPTIONS;
    application = await electron.launch({
      executablePath: path.join(
        projectDirectory,
        "node_modules",
        "electron",
        "dist",
        "electron.exe",
      ),
      args: [
        scriptPath,
        `--user-data-dir=${profile}`,
        `--remote-smoke-root=${root}`,
      ],
      cwd: projectDirectory,
      env: environment,
      timeout: 30000,
    });
    application.process().stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    await expect
      .poll(
        () =>
          application.evaluate(() =>
            Boolean(globalThis.__remotePanelSmoke?.ready),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    const canceled = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.open(),
    );
    assert.equal(canceled.status, 409);
    let state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.deepEqual(state.prompts, [0]);
    assert.deepEqual(state.windows, [{ destroyed: true }]);
    assert.equal(
      state.requests.length,
      0,
      "No page or credentials may be sent before certificate trust.",
    );
    assert.equal(state.localStatus, 200);
    const connected = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.open(),
    );
    assert.equal(connected.status, 200);
    assert.equal(connected.body.opened, true);
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.deepEqual(state.prompts, [0, 1]);
    assert.deepEqual(state.document, {
      heading: "Remote fixture panel",
      require: "undefined",
      process: "undefined",
    });
    assert.deepEqual(state.preferences, {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: "",
    });
    assert.equal(state.ownerCookie, true);
    assert.equal(state.separateSession, true);
    assert.deepEqual(state.ownerClipboard, {
      write: "granted",
      read: "denied",
      embeddedWrite: null,
    });
    assert.deepEqual(state.remoteClipboard, {
      write: "granted",
      read: "denied",
      embeddedWrite: "denied",
    });
    assert.ok(state.cookies.some((item) => item.name === "remote-fixture"));
    assert.ok(state.cookies.every((item) => item.name !== "mc-panel-desktop"));
    assert.ok(
      state.requests.every((item) => !item.cookie.includes("mc-panel-desktop")),
    );
    assert.match(state.title, /^127\.0\.0\.1:\d+ · MC Panel remote$/);
    await application.evaluate(() =>
      globalThis.__remotePanelSmoke.closeRemote(),
    );
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.equal(state.ownerOpen, true);
    assert.equal(state.localStatus, 200);
    assert.ok(state.windows.every((item) => item.destroyed));
    const reopened = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.open(),
    );
    assert.equal(reopened.status, 200);
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.deepEqual(
      state.prompts,
      [0, 1, 1],
      "Each new window must require its own certificate decision.",
    );
    const documents = state.requests.filter((item) => item.path === "/");
    assert.equal(documents.length, 2);
    assert.ok(
      documents.every((item) => item.cookie === ""),
      "A new window must not inherit the previous remote session.",
    );
    console.log(
      "Passed real Electron remote smoke: certificate cancel/accept, HTTPS rendering, sandbox/no Node bridge, isolated cookies, new-window trust, clipboard writes granted only to main documents with reads denied (OS clipboard untouched), and local runtime survives remote close.",
    );
  } catch (cause) {
    if (stderr) console.error(stderr);
    throw cause;
  } finally {
    if (application) {
      await application
        .evaluate(() => globalThis.__remotePanelSmoke?.stop())
        .catch(() => {});
      await application.close().catch(() => {});
    }
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    const resolved = await fs.realpath(root);
    assert.equal(
      path.dirname(resolved).toLowerCase(),
      (await fs.realpath(os.tmpdir())).toLowerCase(),
    );
    assert.ok(path.basename(resolved).startsWith("mc-remote-electron-smoke-"));
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}

if (process.versions.electron) {
  void fixture().catch(async (cause) => {
    console.error(cause);
    (await import("electron")).app.exit(1);
  });
} else {
  await smoke();
}
