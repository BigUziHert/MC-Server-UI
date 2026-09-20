import { useEffect, useState } from "react";

export type PanelServer = {
  id: string;
  name: string;
  status: string;
  software?: string;
  minecraftVersion?: string;
};

export type PanelConnections = {
  activeId: string;
  panels: {
    id: string;
    label: string;
    origin: string;
    local: boolean;
    servers?: PanelServer[];
  }[];
  localServers: {
    id: string;
    name: string;
    status: string;
    software?: string;
    minecraftVersion?: string | null;
  }[];
};

declare global {
  interface Window {
    mcPanelConnections?: {
      list: () => Promise<PanelConnections>;
      open: (url: string) => Promise<PanelConnections>;
      activate: (id: string) => Promise<PanelConnections>;
      disconnect: (id: string) => Promise<PanelConnections>;
      selectLocalServer: (id: string) => Promise<PanelConnections>;
      selectRemoteServer: (
        panelId: string,
        serverId: string,
      ) => Promise<PanelConnections>;
      reportServers: (servers: PanelServer[] | null) => Promise<void>;
    };
  }
}

let rosterReport: Promise<void> = Promise.resolve();
let rosterRevision = 0;
export function reportDesktopServers(servers: PanelServer[] | null) {
  const bridge = window.mcPanelConnections;
  if (!bridge?.reportServers) return Promise.resolve();
  const revision = ++rosterRevision;
  // Logout clears follow any in-flight report, and replace queued stale reports.
  rosterReport = rosterReport
    .catch(() => {})
    .then(() => {
      if (revision !== rosterRevision) return;
      return bridge.reportServers(servers);
    });
  return rosterReport;
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
