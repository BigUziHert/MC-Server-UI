import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
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
import { createRemotePanelController } from "./remote-panels.mjs";
import {
  createRemoteFrontend,
  configureRemoteCertificateVerification,
  PANEL_CONTENT_SECURITY_POLICY,
} from "./remote-frontend.mjs";
import { installPanelPermissionHandlers } from "./permissions.mjs";
import { installConnectionIpc } from "./connections-ipc.mjs";
import { createConnectionStore } from "./connection-store.mjs";
import { flushSelectionForQuit, waitForShutdown } from "./shutdown.mjs";
import {
  installExternalLinkHandlers,
  openExternalWebsite,
} from "./external-links.mjs";
import updaterPackage from "electron-updater";
import { applyDownloadedUpdate, createUpdateController } from "./updates.mjs";
import { createUpdatesWindow } from "./updates-window.mjs";

const { autoUpdater } = updaterPackage;

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const documentation =
  "https://github.com/BigUziHert/MC-Server-UI/tree/dev#readme";
const smokeTest = process.argv.includes("--smoke-test");
configureRemoteCertificateVerification(app.commandLine);
app.setName("MC Panel");
app.setAppUserModelId("com.biguzihert.mcpanel");

const userDataOverride = app.commandLine.getSwitchValue("user-data-dir");
const userData =
  userDataOverride || path.join(app.getPath("appData"), "MC Panel");
if (!path.isAbsolute(userData))
  throw new Error("The user data directory must be an absolute path.");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.setPath("sessionData", userData);

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
let remotePanels;
let removeConnectionIpc;
let updatesWindow;

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

async function selectServerDirectory({ purpose } = {}) {
  if (quitting || !window || window.isDestroyed()) return null;
  if (!directoryDialog) {
    directoryDialog = dialog
      .showOpenDialog(window, {
        title:
          purpose === "installation"
            ? "Choose an empty Minecraft installation folder"
            : "Choose existing Minecraft server folder",
        buttonLabel: "Use server folder",
        properties: [
          "openDirectory",
          "dontAddToRecent",
          ...(purpose === "installation" ? ["createDirectory"] : []),
        ],
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
  let shutdownStarted = false;
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
      const proceed = await flushSelectionForQuit({
        flush: () => flushRendererSelection(window.webContents),
        log: logError,
        confirm: async (cause) => {
          const { response } = await dialog.showMessageBox(window, {
            type: "warning",
            title: "Server choice was not saved",
            message:
              cause.reason === "timeout"
                ? "The panel window is not responding."
                : "MC Panel could not save the selected server.",
            detail:
              "You can cancel and try again, or continue without saving this choice. Your server files will still be saved and stopped normally.",
            buttons: [
              "Cancel",
              installUpdate
                ? "Update without saving the server choice"
                : "Quit without saving the server choice",
            ],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return response === 1;
        },
      });
      if (!proceed) {
        quitting = false;
        return false;
      }
      await flushRendererSelection({
        executeJavaScript: () =>
          window.webContents.executeJavaScript(
            "window.__mcPanelFlushPreferences?.()",
          ),
      }).catch(logError);
      window.setTitle("Shutting down · MC Panel");
    }
    tray?.setToolTip("MC Panel — shutting down servers");
    shutdownStarted = true;
    const finished = await waitForShutdown(
      (async () => {
        await runtime?.close({ gracefulOnly: true });
        removeConnectionIpc?.();
        await remotePanels?.close();
      })(),
      {
        prompt: async (signal) => {
          showWindow();
          const { response } = await dialog.showMessageBox(window, {
            type: "warning",
            title: "Shutdown is still waiting",
            message: "A Minecraft server is still saving or stopping.",
            detail:
              "MC Panel will keep waiting without interrupting server writes. You can inspect desktop.log or explicitly exit now. Exiting now can interrupt a world save and does not install a pending update.",
            buttons: ["Keep waiting", "Open log folder", "Exit now"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal,
          });
          return ["wait", "logs", "exit"][response] ?? "wait";
        },
        openLogs: () => openFolder(userData),
      },
    );
    if (!finished) {
      updates?.dispose();
      canQuit = true;
      tray?.destroy();
      app.exit(1);
      return false;
    }
    updates?.dispose();
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
      updates?.dispose();
      canQuit = true;
      tray?.destroy();
      app.exit(1);
    } else await openFolder(userData);
    return false;
  } finally {
    if (shutdownStarted) {
      clearTimeout(initialUpdateTimer);
      clearInterval(updateTimer);
    }
  }
}

function endWindowsSession() {
  // Windows does not emit before-quit on logout/shutdown. Start saving immediately
  // without blocking the OS logout with our ordinary interactive quit dialog.
  if (canQuit) return;
  quitting = true;
  canQuit = true;
  clearTimeout(initialUpdateTimer);
  clearInterval(updateTimer);
  updates?.dispose();
  void Promise.all([runtime?.close(), remotePanels?.close()])
    .catch(logError)
    .finally(() => app.quit());
}

function createTray() {
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
      label: updates?.snapshot().supported
        ? "Check for updates"
        : "Updates require the Setup edition",
      enabled: updates?.snapshot().supported === true,
      click: () => {
        showWindow();
        updates?.check();
        void updatesWindow?.open().catch(logError);
      },
    },
    { label: "Help and documentation", click: () => void openWebsite() },
    { label: "Quit MC Panel", click: () => void requestQuit() },
  ];
  try {
    tray = new Tray(
      nativeImage.createFromPath(path.join(desktopDir, "assets", "icon.ico")),
    );
    tray.setToolTip("MC Panel — servers and backups keep running");
    const trayMenu = Menu.buildFromTemplate(actions);
    tray.setContextMenu(trayMenu);
    tray.on("double-click", showWindow);
    // Main-process-only smoke inspection of the actual tray, never exposed to
    // the renderer or included in the connection bridge.
    if (smokeTest)
      globalThis.__mcPanelTraySmoke = () => ({
        alive: !tray.isDestroyed(),
        actions: trayMenu.items.map((item) => item.label),
        items: trayMenu.items.map((item) => ({
          label: item.label,
          enabled: item.enabled,
        })),
      });
  } catch (cause) {
    void logError(cause);
    // If the tray cannot be created, the window's close button quits normally.
  }
}

async function launch() {
  // Remove the native menu itself so Alt cannot reveal it.
  Menu.setApplicationMenu(null);
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
    onInstallPending: showWindow,
    log: (cause) => void logError(cause),
  });
  runtime = await startDesktopRuntime({
    dataDir: path.join(userData, "data"),
    selectServerDirectory,
    updates,
    openRemotePanel: (url) => {
      if (quitting)
        throw Object.assign(new Error("MC Panel is shutting down."), {
          status: 503,
        });
      return remotePanels.open(url);
    },
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
  panelSession.webRequest.onHeadersReceived((details, callback) => {
    if (new URL(details.url).origin !== runtime.url)
      return callback({ responseHeaders: details.responseHeaders });
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [PANEL_CONTENT_SECURITY_POLICY],
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
    webPreferences: {
      session: panelSession,
      preload: path.join(desktopDir, "connections-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.setMenu(null);
  updatesWindow = createUpdatesWindow({
    BrowserWindow,
    parent: window,
    origin: runtime.url,
    session: panelSession,
    icon: path.join(desktopDir, "assets", "icon.ico"),
  });
  window.on("closed", () => updatesWindow?.close());
  remotePanels = createRemotePanelController({
    window,
    localOrigin: runtime.url,
    WebContentsView,
    session,
    dialog,
    downloadsDirectory: app.getPath("downloads"),
    preload: path.join(desktopDir, "connections-preload.cjs"),
    openWebsite,
    openUpdatesWindow: () => updatesWindow.open(),
    remoteFrontend: await createRemoteFrontend({
      directory: path.join(desktopDir, "../dist"),
    }),
    store: createConnectionStore({ dataDir: path.join(userData, "data") }),
    onError: (cause) => void logError(cause),
    listLocalServers: () => runtime.listLocalServers(),
    selectLocalServer: async (id) => {
      await flushRendererSelection(window.webContents);
      return runtime.selectLocalServer(id);
    },
  });
  removeConnectionIpc = installConnectionIpc(ipcMain, remotePanels);
  window.on("page-title-updated", (event) => {
    if (remotePanels.list().activeId !== "local") event.preventDefault();
  });
  installPanelPermissionHandlers(
    panelSession,
    runtime.url,
    () => window?.webContents,
  );
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
  createTray();
  await window.loadURL(runtime.url);
  // The owner UI and servers are ready before any saved remote host is tried.
  // Independent restore attempts never hold startup or the local view hostage.
  void remotePanels.restore().catch(logError);
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
    updates?.dispose();
    canQuit = true;
    app.quit();
  });
}
