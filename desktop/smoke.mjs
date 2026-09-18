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

async function capturePackaged(filename) {
  try {
    const png = await bounded(
      application.evaluate(async ({ BrowserWindow }, origin) => {
        const window = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().startsWith(origin),
        );
        if (!window)
          throw new Error("No packaged application window is available.");
        const image = await window.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        });
        if (image.isEmpty())
          throw new Error("The hidden window returned an empty capture.");
        return image.toPNG().toString("base64");
      }, currentOrigin),
      10_000,
      "The hidden Electron window did not finish its optional screenshot.",
    );
    await fs.writeFile(
      path.join(outputDirectory, filename),
      Buffer.from(png, "base64"),
    );
  } catch (error) {
    // Renderer/compositor capture is optional; browser screenshots cover layout.
    console.warn(
      `[desktop smoke] Skipping optional screenshot ${filename}: ${error.message}`,
    );
  }
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

async function launchPackaged({ expectEmpty = false } = {}) {
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
    page.getByRole("heading", {
      level: 1,
      name: expectEmpty ? "Welcome to MC Panel" : "Console",
      exact: true,
    }),
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
    await fs.realpath(mainState.userData),
    await fs.realpath(profileDirectory),
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
  if (expectEmpty) {
    assert.deepEqual(
      servers.data.servers,
      [],
      "A fresh desktop profile must not create a demonstration server.",
    );
    assert.equal(servers.data.defaultServerId, null);
    await ui(
      page.getByRole("heading", { level: 1, name: "Console", exact: true }),
    ).toHaveCount(0);
    await ui(
      page.getByRole("combobox", { name: "Switch server", exact: true }),
    ).toHaveCount(0);
    const initialFiles = await fs.readdir(path.join(profileDirectory, "data"));
    assert.deepEqual(
      initialFiles.sort(),
      ["servers.json"],
      "A fresh desktop profile must contain only an empty fleet registry, without seeded server files.",
    );
  } else {
    assert.equal(servers.data.servers.length, 3);
    assert.deepEqual(
      servers.data.servers.map((server) => server.mode).sort(),
      ["demo", "live", "live"],
      "The smoke profile must retain its explicitly created demo, imported JAR server, and imported NeoForge server.",
    );
  }
  await installDownloadCapture(application, downloadDirectory);
  step(
    `Packaged Electron ${mainState.electronVersion}, Node ${mainState.nodeVersion}; private local runtime ready.`,
  );
  return { page, serverId: servers.data.defaultServerId };
}

async function createSmokeDemo(page) {
  step(
    "Verifying guided creation, then preparing an isolated API fixture for the smoke checks.",
  );
  await capturePackaged("packaged-first-launch.png");
  await ui(
    page.getByRole("button", {
      name: "Import an existing server",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create a new server", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await ui(
    dialog.getByRole("button", { name: "Server software", exact: true }),
  ).toBeVisible();
  await ui(
    dialog.getByRole("button", { name: "Modpack", exact: true }),
  ).toBeVisible();
  await capturePackaged("packaged-create-source.png");
  assert.deepEqual((await browserApi(page, "/servers")).data.servers, []);
  await ui(dialog.getByText("Advanced setup", { exact: true })).toHaveCount(0);
  await ui(
    dialog.getByRole("button", { name: "Create an empty server", exact: true }),
  ).toHaveCount(0);
  await ui(dialog.getByLabel("Mode", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await ui(dialog).not.toBeVisible();
  const fixture = await browserApi(page, "/servers", {
    method: "POST",
    body: {
      name: "Desktop smoke demo",
      mode: "demo",
      port: 25565,
      memoryLimitMB: 2048,
    },
  });
  assert.equal(fixture.status, 201);
  await page.reload();
  await ui(
    page.getByRole("heading", { level: 1, name: "Console", exact: true }),
  ).toBeVisible();
  await ui(
    page.getByRole("heading", { name: "Desktop smoke demo", exact: true }),
  ).toBeVisible();
  const result = await browserApi(page, "/servers");
  assert.equal(result.status, 200);
  assert.equal(result.data.servers.length, 1);
  assert.equal(result.data.servers[0].mode, "demo");
  assert.equal(result.data.servers[0].id, result.data.defaultServerId);
  return result.data.defaultServerId;
}

async function assertDesktopUpdates(page) {
  step(
    "Checking packaged update status without contacting a release service or installing anything.",
  );
  const version = await application.evaluate(({ app }) => app.getVersion());
  const state = await browserApi(page, "/desktop/updates");
  assert.equal(state.status, 200);
  assert.equal(state.data.desktop, true);
  assert.equal(state.data.version, version);
  assert.equal(state.data.supported, false);
  assert.equal(state.data.status, "unsupported");
  const actions = [];
  const recordAction = (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith("/api/desktop/updates/")
    )
      actions.push(request.url());
  };
  page.on("request", recordAction);
  try {
    await page
      .getByRole("button", { name: "App updates", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "App updates",
      exact: true,
    });
    await ui(dialog).toBeVisible();
    await ui(dialog).toContainText(version);
    await ui(dialog).toContainText("Setup edition once");
    for (const name of [
      "Check for updates",
      "Download update",
      "Restart to update",
    ])
      await ui(dialog.getByRole("button", { name, exact: true })).toHaveCount(
        0,
      );
    await capturePackaged("packaged-updates.png");
    await page.keyboard.press("Escape");
    await ui(dialog).not.toBeVisible();
    assert.deepEqual(actions, []);
  } finally {
    page.off("request", recordAction);
  }
}

async function snapshotSmokeFolder(directory, prefix = "") {
  const snapshot = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      snapshot[`${relative}/`] = "directory";
      Object.assign(snapshot, await snapshotSmokeFolder(absolute, relative));
    } else
      snapshot[relative] = (await fs.readFile(absolute)).toString("base64");
  }
  return snapshot;
}

async function assertOutsideProfile(directory) {
  const [profile, canonicalDirectory] = await Promise.all([
    fs.realpath(profileDirectory),
    fs.realpath(directory),
  ]);
  const relative = path.relative(profile, canonicalDirectory);
  assert.ok(
    relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative),
    "Imported fixtures must remain outside the isolated desktop profile.",
  );
}

async function importSmokeExisting(page) {
  step(
    "Importing an existing external folder through the native picker, with cancellation and source preservation checks.",
  );
  const directory = path.join(temporaryRoot, "existing-minecraft-server");
  const files = {
    "server.properties":
      "# Existing desktop server\r\nserver-port=25691\r\nmotd=Desktop imported world\r\nlevel-name=existing-world\r\nmax-players=32\r\n",
    "eula.txt": "# Keep this decision unchanged.\r\neula=false\r\n",
    "paper-fixture.jar": Buffer.from([80, 75, 3, 4, 0, 128, 255]),
    "existing-world/level.dat": Buffer.from([31, 139, 8, 0, 45, 127, 128, 254]),
    "plugins/Example/config.yml":
      "enabled: true\nmessage: Original plugin configuration\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(directory, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
  }
  const original = await snapshotSmokeFolder(directory);
  await assertOutsideProfile(directory);
  const capabilities = await browserApi(page, "/server-import");
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.data.canBrowse, true);
  await application.evaluate(({ dialog }, directory) => {
    globalThis.__panelSmokePicker = {
      original: dialog.showOpenDialog,
      calls: [],
    };
    dialog.showOpenDialog = async (_window, options) => {
      const calls = globalThis.__panelSmokePicker.calls;
      calls.push({ title: options.title, properties: options.properties });
      return calls.length === 1
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [directory] };
    };
  }, directory);
  try {
    await page.getByRole("button", { name: "Add server", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add a server", exact: true })
      .getByRole("button", { name: "Import an existing server", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Import an existing server",
      exact: true,
    });
    const folder = dialog.getByLabel("Server folder", { exact: true });
    await dialog.getByRole("button", { name: "Browse", exact: true }).click();
    await ui
      .poll(() =>
        application.evaluate(() => globalThis.__panelSmokePicker.calls.length),
      )
      .toBe(1);
    await ui(folder).toHaveValue("");
    await dialog.getByRole("button", { name: "Browse", exact: true }).click();
    await ui(folder).toHaveValue(directory);
    const calls = await application.evaluate(
      () => globalThis.__panelSmokePicker.calls,
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].properties, ["openDirectory", "dontAddToRecent"]);
    assert.equal(calls[1].title, "Choose existing Minecraft server folder");
    await dialog
      .getByRole("button", { name: "Inspect folder", exact: true })
      .click();
    await ui(dialog.getByLabel("Server JAR", { exact: true })).toHaveValue(
      "paper-fixture.jar",
    );
    await ui(dialog).toContainText(/not accepted/i);
    assert.deepEqual(await snapshotSmokeFolder(directory), original);
    await dialog
      .getByLabel("Server name", { exact: true })
      .fill("Desktop imported world");
    await capturePackaged("packaged-import-review.png");
    await dialog
      .getByRole("button", { name: "Import server", exact: true })
      .click();
    await ui(dialog).not.toBeVisible();
    await ui(
      page.getByRole("heading", {
        name: "Desktop imported world",
        exact: true,
      }),
    ).toBeVisible();
    const fleet = await browserApi(page, "/servers");
    const imported = fleet.data.servers.find(
      (server) => server.name === "Desktop imported world",
    );
    assert.ok(imported);
    assert.equal(imported.mode, "live");
    assert.equal(imported.status, "offline");
    assert.equal(imported.source, "imported");
    assert.equal(imported.serverDir, await fs.realpath(directory));
    assert.equal(imported.jar, "paper-fixture.jar");
    assert.equal(imported.port, 25691);
    assert.deepEqual(await snapshotSmokeFolder(directory), original);
    await page.getByRole("link", { name: "File Manager", exact: true }).click();
    for (const name of [
      "server.properties",
      "eula.txt",
      "paper-fixture.jar",
      "existing-world",
      "plugins",
    ])
      await ui(page.getByRole("button", { name, exact: true })).toBeVisible();
    const eula = await browserApi(page, "/files/content?path=eula.txt", {
      serverId: imported.id,
    });
    assert.equal(eula.data.content, files["eula.txt"]);
    const registry = JSON.parse(
      await fs.readFile(
        path.join(profileDirectory, "data", "servers.json"),
        "utf8",
      ),
    );
    assert.ok(JSON.stringify(registry).includes("existing-minecraft-server"));
    return { id: imported.id, directory, original };
  } finally {
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__panelSmokePicker.original;
    });
  }
}

async function importSmokeNeoForge(page) {
  step(
    "Importing an existing NeoForge launcher without a root JAR or changes to its JVM arguments.",
  );
  const directory = path.join(temporaryRoot, "existing-neoforge-server");
  const files = {
    "server.properties":
      "# Existing NeoForge desktop server\r\nserver-port=25692\r\nmotd=Original NeoForge world\r\nlevel-name=existing-world\r\nmax-players=32\r\n",
    "eula.txt": "# Do not accept automatically.\r\neula=false\r\n",
    "run.bat":
      "@echo off\r\nREM NeoForge requires JVM arguments.\r\njava @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.200/win_args.txt %*\r\npause\r\n",
    "user_jvm_args.txt": "# Original RAM settings\r\n-Xms2G\r\n-Xmx6G\r\n",
    "libraries/net/neoforged/neoforge/21.1.200/win_args.txt":
      "# Existing generated NeoForge arguments\r\n--launchTarget neoforgeserver\r\n",
    "existing-world/level.dat": Buffer.from([31, 139, 8, 0, 45, 127, 128, 254]),
  };
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(directory, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
  }
  const original = await snapshotSmokeFolder(directory);
  await assertOutsideProfile(directory);
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Add a server", exact: true })
    .getByRole("button", { name: "Import an existing server", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Import an existing server",
    exact: true,
  });
  await dialog.getByLabel("Server folder", { exact: true }).fill(directory);
  await dialog
    .getByRole("button", { name: "Inspect folder", exact: true })
    .click();
  await ui(dialog.getByLabel("Launch method", { exact: true })).toHaveValue(
    "java-args",
  );
  await ui(dialog.getByLabel("Detected launcher", { exact: true })).toHaveValue(
    "run.bat",
  );
  await ui(dialog.getByLabel("Server JAR", { exact: true })).toHaveCount(0);
  await ui(dialog.getByLabel("Memory (MB)", { exact: true })).toHaveCount(0);
  await ui(dialog).toContainText("user_jvm_args.txt");
  await ui(
    dialog.getByRole("button", { name: "Import server", exact: true }),
  ).toBeEnabled();
  assert.deepEqual(await snapshotSmokeFolder(directory), original);
  await dialog
    .getByLabel("Server name", { exact: true })
    .fill("Desktop NeoForge world");
  await capturePackaged("packaged-neoforge-import.png");
  await dialog
    .getByRole("button", { name: "Import server", exact: true })
    .click();
  await ui(dialog).not.toBeVisible();
  await ui(
    page.getByRole("heading", { name: "Desktop NeoForge world", exact: true }),
  ).toBeVisible();
  const fleet = await browserApi(page, "/servers");
  const imported = fleet.data.servers.find(
    (server) => server.name === "Desktop NeoForge world",
  );
  assert.ok(imported);
  assert.equal(imported.mode, "live");
  assert.equal(imported.status, "offline");
  assert.equal(imported.source, "imported");
  assert.equal(imported.serverDir, await fs.realpath(directory));
  assert.equal(imported.launchType, "java-args");
  assert.equal(imported.launchScript, "");
  const launchArgs = [
    "@user_jvm_args.txt",
    "@libraries/net/neoforged/neoforge/21.1.200/win_args.txt",
    "nogui",
  ];
  assert.deepEqual(imported.launchArgs, launchArgs);
  assert.equal(imported.jar, "");
  assert.equal(imported.memoryLimitMB, 6144);
  assert.deepEqual(await snapshotSmokeFolder(directory), original);
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Server settings",
    exact: true,
  });
  await ui(settings.getByLabel("Launch method", { exact: true })).toHaveValue(
    "java-args",
  );
  await ui(
    settings.getByLabel("Startup arguments", { exact: true }),
  ).toHaveValue(launchArgs.join("\n"));
  await ui(settings).toContainText("user_jvm_args.txt");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await ui(settings).not.toBeVisible();
  const world = await browserApi(page, "/files?path=existing-world", {
    serverId: imported.id,
  });
  assert.equal(world.status, 200);
  assert.ok(world.data.entries.some((entry) => entry.name === "level.dat"));
  assert.deepEqual(await snapshotSmokeFolder(directory), original);
  return { id: imported.id, directory, original, launchArgs };
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
  assert.equal((await fs.lstat(temporaryRoot)).isSymbolicLink(), false);
  const target = await fs.realpath(temporaryRoot);
  const parent = await fs.realpath(tmpdir());
  if (
    path.dirname(target).toLowerCase() !== parent.toLowerCase() ||
    !path.basename(temporaryRoot).startsWith("mc-panel-desktop-smoke-") ||
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
  let { page, serverId } = await launchPackaged({ expectEmpty: true });
  await assertDesktopUpdates(page);
  serverId = await createSmokeDemo(page);

  step(
    "Checking bundled Minecraft management pages and configuration modules.",
  );
  const versions = await browserApi(page, "/versions", { serverId });
  assert.equal(versions.status, 200);
  assert.ok(
    versions.data.providers.some(
      (provider) => provider.id === "neoforge" && provider.installable,
    ),
  );
  await page.getByRole("link", { name: "Versions", exact: true }).click();
  await ui(
    page.getByRole("heading", { name: "Versions", exact: true }),
  ).toBeVisible();
  await ui(
    page.getByRole("heading", { name: "NeoForge", exact: true }),
  ).toBeVisible();
  const softwareLogos = page.locator(".version-provider-mark img");
  await ui(softwareLogos).toHaveCount(18);
  await ui
    .poll(() =>
      softwareLogos.evaluateAll((images) =>
        images.every(
          (image) =>
            image.complete &&
            image.naturalWidth > 0 &&
            new URL(image.currentSrc).origin === window.location.origin,
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("link", { name: "Properties", exact: true }).click();
  await ui(
    page.getByRole("tab", { name: "server.properties", exact: true }),
  ).toBeVisible();
  await ui(page.getByLabel("max players", { exact: true })).toBeVisible();

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
  await capturePackaged("packaged-file-manager.png");

  step(
    "Checking the removed Databases route and preserving legacy SQLite storage.",
  );
  const legacyDatabase = await browserApi(page, "/databases", {
    method: "POST",
    body: { name: "desktop_smoke" },
    serverId,
  });
  assert.equal(legacyDatabase.status, 201);
  await page.goto(`${currentOrigin}/#databases`);
  await ui(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
  await ui(
    page.getByRole("link", { name: "Databases", exact: true }),
  ).toHaveCount(0);
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

  const imported = await importSmokeExisting(page);
  const neoForge = await importSmokeNeoForge(page);
  await ui(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toHaveValue(neoForge.id);
  await ui
    .poll(
      async () =>
        (await browserApi(page, "/desktop/selection")).data.activeServerId,
    )
    .toBe(neoForge.id);

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
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toHaveValue(neoForge.id);
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(serverId);
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
  await capturePackaged("packaged-relaunch.png");
  const retainedFleet = await browserApi(page, "/servers");
  const retainedImport = retainedFleet.data.servers.find(
    (server) => server.id === imported.id,
  );
  assert.ok(retainedImport);
  assert.equal(retainedImport.serverDir, await fs.realpath(imported.directory));
  assert.equal(retainedImport.mode, "live");
  assert.equal(retainedImport.status, "offline");
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(imported.id);
  await ui(
    page.getByRole("heading", { name: "Desktop imported world", exact: true }),
  ).toBeVisible();
  const retainedEula = await browserApi(page, "/files/content?path=eula.txt", {
    serverId: imported.id,
  });
  assert.equal(retainedEula.status, 200);
  assert.ok(retainedEula.data.content.includes("eula=false"));
  assert.deepEqual(
    await snapshotSmokeFolder(imported.directory),
    imported.original,
  );
  const retainedNeoForge = retainedFleet.data.servers.find(
    (server) => server.id === neoForge.id,
  );
  assert.ok(retainedNeoForge);
  assert.equal(
    retainedNeoForge.serverDir,
    await fs.realpath(neoForge.directory),
  );
  assert.equal(retainedNeoForge.launchType, "java-args");
  assert.equal(retainedNeoForge.launchScript, "");
  assert.deepEqual(retainedNeoForge.launchArgs, neoForge.launchArgs);
  assert.equal(retainedNeoForge.jar, "");
  assert.equal(retainedNeoForge.status, "offline");
  const retainedJvm = await browserApi(
    page,
    "/files/content?path=user_jvm_args.txt",
    { serverId: neoForge.id },
  );
  assert.equal(retainedJvm.status, 200);
  assert.ok(retainedJvm.data.content.includes("-Xmx6G"));
  assert.deepEqual(
    await snapshotSmokeFolder(neoForge.directory),
    neoForge.original,
  );
  step(
    "Simulating the window's Windows session-ending event and checking graceful exit.",
  );
  await quitPackaged("query-session-end");
  step(
    `Passed: clean startup, read-only update status, explicit creation, native folder picker cancellation/import, JAR and NeoForge imports, source/JVM/EULA preservation, isolation, authenticated API, sandboxing, uploads/downloads, SQLite, persistence, tray close, normal quit, and Windows-session shutdown. Artifacts: ${outputDirectory}`,
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
      await capturePackaged("packaged-smoke-failure.png");
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
