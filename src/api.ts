import { createContext, useContext, useMemo } from "react";
import {
  authenticatedFetch,
  saveSessionCredential,
  sessionRevision,
} from "./session-auth";

export const ServerScope = createContext<string | null>(null);
export type PanelTarget = {
  panelId: string;
  sessionEpoch: string;
  accountId?: string;
  label: string;
  origin: string;
};
export const PanelScope = createContext<PanelTarget | null>(null);
export const SessionExpiredContext = createContext<(() => void) | null>(null);
export const SessionActiveContext = createContext<() => boolean>(() => true);

export function messageOf(
  cause: unknown,
  fallback = "Something went wrong. Please try again.",
) {
  return cause instanceof Error ? cause.message : fallback;
}

export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const revision = sessionRevision();
  const proxied = isPanelProxyUrl(`/api${path}`);
  const sameSession = () => proxied || revision === sessionRevision();
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await authenticatedFetch(`/api${path}`, {
    ...options,
    headers,
  });
  if (!sameSession())
    throw Object.assign(
      new Error(
        "The signed-in account changed while this request was running.",
      ),
      { status: 409 },
    );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (!sameSession())
      throw Object.assign(
        new Error(
          "The signed-in account changed while this request was running.",
        ),
        { status: 409 },
      );
    throw Object.assign(
      new Error(body.error || `Request failed (${response.status})`),
      {
        status: response.status,
        ...(body.setupNotCreated === true ? { setupNotCreated: true } : {}),
        ...(Number.isSafeInteger(body.uploaded) && body.uploaded >= 0
          ? { uploaded: body.uploaded }
          : {}),
        ...(Number.isSafeInteger(body.directories) && body.directories >= 0
          ? { directories: body.directories }
          : {}),
        ...(Number.isSafeInteger(body.copiedFiles) && body.copiedFiles >= 0
          ? { copiedFiles: body.copiedFiles }
          : {}),
        ...(Number.isSafeInteger(body.copiedDirectories) &&
        body.copiedDirectories >= 0
          ? { copiedDirectories: body.copiedDirectories }
          : {}),
      },
    );
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!sameSession())
    throw Object.assign(
      new Error(
        "The signed-in account changed while this request was running.",
      ),
      { status: 409 },
    );
  if (["/access/login", "/access/accept"].includes(path) && body.sessionToken) {
    saveSessionCredential(body.sessionToken);
    delete body.sessionToken;
  }
  if (path === "/access/logout") saveSessionCredential(null);
  return body;
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

export function isPanelProxyUrl(value: string) {
  return /^\/api\/desktop\/panels\/[^/?#]+\/proxy\/api(?:\/|\?)/.test(value);
}

// Capture the destination in a resource URL as well as ordinary requests. The
// desktop broker validates the epoch and injects that panel's own credentials.
export function panelResourceUrl(
  panel: PanelTarget | null,
  path: string,
  serverId?: string | null,
) {
  const target = new URL(`/api${path}`, "https://panel.invalid");
  if (!path.startsWith("/") || path.startsWith("//") || target.hash)
    throw new Error("Choose an API path on the selected panel.");
  if (serverId) target.searchParams.set("serverId", serverId);
  if (!panel || panel.panelId === "local")
    return target.pathname + target.search;
  target.searchParams.set("desktopEpoch", panel.sessionEpoch);
  return `/api/desktop/panels/${encodeURIComponent(panel.panelId)}/proxy${target.pathname}${target.search}`;
}

function useBoundApi(serverId: string | null) {
  const panel = useContext(PanelScope);
  const onSessionExpired = useContext(SessionExpiredContext);
  const isSessionActive = useContext(SessionActiveContext);
  const panelId = panel?.panelId;
  const sessionEpoch = panel?.sessionEpoch;
  return useMemo(() => {
    const scopedApi = <T = any>(path: string, options: RequestInit = {}) => {
      // A background queue can outlive its workspace. Do not let its next
      // request use credentials from an account that signed in afterward.
      if (!isSessionActive())
        return Promise.reject<T>(
          Object.assign(
            new Error(
              "This session has ended. Sign in again before starting another operation.",
            ),
            { status: 401 },
          ),
        );
      const headers = new Headers(options.headers);
      if (serverId) headers.set("X-Server-Id", serverId);
      const resource =
        panel && panel.panelId !== "local"
          ? panelResourceUrl(
              panel,
              path,
              serverId ?? headers.get("X-Server-Id"),
            )
          : `/api${path}`;
      return api<T>(resource.slice("/api".length), { ...options, headers })
        .then((result) => {
          if (!isSessionActive())
            throw Object.assign(
              new Error(
                "This panel session ended while the request was running.",
              ),
              { status: 401 },
            );
          return result;
        })
        .catch((cause) => {
          if (cause?.status === 401 && isSessionActive()) onSessionExpired?.();
          throw cause;
        });
    };
    return {
      api: scopedApi,
      post: <T = any>(path: string, body: unknown = {}) =>
        scopedApi<T>(path, { method: "POST", body: JSON.stringify(body) }),
      downloadUrl: (path: string) => panelResourceUrl(panel, path, serverId),
      scopeKey: JSON.stringify([
        panelId ?? "browser",
        sessionEpoch ?? "",
        serverId,
      ]),
    };
  }, [panelId, sessionEpoch, serverId, onSessionExpired, isSessionActive]);
}
export function usePanelApi() {
  return useBoundApi(null);
}
// Bound clients outlive page navigation, but never their panel/account lease.
export function useServerApi() {
  return useBoundApi(useContext(ServerScope));
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
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)} ${Math.floor(seconds / 3600) === 1 ? "hour" : "hours"} ago`;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
export type PageProps = { notify: (message: string, error?: boolean) => void };
