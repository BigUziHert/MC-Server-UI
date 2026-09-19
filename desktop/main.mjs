import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
} from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopRuntime } from "./runtime.mjs";
import { flushRendererSelection } from "./selection.mjs";
import {
  installExternalLinkHandlers,
  openExternalWebsite,
} from "./external-links.mjs";
import updaterPackage from "electron-updater";
import { applyDownloadedUpdate, createUpdateController } from "./updates.mjs";

const { autoUpdater } = updaterPackage;

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const documentation =
  "https://github.com/BigUziHert/MC-Server-UI/tree/dev#readme";
const smokeTest = process.argv.includes("--smoke-test");
app.setName("MC Panel");
app.setAppUserModelId("com.biguzihert.mcpanel");

const userDataOverride = app.commandLine.getSwitchValue("user-data-dir");
const userData =
  userDataOverride || path.join(app.getPath("appData"), "MC Panel");
if (!path.isAbsolute(userData))
  throw new Error("The user data directory must be an absolute path.");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);

let window;
let tray;
let runtime;
let quitting = false;
let canQuit = false;
let startup;
let directoryDialog;
let updates;
let updateTimer;
let initialUpdateTimer;

async function logError(cause) {
  const message =
    cause instanceof Error ? cause.stack || cause.message : String(cause);
  console.error(message);
  await fs
    .appendFile(
      path.join(userData, "desktop.log"),
      `${new Date().toISOString()} ${message}\n`,
    )
    .catch(() => {});
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function openWebsite(url = documentation) {
  return openExternalWebsite(url, {
    openExternal: (target) => shell.openExternal(target),
    logError,
  });
}

async function openFolder(folder) {
  const failure = await shell.openPath(folder);
  if (failure) dialog.showErrorBox("Could not open folder", failure);
}

async function selectServerDirectory() {
  if (quitting || !window || window.isDestroyed()) return null;
  if (!directoryDialog) {
    directoryDialog = dialog
      .showOpenDialog(window, {
        title: "Choose existing Minecraft server folder",
        buttonLabel: "Use server folder",
        properties: ["openDirectory", "dontAddToRecent"],
      })
      .then(({ canceled, filePaths }) =>
        canceled || quitting ? null : (filePaths[0] ?? null),
      )
      .finally(() => {
        directoryDialog = undefined;
      });
  }
  return directoryDialog;
}

async function requestQuit(installUpdate = false) {
  if (quitting || canQuit) return false;
  quitting = true;
  try {
    await startup;
    const running = [...(runtime?.fleet.runtimes.values() || [])]
      .map((server) => server.descriptor())
      .filter(
        (server) => server.mode === "live" && server.status !== "offline",
      );
    if (running.length) {
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        title: installUpdate ? "Install MC Panel update?" : "Quit MC Panel?",
        message: installUpdate
          ? "Stop your servers and update MC Panel?"
          : "Quit and stop your Minecraft servers?",
        detail: `${running.map((server) => server.name).join(", ")} will shut down after active backups finish. ${installUpdate ? "MC Panel will install the update and reopen. Your files and settings stay in place; start your servers again when you are ready." : "Scheduled backups resume when you open MC Panel again. Closing the window keeps everything running in the system tray."}`,
        buttons: [
          "Keep running",
          installUpdate ? "Stop servers and update" : "Stop servers and quit",
        ],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) {
        quitting = false;
        return false;
      }
    }
    if (window && !window.isDestroyed()) {
      await flushRendererSelection(window.webContents);
      window.setTitle("Shutting down · MC Panel");
    }
    tray?.setToolTip("MC Panel — shutting down servers");
    await runtime?.close({ gracefulOnly: installUpdate });
    clearTimeout(initialUpdateTimer);
    clearInterval(updateTimer);
    tray?.destroy();
    canQuit = true;
    if (installUpdate)
      applyDownloadedUpdate(autoUpdater, (cause) => {
        void logError(cause);
        dialog.showErrorBox(
          "Update could not start",
          "Your servers have been stopped safely, but the update installer could not start. MC Panel will reopen so you can retry. Your server files and settings are unchanged. Details are in desktop.log.",
        );
        app.relaunch();
        app.exit(1);
      });
    else app.quit();
    return true;
  } catch (cause) {
    quitting = false;
    await logError(cause);
    if (cause.code === "PANEL_SELECTION_FLUSH_FAILED") {
      dialog.showErrorBox(
        "Server choice was not saved",
        "MC Panel could not save your selected server. The app and servers are still open. Try quitting or updating again.",
      );
      return false;
    }
    const { response } = await dialog.showMessageBox(window, {
      type: "error",
      title: "Shutdown did not finish",
      message: "MC Panel could not finish saving or stopping a server.",
      detail:
        "Details are in desktop.log. Exiting now could interrupt unfinished server writes. Open the log folder to investigate, or choose Exit now to close the app.",
      buttons: ["Open log folder", "Exit now"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) {
      canQuit = true;
      tray?.destroy();
      app.exit(1);
    } else await openFolder(userData);
    return false;
  }
}

function endWindowsSession() {
  // Windows does not emit before-quit on logout/shutdown. Start saving immediately
  // without blocking the OS logout with our ordinary interactive quit dialog.
  if (canQuit) return;
  quitting = true;
  canQuit = true;
  void Promise.resolve(runtime?.close())
    .catch(logError)
    .finally(() => app.quit());
}

function createMenus() {
  const dataFolder = path.join(userData, "data");
  const actions = [
    { label: "Open MC Panel", click: showWindow },
    { type: "separator" },
    {
      label: "Open server data folder",
      click: () => void openFolder(dataFolder),
    },
    {
      label: "Open downloads folder",
      click: () => void openFolder(app.getPath("downloads")),
    },
    { type: "separator" },
    {
      label: "Check for updates",
      click: () => {
        showWindow();
        updates?.check();
      },
    },
    { label: "Help and documentation", click: () => void openWebsite() },
    { label: "Quit MC Panel", click: () => void requestQuit() },
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Panel", submenu: actions },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  try {
    tray = new Tray(
      nativeImage.createFromPath(path.join(desktopDir, "assets", "icon.ico")),
    );
    tray.setToolTip("MC Panel — servers and backups keep running");
    tray.setContextMenu(Menu.buildFromTemplate(actions));
    tray.on("double-click", showWindow);
  } catch (cause) {
    void logError(cause);
    // If the tray cannot be created, the window's close button quits normally.
  }
}

async function launch() {
  const installed =
    app.isPackaged &&
    !process.env.PORTABLE_EXECUTABLE_FILE &&
    (await fs
      .access(
        path.join(path.dirname(app.getPath("exe")), "Uninstall MC Panel.exe"),
      )
      .then(
        () => true,
        () => false,
      ));
  const supported = process.platform === "win32" && installed && !smokeTest;
  updates = createUpdateController({
    updater: autoUpdater,
    version: app.getVersion(),
    supported,
    reason:
      "Install the Setup edition once to enable in-app updates. Portable and unpacked copies do not update themselves.",
    install: () => requestQuit(true),
    log: (cause) => void logError(cause),
  });
  runtime = await startDesktopRuntime({
    dataDir: path.join(userData, "data"),
    selectServerDirectory,
    updates,
  });
  const panelSession = session.fromPartition(`mc-panel-${randomUUID()}`);
  await panelSession.cookies.set({
    url: runtime.url,
    name: "mc-panel-desktop",
    value: runtime.token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  panelSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  panelSession.setPermissionCheckHandler(() => false);
  panelSession.webRequest.onHeadersReceived((details, callback) => {
    if (new URL(details.url).origin !== runtime.url)
      return callback({ responseHeaders: details.responseHeaders });
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://mc-heads.net https://cdn.modrinth.com https://media.forgecdn.net https://mediafilez.forgecdn.net https://www.spigotmc.org https://cdn.spiget.org https://cdn.feed-the-beast.com https://download.nodecdn.net https://apps.modpacks.ch https://cdn.atlauncher.com https://voidswrath.com https://www.voidswrath.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'",
        ],
      },
    });
  });
  panelSession.on("will-download", (event, item) => {
    if (new URL(item.getURL()).origin !== runtime.url) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      defaultPath: path.join(
        app.getPath("downloads"),
        path.basename(item.getFilename()),
      ),
      title: "Save server file",
    });
  });
  window = new BrowserWindow({
    title: "MC Panel",
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: "#101211",
    icon: path.join(desktopDir, "assets", "icon.ico"),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: panelSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  installExternalLinkHandlers(window.webContents, runtime.url, openWebsite);
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.on("close", (event) => {
    if (canQuit) return;
    event.preventDefault();
    if (tray && !quitting) window.hide();
    else void requestQuit();
  });
  window.on("query-session-end", endWindowsSession);
  window.on("session-end", endWindowsSession);
  createMenus();
  await window.loadURL(runtime.url);
  if (supported) {
    initialUpdateTimer = setTimeout(() => updates.check(), 30000);
    updateTimer = setInterval(() => updates.check(), 4 * 60 * 60 * 1000);
    initialUpdateTimer.unref();
    updateTimer.unref();
  }
  if (!smokeTest) showWindow();
}

if (!app.requestSingleInstanceLock()) {
  canQuit = true;
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    if (canQuit) return;
    event.preventDefault();
    void requestQuit();
  });
  app.on("window-all-closed", () => {
    if (!tray) void requestQuit();
  });
  startup = app.whenReady().then(launch);
  startup.catch(async (cause) => {
    await logError(cause);
    dialog.showErrorBox(
      "MC Panel could not start",
      "The desktop app could not open its local server. Check desktop.log in your MC Panel app data folder for details.",
    );
    await runtime?.close().catch(logError);
    canQuit = true;
    app.quit();
  });
}
