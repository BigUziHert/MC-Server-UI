export function applyDownloadedUpdate(updater, onFailure) {
  let failed = false;
  const handle = (cause) => {
    if (failed) return;
    failed = true;
    onFailure(cause);
  };
  // electron-updater reports installer spawn failures as events, not rejected
  // promises. At this point servers have already stopped, so the main process
  // must recover the app instead of leaving a window with a closed API.
  updater.once("error", handle);
  try {
    updater.quitAndInstall(true, true);
  } catch (cause) {
    handle(cause);
  }
}

// The updater lives in Electron's main process; the renderer only gets status
// and three fixed actions, never a URL, executable path, or GitHub credential.
export function createUpdateController({
  updater,
  version,
  supported,
  reason = "",
  install,
  log = () => {},
  onInstallPending = () => {},
  installTimeoutMs = 125000,
}) {
  let state = {
    desktop: true,
    supported,
    version,
    channel: "dev",
    status: supported ? "idle" : "unsupported",
    availableVersion: null,
    progress: 0,
    checkedAt: null,
    message: supported
      ? "Check for a new build. Your server files and settings are kept when you update."
      : reason,
  };
  let operation;
  let installing = false;
  let timer;
  let watchdog;
  let disposed = false;
  const listeners = [];
  const on = (event, callback) => {
    updater.on(event, callback);
    listeners.push([event, callback]);
  };
  const snapshot = () => ({ ...state });
  const update = (changes) => {
    if (disposed) return;
    state = { ...state, ...changes };
  };
  const failed = (cause) => {
    log(cause);
    const missing =
      [
        "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
        "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
      ].includes(cause?.code) ||
      /404|channel.*not found/i.test(cause?.message || "");
    update({
      status: "error",
      message: missing
        ? "No published dev build is available yet. Try again after the Windows build finishes on GitHub."
        : "The update could not finish. Check your internet connection and try again. Details are in desktop.log.",
    });
  };
  if (supported) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = true;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    on("checking-for-update", () =>
      update({
        status: "checking",
        message: "Checking the latest successful dev build…",
      }),
    );
    on("update-available", (info) =>
      update({
        status: "available",
        availableVersion: info.version,
        progress: 0,
        checkedAt: new Date().toISOString(),
        message: "A new dev build is ready to download.",
      }),
    );
    on("update-not-available", () =>
      update({
        status: "current",
        availableVersion: null,
        checkedAt: new Date().toISOString(),
        message: "You have the latest published dev build.",
      }),
    );
    on("download-progress", (info) =>
      update({
        status: "downloading",
        progress: Math.max(0, Math.min(100, Number(info.percent) || 0)),
      }),
    );
    on("update-downloaded", (info) =>
      update({
        status: "downloaded",
        availableVersion: info.version,
        progress: 100,
        message:
          "Update downloaded. Restart MC Panel when you are ready to install it.",
      }),
    );
    on("error", failed);
  }
  const run = (action) => {
    if (disposed || !supported || operation || installing) return snapshot();
    operation = Promise.resolve()
      .then(() => (disposed ? undefined : action()))
      .catch(failed)
      .finally(() => {
        operation = undefined;
      });
    return snapshot();
  };
  return {
    snapshot,
    check() {
      if (["downloading", "downloaded", "installing"].includes(state.status))
        return snapshot();
      return run(() => updater.checkForUpdates());
    },
    download() {
      if (operation || installing || state.status !== "available")
        return snapshot();
      update({
        status: "downloading",
        progress: 0,
        message: "Downloading and verifying the update…",
      });
      return run(() => updater.downloadUpdate());
    },
    install() {
      if (!disposed && installing && state.status === "shutdown-waiting") {
        onInstallPending();
        return snapshot();
      }
      if (
        disposed ||
        !supported ||
        installing ||
        operation ||
        state.status !== "downloaded"
      )
        return snapshot();
      installing = true;
      update({
        status: "installing",
        message: "Preparing to restart MC Panel…",
      });
      // Yield the HTTP response before shutdown closes its authenticated runtime.
      timer = setTimeout(async () => {
        watchdog = setTimeout(() => {
          update({
            status: "shutdown-waiting",
            message:
              "Shutdown is taking longer than expected. Use the desktop shutdown dialog to keep waiting, inspect the logs, or explicitly exit. The update will wait for a safe shutdown.",
          });
          onInstallPending();
        }, installTimeoutMs);
        watchdog.unref?.();
        try {
          if (!(await install()))
            update({
              status: "downloaded",
              message: "Update is ready. Your servers are still running.",
            });
        } catch (cause) {
          log(cause);
          update({
            status: "downloaded",
            message:
              "The update could not be installed. Your downloaded update is still available; check desktop.log and retry.",
          });
        } finally {
          clearTimeout(watchdog);
          installing = false;
        }
      }, 150);
      return snapshot();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      for (const [event, callback] of listeners) updater.off(event, callback);
      listeners.length = 0;
    },
  };
}
