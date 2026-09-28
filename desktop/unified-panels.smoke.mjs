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
const revocationToken = (host) => host.toUpperCase().repeat(43);

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
  const certificateControl = { pause: false, release: null };
  controller = createUnifiedPanelController({
    window,
    localOrigin: runtime.url,
    session,
    dialog: {
      showMessageBox: async () => {
        prompts++;
        if (certificateControl.pause)
          await new Promise((resolve) => {
            certificateControl.release = resolve;
          });
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
    certificateControl,
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
  const revokedAccounts = new Set();
  const invitedAccount = {
    password: null,
    invitation: "i".repeat(43),
    grants: ["same-id"],
  };
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
          permissions: [
            "server.view",
            "control.console",
            "file.read-content",
            "file.create",
          ],
          hostPermissions: [],
        };
        if (
          [
            "/api/access/login",
            "/api/access/invitation",
            "/api/access/accept",
          ].includes(url.pathname)
        ) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          if (url.pathname === "/api/access/invitation") {
            assert.equal(input.token, invitedAccount.invitation);
            return reply({
              email: "a@example.test",
              panelAddress: url.origin,
              inviteExpiresAt: new Date(Date.now() + 86400000).toISOString(),
            });
          }
          if (url.pathname === "/api/access/accept") {
            assert.equal(input.token, invitedAccount.invitation);
            assert.ok(input.password.length >= 12);
            invitedAccount.password = input.password;
            invitedAccount.invitation = null;
          } else if (
            host === "a" &&
            (!invitedAccount.password ||
              input.password !== invitedAccount.password)
          ) {
            return reply(
              { error: "Finish setting your password using the invitation." },
              401,
            );
          }
          return reply({
            ...session,
            sessionToken: token(host),
            revocationToken: revocationToken(host),
          });
        }
        if (url.pathname === "/api/access/status") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(
            req.headers.authorization,
            undefined,
            "Status checks cannot retain a signed-out authentication bearer",
          );
          assert.equal(input.token, revocationToken(host));
          return reply({ accessRevoked: revokedAccounts.has(host) });
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
          return reply({
            host,
            serverId: req.headers["x-server-id"],
            id: "same-id",
            name: `Computer ${host.toUpperCase()}`,
            status: "running",
            mode: "live",
            software: "Paper",
            version: "1.21.1",
            address: "play.example.test",
            players: [],
            maxPlayers: 20,
            uptime: 0,
            cpu: 0,
            memory: 0,
            memoryLimit: 2048,
            disk: 0,
            diskLimit: 1024 ** 3,
            port: 25565,
            memoryLimitMB: 2048,
            jar: "server.jar",
            javaPath: "java",
          });
        if (url.pathname === "/api/console") return reply({ lines: [] });
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
        if (url.pathname === "/api/access/logout")
          return reply({ ok: true, revocationToken: revocationToken(host) });
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
    assert.equal(draft.connectionState, "connecting");
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
    const invite = `${servers[0].origin}/#invite=${invitedAccount.invitation}`;
    const openInvitation = async () => {
      await page.getByRole("button", { name: /^Account menu for/ }).click();
      await page
        .getByRole("menuitem", { name: "Accept invitation", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Accept invitation",
        exact: true,
      });
      await dialog.getByLabel("Invitation link", { exact: true }).fill(invite);
      await dialog
        .getByRole("button", { name: "Continue with invitation", exact: true })
        .click();
      await expect(
        dialog.getByLabel("New password", { exact: true }),
      ).toBeVisible();
      await expect(dialog).toContainText("a@example.test");
      return dialog;
    };
    let invitation = await openInvitation();
    await invitation
      .getByLabel("New password", { exact: true })
      .fill("never-submitted-password");
    await page.keyboard.press("Escape");
    await expect(invitation).toHaveCount(0);
    assert.equal(invitedAccount.password, null);
    assert.equal(invitedAccount.invitation, "i".repeat(43));
    assert.deepEqual(invitedAccount.grants, ["same-id"]);
    assert.equal(
      requests.some((request) =>
        ["/api/access/login", "/api/access/accept"].includes(request.path),
      ),
      false,
    );
    assert.equal(
      (await page.evaluate(() => window.mcPanelConnections.list())).panels.some(
        (panel) => !panel.local,
      ),
      false,
    );
    invitation = await openInvitation();
    await expect(
      invitation.getByLabel("New password", { exact: true }),
    ).toHaveValue("");
    await invitation
      .getByLabel("New password", { exact: true })
      .fill("fixture-password");
    await invitation
      .getByLabel("Confirm password", { exact: true })
      .fill("fixture-password");
    await invitation
      .getByRole("button", { name: "Set password and continue", exact: true })
      .click();
    await expect(invitation).toHaveCount(0);
    assert.equal(invitedAccount.password, "fixture-password");
    assert.equal(invitedAccount.invitation, null);
    assert.deepEqual(invitedAccount.grants, ["same-id"]);

    await application.evaluate(() => {
      globalThis.__unifiedSmoke.certificateControl.pause = true;
    });
    await page.getByRole("button", { name: /^Account menu for/ }).click();
    await page
      .getByRole("menuitem", { name: "Manage Connections", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Manage Connections", exact: true })
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    const signIn = page.getByRole("dialog", { name: "Sign in", exact: true });
    await signIn
      .getByLabel("Panel address", { exact: true })
      .fill(servers[1].origin);
    await signIn
      .getByLabel("Email address", { exact: true })
      .fill("c@example.test");
    await signIn
      .getByLabel("Password", { exact: true })
      .fill("fixture-password");
    assert.equal(
      requests.some((request) => request.host === "c"),
      false,
    );
    await signIn.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect
      .poll(() =>
        application.evaluate(() =>
          Boolean(globalThis.__unifiedSmoke.certificateControl.release),
        ),
      )
      .toBe(true);
    assert.equal(
      requests.some(
        (request) =>
          request.host === "c" && request.path === "/api/access/login",
      ),
      false,
    );
    await application.evaluate(() => {
      globalThis.__unifiedSmoke.certificateControl.release();
    });
    await expect(signIn).toHaveCount(0);
    const snapshot = await page.evaluate(() =>
      window.mcPanelConnections.list(),
    );
    const a = snapshot.panels.find(
        (panel) => panel.origin === servers[0].origin,
      ),
      c = snapshot.panels.find((panel) => panel.origin === servers[1].origin);
    assert.equal(a.signedIn, true);
    assert.equal(c.signedIn, true);

    // Wide displays must use the available width and height for either host.
    // Keep a user's native zoom choice while switching; connection type does
    // not set display density. This fixture uses only temporary smoke data.
    const localServerId = await page.evaluate(async () => {
      const response = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Local geometry fixture", port: 25567 }),
      });
      if (!response.ok) throw new Error("Geometry fixture creation failed.");
      const id = (await response.json()).server.id;
      // API fixture creation bypasses the UI's usual roster refresh.
      window.dispatchEvent(new Event("focus"));
      return id;
    });
    const previousViewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    const previousZoom = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    );
    const measureWorkspace = async (panelId, serverId, name, zoom) => {
      await page.evaluate(
        ({ panelId, serverId }) =>
          window.mcPanelConnections.selectServer(panelId, serverId),
        { panelId, serverId },
      );
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await expect(
        page.getByRole("log", { name: "Server console output" }),
      ).toBeVisible();
      const geometry = await page.evaluate(async () => {
        await document.fonts.ready;
        const shell = document.querySelector(".main-shell");
        const content = document.querySelector(".main-content");
        const sidebar = document.querySelector(".sidebar");
        const output = document.querySelector(".console-output");
        const command = document.querySelector(".command-form");
        const footer = document.querySelector(".main-content > .footer");
        const shellBounds = shell.getBoundingClientRect();
        const contentBounds = content.getBoundingClientRect();
        const outputBounds = output.getBoundingClientRect();
        const commandBounds = command.getBoundingClientRect();
        const footerBounds = footer.getBoundingClientRect();
        return {
          viewport: innerWidth,
          viewportHeight: innerHeight,
          documentWidth: document.documentElement.clientWidth,
          documentHeight: document.documentElement.scrollHeight,
          shellLeft: shellBounds.left,
          shellRight: shellBounds.right,
          contentLeft: contentBounds.left,
          contentRight: contentBounds.right,
          contentWidth: contentBounds.width,
          contentBottom: contentBounds.bottom,
          contentBottomPadding: parseFloat(
            getComputedStyle(content).paddingBottom,
          ),
          consoleTop: outputBounds.top,
          consoleBottom: outputBounds.bottom,
          consoleHeight: outputBounds.height,
          commandBottom: commandBounds.bottom,
          footerTop: footerBounds.top,
          footerBottom: footerBounds.bottom,
          sidebarWidth: sidebar.getBoundingClientRect().width,
          fontSize: getComputedStyle(document.documentElement).fontSize,
        };
      });
      assert.ok(geometry.viewport > 2012, "Exercise the former page width cap");
      assert.ok(
        geometry.contentWidth > 1780,
        "Wide pages must not stay capped",
      );
      assert.ok(Math.abs(geometry.contentLeft - geometry.shellLeft) < 1);
      assert.ok(Math.abs(geometry.contentRight - geometry.shellRight) < 1);
      assert.ok(Math.abs(geometry.contentRight - geometry.documentWidth) < 1);
      assert.ok(
        Math.abs(geometry.contentBottom - geometry.viewportHeight) < 1,
        `${name}: the console page fills the viewport height`,
      );
      assert.ok(
        geometry.documentHeight <= geometry.viewportHeight + 1,
        `${name}: the console and footer fit without page scrolling`,
      );
      assert.ok(
        Math.abs(
          geometry.viewportHeight -
            geometry.footerBottom -
            geometry.contentBottomPadding,
        ) < 1,
        `${name}: the footer stays at the bottom padding`,
      );
      assert.ok(
        geometry.consoleHeight >= 200 &&
          geometry.consoleBottom < geometry.commandBottom &&
          geometry.commandBottom < geometry.footerTop,
        `${name}: the console remains usable with its command input above the footer`,
      );
      assert.equal(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
        ),
        zoom,
        "Switching panels must retain the chosen desktop zoom",
      );
      return {
        viewport: geometry.viewport,
        viewportHeight: geometry.viewportHeight,
        contentLeft: geometry.contentLeft,
        rightInset: geometry.documentWidth - geometry.contentRight,
        contentBottom: geometry.contentBottom,
        consoleTop: geometry.consoleTop,
        consoleBottom: geometry.consoleBottom,
        consoleHeight: geometry.consoleHeight,
        commandBottom: geometry.commandBottom,
        footerTop: geometry.footerTop,
        footerBottom: geometry.footerBottom,
        sidebarWidth: geometry.sidebarWidth,
        fontSize: geometry.fontSize,
      };
    };
    const geometryChecks = [];
    for (const zoom of [1, 1.25]) {
      await application.evaluate(({ BrowserWindow }, factor) => {
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor);
      }, zoom);
      let shorterGeometry;
      for (const height of [1080, 1392]) {
        // The test-only override exercises large viewports even on small CI
        // displays. Production never sets the selected native zoom factor.
        await page.setViewportSize({ width: 2560, height });
        const localGeometry = await measureWorkspace(
          "local",
          localServerId,
          "Local geometry fixture",
          zoom,
        );
        assert.deepEqual(
          await measureWorkspace(a.id, "same-id", "Computer A", zoom),
          localGeometry,
          `Local and remote console geometry matches at ${zoom * 100}% zoom, ${height}px high`,
        );
        assert.deepEqual(
          await measureWorkspace(c.id, "same-id", "Computer C", zoom),
          localGeometry,
          `A second remote panel retains geometry at ${zoom * 100}% zoom, ${height}px high`,
        );
        if (shorterGeometry) {
          assert.ok(
            Math.abs(
              localGeometry.consoleHeight -
                shorterGeometry.consoleHeight -
                (localGeometry.viewportHeight - shorterGeometry.viewportHeight),
            ) < 1,
            "The console uses the extra height when the same-width window grows",
          );
        }
        shorterGeometry = localGeometry;
        geometryChecks.push({ zoom, ...localGeometry });
      }
    }
    console.log("Native local/two-remote viewport geometry:", geometryChecks);
    await application.evaluate(({ BrowserWindow }, zoom) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom);
    }, previousZoom);
    await page.setViewportSize(previousViewport);
    await page.evaluate(async (id) => {
      const response = await fetch(`/api/servers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Geometry fixture removal failed.");
      window.dispatchEvent(new Event("focus"));
    }, localServerId);
    await expect(
      page.getByRole("button", {
        name: "Select server Local geometry fixture on This computer",
        exact: true,
      }),
    ).toHaveCount(0, { timeout: 15000 });

    const proxy = (panel, endpoint) =>
      `/api/desktop/panels/${panel.id}/proxy/api${endpoint}${endpoint.includes("?") ? "&" : "?"}desktopEpoch=${panel.sessionEpoch}&serverId=same-id`;
    await page.evaluate(
      ({ id }) => window.mcPanelConnections.selectServer(id, "same-id"),
      c,
    );
    assert.deepEqual(
      await page.evaluate(
        async (url) => {
          const { host, serverId } = await (await fetch(url)).json();
          return { host, serverId };
        },
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
    assert.equal(state.prompts, 4);
    assert.ok(
      state.encryption,
      "Native safeStorage must encrypt persisted credentials",
    );
    assert.ok(!JSON.stringify(state.snapshot).includes(token("a")));
    assert.ok(!JSON.stringify(state.snapshot).includes(revocationToken("a")));
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
        async (url) => {
          const { host, serverId } = await (await fetch(url)).json();
          return { host, serverId };
        },
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
    // Reconnect the account that still exists on A, then exercise deletion
    // discovered while signed out. Only a non-authenticating status proof is
    // retained, and the separate C connection stays fully usable throughout.
    await page.getByRole("button", { name: /^Account menu for/ }).click();
    await page
      .getByRole("menuitem", { name: "Manage Connections", exact: true })
      .click();
    let manager = page.getByRole("dialog", {
      name: "Manage Connections",
      exact: true,
    });
    await manager.getByRole("button", { name: "Sign in", exact: true }).click();
    const reconnect = page.getByRole("dialog", {
      name: "Sign in",
      exact: true,
    });
    await reconnect
      .getByLabel("Panel address", { exact: true })
      .fill(servers[0].origin);
    await reconnect
      .getByLabel("Email address", { exact: true })
      .fill("a@example.test");
    await reconnect
      .getByLabel("Password", { exact: true })
      .fill("fixture-password");
    await reconnect
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(reconnect).toHaveCount(0);
    const reconnectedA = (
      await page.evaluate(() => window.mcPanelConnections.list())
    ).panels.find((panel) => panel.origin === servers[0].origin);
    await page.getByRole("button", { name: /^Account menu for/ }).click();
    await page
      .getByRole("menuitem", { name: "Manage Connections", exact: true })
      .click();
    manager = page.getByRole("dialog", {
      name: "Manage Connections",
      exact: true,
    });
    const labelA = new URL(servers[0].origin).host;
    await manager
      .getByRole("button", { name: `Sign out of ${labelA}`, exact: true })
      .click();
    await manager
      .getByRole("button", { name: "Sign out of this panel", exact: true })
      .click();
    await expect(
      manager.getByRole("button", {
        name: `Sign in to ${labelA}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.evaluate(
      (id) => window.mcPanelConnections.retry(id),
      reconnectedA.id,
    );
    assert.equal(
      (await page.evaluate(() => window.mcPanelConnections.list())).panels.find(
        (panel) => panel.id === reconnectedA.id,
      ).signedIn,
      false,
    );
    await manager
      .getByRole("button", { name: "Close panel connections", exact: true })
      .click();
    await expect(
      page.getByRole("list", { name: `Servers on ${labelA}`, exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(labelA, { exact: true })).toHaveCount(0);
    assert.ok(
      requests.some(
        (request) =>
          request.host === "a" && request.path === "/api/access/status",
      ),
    );
    await page.getByRole("button", { name: /^Account menu for/ }).click();
    await page
      .getByRole("menuitem", { name: "Manage Connections", exact: true })
      .click();
    await expect(
      manager.getByRole("button", {
        name: `Sign in to ${labelA}`,
        exact: true,
      }),
    ).toBeVisible();
    revokedAccounts.add("a");
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() => window.mcPanelConnections.list())
          ).panels.some((panel) => panel.id === reconnectedA.id),
        { timeout: 15000 },
      )
      .toBe(false);
    await expect(
      manager.getByRole("button", {
        name: `Sign in to ${labelA}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      manager.getByRole("button", {
        name: `Sign out of ${new URL(servers[1].origin).host}`,
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(
      (await page.evaluate(() => window.mcPanelConnections.list())).panels.find(
        (panel) => panel.id === c.id,
      ).signedIn,
      true,
    );
    await manager
      .getByRole("button", { name: "Close panel connections", exact: true })
      .click();
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
      "Passed native unified workspace: invitation cancellation/reopening preserves pending password setup and grants; one-form sign-in waits for certificate confirmation; local/A/C workspace geometry fills wide displays while preserving native zoom; A/C bearer isolation with colliding IDs; streamed multipart upload and client download surviving selection changes; encrypted session restart, trust persistence, epoch rejection; signed-out panels stay only in Manage Connections and non-authenticating status proof removes confirmed revoked accounts without affecting other panels.",
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
