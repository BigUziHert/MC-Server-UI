const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  const invoke = (action, ...args) =>
    ipcRenderer.invoke(`mc-panel-unified:${action}`, ...args);
  contextBridge.exposeInMainWorld("mcPanelConnections", {
    unified: true,
    list: () => invoke("list"),
    open: (url) => invoke("open", url),
    signIn: (panelId, credentials) => invoke("signIn", panelId, credentials),
    acceptInvitation: (panelId, credentials) =>
      invoke("acceptInvitation", panelId, credentials),
    signOut: (panelId) => invoke("signOut", panelId),
    retry: (panelId) => invoke("retry", panelId),
    forget: (panelId) => invoke("forget", panelId),
    selectServer: (panelId, serverId) =>
      invoke("selectServer", panelId, serverId),
    openUpdates: () => invoke("openUpdates"),
  });
  ipcRenderer.on("mc-panel-connections:changed", () =>
    window.dispatchEvent(new Event("mc-panel-connections-changed")),
  );
  ipcRenderer.on("mc-panel-updates-open", () =>
    window.dispatchEvent(new Event("mc-panel-updates-open")),
  );
}
