import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Plus, X } from "lucide-react";
import { EmptyFleet, ServerWorkspace } from "./App";
import {
  api,
  PanelScope,
  ServerScope,
  SessionActiveContext,
  SessionExpiredContext,
} from "./api";
import {
  useDesktopConnections,
  type PanelConnections,
} from "./desktop-connections";
import {
  DesktopWorkspaceContext,
  type WorkspaceSelection,
} from "./workspace-target";
import ServerManager, {
  ServerSwitcher,
  type ServerRecord,
} from "./ServerManager";
import PanelAccount from "./PanelAccount";
import PanelConnectionsDialog from "./PanelConnections";
import PanelSettings from "./PanelSettings";
import DesktopUpdates from "./DesktopUpdates";
import ConnectPanel, { type ConnectionMode } from "./ConnectPanel";
import { PropertyDraftsContext, type PropertyDraft } from "./property-drafts";
import { SessionScopeContext } from "./session-scope";
import { clearFileClipboard } from "./file-clipboard";
import { clearFileTransfers } from "./file-transfer-state";
import { clearRecoveryBatches } from "./recycle-action-state";
import { clearFileMoves } from "./pages/FileManager";
import "./workspace.css";

type Panel = PanelConnections["panels"][number];
type Manager = {
  panelId: string;
  epoch: string;
  editing: ServerRecord | null;
  step: "choice" | "create" | "import";
};
function managerAllowedFor(
  value: Manager,
  connections: PanelConnections | null,
  requireConnection = true,
) {
  if (value.panelId === "local") return true;
  const host = connections?.panels.find((item) => item.id === value.panelId);
  if (
    !host?.signedIn ||
    !host.session ||
    host.sessionEpoch !== value.epoch ||
    (requireConnection && host.connectionState !== "connected")
  )
    return false;
  return value.editing
    ? !!host.servers
        ?.find((item) => item.id === value.editing?.id)
        ?.accessPermissions?.includes("server.update")
    : !!host.session.hostPermissions?.includes("server.create");
}

export default function DesktopWorkspace() {
  const connections = useDesktopConnections();
  const currentConnections = useRef(connections);
  currentConnections.current = connections;
  const [localServers, setLocalServers] = useState<ServerRecord[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState("");
  const [selected, setSelected] = useState<WorkspaceSelection | null>(null);
  const [manager, setManager] = useState<Manager | null>(null);
  const currentManager = useRef<Manager | null>(null);
  const managerRevision = useRef(0);
  const changeManager = useCallback((value: Manager | null) => {
    managerRevision.current++;
    currentManager.current = value;
    setManager(value);
  }, []);
  const currentLocalServers = useRef(localServers);
  currentLocalServers.current = localServers;
  const currentSelection = useRef(selected);
  currentSelection.current = selected;
  const [chooseHost, setChooseHost] = useState<Manager["step"] | null>(null);
  const [connection, setConnection] = useState<ConnectionMode | null>(null);
  const [managingConnections, setManagingConnections] = useState(false);
  const manageConnections = useCallback(() => setManagingConnections(true), []);
  const [notice, setNotice] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const selectionRequest = useRef(0);
  const alive = useRef(true);
  const drafts = useRef(new Map<string, Map<string, PropertyDraft>>());
  const leases = useRef(new Map<string, () => boolean>());
  const refresh = useCallback(() => {
    setRefreshRevision((value) => value + 1);
    window.dispatchEvent(new Event("mc-panel-connections-changed"));
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      drafts.current.clear();
      leases.current.clear();
      clearFileClipboard();
      clearFileTransfers();
      clearRecoveryBatches();
      clearFileMoves();
    };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if ([...drafts.current.values()].some((items) => items.size))
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    let active = true;
    let running = false;
    const controller = new AbortController();
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const result = await api<{ servers: ServerRecord[] }>("/servers", {
          signal: controller.signal,
        });
        if (active) {
          setLocalServers(result.servers);
          setLocalError("");
        }
      } catch (cause) {
        if (active)
          setLocalError(
            cause instanceof Error
              ? cause.message
              : "This computer's servers could not be loaded.",
          );
      } finally {
        running = false;
        if (active) setLocalLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [refreshRevision]);
  useEffect(() => {
    if (connections) setSelected(connections.selectedServer ?? null);
  }, [
    connections?.selectedServer?.panelId,
    connections?.selectedServer?.serverId,
  ]);
  const select = useCallback(
    (panelId: string, serverId: string | null) => {
      const request = ++selectionRequest.current;
      const previousManager = currentManager.current;
      setSelecting(true);
      void window.mcPanelConnections!.selectServer!(panelId, serverId)
        .then(() => {
          if (!alive.current || selectionRequest.current !== request) return;
          setSelected(serverId ? { panelId, serverId } : null);
          if (currentManager.current === previousManager) changeManager(null);
          window.location.hash = "console";
          refresh();
        })
        .catch((cause) => {
          if (alive.current && selectionRequest.current === request)
            setNotice(cause.message);
        })
        .finally(() => {
          if (alive.current && selectionRequest.current === request)
            setSelecting(false);
        });
    },
    [refresh, changeManager],
  );
  useEffect(() => {
    if (
      !connections ||
      connections.ready === false ||
      localLoading ||
      selected ||
      selecting ||
      connections.selectedServer
    )
      return;
    const local = localServers[0];
    if (local) {
      select("local", local.id);
      return;
    }
    const remote = connections.panels.find(
      (panel) =>
        !panel.local &&
        panel.signedIn &&
        panel.connectionState === "connected" &&
        panel.session &&
        panel.servers?.length,
    );
    if (remote?.servers?.[0]) select(remote.id, remote.servers[0].id);
  }, [connections, localLoading, localServers, selected, selecting, select]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  const panels = connections?.panels ?? [];
  const panel =
    selected?.panelId !== "local"
      ? panels.find((item) => item.id === selected?.panelId)
      : undefined;
  const remote = Boolean(selected && selected.panelId !== "local");
  const available =
    !remote ||
    Boolean(
      panel?.signedIn && panel.session && panel.connectionState === "connected",
    );
  const roster = remote
    ? ((panel?.servers ?? []) as ServerRecord[])
    : localServers;
  const server = roster.find((item) => item.id === selected?.serverId);
  const scopeKey = (panelId: string, epoch: string) =>
    `desktop:${panelId}:${epoch}`;
  const scopeFor = (target: Panel | undefined) => {
    const panelId = target?.id ?? "local";
    const epoch = target?.sessionEpoch ?? "local";
    const key = scopeKey(panelId, epoch);
    if (!leases.current.has(key))
      leases.current.set(key, () => {
        if (!alive.current) return false;
        if (panelId === "local") return true;
        const current = currentConnections.current?.panels.find(
          (item) => item.id === panelId,
        );
        return current?.signedIn === true && current.sessionEpoch === epoch;
      });
    if (!drafts.current.has(key)) drafts.current.set(key, new Map());
    return {
      key,
      active: leases.current.get(key)!,
      drafts: drafts.current.get(key)!,
    };
  };
  const scope = scopeFor(remote ? panel : undefined);
  const transport = useMemo(
    () =>
      remote && panel
        ? {
            panelId: panel.id,
            sessionEpoch: panel.sessionEpoch ?? "",
            label: panel.label,
            origin: panel.origin,
            accountId: panel.session?.accountId ?? panel.session?.userId,
          }
        : null,
    [
      remote,
      panel?.id,
      panel?.sessionEpoch,
      panel?.label,
      panel?.origin,
      panel?.session?.accountId,
      panel?.session?.userId,
    ],
  );
  useEffect(() => {
    for (const [key, valid] of leases.current) {
      if (!valid()) {
        drafts.current.delete(key);
        leases.current.delete(key);
        clearFileClipboard(key);
        clearFileTransfers(key);
        clearRecoveryBatches(key);
        clearFileMoves(key);
      }
    }
    const value = currentManager.current;
    if (value && !managerAllowedFor(value, connections)) changeManager(null);
  }, [connections, changeManager]);
  const openManager = (
    panelId = "local",
    step: Manager["step"] = "choice",
    editing: ServerRecord | null = null,
  ) => {
    const host = panels.find((item) => item.id === panelId);
    setChooseHost(null);
    changeManager({
      panelId,
      epoch: host?.sessionEpoch ?? "local",
      step,
      editing,
    });
  };
  const add = (step: Manager["step"] = "choice") => {
    if (
      panels.some(
        (item) =>
          !item.local &&
          item.signedIn &&
          item.connectionState === "connected" &&
          item.session?.hostPermissions?.includes("server.create"),
      )
    ) {
      managerRevision.current++;
      setChooseHost(step);
    } else openManager("local", step);
  };
  const managerPanel =
    manager?.panelId !== "local"
      ? panels.find((item) => item.id === manager?.panelId)
      : undefined;
  const managerAllowed = manager && managerAllowedFor(manager, connections);
  const ownsManager = (value: Manager) =>
    alive.current &&
    currentManager.current === value &&
    managerAllowedFor(value, currentConnections.current);
  const managerScope = scopeFor(managerPanel);
  const permissions = remote ? (server?.accessPermissions ?? []) : undefined;
  const workspaceValue = useMemo(
    () => ({
      connections,
      localServers,
      selected,
      select,
      refresh,
      manageConnections,
    }),
    [connections, localServers, selected, select, refresh, manageConnections],
  );
  const expire = useCallback(() => {
    // A rejected scoped request refreshes only that host's session/permissions.
    if (transport)
      void window.mcPanelConnections
        ?.retry?.(transport.panelId)
        .catch(() => {});
    refresh();
  }, [transport, refresh]);

  return (
    <DesktopWorkspaceContext.Provider value={workspaceValue}>
      <SessionScopeContext.Provider value={scope.key}>
        <SessionActiveContext.Provider value={scope.active}>
          <SessionExpiredContext.Provider value={remote ? expire : null}>
            <PropertyDraftsContext.Provider value={scope.drafts}>
              <PanelScope.Provider value={transport}>
                {server && available ? (
                  <ServerScope.Provider value={server.id}>
                    <ServerWorkspace
                      key={`${scope.key}:${server.id}:${permissions?.join(",") ?? "owner"}`}
                      session={
                        remote ? (panel!.session ?? undefined) : undefined
                      }
                      permissions={permissions}
                      servers={roster}
                      selected={server}
                      onSelect={(id) => select(selected!.panelId, id)}
                      onAdd={() => add()}
                      onSettings={
                        !remote || permissions?.includes("server.update")
                          ? (status) =>
                              openManager(selected!.panelId, "choice", {
                                ...server,
                                status: status ?? server.status,
                              })
                          : undefined
                      }
                      onConnect={setConnection}
                      onSignedOut={expire}
                    />
                  </ServerScope.Provider>
                ) : selected ? (
                  <div className="app-shell workspace-unavailable">
                    <aside className="sidebar">
                      <a
                        className="brand"
                        href="#console"
                        aria-label="MC Panel home"
                      >
                        <span className="brand-icon">
                          <Box size={24} />
                        </span>
                        <span>
                          MC<span className="brand-light">PANEL</span>
                          <small>YOUR WORLD. YOUR RULES.</small>
                        </span>
                      </a>
                      <nav aria-label="Servers">
                        <ServerSwitcher
                          servers={localServers}
                          onSelect={(id) => select("local", id)}
                          onAdd={() => add()}
                        />
                      </nav>
                      <div className="sidebar-bottom">
                        <PanelAccount
                          targetPanelId={selected.panelId}
                          session={panel?.session ?? undefined}
                          onConnect={setConnection}
                        />
                      </div>
                    </aside>
                    <div className="main-shell">
                      <header className="topbar">
                        <span>{panel?.label ?? "This computer"}</span>
                        <div className="topbar-right">
                          <PanelSettings notify={setNotice} />
                          <DesktopUpdates />
                        </div>
                      </header>
                      <main className="workspace-unavailable-content">
                        <h1>
                          {!available
                            ? "Computer unavailable"
                            : "Server no longer available"}
                        </h1>
                        <p>
                          {!available
                            ? `${panel?.label ?? "This panel"} cannot be reached. Its known servers remain listed. Reconnect before starting server operations.`
                            : "This server was removed or is no longer shared with you. Select another server or manage this connection."}
                        </p>
                        {remote && panel && (
                          <button
                            className="btn primary"
                            onClick={() =>
                              void window.mcPanelConnections!.retry!(panel.id)
                                .then(refresh)
                                .catch((cause) => setNotice(cause.message))
                            }
                          >
                            Reconnect
                          </button>
                        )}
                        {localError && <p role="alert">{localError}</p>}
                      </main>
                    </div>
                  </div>
                ) : (
                  <EmptyFleet
                    canAddServer
                    onAdd={add}
                    onConnect={setConnection}
                    notify={setNotice}
                  />
                )}
              </PanelScope.Provider>
            </PropertyDraftsContext.Provider>
          </SessionExpiredContext.Provider>
        </SessionActiveContext.Provider>
      </SessionScopeContext.Provider>
      {localLoading && !connections && (
        <p className="workspace-status" role="status">
          Loading your computers…
        </p>
      )}
      {connection && (
        <ConnectPanel
          desktop
          initialMode={connection}
          onClose={() => setConnection(null)}
          onOpened={() => {
            setConnection(null);
            refresh();
          }}
        />
      )}
      {managingConnections && (
        <PanelConnectionsDialog onClose={() => setManagingConnections(false)} />
      )}
      {chooseHost && (
        <ChooseHost
          panels={panels}
          onClose={() => setChooseHost(null)}
          onSelect={(id) => openManager(id, chooseHost)}
        />
      )}
      {manager && managerAllowed && (
        <SessionScopeContext.Provider value={managerScope.key}>
          <SessionActiveContext.Provider value={managerScope.active}>
            <PropertyDraftsContext.Provider value={managerScope.drafts}>
              <PanelScope.Provider
                value={
                  managerPanel
                    ? {
                        panelId: manager.panelId,
                        sessionEpoch: manager.epoch,
                        label: managerPanel.label,
                        origin: managerPanel.origin,
                        accountId:
                          managerPanel.session?.accountId ??
                          managerPanel.session?.userId,
                      }
                    : null
                }
              >
                <ServerManager
                  key={`${manager.panelId}:${manager.epoch}:${manager.editing?.id ?? "new"}`}
                  editing={manager.editing}
                  remoteHost={managerPanel?.label}
                  initialStep={manager.step}
                  servers={
                    managerPanel
                      ? ((managerPanel.servers as ServerRecord[]) ?? [])
                      : localServers
                  }
                  onClose={() => {
                    if (ownsManager(manager)) changeManager(null);
                  }}
                  onSaved={(saved) => {
                    if (!ownsManager(manager)) return;
                    const target = manager.panelId;
                    const selection = selectionRequest.current;
                    const page = window.location.hash;
                    changeManager(null);
                    const revision = managerRevision.current;
                    const currentCompletion = () =>
                      alive.current &&
                      revision === managerRevision.current &&
                      selection === selectionRequest.current &&
                      page === window.location.hash &&
                      managerAllowedFor(
                        manager,
                        currentConnections.current,
                        false,
                      );
                    if (target === "local")
                      setLocalServers((items) =>
                        items.some((item) => item.id === saved.id)
                          ? items.map((item) =>
                              item.id === saved.id ? saved : item,
                            )
                          : [...items, saved],
                      );
                    void (
                      target === "local"
                        ? Promise.resolve()
                        : window.mcPanelConnections!.retry!(target)
                    )
                      .then((snapshot) => {
                        if (
                          !currentCompletion() ||
                          !managerAllowedFor(
                            manager,
                            snapshot ?? currentConnections.current,
                          )
                        )
                          return;
                        // Editing refreshes the existing page. A newly created
                        // server is selected only if the user has not moved on.
                        if (!manager.editing) select(target, saved.id);
                        else refresh();
                      })
                      .catch((cause) => {
                        if (currentCompletion()) setNotice(cause.message);
                      });
                    setNotice(
                      `${managerPanel?.label ?? "This computer"}: Server saved.`,
                    );
                    refresh();
                  }}
                  onRemoved={(removedId) => {
                    if (!ownsManager(manager)) return;
                    changeManager(null);
                    if (manager.panelId === "local") {
                      const remaining = currentLocalServers.current.filter(
                        (item) => item.id !== removedId,
                      );
                      setLocalServers(remaining);
                      if (
                        currentSelection.current?.panelId === "local" &&
                        currentSelection.current.serverId === removedId
                      )
                        select("local", remaining[0]?.id ?? null);
                    }
                    refresh();
                  }}
                />
              </PanelScope.Provider>
            </PropertyDraftsContext.Provider>
          </SessionActiveContext.Provider>
        </SessionScopeContext.Provider>
      )}
      {(notice || connections?.error) && (
        <div
          className="toast fleet-empty-toast"
          role={notice ? "status" : "alert"}
        >
          <span>{notice || connections?.error}</span>
          {notice && (
            <button
              aria-label="Dismiss server notification"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}
    </DesktopWorkspaceContext.Provider>
  );
}

function ChooseHost({
  panels,
  onClose,
  onSelect,
}: {
  panels: Panel[];
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="server-dialog"
      aria-labelledby="setup-computer-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="setup-computer-title">Choose a computer</h2>
      <p>
        Choose where to create or import the server. Files, Java, and
        installations stay on that computer.
      </p>
      <div className="workspace-host-choices">
        <button className="btn" onClick={() => onSelect("local")}>
          <Plus size={18} />
          This computer
        </button>
        {panels
          .filter(
            (panel) =>
              !panel.local &&
              panel.signedIn &&
              panel.connectionState === "connected" &&
              panel.session?.hostPermissions?.includes("server.create"),
          )
          .map((panel) => (
            <button
              key={panel.id}
              className="btn"
              onClick={() => onSelect(panel.id)}
            >
              <Plus size={18} />
              {panel.label}
            </button>
          ))}
      </div>
      <div className="server-dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
