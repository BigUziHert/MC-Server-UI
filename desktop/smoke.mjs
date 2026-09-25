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
let smokeProcessPath;
let smokeProcessEvents;
let failed = false;

function step(message) {
  console.log(`[desktop smoke] ${message}`);
}

const serverButton = (page, id) =>
  page.locator(`button[data-server-id="${id}"]`);
async function selectSmokeServer(page, id) {
  const selector = page.getByRole("button", {
    name: "SERVER SELECTOR",
    exact: true,
  });
  if ((await selector.getAttribute("aria-expanded")) === "false")
    await selector.click();
  await serverButton(page, id).click();
  await ui(serverButton(page, id)).toHaveAttribute("aria-pressed", "true");
}

async function processEvents() {
  const content = await fs
    .readFile(smokeProcessEvents, "utf8")
    .catch((cause) => {
      if (cause.code === "ENOENT") return "";
      throw cause;
    });
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function assertSmokeProcessesStopped() {
  await ui
    .poll(
      async () => {
        const events = await processEvents();
        return events
          .filter((event) => event.type === "start")
          .every((started) =>
            events.some(
              (event) =>
                event.type === "exit" &&
                event.pid === started.pid &&
                event.code === 0,
            ),
          );
      },
      {
        message:
          "Every fixture process must exit gracefully with the packaged app.",
      },
    )
    .toBe(true);
}

async function startSmokeServer(page, serverId) {
  await selectSmokeServer(page, serverId);
  await page
    .locator(".sidebar-power")
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await ui
    .poll(
      async () => (await browserApi(page, "/server", { serverId })).data.status,
    )
    .toBe("running");
  await ui(
    page
      .locator(".sidebar-power")
      .getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
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
    async ({ app, BrowserWindow, Menu }, origin) => {
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
        nativeMenu: Menu.getApplicationMenu() !== null,
        menuVisible: window.isMenuBarVisible(),
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
    mainState.nativeMenu,
    false,
    "The app must not install a native menu bar.",
  );
  assert.equal(mainState.menuVisible, false);
  await page.keyboard.press("Alt");
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
    ),
    false,
    "Alt must not reveal a removed menu.",
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
      "A fresh desktop profile must not create a server automatically.",
    );
    assert.equal(servers.data.defaultServerId, null);
    await ui(
      page.getByRole("heading", { level: 1, name: "Console", exact: true }),
    ).toHaveCount(0);
    await ui(page.locator("button[data-server-id]")).toHaveCount(0);
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
      ["live", "live", "live"],
      "The smoke profile must retain its explicitly created process fixture, imported JAR server, and imported NeoForge server.",
    );
  }
  await installDownloadCapture(application, downloadDirectory);
  step(
    `Packaged Electron ${mainState.electronVersion}, Node ${mainState.nodeVersion}; private local runtime ready.`,
  );
  return { page, serverId: servers.data.defaultServerId };
}

async function createSmokeServer(page) {
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
      name: "Desktop smoke process",
      mode: "live",
      launchType: "executable",
      launchExecutable: process.execPath,
      launchArgs: [smokeProcessPath],
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
    page.getByRole("heading", { name: "Desktop smoke process", exact: true }),
  ).toBeVisible();
  const result = await browserApi(page, "/servers");
  assert.equal(result.status, 200);
  assert.equal(result.data.servers.length, 1);
  assert.equal(result.data.servers[0].mode, "live");
  assert.equal(result.data.servers[0].status, "offline");
  assert.equal(result.data.servers[0].id, result.data.defaultServerId);
  const id = result.data.defaultServerId;
  const blocked = await browserApi(page, "/server/power", {
    method: "POST",
    body: { action: "start" },
    serverId: id,
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /EULA/);
  assert.deepEqual(await processEvents(), []);
  const eula = await browserApi(page, "/files/content", {
    method: "PUT",
    body: {
      path: "eula.txt",
      revision: (
        await browserApi(page, "/files/content?path=eula.txt", { serverId: id })
      ).data.revision,
      content: "# Accepted only for the isolated smoke fixture.\neula=true\n",
    },
    serverId: id,
  });
  assert.equal(eula.status, 200);
  await startSmokeServer(page, id);
  await ui
    .poll(
      async () =>
        (await processEvents()).filter((event) => event.type === "start")
          .length,
    )
    .toBe(1);
  await page
    .locator(".server-power")
    .getByRole("button", { name: "Restart", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Restart your server?", exact: true })
    .getByRole("button", { name: "Restart server", exact: true })
    .click();
  await ui
    .poll(
      async () =>
        (await processEvents()).filter((event) => event.type === "start")
          .length,
    )
    .toBe(2);
  await ui
    .poll(
      async () =>
        (await browserApi(page, "/server", { serverId: id })).data.status,
    )
    .toBe("running");
  const events = await processEvents();
  const first = events.find((event) => event.type === "start");
  assert.ok(
    events.some(
      (event) =>
        event.type === "exit" && event.pid === first.pid && event.code === 0,
    ),
  );
  await page
    .getByRole("textbox", { name: "Server command", exact: true })
    .fill("say packaged-process-ready");
  await page.getByRole("button", { name: "Send command", exact: true }).click();
  await ui
    .poll(async () =>
      (await browserApi(page, "/console", { serverId: id })).data.lines.some(
        (line) =>
          line.message ===
          "[Server thread/INFO]: [Server] packaged-process-ready",
      ),
    )
    .toBe(true);
  return result.data.defaultServerId;
}

async function assertSmokeBackup(page, serverId) {
  step(
    "Checking real-process world-save backups, downloads, and archive recovery in the packaged app.",
  );
  const created = await browserApi(page, "/backups", {
    method: "POST",
    body: { name: "Desktop smoke archive" },
    serverId,
  });
  assert.equal(created.status, 201);
  const backup = created.data;
  await page.goto(`${currentOrigin}/#backups`);
  await page
    .getByRole("link", { name: `Download backup ${backup.name}`, exact: true })
    .click();
  const bytes = await expectDownload(`${backup.name}.tar.gz`);
  assert.deepEqual([...bytes.subarray(0, 2)], [31, 139]);
  await page
    .getByRole("button", { name: `Delete backup ${backup.name}`, exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Move this backup to Recycle Bin?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await ui(dialog).not.toBeVisible();
  assert.deepEqual(
    (await browserApi(page, "/backups", { serverId })).data.backups,
    [],
  );
  await page.getByRole("link", { name: "File Manager", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Recycle Bin", exact: true })
    .click();
  const row = page.getByRole("listitem", {
    name: `Recycled backup ${backup.name}`,
    exact: true,
  });
  await ui(row).toContainText("Restore to Backups");
  await row
    .getByRole("button", { name: `Restore ${backup.name}`, exact: true })
    .click();
  await ui(row).toHaveCount(0);
  assert.deepEqual(
    (await browserApi(page, "/backups", { serverId })).data.backups,
    [backup],
  );
  const recovered = await page.evaluate(
    async ({ id, serverId }) => {
      const response = await fetch(
        `/api/backups/${id}/download?serverId=${encodeURIComponent(serverId)}`,
      );
      return {
        status: response.status,
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    },
    { id: backup.id, serverId },
  );
  assert.equal(recovered.status, 200);
  assert.deepEqual(Buffer.from(recovered.bytes), bytes);
  assert.equal(
    (
      await browserApi(page, "/files/content?path=desktop-smoke.txt", {
        serverId,
      })
    ).data.content,
    textContents,
  );
  return backup;
}

async function assertExternalProjectLinks(page) {
  step(
    "Checking catalog project links open the browser without allowing external app navigation.",
  );
  const projects = [
    ["modrinth", "Cloth Config API", "https://modrinth.com/mod/cloth-config"],
    [
      "curseforge",
      "CurseForge project",
      "https://www.curseforge.com/minecraft/mc-mods/cloth-config",
    ],
    ["spigot", "Spigot project", "https://www.spigotmc.org/resources/123/"],
    ["ftb", "FTB project", "https://www.feed-the-beast.com/modpacks/123"],
    [
      "atlauncher",
      "ATLauncher project",
      "https://atlauncher.com/pack/TestPack",
    ],
    [
      "voidswrath",
      "Voids Wrath project",
      "https://voidswrath.com/modpacks/test-pack/",
    ],
  ].map(([platform, title, url], index) => ({
    platform,
    title,
    url,
    id: `external-link-${index}`,
    description: "Desktop link fixture",
  }));
  const routePattern = "**/api/launchpad**";
  const handler = async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json =
      pathname === "/api/launchpad"
        ? {
            platforms: [
              {
                id: "modrinth",
                name: "Modrinth",
                available: true,
                types: ["mod"],
              },
            ],
            gameVersion: "1.21.1",
            gameVersions: ["1.21.1"],
            loader: "neoforge",
            status: "offline",
            warnings: [],
          }
        : pathname === "/api/launchpad/search"
          ? {
              projects,
              total: projects.length,
              offset: 0,
              limit: 10,
            }
          : { items: [], warnings: [] };
    await route.fulfill({ json });
  };
  await page.route(routePattern, handler);
  // Replace only the OS browser call. The packaged production URL validation
  // and Electron navigation/window-open handlers still handle the actual clicks.
  await application.evaluate(({ shell }) => {
    globalThis.__panelSmokeOpenExternal = shell.openExternal;
    globalThis.__panelSmokeOpenedUrls = [];
    shell.openExternal = async (url) => {
      globalThis.__panelSmokeOpenedUrls.push(url);
    };
  });
  try {
    await page.goto(`${currentOrigin}/#launchpad`);
    for (const project of projects)
      await page
        .getByRole("link", {
          name: `Open ${project.title} project page`,
          exact: true,
        })
        .click();
    const openedUrls = () =>
      application.evaluate(() => globalThis.__panelSmokeOpenedUrls);
    await ui.poll(openedUrls).toEqual(projects.map((project) => project.url));
    await page.evaluate((sentinel) => {
      for (const url of [
        "https://untrusted.example/project",
        "https://modrinth.com.evil.example/project",
        "http://modrinth.com/mod/cloth-config",
        "file:///C:/Windows/notepad.exe",
        sentinel,
      ])
        window.open(url, "_blank", "noopener,noreferrer");
    }, projects[0].url);
    await ui
      .poll(openedUrls)
      .toEqual([...projects.map((project) => project.url), projects[0].url]);
    await page.evaluate((url) => {
      const link = document.createElement("a");
      link.href = url;
      document.body.append(link);
      link.click();
      link.remove();
    }, projects[1].url);
    await ui
      .poll(openedUrls)
      .toEqual([
        ...projects.map((project) => project.url),
        projects[0].url,
        projects[1].url,
      ]);
    assert.equal(page.url(), `${currentOrigin}/#launchpad`);
    assert.equal(
      await application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
  } finally {
    await page.goto(`${currentOrigin}/#console`);
    await page.unroute(routePattern, handler);
    await application.evaluate(({ shell }) => {
      shell.openExternal = globalThis.__panelSmokeOpenExternal;
      delete globalThis.__panelSmokeOpenExternal;
      delete globalThis.__panelSmokeOpenedUrls;
    });
  }
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

async function quitPackaged(mode = "quit", expectedRunning = []) {
  if (!application) return;
  const app = application;
  for (const page of app.windows()) await page.unrouteAll({ behavior: "wait" });
  const child = app.process();
  const exit =
    child.exitCode === null
      ? once(child, "exit")
      : Promise.resolve([child.exitCode]);
  if (mode === "quit") {
    await app.evaluate(({ dialog }, waitForConfirmation) => {
      // Keep native dialogs hidden in CI, but exercise and inspect the actual
      // live-server quit confirmation before permitting the process to stop.
      globalThis.__panelSmokeResolveQuit?.({ response: 1 });
      globalThis.__panelSmokeQuitPrompt = undefined;
      dialog.showMessageBox = async (_window, options) => {
        if (
          options.title !== "Quit MC Panel?" ||
          options.buttons?.join("|") !== "Keep running|Stop servers and quit"
        )
          throw new Error(`Unexpected native quit dialog: ${options.title}`);
        globalThis.__panelSmokeQuitPrompt = options;
        if (!waitForConfirmation) return { response: 1 };
        return new Promise((resolve) => {
          globalThis.__panelSmokeResolveQuit = resolve;
        });
      };
    }, expectedRunning.length > 0);
  }
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
  if (mode === "quit" && expectedRunning.length) {
    await ui
      .poll(() => app.evaluate(() => globalThis.__panelSmokeQuitPrompt))
      .toMatchObject({
        type: "question",
        title: "Quit MC Panel?",
        buttons: ["Keep running", "Stop servers and quit"],
        defaultId: 0,
        cancelId: 0,
      });
    const prompt = await app.evaluate(() => globalThis.__panelSmokeQuitPrompt);
    for (const name of expectedRunning) assert.ok(prompt.detail.includes(name));
    await app.evaluate(() => {
      globalThis.__panelSmokeResolveQuit({ response: 1 });
      globalThis.__panelSmokeResolveQuit = undefined;
    });
  }
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
  await assertSmokeProcessesStopped();
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
  smokeProcessPath = path.join(temporaryRoot, "minecraft-smoke-process.mjs");
  smokeProcessEvents = path.join(temporaryRoot, "process-events.jsonl");
  const processFixture = await fs.readFile(
    path.join(projectDir, "tests", "fixtures", "minecraft-process.mjs"),
    "utf8",
  );
  await fs.writeFile(
    smokeProcessPath,
    `import { appendFileSync } from "node:fs";
const recordSmokeEvent = (event) => appendFileSync(${JSON.stringify(smokeProcessEvents)}, JSON.stringify({ ...event, pid: process.pid }) + "\\n");
recordSmokeEvent({ type: "start" });
process.on("exit", (code) => recordSmokeEvent({ type: "exit", code }));
${processFixture}`,
  );
  step(
    `Launching ${path.basename(executablePath)} with an isolated test profile.`,
  );
  let { page, serverId } = await launchPackaged({ expectEmpty: true });
  await assertDesktopUpdates(page);
  serverId = await createSmokeServer(page);
  await assertExternalProjectLinks(page);

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
  const backup = await assertSmokeBackup(page, serverId);

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
  await ui(serverButton(page, neoForge.id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
    const tray = globalThis.__mcPanelTraySmoke?.();
    return {
      destroyed: window.isDestroyed(),
      visible: window.isDestroyed() ? null : window.isVisible(),
      nativeMenu: Menu.getApplicationMenu() !== null,
      trayAlive: tray?.alive,
      actions: tray?.actions ?? [],
    };
  });
  assert.equal(
    trayState.destroyed,
    false,
    "Closing the window must keep the desktop process available in the tray.",
  );
  assert.equal(trayState.visible, false);
  assert.equal(trayState.nativeMenu, false);
  assert.equal(trayState.trayAlive, true);
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
  await quitPackaged("quit", ["Desktop smoke world"]);
  step("Relaunching the same profile to verify saved worlds and files.");
  ({ page } = await launchPackaged());
  await ui(serverButton(page, neoForge.id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await selectSmokeServer(page, serverId);
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
  assert.deepEqual(
    (await browserApi(page, "/backups", { serverId })).data.backups,
    [backup],
  );
  assert.equal(
    (await browserApi(page, "/server", { serverId })).data.status,
    "offline",
  );
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
  await capturePackaged("packaged-relaunch.png");
  const retainedFleet = await browserApi(page, "/servers");
  const retainedImport = retainedFleet.data.servers.find(
    (server) => server.id === imported.id,
  );
  assert.ok(retainedImport);
  assert.equal(retainedImport.serverDir, await fs.realpath(imported.directory));
  assert.equal(retainedImport.mode, "live");
  assert.equal(retainedImport.status, "offline");
  await selectSmokeServer(page, imported.id);
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
  await startSmokeServer(page, serverId);
  await selectSmokeServer(page, neoForge.id);
  step(
    "Simulating the window's Windows session-ending event and checking graceful exit.",
  );
  await quitPackaged("query-session-end");
  step(
    `Passed: clean startup, real process start/restart/commands, read-only update status, catalog browser links and blocked external navigation, explicit creation, native folder picker cancellation/import, JAR and NeoForge imports, source/JVM/EULA preservation, isolation, authenticated API, sandboxing, uploads/downloads, backup recovery, persistence, tray close, normal quit, and Windows-session shutdown with owned-process exit. Artifacts: ${outputDirectory}`,
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
