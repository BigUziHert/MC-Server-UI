import { useEffect, useState } from "react";
import { authenticatedFetch } from "./session-auth";
import type { PanelSession } from "./PanelAccount";
import type { ServerRecord } from "./ServerManager";

export type PanelServer = Omit<
  Partial<ServerRecord>,
  "id" | "name" | "status" | "minecraftVersion"
> & {
  id: string;
  name: string;
  status: string;
  software?: string;
  minecraftVersion?: string;
  iconDataUrl?: string;
};

export type PanelConnections = {
  unified?: boolean;
  ready?: boolean;
  error?: string;
  selectedServer?: { panelId: string; serverId: string } | null;
  activeId?: string;
  // Only the trusted local renderer receives requests to open its setup UI.
  pendingLocalServerSetup?: { id: string; step: "create" | "import" } | null;
  panels: {
    id: string;
    label: string;
    origin: string;
    local: boolean;
    // An address verified for a sign-in form, not yet a saved connection.
    temporary?: boolean;
    // A saved sign-in may remain true while offline. Cached roster rows never
    // authorize requests; live session metadata and permissions are rechecked.
    signedIn?: boolean;
    // A durable self-removal request must be confirmed before credentials or
    // certificate trust can be removed. Only Forget retries are allowed.
    pendingLeave?: boolean;
    session?: PanelSession | null;
    sessionEpoch?: string;
    error?: string;
    connectionState?: "connecting" | "unavailable" | "connected";
    servers?: PanelServer[];
  }[];
  localServers: {
    id: string;
    name: string;
    status: string;
    software?: string;
    minecraftVersion?: string | null;
    iconDataUrl?: string;
  }[];
};

declare global {
  interface Window {
    mcPanelUpdates?: { close: () => void };
    mcPanelConnections?: {
      runtime?: "desktop" | "browser";
      unified?: boolean;
      list: () => Promise<PanelConnections>;
      open: (
        url: string,
      ) => Promise<PanelConnections & { openedPanelId?: string }>;
      activate: (id: string) => Promise<PanelConnections>;
      openUpdates?: () => Promise<void>;
      openLocalServerSetup?: (
        step: "create" | "import",
      ) => Promise<PanelConnections>;
      acknowledgeLocalServerSetup?: (id: string) => Promise<void>;
      disconnect: (id: string) => Promise<PanelConnections>;
      selectLocalServer: (id: string) => Promise<PanelConnections>;
      selectRemoteServer: (
        panelId: string,
        serverId: string,
      ) => Promise<PanelConnections>;
      reportServers: (servers: PanelServer[] | null) => Promise<void>;
      signIn?: (
        panelId: string,
        input: { email: string; password: string },
      ) => Promise<PanelConnections>;
      acceptInvitation?: (
        panelId: string,
        input: { token: string; password: string },
      ) => Promise<PanelConnections>;
      invitation?: (
        panelId: string,
        input: { token: string },
      ) => Promise<{
        email: string;
        panelAddress: string;
        inviteExpiresAt: string;
      }>;
      cancelSignIn?: (panelId: string) => Promise<void | PanelConnections>;
      signOut?: (panelId: string) => Promise<PanelConnections>;
      retry?: (panelId: string) => Promise<PanelConnections>;
      forget?: (
        panelId: string,
        expectedAccountId?: string,
      ) => Promise<PanelConnections>;
      removeSavedConnection?: (
        panelId: string,
        expectedEpoch: string,
      ) => Promise<PanelConnections>;
      selectServer?: (
        panelId: string,
        serverId: string | null,
      ) => Promise<PanelConnections>;
    };
  }
}

let rosterReport: Promise<void> = Promise.resolve();
let rosterRevision = 0;
const iconCache = new Map<
  string,
  {
    version: string;
    dataUrl?: string;
    pending?: Promise<void>;
    abort: AbortController;
  }
>();
const maxRosterIconCharacters = 4 * 1024 * 1024;

async function fetchDesktopIcon(
  serverId: string,
  version: string,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ serverId, v: version });
  const response = await authenticatedFetch(`/api/server/icon?${query}`, {
    credentials: "same-origin",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("image/png")
  )
    throw new Error("Server icon unavailable.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Server icon unavailable.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) throw new Error("Server icon is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let binary = "";
  for (const chunk of chunks)
    for (let offset = 0; offset < chunk.length; offset += 8192)
      binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
  return `data:image/png;base64,${btoa(binary)}`;
}

export function reportDesktopServers(
  servers: (PanelServer & { iconVersion?: string })[] | null,
) {
  const bridge = window.mcPanelConnections;
  if (!bridge?.reportServers) return Promise.resolve();
  const revision = ++rosterRevision;
  const versions = new Map(
    servers?.map((server) => [server.id, server.iconVersion]),
  );
  for (const [id, entry] of iconCache) {
    if (versions.get(id) !== entry.version) {
      entry.abort.abort();
      iconCache.delete(id);
    }
  }
  const snapshot = (): PanelServer[] | null => {
    if (!servers) return null;
    let remaining = maxRosterIconCharacters;
    return servers.map(
      ({ iconVersion: _version, iconDataUrl: _icon, ...server }) => {
        const dataUrl = iconCache.get(server.id)?.dataUrl;
        if (!dataUrl || dataUrl.length > remaining) return server;
        remaining -= dataUrl.length;
        return { ...server, iconDataUrl: dataUrl };
      },
    );
  };
  const publish = () => {
    // Logout clears follow any in-flight report and supersede queued metadata
    // and icon reports. A late image response cannot restore an expired roster.
    rosterReport = rosterReport
      .catch(() => {})
      .then(() => {
        if (revision === rosterRevision)
          return bridge.reportServers(snapshot());
      });
    return rosterReport;
  };
  const initial = publish();
  if (!servers?.some((server) => server.iconVersion)) return initial;
  const fillIcons = async () => {
    // Keep metadata/selection responsive while the sending session fetches its
    // own icons. Bound both concurrent downloads and retained image payload.
    let index = 0;
    const retained = () =>
      [...iconCache.values()].reduce(
        (total, entry) => total + (entry.dataUrl?.length ?? 0),
        0,
      );
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (revision === rosterRevision && index < servers.length) {
          const server = servers[index++];
          if (!server.iconVersion || retained() >= maxRosterIconCharacters)
            continue;
          let entry = iconCache.get(server.id);
          if (!entry) {
            entry = {
              version: server.iconVersion,
              abort: new AbortController(),
            };
            iconCache.set(server.id, entry);
          }
          if (entry.dataUrl) continue;
          const current = entry;
          current.pending ??= fetchDesktopIcon(
            server.id,
            current.version,
            current.abort.signal,
          )
            .then((dataUrl) => {
              if (
                iconCache.get(server.id) !== current ||
                current.abort.signal.aborted
              )
                return;
              if (retained() + dataUrl.length <= maxRosterIconCharacters) {
                current.dataUrl = dataUrl;
              }
            })
            .catch(() => {})
            .finally(() => {
              current.pending = undefined;
            });
          await current.pending;
        }
      }),
    );
    if (revision === rosterRevision) await publish();
  };
  return Promise.all([initial, fillIcons()]).then(() => undefined);
}

export function useDesktopConnections(enabled = true) {
  const [connections, setConnections] = useState<PanelConnections | null>(null);
  useEffect(() => {
    const bridge = window.mcPanelConnections;
    if (!enabled || !bridge) return;
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void bridge
        .list()
        .then((value) => {
          if (active && current === request) setConnections(value);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("mc-panel-connections-changed", refresh);
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("mc-panel-connections-changed", refresh);
      clearInterval(timer);
    };
  }, [enabled]);
  return connections;
}
