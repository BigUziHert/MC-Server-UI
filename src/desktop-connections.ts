import { useEffect, useState } from "react";

export type PanelConnections = {
  activeId: string;
  panels: { id: string; label: string; origin: string; local: boolean }[];
};

declare global {
  interface Window {
    mcPanelConnections?: {
      list: () => Promise<PanelConnections>;
      open: (url: string) => Promise<PanelConnections>;
      activate: (id: string) => Promise<PanelConnections>;
      disconnect: (id: string) => Promise<PanelConnections>;
    };
  }
}

export function useDesktopConnections() {
  const [connections, setConnections] = useState<PanelConnections | null>(null);
  useEffect(() => {
    const bridge = window.mcPanelConnections;
    if (!bridge) return;
    let active = true;
    const refresh = () => {
      void bridge
        .list()
        .then((value) => {
          if (active) setConnections(value);
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
  }, []);
  return connections;
}
