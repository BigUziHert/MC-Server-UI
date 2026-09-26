const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("mcPanelUpdates", {
    close: () => ipcRenderer.send("mc-panel-updates:close"),
  });
}
