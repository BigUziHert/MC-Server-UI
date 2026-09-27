// Native transport coverage with two disposable HTTPS hosts and one local UI.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const project = path.dirname(path.dirname(script));
const token = (host) => host.repeat(43);

async function fixture() {
  const { app, BrowserWindow, ipcMain, session, dialog, safeStorage } =
    await import("electron");
  const { startDesktopRuntime } = await import("./runtime.mjs");
  const { createUnifiedPanelController } = await import("./unified-panels.mjs");
  const { createUnifiedConnectionStore } =
    await import("./unified-connection-store.mjs");
  const { installUnifiedConnectionIpc } = await import("./connections-ipc.mjs");
  const { configureRemoteCertificateVerification } =
    await import("./remote-frontend.mjs");
  configureRemoteCertificateVerification(app.commandLine);
  const root = app.commandLine.getSwitchValue("unified-smoke-root");
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("mc-unified-smoke-"));
  app.setPath("userData", path.join(root, "profile"));
  app.setPath("sessionData", path.join(root, "profile"));
  await app.whenReady();
  let controller;
  const runtime = await startDesktopRuntime({
    dataDir: path.join(root, "data"),
    scheduler: false,
    proxyRemotePanel: (...args) => controller.proxy(...args),
  });
  const local = session.fromPartition(`unified-local-${Date.now()}`);
  await local.cookies.set({
    url: runtime.url,
    name: "mc-panel-desktop",
    value: runtime.token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  const downloads = [];
  local.on("will-download", (_event, item) => {
    const record = { url: item.getURL(), state: "progressing" };
    downloads.push(record);
    item.setSavePath(path.join(root, "download.bin"));
    item.on("done", (_event, state) => {
      record.state = state;
    });
  });
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 780,
    webPreferences: {
      session: local,
      preload: path.join(project, "desktop/unified-connections-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  let prompts = 0;
  controller = createUnifiedPanelController({
    window,
    localOrigin: runtime.url,
    session,
    dialog: {
      showMessageBox: async () => {
        prompts++;
        return { response: 1 };
      },
    },
    store: createUnifiedConnectionStore({
      dataDir: path.join(root, "data"),
      safeStorage,
    }),
    listLocalServers: () => runtime.listLocalServerRecords(),
  });
  const remove = installUnifiedConnectionIpc(ipcMain, controller);
  await window.loadURL(runtime.url);
  await controller.restore();
  globalThis.__unifiedSmoke = {
    ready: true,
    inspect: () => ({
      snapshot: controller.list(),
      prompts,
      downloads,
      localOrigin: runtime.url,
      windows: BrowserWindow.getAllWindows().length,
      childViews: window.contentView.children.length,
      encryption: safeStorage.isEncryptionAvailable(),
    }),
    stop: async () => {
      remove();
      await controller.close();
      await runtime.close();
    },
  };
  void dialog;
}

async function smoke() {
  const { _electron: electron, expect } = await import("@playwright/test");
  const { default: selfsigned } = await import("selfsigned");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-unified-smoke-"));
  const certificate = await selfsigned.generate(
    [{ name: "commonName", value: "127.0.0.1" }],
    {
      days: 1,
      keySize: 2048,
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      ],
    },
  );
  const requests = [],
    servers = [];
  let releaseDownload;
  const downloadGate = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  const downloadBytes = Buffer.alloc(1024 * 1024, 0x41);
  for (const host of ["a", "c"]) {
    const listener = https.createServer(
      { key: certificate.private, cert: certificate.cert },
      async (req, res) => {
        const url = new URL(req.url, `https://${req.headers.host}`);
        requests.push({
          host,
          path: url.pathname,
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          serverId: req.headers["x-server-id"],
        });
        const reply = (value, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(value));
        };
        const session = {
          role: "subuser",
          accountId: host,
          email: `${host}@example.test`,
          userId: host,
          serverId: "same-id",
          permissions: ["server.view", "file.read-content", "file.create"],
          hostPermissions: [],
        };
        if (url.pathname === "/api/access/login") {
          for await (const _ of req) {
          }
          return reply({ ...session, sessionToken: token(host) });
        }
        if (url.pathname === "/api/access/session")
          return reply(
            req.headers.authorization === `Bearer ${token(host)}`
              ? session
              : { role: "guest" },
          );
        if (req.headers.authorization !== `Bearer ${token(host)}`)
          return reply({ error: "Host credential mismatch" }, 401);
        if (url.pathname === "/api/servers")
          return reply({
            servers: [
              {
                id: "same-id",
                name: `Computer ${host.toUpperCase()}`,
                status: "running",
                accessPermissions: session.permissions,
              },
            ],
            hostPermissions: [],
          });
        if (url.pathname === "/api/server")
          return reply({ host, serverId: req.headers["x-server-id"] });
        if (url.pathname === "/api/files/upload") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          return reply({
            host,
            size: body.length,
            contentType: req.headers["content-type"],
            digest: createHash("sha256").update(body).digest("hex"),
          });
        }
        if (url.pathname === "/api/files/download") {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="download.bin"',
          });
          res.write(downloadBytes.subarray(0, 65536));
          await downloadGate;
          return res.end(downloadBytes.subarray(65536));
        }
        if (url.pathname === "/api/access/logout") return reply({ ok: true });
        if (url.pathname === "/api/access/leave") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(body.confirmed, true);
          return reply({ left: true, requestId: body.requestId });
        }
        reply({ error: "Unknown fixture endpoint" }, 404);
      },
    );
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    servers.push({
      listener,
      origin: `https://127.0.0.1:${listener.address().port}`,
    });
  }
  let application;
  let stderr = "";
  const launch = async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    application = await electron.launch({
      executablePath: path.join(
        project,
        "node_modules/electron/dist/electron.exe",
      ),
      args: [
        script,
        `--unified-smoke-root=${root}`,
        `--user-data-dir=${path.join(root, "profile")}`,
      ],
      cwd: project,
      env,
      timeout: 30000,
    });
    application.process().stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    application.context().setDefaultTimeout(15000);
    await expect
      .poll(
        () =>
          application.evaluate(() => Boolean(globalThis.__unifiedSmoke?.ready)),
        { timeout: 30000 },
      )
      .toBe(true);
    return application.firstWindow();
  };
  const stop = async () => {
    if (!application) return;
    await application.evaluate(() => globalThis.__unifiedSmoke.stop());
    await application.close();
    application = null;
  };
  try {
    let page = await launch();
    assert.equal(
      await page.evaluate(() => window.mcPanelConnections.unified),
      true,
    );
    const draft = (
      await page.evaluate(
        (origin) => window.mcPanelConnections.open(origin),
        servers[0].origin,
      )
    ).panels.find((panel) => panel.origin === servers[0].origin);
    assert.equal(draft.temporary, true);
    assert.equal(
      (await page.evaluate(() => window.mcPanelConnections.list())).panels.some(
        (panel) => panel.id === draft.id,
      ),
      false,
    );
    const beforeSignIn = await fs
      .readFile(path.join(root, "data", "desktop-workspace.json"), "utf8")
      .then(JSON.parse)
      .catch((cause) => {
        if (cause.code === "ENOENT") return { panels: [] };
        throw cause;
      });
    assert.equal(
      beforeSignIn.panels.some((panel) => panel.origin === servers[0].origin),
      false,
    );
    await page.evaluate(
      (id) => window.mcPanelConnections.cancelSignIn(id),
      draft.id,
    );
    assert.equal(
      (await application.evaluate(() => globalThis.__unifiedSmoke.inspect()))
        .prompts,
      1,
    );
    for (let index = 0; index < servers.length; index++) {
      const origin = servers[index].origin;
      const opened = await page.evaluate(
        (origin) => window.mcPanelConnections.open(origin),
        origin,
      );
      const temporary = opened.panels.find((panel) => panel.origin === origin);
      await page.evaluate(
        async ({ id, email }) => {
          await window.mcPanelConnections.signIn(id, {
            email,
            password: "fixture-password",
          });
        },
        { id: temporary.id, email: `${index ? "c" : "a"}@example.test` },
      );
    }
    const snapshot = await page.evaluate(() =>
      window.mcPanelConnections.list(),
    );
    const a = snapshot.panels.find(
        (panel) => panel.origin === servers[0].origin,
      ),
      c = snapshot.panels.find((panel) => panel.origin === servers[1].origin);
    assert.equal(a.signedIn, true);
    assert.equal(c.signedIn, true);
    const proxy = (panel, endpoint) =>
      `/api/desktop/panels/${panel.id}/proxy/api${endpoint}${endpoint.includes("?") ? "&" : "?"}desktopEpoch=${panel.sessionEpoch}&serverId=same-id`;
    await page.evaluate(
      ({ id }) => window.mcPanelConnections.selectServer(id, "same-id"),
      c,
    );
    assert.deepEqual(
      await page.evaluate(
        async (url) => (await fetch(url)).json(),
        proxy(a, "/server"),
      ),
      { host: "a", serverId: "same-id" },
    );
    const uploaded = await page.evaluate(
      async (url) => {
        const body = new FormData();
        body.set("file", new Blob(["payload".repeat(150000)]), "client.txt");
        return (await fetch(url, { method: "POST", body })).json();
      },
      proxy(a, "/files/upload"),
    );
    assert.equal(uploaded.host, "a", JSON.stringify(uploaded));
    assert.ok(uploaded.size > 1024 * 1024);
    assert.match(uploaded.contentType, /^multipart\/form-data/);
    await page.evaluate(
      (url) => {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      },
      proxy(a, "/files/download?path=world"),
    );
    await expect
      .poll(() =>
        application.evaluate(
          () => globalThis.__unifiedSmoke.inspect().downloads.length,
        ),
      )
      .toBe(1);
    await page.evaluate(
      (id) => window.mcPanelConnections.selectServer(id, "same-id"),
      c.id,
    );
    await page.evaluate(() =>
      window.mcPanelConnections.selectServer("local", null),
    );
    releaseDownload();
    await expect
      .poll(() =>
        application.evaluate(
          () => globalThis.__unifiedSmoke.inspect().downloads[0].state,
        ),
      )
      .toBe("completed");
    assert.deepEqual(
      await fs.readFile(path.join(root, "download.bin")),
      downloadBytes,
    );
    let state = await application.evaluate(() =>
      globalThis.__unifiedSmoke.inspect(),
    );
    assert.equal(state.windows, 1);
    assert.equal(state.childViews, 0);
    assert.equal(new URL(page.url()).origin, state.localOrigin);
    assert.equal(state.prompts, 3);
    assert.ok(
      state.encryption,
      "Native safeStorage must encrypt persisted credentials",
    );
    assert.ok(!JSON.stringify(state.snapshot).includes(token("a")));
    assert.ok(
      requests.every(
        (request) => !request.cookie?.includes("mc-panel-desktop"),
      ),
    );
    await page.evaluate(
      (id) => window.mcPanelConnections.selectServer(id, "same-id"),
      c.id,
    );
    await stop();
    page = await launch();
    state = await application.evaluate(() =>
      globalThis.__unifiedSmoke.inspect(),
    );
    assert.equal(state.prompts, 0);
    assert.deepEqual(state.snapshot.selectedServer, {
      panelId: c.id,
      serverId: "same-id",
    });
    assert.equal(
      state.snapshot.panels.filter((panel) => !panel.local && panel.signedIn)
        .length,
      2,
    );
    const restoredA = state.snapshot.panels.find((panel) => panel.id === a.id);
    assert.notEqual(restoredA.sessionEpoch, a.sessionEpoch);
    assert.equal(
      await page.evaluate(
        async (url) => (await fetch(url)).status,
        proxy(a, "/server"),
      ),
      409,
    );
    assert.deepEqual(
      await page.evaluate(
        async (url) => (await fetch(url)).json(),
        proxy(restoredA, "/server"),
      ),
      { host: "a", serverId: "same-id" },
    );
    await page.evaluate((id) => window.mcPanelConnections.signOut(id), a.id);
    await page.evaluate(async (id) => {
      const panel = (await window.mcPanelConnections.list()).panels.find(
        (entry) => entry.id === id,
      );
      await window.mcPanelConnections.removeSavedConnection(
        id,
        panel.sessionEpoch,
      );
    }, a.id);
    assert.equal(
      (await page.evaluate(() => window.mcPanelConnections.list())).panels.some(
        (panel) => panel.id === a.id,
      ),
      false,
    );
    assert.ok(
      !requests.some(
        (request) =>
          request.host === "a" && request.path === "/api/access/leave",
      ),
      "Removing a signed-out address never deletes a host account",
    );
    assert.equal(
      (await page.evaluate(() => window.mcPanelConnections.list())).panels.find(
        (panel) => panel.id === c.id,
      ).signedIn,
      true,
    );
    await page.evaluate(
      (id) => window.mcPanelConnections.forget(id, "c"),
      c.id,
    );
    assert.equal(
      (await page.evaluate(() => window.mcPanelConnections.list())).panels.some(
        (panel) => panel.id === c.id,
      ),
      false,
    );
    assert.ok(
      requests.some(
        (request) =>
          request.host === "c" && request.path === "/api/access/leave",
      ),
    );
    assert.ok(
      !requests.some((request) => request.path.includes("power")),
      "Switching/signing out/restarting the client must not stop a remote server",
    );
    console.log(
      "Passed native unified workspace: one local renderer; A/C bearer isolation with colliding IDs; streamed multipart upload and client download surviving selection changes; encrypted session restart, trust persistence, epoch rejection, isolated sign-out and confirmed access removal.",
    );
  } catch (cause) {
    if (stderr) console.error(stderr);
    throw cause;
  } finally {
    releaseDownload();
    await stop().catch(() => {});
    for (const { listener } of servers) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    const resolved = await fs.realpath(root);
    assert.equal(
      path.dirname(resolved).toLowerCase(),
      (await fs.realpath(os.tmpdir())).toLowerCase(),
    );
    assert.ok(path.basename(resolved).startsWith("mc-unified-smoke-"));
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}

if (process.versions.electron)
  void fixture().catch(async (cause) => {
    console.error(cause);
    (await import("electron")).app.exit(1);
  });
else await smoke();
