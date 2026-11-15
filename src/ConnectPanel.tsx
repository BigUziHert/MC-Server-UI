import WorkspaceConnectPanel from "./WorkspaceConnectPanel";
import LegacyConnectPanel from "./compat/LegacyConnectPanel";

export type ConnectionMode = "signin" | "invitation";

// Current browser and desktop sessions always use WorkspaceConnectPanel.
// Older released shells can load this host's frontend without a unified bridge.
// Keep that compatibility boundary explicit; see docs/legacy-desktop-compatibility.md.
export default function ConnectPanel(props: {
  desktop: boolean;
  initialMode?: ConnectionMode;
  initialUrl?: string;
  onClose: () => void;
  onOpened: () => void;
}) {
  return window.mcPanelConnections?.unified ? (
    <WorkspaceConnectPanel {...props} />
  ) : (
    <LegacyConnectPanel {...props} />
  );
}
