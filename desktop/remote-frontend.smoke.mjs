// Run after pnpm build: node desktop/remote-frontend.smoke.mjs
// Real Electron, a stale loopback HTTPS host, and isolated disposable app data.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const project = path.dirname(path.dirname(script));
const server = {
  id: "remote-world",
  name: "Remote survival",
  mode: "live",
  status: "running",
  software: "Paper",
  version: "1.21.1",
  minecraftVersion: "1.21.1",
  players: [],
  maxPlayers: 20,
  memory: 128,
  memoryLimit: 2048,
  cpu: 1,
  cpuCapacity: 800,
  disk: 1024,
  diskLimit: 1024 ** 3,
  uptime: 60,
  address: "localhost:25565",
  accessPermissions: ["control.console", "audit.read"],
};
const user = {
  role: "subuser",
  email: "fixture@example.test",
  userId: "fixture",
  serverId: server.id,
  permissions: server.accessPermissions,
};

async function fixture() {
  const { app, BrowserWindow, WebContentsView, ipcMain, session } =
    await import("electron");
  const { default: selfsigned } = await import("selfsigned");
  const { startDesktopRuntime, DESKTOP_COOKIE_NAME } =
    await import("./runtime.mjs");
  const { createRemotePanelController } = await import("./remote-panels.mjs");
  const { installConnectionIpc } = await import("./connections-ipc.mjs");
  const { createUpdatesOverlay } = await import("./updates-overlay.mjs");
  const { createRemoteFrontend, configureRemoteCertificateVerification } =
    await import("./remote-frontend.mjs");
  configureRemoteCertificateVerification(app.commandLine);
  const root = app.commandLine.getSwitchValue("frontend-smoke-root");
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("mc-frontend-smoke-"));
  app.setPath("userData", path.join(root, "profile"));
  await app.whenReady();
  const cert = await selfsigned.generate(
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
  const fingerprint = new X509Certificate(cert.cert).fingerprint256;
  const requests = [];
  let lines = [
    { id: 1, time: "12:00:00", level: "info", message: "Remote server ready" },
    { id: 2, time: "12:00:01", level: "warn", message: "Remote warning" },
    { id: 3, time: "12:00:02", level: "error", message: "Remote error" },
  ];
  const host = https.createServer(
    { key: cert.private, cert: cert.cert },
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      requests.push({
        path: req.url,
        method: req.method,
        cookie: req.headers.cookie || "",
        origin: req.headers.origin,
        serverId: req.headers["x-server-id"],
        body,
      });
      const json = (data, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/api/access/login") {
        assert.deepEqual(JSON.parse(body), {
          email: user.email,
          password: "fixture-password",
        });
        res.setHeader(
          "Set-Cookie",
          "frontend-fixture=authenticated; Secure; HttpOnly; SameSite=Strict; Path=/",
        );
        return json(user);
      }
      const authenticated = req.headers.cookie?.includes(
        "frontend-fixture=authenticated",
      );
      if (req.url === "/api/access/session")
        return json(authenticated ? user : { role: "guest" });
      if (req.url.startsWith("/api/")) {
        if (!authenticated) return json({ error: "Sign in first." }, 401);
        if (req.url === "/api/servers")
          return json({ servers: [server], defaultServerId: server.id });
        if (req.url === "/api/server") return json(server);
        if (req.url === "/api/console") return json({ lines });
        if (req.url.startsWith("/api/audit"))
          return json({ entries: [], total: 0 });
        return json({ error: "Owner-only or unavailable fixture route." }, 403);
      }
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      res.end(
        "<!doctype html><h1>Old remote interface without console filters</h1><script>window.oldRemoteCodeExecuted=true</script>",
      );
    },
  );
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${host.address().port}`;
  const updaterCalls = [];
  const updateState = {
    desktop: true,
    supported: true,
    version: "0.0.0-dev.smoke",
    channel: "dev",
    status: "idle",
    message: "Ready to check this computer for updates.",
  };
  const runtime = await startDesktopRuntime({
    dataDir: path.join(root, "data"),
    scheduler: false,
    updates: {
      snapshot: () => updateState,
      check: async () => {
        updaterCalls.push("check");
        updateState.status = "current";
        updateState.message = "This computer is up to date.";
        return updateState;
      },
    },
  });
  const ownerSession = session.fromPartition("frontend-smoke-owner");
  await ownerSession.cookies.set({
    url: runtime.url,
    name: DESKTOP_COOKIE_NAME,
    value: runtime.token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  const preload = path.join(project, "desktop", "connections-preload.cjs");
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: {
      session: ownerSession,
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const remoteContents = [];
  const downloads = [];
  class TrackedView {
    constructor(options) {
      const view = new WebContentsView(options);
      remoteContents.push(view.webContents);
      options.webPreferences.session.on("will-download", (_event, item) => {
        item.setSavePath(path.join(root, path.basename(item.getFilename())));
        item.once("done", (_event, state) =>
          downloads.push({ name: item.getFilename(), state }),
        );
      });
      return view;
    }
  }
  const prompts = [];
  const answers = [0, 1];
  const updatesOverlay = createUpdatesOverlay({
    WebContentsView,
    ipcMain,
    parent: window,
    origin: runtime.url,
    session: ownerSession,
    preload: path.join(project, "desktop", "updates-preload.cjs"),
  });
  const controller = createRemotePanelController({
    window,
    localOrigin: runtime.url,
    WebContentsView: TrackedView,
    session,
    preload,
    openUpdatesOverlay: (contents) => updatesOverlay.open(contents),
    dismissUpdatesOverlay: () => updatesOverlay.dismiss(),
    remoteFrontend: await createRemoteFrontend({
      directory: path.join(project, "dist"),
    }),
    downloadsDirectory: root,
    dialog: {
      async showMessageBox(parent, options) {
        assert.equal(parent, window);
        assert.ok(options.detail.includes(fingerprint));
        assert.ok(answers.length, "Unexpected certificate confirmation");
        const response = answers.shift();
        prompts.push(response);
        return { response };
      },
    },
  });
  const removeIpc = installConnectionIpc(ipcMain, controller);
  await window.loadURL(runtime.url);
  globalThis.__frontendSmoke = {
    ready: true,
    origin,
    async open() {
      try {
        return { value: await controller.open(origin) };
      } catch (error) {
        return { status: error.status };
      }
    },
    append() {
      lines.push({
        id: 4,
        time: "12:00:03",
        level: "info",
        message: "New remote output",
      });
    },
    async inspect() {
      return {
        prompts,
        requests,
        downloads,
        updaterCalls,
        localServers: runtime.listLocalServers(),
        nativeWindows: BrowserWindow.getAllWindows().length,
        childViews: window.contentView.children.length,
        context: controller.list(),
        cookies: remoteContents.at(-1).isDestroyed()
          ? []
          : await remoteContents.at(-1).session.cookies.get({}),
      };
    },
    async stop() {
      removeIpc();
      updatesOverlay.close();
      await controller.close();
      await runtime.close();
      host.closeAllConnections();
      await new Promise((resolve) => host.close(resolve));
      window.destroy();
    },
  };
}

async function smoke() {
  const { _electron: electron, expect } = await import("@playwright/test");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-frontend-smoke-"));
  let application;
  let stderr = "";
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    application = await electron.launch({
      executablePath: path.join(
        project,
        "node_modules",
        "electron",
        "dist",
        "electron.exe",
      ),
      args: [
        script,
        `--user-data-dir=${path.join(root, "profile")}`,
        `--frontend-smoke-root=${root}`,
      ],
      cwd: project,
      env,
      timeout: 30000,
    });
    application.process().stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await expect
      .poll(
        () =>
          application.evaluate(() =>
            Boolean(globalThis.__frontendSmoke?.ready),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    const local = await application.firstWindow();
    await expect(
      local.getByRole("heading", { name: "Welcome to MC Panel" }),
    ).toBeVisible();
    const localScript = await local
      .locator('script[type="module"]')
      .getAttribute("src");
    assert.equal(
      (await application.evaluate(() => globalThis.__frontendSmoke.open()))
        .status,
      409,
    );
    let state = await application.evaluate(() =>
      globalThis.__frontendSmoke.inspect(),
    );
    assert.equal(
      state.requests.length,
      0,
      "Canceled TLS trust must send no requests",
    );
    await application.evaluate(() => globalThis.__frontendSmoke.open());
    const origin = await application.evaluate(
      () => globalThis.__frontendSmoke.origin,
    );
    await expect
      .poll(() =>
        application
          .windows()
          .find((page) => page.url().startsWith(origin))
          ?.url(),
      )
      .toContain(origin);
    const remote = application
      .windows()
      .find((page) => page.url().startsWith(origin));
    await expect(
      remote.getByRole("heading", { name: "Welcome to your server" }),
    ).toBeVisible();
    assert.equal(
      await remote.locator('script[type="module"]').getAttribute("src"),
      localScript,
      "Local and remote must use the same installed bundle",
    );
    assert.equal(
      await remote.evaluate(() => window.oldRemoteCodeExecuted),
      undefined,
    );
    await remote.getByLabel("Email address", { exact: true }).fill(user.email);
    await remote
      .getByLabel("Password", { exact: true })
      .fill("fixture-password");
    await remote.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      remote.getByRole("heading", { name: server.name, exact: true }),
    ).toBeVisible();
    const output = remote.getByRole("log");
    await expect(output.locator(".log-message")).toHaveCount(3);
    await remote.getByRole("button", { name: "Filter console levels" }).click();
    const levels = remote.getByRole("group", { name: "Console log level" });
    await levels.getByRole("button", { name: "ERROR", exact: true }).click();
    await expect(output.locator(".log-message")).toHaveText(["Remote error"]);
    await remote.getByRole("button", { name: "Clear console view" }).click();
    await levels.getByRole("button", { name: "All logs", exact: true }).click();
    await expect(output.locator(".log-message")).toHaveCount(0);
    await application.evaluate(() => globalThis.__frontendSmoke.append());
    await expect(output.locator(".log-message")).toHaveText([
      "New remote output",
    ]);
    await remote.getByRole("button", { name: "Download console logs" }).click();
    await expect
      .poll(
        async () =>
          (
            await application.evaluate(() =>
              globalThis.__frontendSmoke.inspect(),
            )
          ).downloads,
      )
      .toEqual([{ name: "server-console.log", state: "completed" }]);
    assert.match(
      await fs.readFile(path.join(root, "server-console.log"), "utf8"),
      /Remote error/,
    );
    state = await application.evaluate(() =>
      globalThis.__frontendSmoke.inspect(),
    );
    const remoteId = state.context.activeId;
    const remoteUrl = remote.url();
    assert.deepEqual(
      state.localServers,
      [],
      "The gaming PC has no local servers",
    );
    await remote
      .getByRole("button", { name: "App updates", exact: true })
      .click();
    await expect
      .poll(
        () =>
          application
            .windows()
            .filter((page) => page.url().includes("?app-updates=1")).length,
      )
      .toBe(1);
    const updater = application
      .windows()
      .find((page) => page.url().includes("?app-updates=1"));
    await expect(
      updater.getByRole("dialog", { name: "App updates" }),
    ).toBeVisible();
    await expect(
      updater.getByText("0.0.0-dev.smoke", { exact: true }),
    ).toBeVisible();
    assert.equal(
      await updater.evaluate(() => window.mcPanelConnections),
      undefined,
    );
    assert.deepEqual(
      await updater.evaluate(() => Object.keys(window.mcPanelUpdates)),
      ["close"],
    );
    await expect
      .poll(() =>
        updater.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        ),
      )
      .toBe("rgba(0, 0, 0, 0)");
    await expect
      .poll(() =>
        remote.evaluate(
          () => getComputedStyle(document.documentElement).filter,
        ),
      )
      .toBe("blur(3px)");
    state = await application.evaluate(() =>
      globalThis.__frontendSmoke.inspect(),
    );
    assert.equal(
      state.context.activeId,
      remoteId,
      "Updates must not switch to local Welcome",
    );
    assert.equal(remote.url(), remoteUrl);
    assert.equal(
      state.nativeWindows,
      1,
      "Updates must stay inside the existing native window",
    );
    assert.equal(
      state.childViews,
      2,
      "A transparent local overlay sits above the remote view",
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1100, 780),
    );
    await expect
      .poll(() =>
        updater.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      )
      .toEqual({ width: 1100, height: 780 });
    const modalBounds = await updater
      .getByRole("dialog", { name: "App updates" })
      .boundingBox();
    assert.ok(Math.abs(modalBounds.x + modalBounds.width / 2 - 550) < 2);
    assert.ok(Math.abs(modalBounds.y + modalBounds.height / 2 - 390) < 2);
    await expect(
      local.getByRole("dialog", { name: "App updates" }),
    ).toHaveCount(0);
    await updater
      .getByRole("button", { name: "Check for updates", exact: true })
      .click();
    await expect(updater.getByRole("status")).toHaveText(
      "This computer is up to date.",
    );
    const screenshotDirectory = path.join(project, "release", "review-updates");
    await fs.mkdir(screenshotDirectory, { recursive: true });
    const composed = await application.evaluate(async ({ webContents }) =>
      (
        await webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes("?app-updates=1"))
          .capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
      )
        .toPNG()
        .toString("base64"),
    );
    await fs.writeFile(
      path.join(screenshotDirectory, "updates-overlay.png"),
      Buffer.from(composed, "base64"),
    );
    await updater
      .getByRole("button", { name: "Close app updates", exact: true })
      .click();
    await expect.poll(() => updater.isClosed()).toBe(true);
    state = await application.evaluate(() =>
      globalThis.__frontendSmoke.inspect(),
    );
    assert.equal(state.context.activeId, remoteId);
    assert.equal(state.nativeWindows, 1);
    assert.equal(state.childViews, 1);
    await expect
      .poll(() =>
        remote.evaluate(
          () => getComputedStyle(document.documentElement).filter,
        ),
      )
      .toBe("none");
    await remote.getByRole("button", { name: "Filter console levels" }).click();
    await expect(levels).toBeHidden();
    await remote.getByRole("button", { name: "Filter console levels" }).click();
    await expect(levels).toBeVisible();
    assert.deepEqual(state.updaterCalls, ["check"]);
    assert.ok(
      state.requests.every(
        (request) => !request.path.startsWith("/api/desktop/updates"),
      ),
    );
    await expect(output.locator(".log-message")).toHaveText([
      "New remote output",
    ]);
    await remote
      .getByRole("button", { name: "App updates", exact: true })
      .click();
    await expect
      .poll(
        () =>
          application
            .windows()
            .filter((page) => page.url().includes("?app-updates=1")).length,
      )
      .toBe(1);
    const reopenedUpdates = application
      .windows()
      .find((page) => page.url().includes("?app-updates=1"));
    await expect(
      reopenedUpdates.getByRole("dialog", { name: "App updates" }),
    ).toBeVisible();
    await reopenedUpdates.keyboard.press("Escape").catch((cause) => {
      // Escape destroys this WebContentsView before Chromium can acknowledge
      // key-up; only that expected close may interrupt the input command.
      if (!reopenedUpdates.isClosed()) throw cause;
    });
    await expect.poll(() => reopenedUpdates.isClosed()).toBe(true);
    assert.equal(
      (await application.evaluate(() => globalThis.__frontendSmoke.inspect()))
        .context.activeId,
      remoteId,
    );
    await remote.reload();
    await expect(
      remote.getByRole("heading", { name: server.name, exact: true }),
    ).toBeVisible();
    await expect(
      remote.getByRole("button", { name: "Clear console view" }),
    ).toBeVisible();
    state = await application.evaluate(() =>
      globalThis.__frontendSmoke.inspect(),
    );
    assert.deepEqual(state.prompts, [0, 1]);
    assert.ok(
      state.requests.every(
        (request) => !request.cookie.includes("mc-panel-desktop"),
      ),
      "Local owner credentials must never reach the remote host",
    );
    assert.ok(
      state.requests
        .filter((request) => request.path === "/api/console")
        .every(
          (request) =>
            request.serverId === server.id &&
            request.cookie.includes("frontend-fixture=authenticated"),
        ),
    );
    assert.equal(
      state.requests.find((request) => request.path === "/api/access/login")
        .origin,
      origin,
    );
    assert.ok(
      state.requests.every((request) => !request.path.startsWith("/assets/")),
      "Stale remote JavaScript and CSS must not load",
    );
    console.log(
      "Passed native frontend consistency: stale remote shell replaced by installed UI; certificate consent, remote sign-in/cookies, console filter/clear/export, Updates, switching and reload.",
    );
  } catch (error) {
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    if (application) {
      await application
        .evaluate(() => globalThis.__frontendSmoke?.stop())
        .catch(() => {});
      await application.close().catch(() => {});
    }
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    const resolved = await fs.realpath(root);
    assert.equal(
      path.dirname(resolved).toLowerCase(),
      (await fs.realpath(os.tmpdir())).toLowerCase(),
    );
    assert.ok(path.basename(resolved).startsWith("mc-frontend-smoke-"));
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  }
}

if (process.versions.electron)
  void fixture().catch(async (error) => {
    console.error(error);
    (await import("electron")).app.exit(1);
  });
else await smoke();
