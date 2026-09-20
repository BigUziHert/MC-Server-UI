// Opt-in: node desktop/remote-persistence.smoke.mjs
// The loopback fixtures live in the parent Node process so every Electron
// restart is a real quit/relaunch against the same disposable profile.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectDirectory = path.dirname(path.dirname(scriptPath));
const cookieName = "remote-persistence-session";
const ownerCookieName = "mc-panel-desktop";

async function electronFixture() {
  const { app, BrowserWindow, WebContentsView, ipcMain, session } =
    await import("electron");
  const { createRemotePanelController } = await import("./remote-panels.mjs");
  const { createConnectionStore } = await import("./connection-store.mjs");
  const { installConnectionIpc } = await import("./connections-ipc.mjs");
  const root = app.commandLine.getSwitchValue("persistence-smoke-root");
  assert.ok(path.isAbsolute(root));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("mc-remote-persistence-smoke-"));
  app.setPath("userData", path.join(root, "profile"));
  app.setPath("sessionData", path.join(root, "profile"));
  const config = JSON.parse(
    await fs.readFile(path.join(root, "fixture.json"), "utf8"),
  );
  await app.whenReady();
  // Keep this hidden harness alive until Playwright closes the entire process.
  app.on("window-all-closed", () => {});
  const ownerSession = session.fromPartition("persistence-smoke-owner");
  await ownerSession.cookies.set({
    url: config.localOrigin,
    name: ownerCookieName,
    value: "fixture-owner-only",
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  const preload = path.join(
    projectDirectory,
    "desktop",
    "connections-preload.cjs",
  );
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: ownerSession,
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const tracked = [];
  class TrackedView {
    constructor(options) {
      const view = new WebContentsView(options);
      tracked.push({
        contents: view.webContents,
        session: options.webPreferences.session,
      });
      return view;
    }
  }
  const prompts = [];
  let answers = [];
  const store = createConnectionStore({ dataDir: path.join(root, "data") });
  const controller = createRemotePanelController({
    window,
    localOrigin: config.localOrigin,
    WebContentsView: TrackedView,
    session,
    store,
    preload,
    downloadsDirectory: path.join(root, "downloads"),
    dialog: {
      async showMessageBox(parent, options) {
        assert.equal(parent, window);
        assert.equal(options.defaultId, 0);
        assert.equal(options.cancelId, 0);
        const fingerprint = config.fingerprints.find((value) =>
          options.detail.includes(value),
        );
        assert.ok(
          fingerprint,
          "Only a generated fixture certificate may prompt.",
        );
        assert.ok(answers.length, "Unexpected certificate trust prompt.");
        const response = answers.shift();
        prompts.push({ fingerprint, response, detail: options.detail });
        return { response };
      },
    },
  });
  const removeIpc = installConnectionIpc(ipcMain, controller);
  await window.loadURL(config.localOrigin);
  const restored = await controller.restore();
  const remoteContents = (origin) => {
    assert.ok(config.remoteOrigins.includes(origin));
    const match = tracked.findLast(({ contents }) => {
      if (contents.isDestroyed()) return false;
      try {
        return new URL(contents.getURL()).origin === origin;
      } catch {
        return false;
      }
    });
    assert.ok(match, `No loaded remote fixture for ${origin}`);
    return match.contents;
  };
  globalThis.__persistenceSmoke = {
    ready: true,
    restored,
    answers(values) {
      assert.ok(values.every((value) => value === 0 || value === 1));
      answers = values;
    },
    open(origin) {
      assert.ok(config.remoteOrigins.includes(origin));
      return window.webContents.executeJavaScript(
        `window.mcPanelConnections.open(${JSON.stringify(origin)})`,
      );
    },
    disconnect(id) {
      return window.webContents.executeJavaScript(
        `window.mcPanelConnections.disconnect(${JSON.stringify(id)})`,
      );
    },
    activateLocal() {
      return window.webContents.executeJavaScript(
        'window.mcPanelConnections.activate("local")',
      );
    },
    report(origin, roster) {
      return remoteContents(origin).executeJavaScript(
        `window.mcPanelConnections.reportServers(${JSON.stringify(roster)})`,
      );
    },
    request(origin, route, method = "GET") {
      assert.ok(["/session", "/login", "/logout"].includes(route));
      assert.ok(["GET", "POST"].includes(method));
      return remoteContents(origin).executeJavaScript(
        `(async()=>{const response=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(method)}});return {status:response.status,body:await response.json()}})()`,
      );
    },
    async remoteState(origin, marker) {
      const contents = remoteContents(origin);
      if (marker !== undefined)
        await contents.executeJavaScript(
          `localStorage.setItem("fixture-marker",${JSON.stringify(marker)})`,
        );
      return {
        cookies: await contents.session.cookies.get({}),
        marker: await contents.executeJavaScript(
          'localStorage.getItem("fixture-marker")',
        ),
        documentCookie: await contents.executeJavaScript("document.cookie"),
      };
    },
    async inspect() {
      return {
        pid: process.pid,
        context: controller.list(),
        prompts,
        ownerCookies: await ownerSession.cookies.get({}),
        sessions: await Promise.all(
          tracked.map(async (item) => ({
            destroyed: item.contents.isDestroyed(),
            cookies: await item.session.cookies.get({}),
          })),
        ),
      };
    },
    async stop() {
      // Production close must flush persistent cookies and preserve the saved
      // registry. Do not manually flush cookies/store here and hide regressions.
      await controller.close();
      removeIpc();
      window.destroy();
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function smoke() {
  const { _electron: electron, expect } = await import("@playwright/test");
  const { default: selfsigned } = await import("selfsigned");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-remote-persistence-smoke-"),
  );
  const profile = path.join(root, "profile");
  await fs.mkdir(profile);
  const certificates = await Promise.all(
    [0, 1].map(() =>
      selfsigned.generate([{ name: "commonName", value: "127.0.0.1" }], {
        keySize: 2048,
        algorithm: "sha256",
        notBeforeDate: new Date(Date.now() - 60000),
        notAfterDate: new Date(Date.now() + 86400000),
        extensions: [
          { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
        ],
      }),
    ),
  );
  const fingerprints = certificates.map(
    (certificate) => new X509Certificate(certificate.cert).fingerprint256,
  );
  const requests = [];
  const liveTokens = [null, null];
  const loginCounts = [0, 0];
  const page =
    "<!doctype html><title>Persistence fixture</title><h1>Remote persistence fixture</h1>";
  const remoteServers = [0, 1].map((index) =>
    https.createServer(
      { key: certificates[0].private, cert: certificates[0].cert },
      (req, res) => {
        const cookie = req.headers.cookie || "";
        requests.push({ server: index, path: req.url, cookie });
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json");
        const authenticated = Boolean(
          liveTokens[index] &&
          cookie.split(/;\s*/).includes(`${cookieName}=${liveTokens[index]}`),
        );
        if (req.url === "/login" && req.method === "POST") {
          liveTokens[index] = `fixture-token-${index}-${++loginCounts[index]}`;
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=${liveTokens[index]}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
          );
          res.end(JSON.stringify({ authenticated: true, server: index }));
        } else if (req.url === "/logout" && req.method === "POST") {
          liveTokens[index] = null;
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
          res.end(JSON.stringify({ authenticated: false }));
        } else if (req.url === "/session") {
          res.statusCode = authenticated ? 200 : 401;
          res.end(JSON.stringify({ authenticated, server: index }));
        } else {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(page);
        }
      },
    ),
  );
  const ownerRequests = [];
  const ownerServer = http.createServer((req, res) => {
    ownerRequests.push(req.headers.cookie || "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><title>Owner fixture</title><h1>This computer</h1>",
    );
  });
  let application;
  let stderr = "";
  const pids = [];
  const remoteOrigins = [];
  const inspect = () =>
    application.evaluate(() => globalThis.__persistenceSmoke.inspect());
  const open = (origin) =>
    application.evaluate(
      (_electron, value) => globalThis.__persistenceSmoke.open(value),
      origin,
    );
  const answers = (values) =>
    application.evaluate(
      (_electron, value) => globalThis.__persistenceSmoke.answers(value),
      values,
    );
  const request = (origin, route, method = "GET") =>
    application.evaluate(
      (_electron, args) => globalThis.__persistenceSmoke.request(...args),
      [origin, route, method],
    );
  const remoteState = (origin, marker) =>
    application.evaluate(
      (_electron, args) => globalThis.__persistenceSmoke.remoteState(...args),
      marker === undefined ? [origin] : [origin, marker],
    );
  const report = (origin, roster) =>
    application.evaluate(
      (_electron, args) => globalThis.__persistenceSmoke.report(...args),
      [origin, roster],
    );
  const close = async () => {
    if (!application) return;
    const closing = application;
    const child = closing.process();
    await closing.evaluate(() => globalThis.__persistenceSmoke.stop());
    await closing.close();
    application = undefined;
    assert.notEqual(
      child.exitCode,
      null,
      "The old Electron process must exit before relaunch.",
    );
  };
  const launch = async () => {
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
        `--persistence-smoke-root=${root}`,
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
            Boolean(globalThis.__persistenceSmoke?.ready),
          ),
        { timeout: 20000 },
      )
      .toBe(true);
    const state = await inspect();
    assert.ok(
      !pids.includes(state.pid),
      "Every restart must create a new Electron process.",
    );
    pids.push(state.pid);
    return state;
  };
  const assertIsolated = (state) => {
    assert.ok(
      state.ownerCookies.some((cookie) => cookie.name === ownerCookieName),
    );
    assert.ok(state.ownerCookies.every((cookie) => cookie.name !== cookieName));
    assert.ok(
      state.sessions.every((item) =>
        item.cookies.every((cookie) => cookie.name !== ownerCookieName),
      ),
    );
    assert.ok(requests.every((item) => !item.cookie.includes(ownerCookieName)));
    assert.ok(ownerRequests.every((cookie) => !cookie.includes(cookieName)));
    for (const entry of requests)
      assert.ok(
        !entry.cookie.includes(`fixture-token-${1 - entry.server}-`),
        "Remote connections must not receive each other's credentials even on the same host.",
      );
  };
  try {
    await Promise.all([ownerServer, ...remoteServers].map(listen));
    remoteOrigins.push(
      ...remoteServers.map(
        (server) => `https://127.0.0.1:${server.address().port}`,
      ),
    );
    const localOrigin = `http://127.0.0.1:${ownerServer.address().port}`;
    await fs.writeFile(
      path.join(root, "fixture.json"),
      JSON.stringify({ localOrigin, remoteOrigins, fingerprints }),
    );
    let state = await launch();
    assert.equal(state.context.panels.length, 1);
    await answers([1, 1]);
    const first = (await open(remoteOrigins[0])).activeId;
    assert.equal((await request(remoteOrigins[0], "/session")).status, 401);
    assert.equal(
      (await request(remoteOrigins[0], "/login", "POST")).status,
      200,
    );
    const firstState = await remoteState(remoteOrigins[0], "first-only");
    assert.equal(
      firstState.documentCookie,
      "",
      "The signed-in cookie must remain HttpOnly.",
    );
    const firstToken = firstState.cookies.find(
      (cookie) => cookie.name === cookieName,
    ).value;
    await report(remoteOrigins[0], [
      { id: "same-world-id", name: "First world", status: "offline" },
    ]);
    const second = (await open(remoteOrigins[1])).activeId;
    assert.notEqual(first, second);
    assert.equal((await request(remoteOrigins[1], "/session")).status, 401);
    assert.equal((await remoteState(remoteOrigins[1])).marker, null);
    await request(remoteOrigins[1], "/login", "POST");
    await remoteState(remoteOrigins[1], "second-only");
    await report(remoteOrigins[1], [
      { id: "same-world-id", name: "Second world", status: "running" },
    ]);
    state = await inspect();
    assert.equal(state.prompts.length, 2);
    assertIsolated(state);
    await close();

    // Normal close preserves saved hosts, exact certificate trust, persistent
    // HttpOnly login cookies, and origin-isolated browser storage.
    state = await launch();
    assert.deepEqual(
      state.context.panels
        .filter((panel) => !panel.local)
        .map((panel) => panel.id)
        .sort(),
      [first, second].sort(),
    );
    assert.equal(state.prompts.length, 0);
    assert.equal(state.context.activeId, second);
    for (const [index, marker] of [
      [0, "first-only"],
      [1, "second-only"],
    ]) {
      await open(remoteOrigins[index]);
      assert.equal(
        (await request(remoteOrigins[index], "/session")).status,
        200,
      );
      assert.equal((await remoteState(remoteOrigins[index])).marker, marker);
    }
    assert.equal(
      (await remoteState(remoteOrigins[0])).cookies.find(
        (cookie) => cookie.name === cookieName,
      ).value,
      firstToken,
    );
    assert.equal((await inspect()).prompts.length, 0);
    await request(remoteOrigins[0], "/logout", "POST");
    await report(remoteOrigins[0], null);
    assert.equal((await request(remoteOrigins[0], "/session")).status, 401);
    assert.ok(
      (await remoteState(remoteOrigins[0])).cookies.every(
        (cookie) => cookie.name !== cookieName,
      ),
    );
    assertIsolated(await inspect());
    await close();

    // Logging out survives a full restart without disturbing the other host.
    state = await launch();
    assert.equal(state.context.panels.length, 3);
    await open(remoteOrigins[0]);
    assert.equal((await request(remoteOrigins[0], "/session")).status, 401);
    assert.equal((await request(remoteOrigins[1], "/session")).status, 200);
    assert.ok(
      (await remoteState(remoteOrigins[0])).cookies.every(
        (cookie) => cookie.name !== cookieName,
      ),
    );
    await request(remoteOrigins[0], "/login", "POST");
    await report(remoteOrigins[0], [
      { id: "same-world-id", name: "First world", status: "offline" },
    ]);
    await close();

    // A different, still self-signed certificate must never inherit trust.
    remoteServers[0].setSecureContext({
      key: certificates[1].private,
      cert: certificates[1].cert,
    });
    remoteServers[0].closeAllConnections();
    const beforeChangedCertificate = requests.filter(
      (item) => item.server === 0,
    ).length;
    state = await launch();
    assert.equal(
      state.prompts.length,
      0,
      "Restoring saved panels must not silently approve or prompt for changed certificates.",
    );
    assert.equal(
      requests.filter((item) => item.server === 0).length,
      beforeChangedCertificate,
      "A changed certificate must block requests before any cookie reaches that host.",
    );
    assert.ok(
      state.context.panels.some((panel) => panel.id === first),
      "A failed restore must retain the saved host for an explicit retry.",
    );
    assert.equal((await request(remoteOrigins[1], "/session")).status, 200);
    await answers([0]);
    await assert.rejects(open(remoteOrigins[0]));
    state = await inspect();
    assert.equal(state.prompts.length, 1);
    assert.equal(state.prompts[0].fingerprint, fingerprints[1]);
    assert.match(state.prompts[0].detail, /certificate has changed/i);
    assert.equal(
      requests.filter((item) => item.server === 0).length,
      beforeChangedCertificate,
    );
    await answers([1]);
    assert.equal((await open(remoteOrigins[0])).activeId, first);
    assert.equal((await request(remoteOrigins[0], "/session")).status, 200);
    const beforeDisconnect = await inspect();
    const oldSessionIndices = beforeDisconnect.sessions.flatMap(
      (item, index) =>
        item.cookies.some((cookie) =>
          cookie.value.startsWith("fixture-token-0-"),
        )
          ? [index]
          : [],
    );
    assert.ok(oldSessionIndices.length);
    await application.evaluate(
      (_electron, id) => globalThis.__persistenceSmoke.disconnect(id),
      first,
    );
    state = await inspect();
    assert.ok(state.context.panels.every((panel) => panel.id !== first));
    for (const index of oldSessionIndices) {
      assert.equal(state.sessions[index].destroyed, true);
      assert.deepEqual(
        state.sessions[index].cookies,
        [],
        "Disconnect must clear the old persistent session, not only remove the visible row.",
      );
    }
    assertIsolated(state);
    await close();

    // Disconnect forgets the saved host; reconnect starts fresh and asks for
    // trust again, while the untouched remote connection remains signed in.
    state = await launch();
    assert.deepEqual(
      state.context.panels
        .filter((panel) => !panel.local)
        .map((panel) => panel.id),
      [second],
    );
    assert.equal((await request(remoteOrigins[1], "/session")).status, 200);
    await answers([1]);
    const reconnected = (await open(remoteOrigins[0])).activeId;
    assert.notEqual(reconnected, first);
    assert.equal((await request(remoteOrigins[0], "/session")).status, 401);
    assert.equal((await remoteState(remoteOrigins[0])).marker, null);
    state = await inspect();
    assert.equal(state.prompts.length, 1);
    assert.equal(state.prompts[0].fingerprint, fingerprints[1]);
    assertIsolated(state);
    await close();
    console.log(
      "Passed real Electron persistence smoke: five distinct processes, saved hosts and certificate trust restored, HttpOnly sessions survive normal quit, local/remote storage stays isolated, signout survives restart, changed certificates block credentials, and disconnect forgets and clears the old session.",
    );
  } catch (cause) {
    if (stderr) console.error(stderr);
    throw cause;
  } finally {
    if (application) {
      await application
        .evaluate(() => globalThis.__persistenceSmoke?.stop())
        .catch(() => {});
      await application.close().catch(() => {});
    }
    for (const server of [ownerServer, ...remoteServers]) {
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
    }
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    const resolved = await fs.realpath(root);
    assert.equal(
      path.dirname(resolved).toLowerCase(),
      (await fs.realpath(os.tmpdir())).toLowerCase(),
    );
    assert.ok(
      path.basename(resolved).startsWith("mc-remote-persistence-smoke-"),
    );
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}

if (process.versions.electron) {
  void electronFixture().catch(async (cause) => {
    console.error(cause);
    (await import("electron")).app.exit(1);
  });
} else {
  await smoke();
}
