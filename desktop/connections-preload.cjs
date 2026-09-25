const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  ipcRenderer.on("mc-panel-updates-open", () => {
    window.dispatchEvent(new Event("mc-panel-updates-open"));
  });
  contextBridge.exposeInMainWorld("mcPanelConnections", {
    list: () => ipcRenderer.invoke("mc-panel-connections:list"),
    open: (url) => ipcRenderer.invoke("mc-panel-connections:open", url),
    activate: (id) => ipcRenderer.invoke("mc-panel-connections:activate", id),
    disconnect: (id) =>
      ipcRenderer.invoke("mc-panel-connections:disconnect", id),
    openUpdates: () => ipcRenderer.invoke("mc-panel-connections:open-updates"),
    selectLocalServer: (id) =>
      ipcRenderer.invoke("mc-panel-connections:select-local-server", id),
    reportServers: (servers) =>
      ipcRenderer.invoke("mc-panel-connections:report-servers", servers),
    selectRemoteServer: (panelId, serverId) =>
      ipcRenderer.invoke(
        "mc-panel-connections:select-remote-server",
        panelId,
        serverId,
      ),
  });
  ipcRenderer.on("mc-panel-connections:changed", () => {
    window.dispatchEvent(new Event("mc-panel-connections-changed"));
  });
  ipcRenderer.on("mc-panel-local-server-selected", (_event, serverId) => {
    if (typeof serverId === "string")
      window.dispatchEvent(
        new CustomEvent("mc-panel-local-server-selected", {
          detail: { serverId },
        }),
      );
  });
  ipcRenderer.on("mc-panel-remote-server-selected", (_event, serverId) => {
    if (typeof serverId === "string")
      window.dispatchEvent(
        new CustomEvent("mc-panel-remote-server-selected", {
          detail: { serverId },
        }),
      );
  });
}
