import {
  browserConnectionsKey,
  createBrowserConnectionController,
} from "../shared/browser-connections.mjs";
import { saveSessionCredential, sessionCredential } from "./session-auth";
import { registerBrowserPanelTransport } from "./panel-transport";
import type {} from "./desktop-connections";

let controller:
  ReturnType<typeof createBrowserConnectionController> | undefined;
let initialization: Promise<void> | undefined;

export function initializeBrowserConnections(): Promise<void> {
  if (
    window.mcPanelConnections &&
    window.mcPanelConnections.runtime !== "browser"
  )
    return Promise.resolve();
  if (initialization) return initialization;
  // Access storage through methods: blocked Web Storage must become a visible
  // save/read failure rather than crashing module evaluation or losing proof.
  controller = createBrowserConnectionController({
    origin: window.location.origin,
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    fetch: window.fetch.bind(window),
    legacyToken: sessionCredential,
    legacySelection: () =>
      window.localStorage.getItem("mc-panel.active-server"),
    homeCredential: saveSessionCredential,
    changed: () =>
      window.dispatchEvent(new Event("mc-panel-connections-changed")),
    lock: async (operation) =>
      await (navigator.locks
        ? navigator.locks.request("mc-panel-browser-connections", operation)
        : operation()),
  });
  window.mcPanelConnections = controller.bridge;
  registerBrowserPanelTransport({
    fetch: browserPanelFetch,
    download: browserPanelDownloadUrl,
  });
  window.addEventListener("storage", (event) => {
    if (event.key === browserConnectionsKey || event.key === null)
      controller?.storageChanged();
  });
  // pagehide also runs when the document enters the back/forward cache. Cancel
  // incomplete account attempts while retaining authenticated connections for
  // a later pageshow; closing the controller would break that restored page.
  window.addEventListener("pagehide", () => controller?.cancelAttempts());
  initialization = controller.initialize().then(() => undefined);
  return initialization;
}

export async function browserPanelFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!controller) await initializeBrowserConnections();
  if (!controller)
    throw new Error("Browser panel connections are unavailable.");
  return controller.fetch(url, options);
}

export async function browserPanelDownloadUrl(url: string): Promise<string> {
  if (!controller) await initializeBrowserConnections();
  if (!controller)
    throw new Error("Browser panel connections are unavailable.");
  return controller.download(url);
}
