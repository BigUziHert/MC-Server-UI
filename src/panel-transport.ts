// The shared workspace captures destinations in the same scoped resource URL.
// Electron resolves it in main; browsers resolve it using their own saved
// connection registry. No page chooses an arbitrary credential or destination.
type BrowserPanelTransport = {
  fetch: (url: string, options?: RequestInit) => Promise<Response>;
  download: (url: string) => Promise<string>;
};

let browserTransport: BrowserPanelTransport | undefined;

export function registerBrowserPanelTransport(value: BrowserPanelTransport) {
  browserTransport = value;
}

export function getBrowserPanelTransport() {
  return browserTransport;
}
