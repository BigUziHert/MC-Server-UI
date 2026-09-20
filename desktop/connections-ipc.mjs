export const CONNECTION_CHANNELS = {
  list: "mc-panel-connections:list",
  open: "mc-panel-connections:open",
  activate: "mc-panel-connections:activate",
  disconnect: "mc-panel-connections:disconnect",
};

export function installConnectionIpc(ipcMain, controller) {
  for (const [action, channel] of Object.entries(CONNECTION_CHANNELS)) {
    ipcMain.handle(channel, (event, value) => {
      if (!controller.isManagedSender(event))
        throw new Error("This page cannot manage desktop connections.");
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
