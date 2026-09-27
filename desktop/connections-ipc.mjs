export const CONNECTION_CHANNELS = {
  list: "mc-panel-connections:list",
  open: "mc-panel-connections:open",
  activate: "mc-panel-connections:activate",
  disconnect: "mc-panel-connections:disconnect",
  openUpdates: "mc-panel-connections:open-updates",
  selectLocalServer: "mc-panel-connections:select-local-server",
  reportServers: "mc-panel-connections:report-servers",
  selectRemoteServer: "mc-panel-connections:select-remote-server",
  openLocalServerSetup: "mc-panel-connections:open-local-server-setup",
  acknowledgeLocalServerSetup:
    "mc-panel-connections:acknowledge-local-server-setup",
};

export function installConnectionIpc(ipcMain, controller) {
  for (const [action, channel] of Object.entries(CONNECTION_CHANNELS)) {
    ipcMain.handle(channel, (event, value, serverId) => {
      if (!controller.isManagedSender(event))
        throw new Error("This page cannot manage desktop connections.");
      if (action === "openUpdates") return controller.openUpdates();
      if (action === "reportServers")
        return controller.reportServers(event, value);
      if (action === "openLocalServerSetup") {
        if (value !== "create" && value !== "import")
          throw new Error("Choose create or import for local server setup.");
        return controller.openLocalServerSetup(value);
      }
      if (action === "acknowledgeLocalServerSetup") {
        if (typeof value !== "string" || !value || value.length > 128)
          throw new Error("Provide a valid local setup request identifier.");
        return controller.acknowledgeLocalServerSetup(event, value);
      }
      if (action === "selectRemoteServer") {
        if (
          typeof value !== "string" ||
          value.length > 128 ||
          typeof serverId !== "string" ||
          serverId.length > 128
        )
          throw new Error("Provide a valid remote panel and server.");
        return controller.selectRemoteServer(value, serverId);
      }
      if (
        action !== "list" &&
        (typeof value !== "string" || value.length > 4096)
      )
        throw new Error("Provide a valid panel address or connection.");
      return action === "list"
        ? controller.list(event)
        : controller[action](value);
    });
  }
  return () => {
    for (const channel of Object.values(CONNECTION_CHANNELS))
      ipcMain.removeHandler(channel);
  };
}
