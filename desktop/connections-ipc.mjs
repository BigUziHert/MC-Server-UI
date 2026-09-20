export const CONNECTION_CHANNELS = {
  list: "mc-panel-connections:list",
  open: "mc-panel-connections:open",
  activate: "mc-panel-connections:activate",
  disconnect: "mc-panel-connections:disconnect",
  selectLocalServer: "mc-panel-connections:select-local-server",
  reportServers: "mc-panel-connections:report-servers",
  selectRemoteServer: "mc-panel-connections:select-remote-server",
};

export function installConnectionIpc(ipcMain, controller) {
  for (const [action, channel] of Object.entries(CONNECTION_CHANNELS)) {
    ipcMain.handle(channel, (event, value, serverId) => {
      if (!controller.isManagedSender(event))
        throw new Error("This page cannot manage desktop connections.");
      if (action === "reportServers")
        return controller.reportServers(event, value);
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
      return action === "list" ? controller.list() : controller[action](value);
    });
  }
  return () => {
    for (const channel of Object.values(CONNECTION_CHANNELS))
      ipcMain.removeHandler(channel);
  };
}
