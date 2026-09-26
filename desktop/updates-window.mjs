// The updater belongs to this installation. Remote views may open this trusted
// local window, but never receive its state, owner cookie, or action API.
export function createUpdatesWindow({
  BrowserWindow,
  parent,
  origin,
  session,
  icon,
  show = true,
}) {
  const url = new URL("/?app-updates=1", origin).href;
  let window;
  let opening;
  let disposed = false;
  const reveal = () => {
    if (!window || window.isDestroyed() || !show) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  return {
    async open() {
      if (disposed || parent.isDestroyed())
        throw new Error("MC Panel is shutting down.");
      if (opening) return opening;
      if (window && !window.isDestroyed()) {
        reveal();
        return;
      }
      const child = new BrowserWindow({
        parent,
        title: "App updates · MC Panel",
        width: 560,
        height: 540,
        minWidth: 360,
        minHeight: 360,
        backgroundColor: "#101211",
        icon,
        show: false,
        webPreferences: {
          session,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          spellcheck: false,
        },
      });
      window = child;
      child.setMenu(null);
      child.on("page-title-updated", (event) => event.preventDefault());
      child.on("closed", () => {
        if (window === child) window = undefined;
      });
      const contents = child.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-attach-webview", (event) => event.preventDefault());
      const restrictNavigation = (event, target) => {
        if (target !== url) event.preventDefault();
      };
      contents.on("will-navigate", restrictNavigation);
      contents.on("will-redirect", restrictNavigation);
      opening = child
        .loadURL(url)
        .then(() => {
          if (window === child) reveal();
        })
        .catch((cause) => {
          if (!child.isDestroyed()) child.destroy();
          throw cause;
        })
        .finally(() => {
          opening = undefined;
        });
      return opening;
    },
    close() {
      disposed = true;
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}
