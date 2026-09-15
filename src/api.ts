import { createContext, useContext, useMemo } from "react";

export const ServerScope = createContext<string | null>(null);

export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(
      new Error(body.error || `Request failed (${response.status})`),
      {
        status: response.status,
      },
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const post = <T = any>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

let desktopSelectionWrite: Promise<unknown> = Promise.resolve();
let latestDesktopSelection: string | null | undefined;
export function saveDesktopSelection(activeServerId: string | null) {
  latestDesktopSelection = activeServerId;
  desktopSelectionWrite = desktopSelectionWrite
    .catch(() => {})
    .then(() =>
      api("/desktop/selection", {
        method: "PUT",
        body: JSON.stringify({ activeServerId }),
        keepalive: true,
      }),
    );
  return desktopSelectionWrite;
}
export async function flushDesktopSelection() {
  let retried = false;
  for (;;) {
    const observed = desktopSelectionWrite;
    try {
      await observed;
    } catch (cause) {
      if (observed !== desktopSelectionWrite) continue;
      if (retried || latestDesktopSelection === undefined) throw cause;
      retried = true;
      saveDesktopSelection(latestDesktopSelection);
      continue;
    }
    if (observed === desktopSelectionWrite) return;
  }
}

declare global {
  interface Window {
    __mcPanelFlushSelection?: () => Promise<unknown>;
  }
}
// Native Quit uses the same pending-save barrier as the in-app update action.
// This exposes no Node.js capabilities or credentials to the renderer.
window.__mcPanelFlushSelection = flushDesktopSelection;

// Bind requests and downloads to the mounted workspace, including async work
// that finishes after the user switches servers. No mutable global selector.
export function useServerApi() {
  const serverId = useContext(ServerScope);
  return useMemo(() => {
    const scopedApi = <T = any>(path: string, options: RequestInit = {}) => {
      const headers = new Headers(options.headers);
      if (serverId) headers.set("X-Server-Id", serverId);
      return api<T>(path, { ...options, headers });
    };
    return {
      api: scopedApi,
      post: <T = any>(path: string, body: unknown = {}) =>
        scopedApi<T>(path, { method: "POST", body: JSON.stringify(body) }),
      downloadUrl: (path: string) =>
        `/api${path}${serverId ? `${path.includes("?") ? "&" : "?"}serverId=${encodeURIComponent(serverId)}` : ""}`,
    };
  }, [serverId]);
}
export function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB"][unit]}`;
}
export function relativeTime(value: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
export type PageProps = { notify: (message: string, error?: boolean) => void };
