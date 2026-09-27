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

// Only the persistent local main frame receives this control plane. Request
// bodies and file bytes use the authenticated streaming runtime route instead.
export function installUnifiedConnectionIpc(ipcMain, controller) {
  const actions = [
    "list",
    "open",
    "cancelSignIn",
    "signIn",
    "acceptInvitation",
    "signOut",
    "retry",
    "forget",
    "removeSavedConnection",
    "selectServer",
    "openUpdates",
  ];
  for (const action of actions) {
    ipcMain.handle(`mc-panel-unified:${action}`, (event, first, second) => {
      if (!controller.isManagedSender(event))
        throw new Error(
          "Only this computer's panel workspace can manage connections.",
        );
      if (["list", "openUpdates"].includes(action)) return controller[action]();
      if (
        typeof first !== "string" ||
        first.length > (action === "open" ? 2048 : 128)
      )
        throw new Error("Provide a valid panel connection.");
      if (
        action === "selectServer" &&
        second !== null &&
        (typeof second !== "string" || second.length > 128)
      )
        throw new Error("Provide a valid server selection.");
      if (
        action === "forget" &&
        (typeof second !== "string" || !second || second.length > 128)
      )
        throw new Error(
          "Confirm the signed-in account before forgetting this panel.",
        );
      if (
        action === "removeSavedConnection" &&
        (typeof second !== "string" || !second || second.length > 128)
      )
        throw new Error(
          "Confirm the current signed-out connection before removing it.",
        );
      return controller[action](first, second);
    });
  }
  return () => {
    for (const action of actions)
      ipcMain.removeHandler(`mc-panel-unified:${action}`);
  };
}
