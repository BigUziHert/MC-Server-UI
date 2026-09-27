import { useContext, useEffect, useRef, useState } from "react";
import { Globe2, LogIn, LogOut, Monitor } from "lucide-react";
import AccountMenu, { type AccountMenuAction } from "./AccountMenu";
import { post } from "./api";
import type { ConnectionMode } from "./ConnectPanel";
import { useDesktopConnections } from "./desktop-connections";
import PanelConnections from "./PanelConnections";
import { useConfirmDiscardPropertyDrafts } from "./property-drafts";
import { DesktopWorkspaceContext } from "./workspace-target";

export type PanelSession = {
  role: "subuser";
  accountId?: string;
  email: string;
  serverId: string | null;
  userId: string;
  permissions: string[];
  hostPermissions?: string[];
};

export function DesktopPanelReturn() {
  const [error, setError] = useState("");
  const [manage, setManage] = useState(false);
  const workspace = useContext(DesktopWorkspaceContext);
  if (!window.mcPanelConnections) return null;
  const unified = window.mcPanelConnections.unified === true;
  return (
    <div className="desktop-panel-return">
      {!unified && (
        <button
          className="btn"
          type="button"
          onClick={() => {
            setError("");
            void window
              .mcPanelConnections!.activate("local")
              .catch((cause) => setError(cause.message));
          }}
        >
          <Monitor size={15} /> Back to this computer
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="btn panel-connections-open"
        type="button"
        onClick={() =>
          unified && workspace ? workspace.manageConnections() : setManage(true)
        }
      >
        <Globe2 size={15} />{" "}
        {unified ? "Manage Connections" : "Manage panel connections"}
      </button>
      {manage && <PanelConnections onClose={() => setManage(false)} />}
    </div>
  );
}

export default function PanelAccount({
  session,
  onSignedOut,
  onConnect,
  targetPanelId,
}: {
  session?: PanelSession;
  onSignedOut?: () => void;
  onConnect: (mode: ConnectionMode) => void;
  targetPanelId?: string;
}) {
  const workspace = useContext(DesktopWorkspaceContext);
  const legacyConnections = useDesktopConnections(!workspace);
  const connections = workspace?.connections ?? legacyConnections;
  const confirmDiscardDrafts = useConfirmDiscardPropertyDrafts();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [manage, setManage] = useState(false);
  const unified = window.mcPanelConnections?.unified === true;
  const targetPanel =
    connections?.panels.find(
      (panel) =>
        panel.id ===
        (targetPanelId ??
          workspace?.selected?.panelId ??
          connections.selectedServer?.panelId ??
          "local"),
    ) ??
    (unified
      ? (connections?.panels.find((panel) => panel.local) ??
        connections?.panels.find((panel) => panel.signedIn) ??
        connections?.panels[0])
      : undefined);
  const hasLocalOwner =
    !unified || connections?.panels.some((panel) => panel.local);
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to complete this action. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const actions: AccountMenuAction[] = (
    unified ? [] : (connections?.panels ?? [])
  )
    .filter(
      (panel) =>
        !panel.local &&
        panel.signedIn === true &&
        panel.id !== connections?.activeId,
    )
    .map((panel) => ({
      id: panel.id,
      label: `Switch to ${panel.label}`,
      icon: <Globe2 size={16} />,
      disabled: busy,
      onSelect: () =>
        void perform(() => window.mcPanelConnections!.activate(panel.id)),
    }));
  if (!unified && session && window.mcPanelConnections)
    actions.unshift({
      id: "local",
      label: "Switch to this computer",
      icon: <Monitor size={16} />,
      disabled: busy,
      onSelect: () =>
        void perform(() => window.mcPanelConnections!.activate("local")),
    });
  actions.push({
    id: "signin",
    label: unified ? "Add Panel" : "Sign in to another panel",
    icon: <LogIn size={16} />,
    disabled: busy,
    onSelect: () => onConnect(unified ? "invitation" : "signin"),
  });
  if (window.mcPanelConnections)
    actions.push({
      id: "connections",
      label: unified ? "Manage Connections" : "Manage panel connections",
      icon: <Globe2 size={16} />,
      disabled: busy,
      onSelect: () =>
        unified && workspace ? workspace.manageConnections() : setManage(true),
    });
  if (!unified && session)
    actions.push({
      id: "signout",
      label: "Sign out",
      icon: <LogOut size={16} />,
      busy,
      onSelect: () => {
        if (!confirmDiscardDrafts()) return;
        void perform(async () => {
          try {
            await post("/access/logout");
          } catch (cause) {
            if ((cause as { status?: number }).status !== 401) throw cause;
          }
          if (mounted.current) onSignedOut?.();
        });
      },
    });
  return (
    <>
      {error && (
        <div className="panel-account-error" role="alert">
          {error}
        </div>
      )}
      <AccountMenu
        identity={
          unified && targetPanel && !targetPanel.local
            ? {
                name:
                  targetPanel.session?.email ??
                  (targetPanel.signedIn ? "Saved panel account" : "Signed out"),
                detail: targetPanel.label,
              }
            : session
              ? { name: session.email, detail: window.location.host }
              : hasLocalOwner
                ? {
                    name: "Local administrator",
                    detail: "This computer",
                    initial: "L",
                  }
                : { name: "Not signed in", detail: "Your panels" }
        }
        status={
          unified && targetPanel && !targetPanel.local
            ? {
                label:
                  targetPanel.connectionState === "unavailable"
                    ? "Panel unavailable"
                    : targetPanel.connectionState === "connecting"
                      ? "Connecting…"
                      : targetPanel.signedIn
                        ? "Signed in · Shared access"
                        : "Sign in to access servers",
                tone:
                  targetPanel.signedIn &&
                  targetPanel.connectionState === "connected"
                    ? "active"
                    : "neutral",
              }
            : session
              ? { label: "Signed in · Shared access", tone: "active" }
              : {
                  label: hasLocalOwner
                    ? "Local access"
                    : "Add a panel or sign in",
                  tone: "neutral",
                }
        }
        actions={actions}
      />
      {manage && <PanelConnections onClose={() => setManage(false)} />}
    </>
  );
}
