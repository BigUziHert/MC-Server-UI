import { useEffect, useRef, useState } from "react";
import { Globe2, LogIn, LogOut, Monitor } from "lucide-react";
import AccountMenu, { type AccountMenuAction } from "./AccountMenu";
import { post } from "./api";
import type { ConnectionMode } from "./ConnectPanel";
import { useDesktopConnections } from "./desktop-connections";
import PanelConnections from "./PanelConnections";
import { useConfirmDiscardPropertyDrafts } from "./property-drafts";

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
  if (!window.mcPanelConnections) return null;
  return (
    <div className="desktop-panel-return">
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
      {error && <p role="alert">{error}</p>}
      <button
        className="btn panel-connections-open"
        type="button"
        onClick={() => setManage(true)}
      >
        <Globe2 size={15} /> Manage panel connections
      </button>
      {manage && <PanelConnections onClose={() => setManage(false)} />}
    </div>
  );
}

export default function PanelAccount({
  session,
  onSignedOut,
  onConnect,
}: {
  session?: PanelSession;
  onSignedOut?: () => void;
  onConnect: (mode: ConnectionMode) => void;
}) {
  const connections = useDesktopConnections();
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
  const actions: AccountMenuAction[] = (connections?.panels ?? [])
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
  if (session && window.mcPanelConnections)
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
    label: "Sign in to another panel",
    icon: <LogIn size={16} />,
    disabled: busy,
    onSelect: () => onConnect("signin"),
  });
  if (window.mcPanelConnections)
    actions.push({
      id: "connections",
      label: "Manage panel connections",
      icon: <Globe2 size={16} />,
      disabled: busy,
      onSelect: () => setManage(true),
    });
  if (session)
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
          session
            ? { name: session.email, detail: window.location.host }
            : {
                name: "Local administrator",
                detail: "This computer",
                initial: "L",
              }
        }
        status={
          session
            ? { label: "Signed in · Shared access", tone: "active" }
            : { label: "Local access", tone: "neutral" }
        }
        actions={actions}
      />
      {manage && <PanelConnections onClose={() => setManage(false)} />}
    </>
  );
}
