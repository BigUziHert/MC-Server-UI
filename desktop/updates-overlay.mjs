export const CLOSE_UPDATES_CHANNEL = "mc-panel-updates:close";

// Keep updater authority on the local owner origin. The remote renderer only
// asks to open this overlay; it receives neither update state nor actions.
export function createUpdatesOverlay({
  WebContentsView,
  ipcMain,
  parent,
  origin,
  session,
  preload,
}) {
  const url = new URL("/?app-updates=1", origin).href;
  let current;
  let disposed = false;
  const resize = () => {
    if (!current || parent.isDestroyed()) return;
    const [width, height] = parent.getContentSize();
    current.view.setBounds({ x: 0, y: 0, width, height });
  };
  const dismiss = (record = current) => {
    if (!record || current !== record) return;
    current = undefined;
    record.background?.removeListener(
      "destroyed",
      record.onBackgroundDestroyed,
    );
    if (record.attached && !parent.isDestroyed())
      parent.contentView.removeChildView(record.view);
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    // CSS insertion can finish after close. Always remove that exact insertion.
    void record.blur
      ?.then((key) => {
        if (!record.background.isDestroyed())
          return record.background.removeInsertedCSS(key);
      })
      .catch(() => {});
    if (!disposed && !parent.isDestroyed() && !record.background?.isDestroyed())
      record.background?.focus();
  };
  const closeFromRenderer = (event) => {
    const contents = current?.view.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      contents.getURL() !== url ||
      contents.mainFrame.url !== url ||
      contents.mainFrame.origin !== new URL(origin).origin
    )
      return;
    dismiss();
  };
  const dispose = () => {
    disposed = true;
    dismiss();
    parent.removeListener("resize", resize);
    parent.removeListener("closed", dispose);
    ipcMain.removeListener(CLOSE_UPDATES_CHANNEL, closeFromRenderer);
  };
  parent.on("resize", resize);
  parent.on("closed", dispose);
  ipcMain.on(CLOSE_UPDATES_CHANNEL, closeFromRenderer);
  return {
    async open(background = parent.webContents) {
      if (disposed || parent.isDestroyed())
        throw new Error("MC Panel is shutting down.");
      if (current) {
        if (!current.view.webContents.isDestroyed())
          current.view.webContents.focus();
        return current.opening;
      }
      const view = new WebContentsView({
        webPreferences: {
          session,
          preload,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          spellcheck: false,
        },
      });
      view.setBackgroundColor("#00000000");
      const record = { view, background };
      current = record;
      record.onBackgroundDestroyed = () => dismiss(record);
      background?.once("destroyed", record.onBackgroundDestroyed);
      const contents = view.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-attach-webview", (event) => event.preventDefault());
      const restrictNavigation = (event, target) => {
        if (target !== url) event.preventDefault();
      };
      contents.on("will-navigate", restrictNavigation);
      contents.on("will-redirect", restrictNavigation);
      contents.once("destroyed", () => dismiss(record));
      contents.once("render-process-gone", () => dismiss(record));
      record.opening = contents
        .loadURL(url)
        .then(async () => {
          if (current !== record || parent.isDestroyed()) return;
          // Backdrop filters cannot cross renderer surfaces. Blur the underlying
          // view explicitly while the transparent local modal covers it.
          if (background && !background.isDestroyed()) {
            record.blur = background.insertCSS(
              ":root { filter: blur(3px) !important; pointer-events: none !important; }",
            );
            await record.blur.catch(() => {});
          }
          if (current !== record || parent.isDestroyed()) return;
          parent.contentView.addChildView(view);
          record.attached = true;
          resize();
          contents.focus();
        })
        .catch((cause) => {
          if (current !== record) return;
          dismiss(record);
          throw cause;
        });
      return record.opening;
    },
    dismiss,
    close: dispose,
  };
}
