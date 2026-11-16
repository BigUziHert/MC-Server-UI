import { createContext } from "react";
import type { PanelConnections } from "./desktop-connections";
import type { ServerRecord } from "./ServerManager";

export type WorkspaceSelection = { panelId: string; serverId: string };

// One persistent desktop workspace owns the complete roster. Every page uses
// the same selection tuple; server IDs alone are only unique within a panel.
export const DesktopWorkspaceContext = createContext<{
  connections: PanelConnections | null;
  localServers: ServerRecord[];
  selected: WorkspaceSelection | null;
  select: (panelId: string, serverId: string) => void;
  refresh: () => void;
  manageConnections: () => void;
} | null>(null);
