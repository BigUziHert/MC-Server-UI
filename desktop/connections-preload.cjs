const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("mcPanelConnections", {
    list: () => ipcRenderer.invoke("mc-panel-connections:list"),
    open: (url) => ipcRenderer.invoke("mc-panel-connections:open", url),
    activate: (id) => ipcRenderer.invoke("mc-panel-connections:activate", id),
    disconnect: (id) =>
      ipcRenderer.invoke("mc-panel-connections:disconnect", id),
  });
  ipcRenderer.on("mc-panel-connections:changed", () => {
    window.dispatchEvent(new Event("mc-panel-connections-changed"));
  });
}
