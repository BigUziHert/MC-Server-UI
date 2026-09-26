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
import { Resvg } from "@resvg/resvg-js";

const scriptPath = fileURLToPath(import.meta.url);
const projectDirectory = path.dirname(path.dirname(scriptPath));
const icon = (fill) =>
  `data:image/png;base64,${new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${fill}"/></svg>`,
  )
    .render()
    .asPng()
    .toString("base64")}`;

async function fixture() {
  const { app, BrowserWindow, WebContentsView, ipcMain, session } =
    await import("electron");
  const { default: selfsigned } = await import("selfsigned");
  const { createRemotePanelController } = await import("./remote-panels.mjs");
  const { installPanelPermissionHandlers } = await import("./permissions.mjs");
  const { installConnectionIpc } = await import("./connections-ipc.mjs");
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
  const secureServers = [0, 1].map((number) =>
    https.createServer(
      { key: certificate.private, cert: certificate.cert },
      (req, res) => {
        requests.push({
          path: req.url,
          cookie: req.headers.cookie || "",
          origin: req.headers.origin,
          server: number,
        });
        res.setHeader(
          "Set-Cookie",
          `remote-fixture=fixture-session-${number}; Secure; HttpOnly; SameSite=Strict; Path=/`,
        );
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><title>Fixture cannot replace native host title</title><h1>Remote fixture panel</h1><p>This page is served by the loopback HTTPS test fixture.</p>" +
            '<script>window.__localServerSelections=[];addEventListener("mc-panel-local-server-selected",event=>window.__localServerSelections.push(event.detail))</script>' +
            '<script>window.__remoteServerSelections=[];addEventListener("mc-panel-remote-server-selected",event=>window.__remoteServerSelections.push(event.detail))</script>' +
            '<script>window.__updatesOpened=0;addEventListener("mc-panel-updates-open",()=>window.__updatesOpened++)</script>' +
            (req.url === "/" ? '<iframe src="/embedded"></iframe>' : ""),
        );
      },
    ),
  );
  for (const secureServer of secureServers)
    await new Promise((resolve, reject) => {
      secureServer.once("error", reject);
      secureServer.listen(0, "127.0.0.1", resolve);
    });
  const remoteUrls = secureServers.map(
    (server) => `https://127.0.0.1:${server.address().port}/`,
  );
  const remoteUrl = remoteUrls[0];
  const remoteViews = [];
  const remoteContents = [];
  const prompts = [];
  const answers = [0, 1, 1, 1];
  class TrackedView {
    constructor(options) {
      const view = new WebContentsView(options);
      remoteViews.push(view);
      remoteContents.push(view.webContents);
      return view;
    }
  }
  let controller;
  const updaterCalls = [];
  const runtime = await startDesktopRuntime({
    dataDir: path.join(root, "data"),
    scheduler: false,
    openRemotePanel: (url) => controller.open(url),
    updates: Object.fromEntries(
      ["snapshot", "check", "download", "install"].map((action) => [
        action,
        () => {
          updaterCalls.push(action);
          return { desktop: true, supported: false };
        },
      ]),
    ),
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
      preload: path.join(
        projectDirectory,
        "desktop",
        "connections-preload.cjs",
      ),
    },
  });
  controller = createRemotePanelController({
    window: ownerWindow,
    localOrigin: runtime.url,
    WebContentsView: TrackedView,
    session,
    preload: path.join(projectDirectory, "desktop", "connections-preload.cjs"),
    downloadsDirectory: path.join(root, "downloads"),
    listLocalServers: () => runtime.listLocalServers(),
    selectLocalServer: (id) => runtime.selectLocalServer(id),
    openUpdatesOverlay: () =>
      ownerWindow.webContents.send("mc-panel-updates-open"),
    dialog: {
      async showMessageBox(window, options) {
        assert.equal(window, ownerWindow);
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
  const removeIpc = installConnectionIpc(ipcMain, controller);
  installPanelPermissionHandlers(
    ownerSession,
    runtime.url,
    () => ownerWindow.webContents,
  );
  await ownerWindow.loadURL(`${runtime.url}/api/access/session`);
  await ownerWindow.webContents.executeJavaScript(
    'window.__localServerSelections=[];addEventListener("mc-panel-local-server-selected",event=>window.__localServerSelections.push(event.detail))',
  );
  await ownerWindow.webContents.executeJavaScript(
    'window.__remoteServerSelections=[];addEventListener("mc-panel-remote-server-selected",event=>window.__remoteServerSelections.push(event.detail));window.__connectionChanges=0;addEventListener("mc-panel-connections-changed",()=>window.__connectionChanges++)',
  );
  await ownerWindow.webContents.executeJavaScript(
    'window.__updatesOpened=0;addEventListener("mc-panel-updates-open",()=>window.__updatesOpened++)',
  );
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
  const localResponse = await privateRequest("/api/servers", {
    method: "POST",
    body: JSON.stringify({ name: "Local smoke world", port: 25565 }),
  });
  assert.equal(localResponse.status, 201);
  const localServerId = (await localResponse.json()).server.id;
  const iconResponse = await privateRequest(
    `/api/server/icon?serverId=${encodeURIComponent(localServerId)}`,
    { method: "POST", body: JSON.stringify({ image: icon("#008800") }) },
  );
  assert.equal(iconResponse.status, 200);
  globalThis.__remotePanelSmoke = {
    ready: true,
    remoteUrl,
    remoteUrls,
    localServerId,
    async open() {
      const response = await privateRequest("/api/desktop/connections/open", {
        method: "POST",
        body: JSON.stringify({ url: remoteUrl }),
      });
      return { status: response.status, body: await response.json() };
    },
    invoke(action, value, fromRemote = false, other) {
      const contents =
        typeof fromRemote === "number"
          ? remoteContents[fromRemote]
          : fromRemote
            ? remoteContents.at(-1)
            : ownerWindow.webContents;
      assert.ok(
        [
          "list",
          "open",
          "activate",
          "disconnect",
          "openUpdates",
          "selectLocalServer",
          "reportServers",
          "selectRemoteServer",
        ].includes(action),
      );
      return contents.executeJavaScript(
        action === "openUpdates"
          ? "window.mcPanelConnections.openUpdates()"
          : `window.mcPanelConnections[${JSON.stringify(action)}](${JSON.stringify(value)},${JSON.stringify(other)})`,
      );
    },
    async inspect() {
      const contents = remoteContents.at(-1);
      const active = contents && !contents.isDestroyed();
      const preferences = active ? contents.getLastWebPreferences() : null;
      return {
        prompts,
        requests,
        updaterCalls,
        nativeWindows: BrowserWindow.getAllWindows().length,
        context: controller.list(),
        ownerUpdatesOpened: await ownerWindow.webContents.executeJavaScript(
          "window.__updatesOpened",
        ),
        remoteUpdatesOpened: await Promise.all(
          remoteContents.map(async (item) =>
            item.isDestroyed()
              ? 0
              : item.executeJavaScript("window.__updatesOpened"),
          ),
        ),
        connectionChanges: await ownerWindow.webContents.executeJavaScript(
          "window.__connectionChanges",
        ),
        ownerRemoteSelectionEvents:
          await ownerWindow.webContents.executeJavaScript(
            "window.__remoteServerSelections",
          ),
        remoteServerSelectionEvents: await Promise.all(
          remoteContents.map(async (item) =>
            item.isDestroyed()
              ? []
              : item.executeJavaScript("window.__remoteServerSelections"),
          ),
        ),
        localSelection: (
          await (await privateRequest("/api/desktop/selection")).json()
        ).activeServerId,
        ownerSelectionEvents: await ownerWindow.webContents.executeJavaScript(
          "window.__localServerSelections",
        ),
        remoteSelectionEvents: active
          ? await contents.executeJavaScript("window.__localServerSelections")
          : [],
        views: remoteContents.map((item) => ({
          destroyed: item.isDestroyed(),
        })),
        ownerOpen: !ownerWindow.isDestroyed(),
        localStatus: (await privateRequest("/api/servers")).status,
        ownerCookie: (
          await ownerSession.cookies.get({ url: runtime.url })
        ).some((item) => item.name === DESKTOP_COOKIE_NAME),
        cookies: active ? await contents.session.cookies.get({}) : [],
        remoteCookies: await Promise.all(
          remoteContents.map(async (item) =>
            item.isDestroyed() ? [] : item.session.cookies.get({}),
          ),
        ),
        separateSession: active ? contents.session !== ownerSession : true,
        title: ownerWindow.getTitle(),
        preferences: preferences && {
          nodeIntegration: preferences.nodeIntegration,
          contextIsolation: preferences.contextIsolation,
          sandbox: preferences.sandbox,
          webSecurity: preferences.webSecurity,
        },
        ownerClipboard: await clipboardPermissions(ownerWindow.webContents),
        remoteClipboard: active ? await clipboardPermissions(contents) : null,
        document: active
          ? await contents.executeJavaScript(
              "({heading:document.querySelector('h1')?.textContent,require:typeof require,process:typeof process,bridge:Object.keys(window.mcPanelConnections),frameBridge:typeof document.querySelector('iframe')?.contentWindow.mcPanelConnections})",
            )
          : null,
      };
    },
    async stop() {
      removeIpc();
      await controller.close();
      await runtime.close();
      for (const secureServer of secureServers) {
        secureServer.closeAllConnections();
        await new Promise((resolve) => secureServer.close(resolve));
      }
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
    assert.deepEqual(state.views, [{ destroyed: true }]);
    assert.equal(state.nativeWindows, 1);
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
      bridge: [
        "list",
        "open",
        "activate",
        "disconnect",
        "openUpdates",
        "selectLocalServer",
        "reportServers",
        "selectRemoteServer",
      ],
      frameBridge: "undefined",
    });
    assert.deepEqual(state.preferences, {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
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
    assert.match(state.title, /^127\.0\.0\.1:\d+ · MC Panel$/);
    const firstId = state.context.activeId;
    const connectedPanels = state.context.panels;
    const connectedCookies = state.cookies;
    assert.equal(state.ownerUpdatesOpened, 0);
    assert.deepEqual(state.remoteUpdatesOpened, [0, 0]);
    const updatesResult = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.invoke("openUpdates", undefined, true),
    );
    assert.equal(
      updatesResult,
      undefined,
      "opening updates must return no local data",
    );
    await expect
      .poll(async () => {
        const current = await application.evaluate(() =>
          globalThis.__remotePanelSmoke.inspect(),
        );
        return current.ownerUpdatesOpened;
      })
      .toBe(1);
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.equal(state.context.activeId, firstId);
    assert.match(state.title, /^127\.0\.0\.1:\d+ · MC Panel$/);
    assert.deepEqual(state.context.panels, connectedPanels);
    assert.deepEqual(state.views, [{ destroyed: true }, { destroyed: false }]);
    assert.deepEqual(state.cookies, connectedCookies);
    assert.deepEqual(
      state.remoteUpdatesOpened,
      [0, 0],
      "update notifications must only reach the local owner renderer",
    );
    assert.deepEqual(
      state.updaterCalls,
      [],
      "the connection bridge must not read updater state or initiate update actions",
    );
    assert.ok(
      state.requests.every(
        (request) => !request.path.startsWith("/api/desktop/updates"),
      ),
      "opening local updates must not call the remote updater",
    );
    assert.equal(state.context.activeId, firstId);
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.equal(
      state.views.length,
      2,
      "opening updates must retain the remote view",
    );
    assert.deepEqual(state.cookies, connectedCookies);
    const firstRoster = [
      {
        id: "remote-world",
        name: "Remote survival",
        status: "running",
        software: "Paper",
        minecraftVersion: "1.21.8",
        iconDataUrl: icon("#0044cc"),
      },
    ];
    await application.evaluate(
      (_electron, roster) =>
        globalThis.__remotePanelSmoke.invoke("reportServers", roster, true),
      firstRoster,
    );
    const firstCookie = state.cookies.find(
      (item) => item.name === "remote-fixture",
    ).value;
    assert.equal(firstCookie, "fixture-session-0");
    const second = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.invoke(
        "open",
        globalThis.__remotePanelSmoke.remoteUrls[1],
        true,
      ),
    );
    const secondId = second.activeId;
    const secondRoster = [
      {
        id: "remote-world",
        name: "Remote creative",
        status: "offline",
        iconDataUrl: icon("#cc4400"),
      },
    ];
    await application.evaluate(
      (_electron, roster) =>
        globalThis.__remotePanelSmoke.invoke("reportServers", roster, true),
      secondRoster,
    );
    assert.notEqual(firstId, secondId);
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.equal(
      state.nativeWindows,
      1,
      "remote connections must stay in the original native window",
    );
    assert.equal(state.context.panels.length, 3);
    assert.equal(state.context.localServers.length, 1);
    assert.equal(state.context.localServers[0].name, "Local smoke world");
    assert.ok(
      Object.keys(state.context.localServers[0]).every((key) =>
        [
          "id",
          "name",
          "status",
          "software",
          "minecraftVersion",
          "iconDataUrl",
        ].includes(key),
      ),
    );
    assert.equal(state.context.localServers[0].iconDataUrl, icon("#008800"));
    const remoteSnapshot = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.invoke("list", undefined, true),
    );
    assert.equal(remoteSnapshot.localServers[0].iconDataUrl, icon("#008800"));
    assert.deepEqual(
      remoteSnapshot.panels.find((panel) => panel.id === firstId).servers,
      firstRoster,
    );
    assert.deepEqual(
      remoteSnapshot.panels.find((panel) => panel.id === secondId).servers,
      secondRoster,
    );
    assert.equal(
      state.remoteCookies[1].find((item) => item.name === "remote-fixture")
        .value,
      firstCookie,
    );
    assert.equal(
      state.remoteCookies[2].find((item) => item.name === "remote-fixture")
        .value,
      "fixture-session-1",
    );
    const localSelected = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.invoke(
        "selectLocalServer",
        globalThis.__remotePanelSmoke.localServerId,
        true,
      ),
    );
    assert.equal(localSelected.activeId, "local");
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.equal(state.localSelection, state.context.localServers[0].id);
    assert.deepEqual(state.ownerSelectionEvents, [
      { serverId: state.localSelection },
    ]);
    assert.deepEqual(
      state.remoteSelectionEvents,
      [],
      "local selection notifications must only reach the owner renderer",
    );
    assert.deepEqual(
      state.context.panels.find((panel) => panel.id === firstId).servers,
      firstRoster,
    );
    assert.deepEqual(
      state.context.panels.find((panel) => panel.id === secondId).servers,
      secondRoster,
    );
    const beforeSameReport = state.connectionChanges;
    await application.evaluate(
      (_electron, roster) =>
        globalThis.__remotePanelSmoke.invoke("reportServers", roster, 1),
      firstRoster,
    );
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.equal(
      state.connectionChanges,
      beforeSameReport,
      "identical reports must not cause refresh loops",
    );
    const selectedRemote = await application.evaluate(
      (_electron, panelId) =>
        globalThis.__remotePanelSmoke.invoke(
          "selectRemoteServer",
          panelId,
          false,
          "remote-world",
        ),
      firstId,
    );
    assert.equal(selectedRemote.activeId, firstId);
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.deepEqual(state.remoteServerSelectionEvents[1], [
      { serverId: "remote-world" },
    ]);
    assert.deepEqual(state.remoteServerSelectionEvents[2], []);
    assert.deepEqual(state.ownerRemoteSelectionEvents, []);
    const resumed = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.invoke(
        "open",
        globalThis.__remotePanelSmoke.remoteUrl,
      ),
    );
    assert.equal(resumed.activeId, firstId);
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.equal(
      state.views.length,
      3,
      "switching and reopening an origin reuse its view",
    );
    assert.equal(
      state.remoteCookies[1].find((item) => item.name === "remote-fixture")
        .value,
      firstCookie,
    );
    assert.deepEqual(
      state.prompts,
      [0, 1, 1],
      "switching must preserve the certificate decision",
    );
    await application.evaluate(() =>
      globalThis.__remotePanelSmoke.invoke("reportServers", null, 1),
    );
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.deepEqual(
      state.context.panels.find((panel) => panel.id === firstId).servers,
      [],
    );
    assert.deepEqual(
      state.context.panels.find((panel) => panel.id === secondId).servers,
      secondRoster,
    );
    assert.equal(
      state.remoteCookies[1].find((item) => item.name === "remote-fixture")
        .value,
      firstCookie,
      "roster logout reporting must not discard or replace native sessions",
    );
    await application.evaluate(
      (_electron, id) => globalThis.__remotePanelSmoke.invoke("disconnect", id),
      firstId,
    );
    await application.evaluate(
      (_electron, id) => globalThis.__remotePanelSmoke.invoke("disconnect", id),
      secondId,
    );
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.equal(state.ownerOpen, true);
    assert.equal(state.localStatus, 200);
    assert.ok(state.views.every((item) => item.destroyed));
    assert.equal(state.context.activeId, "local");
    const reopened = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.open(),
    );
    assert.equal(reopened.status, 200);
    state = await application.evaluate(() =>
      globalThis.__remotePanelSmoke.inspect(),
    );
    assert.deepEqual(
      state.prompts,
      [0, 1, 1, 1],
      "Reconnecting after disconnect must require its own certificate decision.",
    );
    const documents = state.requests.filter(
      (item) => item.path === "/" && item.server === 0,
    );
    assert.equal(documents.length, 2);
    assert.ok(
      documents.every((item) => item.cookie === ""),
      "A reconnected view must not inherit the disconnected session.",
    );
    console.log(
      "Passed real Electron remote smoke: one native window, two isolated remote views, distinct local/remote icons and rosters across switches, scoped signout clearing/selection events, minimal local entries, owner-only persisted selection and update navigation, cookies/trust preserved, disconnect cleanup, local runtime survival, and clipboard permission checks (OS clipboard untouched).",
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
