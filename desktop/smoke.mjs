import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

// Run against the built application, never the development server or a user's profile.
// node desktop/smoke.mjs [--executable=C:/path/MC Panel.exe] [--keep-data]
const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const argument = (name) =>
  process.argv
    .slice(2)
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const executablePath = path.resolve(
  argument("--executable") ??
    path.join(projectDir, "release", "win-unpacked", "MC Panel.exe"),
);
const outputDirectory = path.resolve(
  argument("--output") ?? path.join(projectDir, "release", "smoke-results"),
);
const keepData = process.argv.includes("--keep-data");
const ui = expect.configure({ timeout: 15_000 });
const uploadBytes = Buffer.from([0, 1, 10, 13, 63, 127, 128, 200, 254, 255]);
const textContents =
  "Created by the packaged desktop smoke test.\nPersistence must survive a complete app restart.\n";
const imageFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="#71543b" d="M0 0h64v64H0z"/><path fill="#c49372" d="M8 24h48v32H8z"/><path fill="#2d5678" d="M8 24h16v8H8zm32 0h16v8H40z"/></svg>';
let application;
let profileDirectory;
let temporaryRoot;
let currentOrigin;
let downloadDirectory;
let failed = false;

function step(message) {
  console.log(`[desktop smoke] ${message}`);
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function browserApi(
  page,
  endpoint,
  { method = "GET", body, serverId } = {},
) {
  return page.evaluate(
    async ({ endpoint, method, body, serverId }) => {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (serverId) headers["X-Server-Id"] = serverId;
      const response = await fetch(`/api${endpoint}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    },
    { endpoint, method, body, serverId },
  );
}

async function assertPrivateApi(origin) {
  const response = await fetch(`${origin}/api/servers`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(
    [401, 403].includes(response.status),
    `Unauthenticated requests must be rejected, received ${response.status}.`,
  );
}

async function installDownloadCapture(app, destination) {
  await app.evaluate(({ BrowserWindow }, destination) => {
    globalThis.__panelSmokeDownloads = [];
    const windowSession = BrowserWindow.getAllWindows()[0].webContents.session;
    windowSession.on("will-download", (_event, item) => {
      const filename = item.getFilename();
      item.setSavePath(`${destination}/${filename}`);
      const record = { filename, state: "started", path: item.getSavePath() };
      globalThis.__panelSmokeDownloads.push(record);
      item.on("updated", (_updateEvent, state) => {
        record.state = state;
      });
      item.once("done", (_doneEvent, state) => {
        record.state = state;
      });
    });
  }, destination);
}

async function expectDownload(filename) {
  await ui
    .poll(
      () =>
        application.evaluate(
          (_electron, filename) =>
            globalThis.__panelSmokeDownloads.find(
              (item) => item.filename === filename,
            )?.state ?? "pending",
          filename,
        ),
      { message: `The packaged app must finish downloading ${filename}.` },
    )
    .toBe("completed");
  return fs.readFile(path.join(downloadDirectory, filename));
}

async function launchPackaged() {
  const launchEnvironment = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
  delete launchEnvironment.ELECTRON_RUN_AS_NODE;
  delete launchEnvironment.NODE_OPTIONS;
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profileDirectory}`, "--smoke-test"],
    cwd: path.dirname(executablePath),
    timeout: 45_000,
    env: launchEnvironment,
  });
  const page = await application.firstWindow({ timeout: 30_000 });
  await page.route("https://mc-heads.net/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: imageFixture }),
  );
  await ui(
    page.getByRole("heading", { level: 1, name: "Console", exact: true }),
  ).toBeVisible();
  await ui(page).toHaveTitle(/MC\s*Panel/i);
  const url = new URL(page.url());
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(
    Number(url.port) > 0,
    "The packaged runtime must bind an ephemeral local port.",
  );
  assert.ok(
    !["3001", "5173"].includes(url.port),
    "The app must not depend on development-server ports.",
  );
  assert.equal(
    url.search,
    "",
    "Authentication secrets must not appear in the page URL.",
  );
  currentOrigin = url.origin;

  const mainState = await application.evaluate(
    async ({ app, BrowserWindow }, origin) => {
      const window = BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().startsWith(origin),
      );
      const preferences = window.webContents.getLastWebPreferences();
      const cookies = await window.webContents.session.cookies.get({
        url: origin,
      });
      return {
        packaged: app.isPackaged,
        userData: app.getPath("userData"),
        visible: window.isVisible(),
        preferences: {
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          webSecurity: preferences.webSecurity,
        },
        cookies: cookies.map(({ name, httpOnly, sameSite }) => ({
          name,
          httpOnly,
          sameSite,
        })),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
      };
    },
    currentOrigin,
  );
  assert.equal(
    mainState.packaged,
    true,
    "This script must test the packaged executable, not Electron development mode.",
  );
  assert.equal(
    path.resolve(mainState.userData).toLowerCase(),
    profileDirectory.toLowerCase(),
  );
  assert.equal(
    mainState.visible,
    false,
    "--smoke-test must avoid opening a visible application window.",
  );
  assert.deepEqual(mainState.preferences, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
  });
  assert.ok(
    mainState.cookies.some(
      (cookie) =>
        cookie.name === "mc-panel-desktop" &&
        cookie.httpOnly &&
        cookie.sameSite === "strict",
    ),
    "The private desktop cookie must be HttpOnly and SameSite=Strict.",
  );
  const rendererState = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    cookies: document.cookie,
  }));
  assert.equal(rendererState.require, "undefined");
  assert.equal(rendererState.process, "undefined");
  assert.ok(
    !rendererState.cookies.includes("mc-panel-desktop"),
    "Renderer JavaScript must not read the desktop credential.",
  );
  await assertPrivateApi(currentOrigin);
  const servers = await browserApi(page, "/servers");
  assert.equal(
    servers.status,
    200,
    "The window must authenticate its own API requests.",
  );
  assert.ok(servers.data.servers.length > 0);
  assert.equal(
    servers.data.servers[0].mode,
    "demo",
    "A smoke profile must not start a live Java server.",
  );
  await installDownloadCapture(application, downloadDirectory);
  step(
    `Packaged Electron ${mainState.electronVersion}, Node ${mainState.nodeVersion}; private local runtime ready.`,
  );
  return { page, serverId: servers.data.defaultServerId };
}

async function quitPackaged(mode = "quit") {
  if (!application) return;
  const app = application;
  const child = app.process();
  const exit =
    child.exitCode === null
      ? once(child, "exit")
      : Promise.resolve([child.exitCode]);
  await app
    .evaluate(({ app, BrowserWindow }, mode) => {
      if (mode === "query-session-end") {
        const window = BrowserWindow.getAllWindows()[0];
        // Exercise the app's logout handler without asking Windows to log off.
        if (!window.emit("query-session-end", { preventDefault() {} }))
          throw new Error(
            "The packaged window has no Windows session-ending handler.",
          );
      } else {
        app.quit();
      }
    }, mode)
    .catch((error) => {
      if (
        child.exitCode === null &&
        !/closed|Target.*gone/i.test(error.message)
      )
        throw error;
    });
  const [exitCode, signal] = await bounded(
    exit,
    25_000,
    "The packaged app did not finish graceful shutdown.",
  );
  assert.equal(
    exitCode,
    0,
    `The packaged app exited abnormally (${signal ?? exitCode}).`,
  );
  await ui
    .poll(
      async () => {
        try {
          await fetch(`${currentOrigin}/api/servers`, {
            signal: AbortSignal.timeout(1500),
          });
          return "open";
        } catch {
          return "closed";
        }
      },
      {
        timeout: 5000,
        message:
          "The local runtime port must close when the application exits.",
      },
    )
    .toBe("closed");
  application = undefined;
}

async function cleanupTemporaryProfile() {
  if (!temporaryRoot) return;
  const target = path.resolve(temporaryRoot);
  const parent = path.resolve(tmpdir());
  if (
    path.dirname(target).toLowerCase() !== parent.toLowerCase() ||
    !path.basename(target).startsWith("mc-panel-desktop-smoke-")
  ) {
    throw new Error(
      `Refusing to remove an unexpected smoke-test directory: ${target}`,
    );
  }
  await fs.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  });
}

try {
  assert.equal(
    process.platform,
    "win32",
    "This smoke test targets the packaged Windows executable.",
  );
  assert.ok(
    (await fs.stat(executablePath)).isFile(),
    `Build the unpacked application before testing: ${executablePath}`,
  );
  await fs.mkdir(outputDirectory, { recursive: true });
  // Avoid native overwrite prompts when the same smoke command is run again.
  downloadDirectory = await fs.mkdtemp(
    path.join(outputDirectory, "downloads-"),
  );
  temporaryRoot = await fs.mkdtemp(
    path.join(tmpdir(), "mc-panel-desktop-smoke-"),
  );
  profileDirectory = path.join(temporaryRoot, "profile");
  await fs.mkdir(profileDirectory);
  step(
    `Launching ${path.basename(executablePath)} with an isolated test profile.`,
  );
  let { page, serverId } = await launchPackaged();

  step("Creating and uploading files through the packaged File Manager.");
  await page.goto(`${currentOrigin}/#files`);
  await ui(
    page.getByRole("heading", { name: "File Manager", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New file", exact: true }).click();
  const fileDialog = page.getByRole("dialog");
  await fileDialog
    .getByLabel("File name", { exact: true })
    .fill("desktop-smoke.txt");
  await fileDialog
    .getByLabel("Contents (optional)", { exact: true })
    .fill(textContents);
  await fileDialog
    .getByRole("button", { name: "Create file", exact: true })
    .click();
  await ui(fileDialog).not.toBeVisible();
  await page.getByLabel("Upload server files").setInputFiles({
    name: "desktop-smoke.bin",
    mimeType: "application/octet-stream",
    buffer: uploadBytes,
  });
  await ui(
    page.getByRole("button", { name: "desktop-smoke.bin", exact: true }),
  ).toBeVisible();
  const textFile = await browserApi(
    page,
    "/files/content?path=desktop-smoke.txt",
    { serverId },
  );
  assert.equal(textFile.status, 200);
  assert.equal(textFile.data.content, textContents);
  await page
    .getByRole("link", { name: "Download desktop-smoke.bin", exact: true })
    .click();
  assert.deepEqual(await expectDownload("desktop-smoke.bin"), uploadBytes);
  await page.screenshot({
    path: path.join(outputDirectory, "packaged-file-manager.png"),
    fullPage: true,
  });

  step("Creating and downloading SQLite through the bundled Node runtime.");
  await page.goto(`${currentOrigin}/#databases`);
  await ui(
    page.getByRole("heading", { name: "Databases", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create database", exact: true })
    .click();
  const databaseDialog = page.getByRole("dialog", {
    name: "Create a database",
    exact: true,
  });
  await databaseDialog
    .getByLabel("Database name", { exact: true })
    .fill("desktop_smoke");
  await databaseDialog
    .getByRole("button", { name: "Create database", exact: true })
    .click();
  await ui(databaseDialog).not.toBeVisible();
  await page
    .getByRole("link", { name: "Download desktop_smoke", exact: true })
    .click();
  const sqlite = await expectDownload("desktop_smoke.sqlite");
  assert.equal(sqlite.subarray(0, 16).toString(), "SQLite format 3\0");
  assert.ok(sqlite.length > 1024);
  const databases = await browserApi(page, "/databases", { serverId });
  assert.equal(databases.status, 200);
  assert.ok(
    databases.data.databases.some(
      (item) => item.name === "desktop_smoke" && item.size > 1024,
    ),
  );
  assert.ok(
    (
      await fs.stat(path.join(profileDirectory, "data", "servers.json"))
    ).isFile(),
    "The fleet registry must be stored in the isolated user-data directory.",
  );
  const renamed = await browserApi(
    page,
    `/servers/${encodeURIComponent(serverId)}`,
    { method: "PATCH", body: { name: "Desktop smoke world" } },
  );
  assert.equal(renamed.status, 200);

  step("Closing the hidden window keeps the tray runtime available.");
  const trayState = await application.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.close();
    // The Panel menu shares its open/quit actions with the tray's context menu.
    const panelMenu = Menu.getApplicationMenu()?.items.find(
      (item) => item.label === "Panel",
    );
    return {
      destroyed: window.isDestroyed(),
      visible: window.isDestroyed() ? null : window.isVisible(),
      actions: panelMenu?.submenu?.items.map((item) => item.label) ?? [],
    };
  });
  assert.equal(
    trayState.destroyed,
    false,
    "Closing the window must keep the desktop process available in the tray.",
  );
  assert.equal(trayState.visible, false);
  assert.ok(trayState.actions.includes("Open MC Panel"));
  assert.ok(trayState.actions.includes("Quit MC Panel"));
  const trayRuntime = await browserApi(page, "/servers");
  assert.equal(
    trayRuntime.status,
    200,
    "The local runtime must stay available after the window closes to the tray.",
  );
  assert.equal(application.process().exitCode, null);

  step("Quitting the app and confirming that its private API shuts down.");
  await quitPackaged();
  step(
    "Relaunching the same profile to verify saved worlds, files, and databases.",
  );
  ({ page } = await launchPackaged());
  await ui(
    page.getByRole("heading", { name: "Desktop smoke world", exact: true }),
  ).toBeVisible();
  const retainedText = await browserApi(
    page,
    "/files/content?path=desktop-smoke.txt",
    { serverId },
  );
  assert.equal(retainedText.status, 200);
  assert.equal(retainedText.data.content, textContents);
  const retainedBytes = await page.evaluate(async (serverId) => {
    const response = await fetch(
      `/api/files/download?path=desktop-smoke.bin&serverId=${encodeURIComponent(serverId)}`,
    );
    return {
      status: response.status,
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
    };
  }, serverId);
  assert.equal(retainedBytes.status, 200);
  assert.deepEqual(Buffer.from(retainedBytes.bytes), uploadBytes);
  const retainedDatabases = await browserApi(page, "/databases", { serverId });
  assert.equal(retainedDatabases.status, 200);
  assert.ok(
    retainedDatabases.data.databases.some(
      (item) => item.name === "desktop_smoke",
    ),
  );
  await page.screenshot({
    path: path.join(outputDirectory, "packaged-relaunch.png"),
    fullPage: true,
  });
  step(
    "Simulating the window's Windows session-ending event and checking graceful exit.",
  );
  await quitPackaged("query-session-end");
  step(
    `Passed: startup, isolation, authenticated API, sandboxing, uploads/downloads, SQLite, persistence, tray close, normal quit, and Windows-session shutdown. Artifacts: ${outputDirectory}`,
  );
} catch (error) {
  failed = true;
  console.error(error.stack || error.message || error);
  if (application) {
    try {
      const downloads = await application.evaluate(
        () => globalThis.__panelSmokeDownloads ?? [],
      );
      console.error(`Smoke download states: ${JSON.stringify(downloads)}`);
      const windows = application.windows();
      if (windows[0])
        await windows[0].screenshot({
          path: path.join(outputDirectory, "packaged-smoke-failure.png"),
          fullPage: true,
        });
    } catch {
      /* The failing process may already have exited. */
    }
  }
  process.exitCode = 1;
} finally {
  if (application) {
    try {
      await quitPackaged();
    } catch (error) {
      console.error(
        `Smoke-test cleanup could not quit gracefully: ${error.message}`,
      );
      // Only terminate the exact child process launched by this test.
      application?.process().kill();
      failed = true;
      process.exitCode = 1;
    }
  }
  if (failed || keepData) {
    if (temporaryRoot) step(`Isolated test data retained: ${temporaryRoot}`);
  } else {
    await cleanupTemporaryProfile();
  }
}
