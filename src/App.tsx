import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  Box,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cloud,
  Copy,
  Cpu,
  ExternalLink,
  FileText,
  FolderOpen,
  HardDrive,
  Layers3,
  ListFilter,
  Menu,
  MessageSquare,
  MemoryStick,
  Pencil,
  Puzzle,
  Tags,
  SlidersHorizontal,
  Play,
  Plus,
  RotateCw,
  Search,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  Users,
  X,
} from "lucide-react";
import {
  api as fleetApi,
  formatBytes,
  saveDesktopSelection,
  ServerScope,
  useServerApi,
} from "./api";
import FileManager from "./pages/FileManager";
import Backups from "./pages/Backups";
import Subusers from "./pages/Subusers";
import AuditLogs from "./pages/AuditLogs";
import Players from "./pages/Players";
import Versions from "./pages/Versions";
import Launchpad from "./pages/Launchpad";
import Properties from "./pages/Properties";
import PlayerHead from "./PlayerHead";
import SearchField from "./SearchField";
import DesktopUpdates from "./DesktopUpdates";
import ServerIcon from "./ServerIcon";
import { version as appVersion } from "../package.json";
import ServerManager, {
  ServerSwitcher,
  type ServerRecord,
} from "./ServerManager";

type Page =
  | "console"
  | "files"
  | "players"
  | "versions"
  | "launchpad"
  | "properties"
  | "subusers"
  | "backups"
  | "audit";
type Server = {
  name: string;
  address: string;
  status: "running" | "offline" | "starting" | "stopping";
  mode: "demo" | "live";
  version: string | null;
  software: string;
  uptime: number;
  cpu: number | null;
  cpuCapacity?: number;
  memory: number | null;
  metricsMessage?: string;
  iconVersion?: string | null;
  serverIconVersion?: string | null;
  iconPreference?: "server" | "default";
  addressSource?: "public" | "custom" | "local";
  addressNote?: string;
  memoryLimit: number | null;
  memoryLimitSource?: "panel" | "launch" | "unknown";
  memoryLimitState?: "configured" | "started";
  disk: number;
  diskLimit: number;
  diskAvailable?: number;
  players: { name: string; uuid?: string; latency?: number | null }[];
  maxPlayers: number;
  metricsAvailable?: boolean;
  playersAvailable?: boolean;
};
type LogLine = {
  id: string | number;
  time: string;
  level: string;
  message: string;
};
const navigationGroups = [
  { id: "server", label: "SERVER" },
  { id: "minecraft", label: "MINECRAFT" },
  { id: "management", label: "MANAGEMENT" },
] as const;
type NavigationGroup = (typeof navigationGroups)[number]["id"];
const navigationStorageKey = "mc-panel.navigation-collapsed";
function readCollapsedNavigation(): Record<NavigationGroup, boolean> {
  try {
    const saved = JSON.parse(
      localStorage.getItem(navigationStorageKey) || "null",
    );
    return {
      server: saved?.server === true,
      minecraft: saved?.minecraft === true,
      management: saved?.management === true,
    };
  } catch {
    return { server: false, minecraft: false, management: false };
  }
}
const navigation = [
  { id: "console", label: "Console", icon: Terminal, group: "server" },
  { id: "files", label: "File Manager", icon: FolderOpen, group: "server" },
  { id: "players", label: "Players", icon: ShieldCheck, group: "server" },
  { id: "versions", label: "Versions", icon: Tags, group: "minecraft" },
  { id: "launchpad", label: "Launchpad", icon: Puzzle, group: "minecraft" },
  {
    id: "properties",
    label: "Properties",
    icon: SlidersHorizontal,
    group: "minecraft",
  },
  { id: "subusers", label: "Subusers", icon: Users, group: "management" },
  { id: "backups", label: "Backups", icon: Cloud, group: "management" },
  { id: "audit", label: "Audit Logs", icon: FileText, group: "management" },
] as const;
function getPage(): Page {
  const hash = window.location.hash.slice(1);
  return navigation.some((n) => n.id === hash) ? (hash as Page) : "console";
}
function uptime(seconds: number) {
  return seconds < 60
    ? `${Math.floor(seconds)}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function useDialogFocus(open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(
      ".modal-backdrop .modal",
    );
    if (!dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      );
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [open]);
}

function Sparkline({
  values,
  color = "#ffd000",
}: {
  values: number[];
  color?: string;
}) {
  const max = Math.max(...values, 1) * 1.25;
  const points = values
    .map(
      (v, i) =>
        `${(i / Math.max(values.length - 1, 1)) * 260},${45 - (v / max) * 35}`,
    )
    .join(" ");
  return (
    <svg
      className="sparkline"
      viewBox="0 0 260 50"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={`fade-${color.slice(1)}`}
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop offset="0%" stopColor={color} stopOpacity=".15" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,50 ${points} 260,50`}
        fill={`url(#fade-${color.slice(1)})`}
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.7"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function App() {
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [activeId, setActiveId] = useState(() => {
    try {
      return localStorage.getItem("mc-panel.active-server") || "";
    } catch {
      return "";
    }
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [manager, setManager] = useState<{
    editing: ServerRecord | null;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const fleetRequest = useRef(0);
  const fleetInFlight = useRef(false);
  const desktopSelection = useRef<boolean | null>(null);
  const persistedSelection = useRef("");
  const [selectionReady, setSelectionReady] = useState(false);
  const loadServers = useCallback(async (showLoading = false) => {
    if (fleetInFlight.current) return;
    fleetInFlight.current = true;
    const request = ++fleetRequest.current;
    if (showLoading) {
      setLoading(true);
      setError("");
    }
    try {
      const [result, selection] = await Promise.all([
        fleetApi<{
          servers: ServerRecord[];
          defaultServerId: string | null;
        }>("/servers", { signal: AbortSignal.timeout(10_000) }),
        desktopSelection.current === null
          ? fleetApi<{ desktop: boolean; activeServerId: string | null }>(
              "/desktop/selection",
              { signal: AbortSignal.timeout(10_000) },
            ).catch((cause) => {
              // Browser runtimes do not provide desktop preferences. A failed
              // desktop read must be retried before mounting any server workspace.
              if (cause instanceof SyntaxError || cause?.status === 404)
                return null;
              throw cause;
            })
          : Promise.resolve(null),
      ]);
      if (request !== fleetRequest.current) return;
      if (desktopSelection.current === null) {
        desktopSelection.current = selection?.desktop === true;
        persistedSelection.current = selection?.activeServerId ?? "";
      }
      setServers(result.servers);
      setActiveId((current) => {
        const preferred = selection?.activeServerId || current;
        return result.servers.some((server) => server.id === preferred)
          ? preferred
          : (result.servers.find(
              (server) => server.id === result.defaultServerId,
            )?.id ??
              result.servers[0]?.id ??
              "");
      });
      setSelectionReady(true);
      setError("");
    } catch (cause) {
      if (request === fleetRequest.current)
        setError(
          cause instanceof Error && cause.name === "TimeoutError"
            ? "The local panel took too long to respond. Try connecting again."
            : cause instanceof Error
              ? cause.message
              : "The local panel could not be reached.",
        );
    } finally {
      fleetInFlight.current = false;
      if (request === fleetRequest.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadServers(true);
    const timer = setInterval(() => void loadServers(), 5000);
    return () => clearInterval(timer);
  }, [loadServers]);
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem("mc-panel.active-server", activeId);
      else localStorage.removeItem("mc-panel.active-server");
    } catch {
      /* Selection still works without browser storage. */
    }
  }, [activeId]);
  useEffect(() => {
    if (
      !selectionReady ||
      !desktopSelection.current ||
      persistedSelection.current === activeId
    )
      return;
    persistedSelection.current = activeId;
    void saveDesktopSelection(activeId || null).catch(() => {
      setNotice(
        "Your server was selected, but the choice could not be saved for the next app launch.",
      );
    });
  }, [activeId, selectionReady]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const active = servers.find((server) => server.id === activeId);
  useEffect(() => {
    if (!active)
      document.title = `${loading ? "Opening" : error ? "Connection error" : "Welcome"} · MC Panel`;
  }, [active, error, loading]);
  const saved = (server: ServerRecord) => {
    fleetRequest.current++;
    setLoading(false);
    setError("");
    setServers((current) =>
      current.some((item) => item.id === server.id)
        ? current.map((item) => (item.id === server.id ? server : item))
        : [...current, server],
    );
    setActiveId(server.id);
    if (!manager?.editing) window.location.hash = "console";
    setNotice(
      manager?.editing
        ? "Server settings saved."
        : server.source === "imported"
          ? "Server imported. Your files stay in their original folder."
          : "Server created. Your new workspace is ready.",
    );
    setManager(null);
    void loadServers();
  };
  const removed = (serverId: string) => {
    fleetRequest.current++;
    setServers((current) => current.filter((server) => server.id !== serverId));
    setActiveId((current) =>
      current === serverId
        ? (servers.find((server) => server.id !== serverId)?.id ?? "")
        : current,
    );
    setLoading(false);
    setError("");
    setManager(null);
    setNotice(
      "Server removed from the panel. Its files and backups are still on disk.",
    );
    void loadServers();
  };
  return (
    <>
      {active ? (
        <ServerScope.Provider value={active.id}>
          <ServerWorkspace
            key={active.id}
            servers={servers}
            selected={active}
            onSelect={setActiveId}
            onAdd={() => setManager({ editing: null })}
            onSettings={(status) =>
              setManager({
                editing: { ...active, status: status ?? active.status },
              })
            }
          />
        </ServerScope.Provider>
      ) : loading || error ? (
        <div
          className="server-workspace-loading"
          role={error ? "alert" : "status"}
        >
          <span className="fleet-loading-mark">
            <Box size={33} />
          </span>
          <h1>{error ? "Unable to load your servers" : "Opening MC Panel…"}</h1>
          <p>{error || "Connecting to your local server panel."}</p>
          {error && (
            <button
              className="btn primary"
              onClick={() => void loadServers(true)}
            >
              Retry connection
            </button>
          )}
        </div>
      ) : (
        <EmptyFleet onAdd={() => setManager({ editing: null })} />
      )}
      {manager && (
        <ServerManager
          editing={manager.editing}
          servers={servers}
          onClose={() => setManager(null)}
          onSaved={saved}
          onRemoved={removed}
        />
      )}
      {notice && (
        <div
          className={`toast ${!active ? "fleet-empty-toast" : ""}`}
          role="status"
        >
          <CheckCheck size={18} />
          <span>{notice}</span>
          <button
            aria-label="Dismiss server notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}

function EmptyFleet({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="fleet-welcome-shell">
      <header className="fleet-welcome-header">
        <div className="brand" aria-label="MC Panel">
          <span className="brand-icon">
            <Box size={24} />
          </span>
          <span>
            MC<span className="brand-light">PANEL</span>
            <small>YOUR WORLD. YOUR RULES.</small>
          </span>
        </div>
        <div className="welcome-header-actions">
          <DesktopUpdates />
          <a
            className="help-button"
            href="https://github.com/BigUziHert/MC-Server-UI/tree/dev#readme"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={17} /> <span>Setup guide</span>{" "}
            <ExternalLink size={13} />
          </a>
        </div>
      </header>
      <main className="fleet-welcome-main">
        <section
          className="fleet-welcome-intro"
          aria-labelledby="fleet-welcome-title"
        >
          <div className="fleet-welcome-copy">
            <span className="fleet-welcome-eyebrow">WELCOME TO MC PANEL</span>
            <h1 id="fleet-welcome-title">
              Your next world
              <br />
              <span>starts here</span>
            </h1>
            <p>
              Create a new Minecraft server or import one you already have. Your
              console, files, players, and backups, together in one place.
            </p>
            <button className="btn primary fleet-welcome-add" onClick={onAdd}>
              <Plus size={18} /> Add your first server <ArrowRight size={17} />
            </button>
            <span className="fleet-welcome-hint">
              Just exploring? Demo mode is available when you add a server.
            </span>
          </div>
          <div className="fleet-welcome-art" aria-hidden="true">
            <div className="fleet-art-grid" />
            <div className="fleet-art-ring" />
            <span className="fleet-art-cube">
              <Box size={102} strokeWidth={1.2} />
            </span>
            <span className="fleet-art-tool fleet-art-terminal">
              <Terminal size={24} />
            </span>
            <span className="fleet-art-tool fleet-art-files">
              <FolderOpen size={25} />
            </span>
            <span className="fleet-art-tool fleet-art-backup">
              <Cloud size={25} />
            </span>
            <span className="fleet-art-dot fleet-art-dot-one" />
            <span className="fleet-art-dot fleet-art-dot-two" />
          </div>
        </section>
        <section
          className="fleet-welcome-steps"
          aria-labelledby="fleet-steps-title"
        >
          <div className="fleet-steps-heading">
            <h2 id="fleet-steps-title">From an idea to your own world</h2>
            <span>THREE SIMPLE STEPS</span>
          </div>
          <ol>
            <li>
              <span className="fleet-step-number">01</span>
              <Box size={21} />
              <h3>Add your server</h3>
              <p>Create a fresh server or select the folder you already use.</p>
            </li>
            <li>
              <span className="fleet-step-number">02</span>
              <FolderOpen size={21} />
              <h3>Bring your world</h3>
              <p>
                Add your server software, or keep your existing world and mods
                right where they are.
              </p>
            </li>
            <li>
              <span className="fleet-step-number">03</span>
              <Play size={21} />
              <h3>Make it yours</h3>
              <p>
                Start from Console, invite your players, and set a backup
                schedule that fits.
              </p>
            </li>
          </ol>
        </section>
        <footer className="fleet-welcome-footer">
          <span>
            <ShieldCheck size={15} /> Your servers. Your computer. Your control.
          </span>
          <span>
            MC Panel <span className="footer-version">v{appVersion}</span>
          </span>
        </footer>
      </main>
    </div>
  );
}

function ServerWorkspace({
  servers,
  selected,
  onSelect,
  onAdd,
  onSettings,
}: {
  servers: ServerRecord[];
  selected: ServerRecord;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSettings: (status?: ServerRecord["status"]) => void;
}) {
  const { api } = useServerApi();
  const [page, setPage] = useState<Page>(getPage);
  const [server, setServer] = useState<Server | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [toast, setToast] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [collapsedNavigation, setCollapsedNavigation] = useState(
    readCollapsedNavigation,
  );
  const previousPage = useRef(page);
  const [help, setHelp] = useState(false);
  useDialogFocus(help, () => setHelp(false));
  const [history, setHistory] = useState<{ cpu: number[]; memory: number[] }>({
    cpu: [],
    memory: [],
  });
  const notify = useCallback(
    (message: string, error?: boolean) => setToast({ message, error }),
    [],
  );
  const refresh = useCallback(async () => {
    try {
      const s = await api<Server>("/server");
      setServer(s);
      setConnectionError("");
      setHistory((h) => ({
        cpu: s.cpu === null ? h.cpu : [...h.cpu.slice(-39), s.cpu],
        memory:
          s.memory === null ? h.memory : [...h.memory.slice(-39), s.memory],
      }));
    } catch (error) {
      setConnectionError((error as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    setServer((current) =>
      current ? { ...current, name: selected.name } : current,
    );
  }, [selected.name]);
  useEffect(() => {
    const changed = () => {
      setPage(getPage());
      setSidebar(false);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    document.title = `${navigation.find((n) => n.id === page)?.label} · MC Panel`;
  }, [page]);
  useEffect(() => {
    try {
      localStorage.setItem(
        navigationStorageKey,
        JSON.stringify(collapsedNavigation),
      );
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
  }, [collapsedNavigation]);
  useEffect(() => {
    if (previousPage.current === page) return;
    previousPage.current = page;
    const group = navigation.find((item) => item.id === page)?.group;
    if (group)
      setCollapsedNavigation((current) =>
        current[group] ? { ...current, [group]: false } : current,
      );
  }, [page]);
  const navigate = (id: Page) => {
    window.location.hash = id;
    setPage(id);
    setSidebar(false);
  };
  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="sidebar-shade"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? "is-open" : ""}`}>
        <a className="brand" href="#console" aria-label="MC Panel home">
          <span className="brand-icon">
            <Box size={24} />
          </span>
          <span>
            MC<span className="brand-light">PANEL</span>
            <small>YOUR WORLD. YOUR RULES.</small>
          </span>
        </a>
        <ServerSwitcher
          servers={servers}
          selected={{
            ...selected,
            status: server?.status ?? selected.status,
            iconVersion: server?.iconVersion,
          }}
          onSelect={onSelect}
          onAdd={onAdd}
          onSettings={() => onSettings(server?.status)}
        />
        <nav aria-label="Main navigation">
          {navigationGroups.map((group) => {
            const items = navigation.filter((item) => item.group === group.id);
            const collapsed = collapsedNavigation[group.id];
            const active = items.find((item) => item.id === page);
            return (
              <section
                className="nav-group"
                aria-labelledby={`nav-heading-${group.id}`}
                key={group.id}
              >
                <h2 className="nav-group-heading">
                  <button
                    type="button"
                    id={`nav-heading-${group.id}`}
                    className={`nav-group-toggle ${collapsed && active ? "contains-active" : ""}`}
                    aria-expanded={!collapsed}
                    aria-controls={`nav-links-${group.id}`}
                    title={
                      collapsed && active
                        ? `${active.label} is currently open`
                        : undefined
                    }
                    onClick={() =>
                      setCollapsedNavigation((current) => ({
                        ...current,
                        [group.id]: !current[group.id],
                      }))
                    }
                  >
                    <span>{group.label}</span>
                    {collapsed && active && (
                      <span className="nav-group-active" aria-hidden="true" />
                    )}
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </h2>
                <div id={`nav-links-${group.id}`} hidden={collapsed}>
                  {items.map((item) => (
                    <a
                      key={item.id}
                      href={`#${item.id}`}
                      className={`nav-item ${page === item.id ? "active" : ""}`}
                      aria-current={page === item.id ? "page" : undefined}
                      onClick={() => setSidebar(false)}
                    >
                      <item.icon size={19} aria-hidden="true" />
                      <span>{item.label}</span>
                      {page === item.id && <span className="nav-active-dot" />}
                    </a>
                  ))}
                </div>
              </section>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">C</div>
            <div>
              <strong>Local administrator</strong>
              <small>Development workspace</small>
            </div>
            <span className="profile-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="btn icon mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <Layers3 size={16} />
            <span className="fleet-breadcrumb-name" title={selected.name}>
              {selected.name}
            </span>
            <ChevronRight size={14} />
            <strong>{navigation.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="topbar-right">
            <DesktopUpdates />
            <span className="environment-badge">
              <span />
              {(server?.mode ?? selected.mode) === "live"
                ? "Local server"
                : "Demo workspace"}
            </span>
            <span className="topbar-divider" />
            <button
              className="help-button"
              aria-label="Help and documentation"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={17} />
              <span>Help & docs</span>
            </button>
          </div>
        </header>
        <main className="main-content">
          {connectionError && (
            <div className="connection-error" role="alert">
              {selected.sourceError
                ? "Server folder unavailable."
                : "Unable to reach the local backend."}{" "}
              {selected.sourceError || connectionError}
              <button className="btn" onClick={refresh}>
                Retry
              </button>
            </div>
          )}
          {page === "console" && (
            <ConsolePage
              server={server}
              history={history}
              notify={notify}
              refresh={refresh}
              navigate={navigate}
              onSettings={() => onSettings(server?.status)}
            />
          )}
          {page === "files" && <FileManager notify={notify} />}
          {page === "players" && <Players notify={notify} />}
          {page === "versions" && <Versions notify={notify} />}
          {page === "launchpad" && <Launchpad notify={notify} />}
          {page === "properties" && <Properties notify={notify} />}
          {page === "backups" && <Backups notify={notify} />}
          {page === "subusers" && <Subusers notify={notify} />}
          {page === "audit" && <AuditLogs notify={notify} />}
          <footer className="footer">
            <span>
              <Box size={13} /> MC Panel <span className="muted">/</span>{" "}
              <span className="muted">
                A little more control. A lot more play.
              </span>
            </span>
            <span className="muted">
              Development build{" "}
              <span className="footer-version">v{appVersion}</span>
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <CircleHelp size={18} /> : <CheckCheck size={18} />}
          <span>{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="feature-icon">
                <Box size={24} />
              </span>
              <button
                className="btn icon"
                aria-label="Close help"
                autoFocus
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </div>
            <h2 id="help-title">Your server starts here.</h2>
            <p>
              This development workspace runs on your computer. Files, backup
              archives, schedules, database files, and activity are stored
              locally.
            </p>
            <div className="help-step">
              <span>01</span>
              <div>
                <strong>Explore the console</strong>
                <p>
                  Demo mode simulates a Minecraft server. Try <code>help</code>,{" "}
                  <code>list</code>, or <code>say Hello world</code>.
                </p>
              </div>
            </div>
            <div className="help-step">
              <span>02</span>
              <div>
                <strong>Make it your own</strong>
                <p>
                  Upload files in File Manager and set an automatic backup
                  schedule. These operations use real local files, including in
                  demo mode.
                </p>
              </div>
            </div>
            <div className="help-step">
              <span>03</span>
              <div>
                <strong>Add a Minecraft server</strong>
                <p>
                  Choose Add server to create a workspace or import your
                  existing server folder. Select its launch method: a JAR, Java
                  arguments, script, or executable. Use Settings to rename a
                  server and Players to manage in-game OP.
                </p>
              </div>
            </div>
            <a
              className="btn primary"
              href="https://github.com/BigUziHert/MC-Server-UI/tree/dev#readme"
              target="_blank"
              rel="noreferrer"
            >
              Open setup guide <ExternalLink size={15} />
            </a>
          </section>
        </div>
      )}
    </div>
  );
}

function ConsolePage({
  server,
  history,
  notify,
  refresh,
  navigate,
  onSettings,
}: {
  server: Server | null;
  history: { cpu: number[]; memory: number[] };
  notify: (message: string, error?: boolean) => void;
  refresh: () => Promise<void>;
  navigate: (page: Page) => void;
  onSettings: () => void;
}) {
  const { api, post } = useServerApi();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [inputMode, setInputMode] = useState<"command" | "message">("command");
  const [drafts, setDrafts] = useState({ command: "", message: "" });
  const command = drafts[inputMode];
  const setCommand = (value: string) =>
    setDrafts((previous) => ({ ...previous, [inputMode]: value }));
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmPower, setConfirmPower] = useState<"stop" | "restart" | null>(
    null,
  );
  useDialogFocus(confirmPower !== null, () => setConfirmPower(null));
  const [hiddenUntil, setHiddenUntil] = useState<string | number | null>(null);
  const [logError, setLogError] = useState(false);
  const commandInput = useRef<HTMLInputElement>(null);
  const logContainer = useRef<HTMLDivElement>(null);
  const commandHistory = useRef<Record<"command" | "message", string[]>>({
    command: [],
    message: [],
  });
  const historyIndex = useRef(-1);
  const loadLogs = useCallback(async () => {
    try {
      const result = await api<{ lines: LogLine[] }>("/console");
      setLines(result.lines);
      setLogError(false);
    } catch {
      setLogError(true);
    }
  }, [api]);
  useEffect(() => {
    void loadLogs();
    const timer = setInterval(loadLogs, 1500);
    return () => clearInterval(timer);
  }, [loadLogs]);
  useEffect(() => {
    if (autoScroll && logContainer.current)
      logContainer.current.scrollTop = logContainer.current.scrollHeight;
  }, [lines, autoScroll]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        commandInput.current?.focus();
      }
      if (e.key === "Escape") setConfirmPower(null);
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  async function power(action: "start" | "stop" | "restart") {
    setBusy(true);
    setConfirmPower(null);
    try {
      await post("/server/power", { action });
      await refresh();
      await loadLogs();
      notify(
        `Server ${action === "stop" ? "stop" : action === "restart" ? "restart" : "start"} requested.`,
      );
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function sendCommand(e: React.FormEvent) {
    e.preventDefault();
    if (!command.trim() || busy) return;
    setBusy(true);
    try {
      await post("/console/command", {
        command:
          inputMode === "message" ? `say ${command.trim()}` : command.trim(),
      });
      commandHistory.current[inputMode].unshift(command);
      historyIndex.current = -1;
      setCommand("");
      await loadLogs();
      await refresh();
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
      commandInput.current?.focus();
    }
  }
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(server?.address || "localhost:25565");
      notify("Server address copied.");
    } catch {
      notify("Could not access the clipboard.", true);
    }
  }
  function downloadLogs() {
    const blob = new Blob(
      [
        lines
          .map(
            (line) =>
              `[${line.time}] [${line.level.toUpperCase()}] ${line.message}`,
          )
          .join("\n"),
      ],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "server-console.log";
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Console log downloaded.");
  }
  const isRunning = server?.status === "running";
  const unavailable = server?.metricsAvailable === false;
  const cpuCapacity = server?.cpuCapacity || 0;
  const normalizedCpu = (value: number) =>
    Math.min(100, Math.max(0, (value / cpuCapacity) * 100));
  const cpuUnavailable = unavailable || server?.cpu == null || cpuCapacity <= 0;
  const playersUnavailable = server?.playersAvailable === false;
  const hiddenIndex =
    hiddenUntil === null ? -1 : lines.findIndex((l) => l.id === hiddenUntil);
  const visibleLines = lines
    .slice(hiddenIndex + 1)
    .filter((line) =>
      `${line.message} ${line.level}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  return (
    <>
      <div className="page-heading console-heading">
        <div>
          <div className="eyebrow">SERVER OVERVIEW</div>
          <h1>Console</h1>
        </div>
        <div className="heading-meta">
          <Clock3 size={14} />
          <span>
            {server?.mode === "demo"
              ? "Simulated server activity"
              : "Updated every 3 seconds"}
          </span>
        </div>
      </div>
      <section className="server-banner">
        <div className="server-identity">
          <ServerIcon
            version={server?.iconVersion}
            serverVersion={server?.serverIconVersion}
            name={server?.name || "Minecraft server"}
            onSaved={refresh}
          />
          <div>
            <div className="server-title">
              <h2>{server?.name || "Minecraft Server"}</h2>
              <button
                className="rename-server-button"
                aria-label="Rename server"
                title="Rename server"
                onClick={onSettings}
              >
                <Pencil size={14} />
              </button>
              <span
                className={`status-badge ${isRunning ? "running" : "offline"}`}
              >
                <i />
                {server?.status || "Connecting"}
              </span>
            </div>
            <button
              className="address-button"
              onClick={copyAddress}
              aria-label="Copy server address"
              title={server?.addressNote}
            >
              <span>{server?.address || "localhost:25565"}</span>
              <Copy size={12} />
            </button>
          </div>
        </div>
        <div className="server-power">
          <span className="uptime">
            <Clock3 size={13} />
            {isRunning
              ? `Up for ${uptime(server?.uptime || 0)}`
              : server?.status === "starting"
                ? "Server starting…"
                : server?.status === "stopping"
                  ? "Server stopping…"
                  : "Server offline"}
          </span>
          <div className="power-buttons">
            <button
              className="btn start-button"
              disabled={
                !server || isRunning || busy || server.status !== "offline"
              }
              onClick={() => power("start")}
            >
              <Play size={14} fill="currentColor" />
              Start
            </button>
            <button
              className="btn restart-button"
              disabled={!isRunning || busy}
              onClick={() => setConfirmPower("restart")}
            >
              <RotateCw size={14} />
              Restart
            </button>
            <button
              className="btn stop-button"
              disabled={(!isRunning && server?.status !== "starting") || busy}
              onClick={() => setConfirmPower("stop")}
            >
              <Square size={12} fill="currentColor" />
              Stop
            </button>
          </div>
        </div>
      </section>
      <section className="metrics-grid" aria-label="Server resources">
        <div className="metric-card">
          <div className="metric-label">
            <Cpu size={15} />
            <span>CPU usage</span>
            <span className="metric-indicator" />
          </div>
          <div className="metric-value cpu-value">
            {cpuUnavailable
              ? "—"
              : `${normalizedCpu(server?.cpu || 0).toFixed(1)}%`}
            {!cpuUnavailable && (
              <span
                title={`${cpuCapacity / 100} logical cores · ${cpuCapacity}% combined per-core capacity`}
              >
                / 100% ({cpuCapacity}%)
              </span>
            )}
          </div>
          <div className="metric-subtitle">
            {cpuUnavailable
              ? server?.metricsMessage || "Waiting for server process…"
              : server?.mode === "demo"
                ? "Simulated utilization"
                : server?.status === "offline"
                  ? "Server offline"
                  : `Whole processor · ${cpuCapacity / 100} logical cores`}
          </div>
          {!cpuUnavailable && (
            <Sparkline values={history.cpu.map(normalizedCpu)} />
          )}
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <MemoryStick size={15} />
            <span>Memory</span>
          </div>
          <div className="metric-value">
            {unavailable ? "—" : ((server?.memory || 0) / 1024 ** 3).toFixed(2)}
            {!unavailable && (
              <span
                title={
                  server?.memoryLimitState === "started"
                    ? "Maximum JVM heap when this server started"
                    : "Maximum JVM heap configured for the next launch"
                }
              >
                /{" "}
                {server?.memoryLimit
                  ? Number((server.memoryLimit / 1024 ** 3).toFixed(2))
                  : "—"}{" "}
                GB
              </span>
            )}
          </div>
          <div className="metric-subtitle">
            {unavailable
              ? server?.metricsMessage || "Waiting for server process…"
              : server?.mode === "demo"
                ? "Simulated usage · allocated memory"
                : !server?.memoryLimit
                  ? "Physical memory · heap limit unknown"
                  : server?.status === "offline"
                    ? "Server offline · next launch allocation"
                    : server?.memoryLimitState === "started"
                      ? "Physical memory · startup heap limit"
                      : "Physical memory · configured heap limit"}
          </div>
          {!unavailable && (
            <Sparkline values={history.memory} color="#97b9f5" />
          )}
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <HardDrive size={15} />
            <span>Storage</span>
          </div>
          <div className="metric-value">
            {formatBytes(server?.disk || 0).split(" ")[0]}
            <span>{formatBytes(server?.disk || 0).split(" ")[1]}</span>
          </div>
          <div className="metric-subtitle">
            {server?.diskLimit
              ? `${formatBytes(server.diskAvailable ?? server.diskLimit)} free on host`
              : "Local server files"}
          </div>
          <div className="storage-progress">
            <div
              style={{
                width: `${Math.max(1, Math.min(100, ((server?.disk || 0) / (server?.diskLimit || 1024 ** 3)) * 100))}%`,
              }}
            />
          </div>
          <div className="metric-footnote">Filesystem storage</div>
        </div>
        <div className="metric-card players-metric">
          <div className="metric-label">
            <Users size={15} />
            <span>Players online</span>
          </div>
          <div className="metric-value">
            {playersUnavailable ? "—" : server?.players.length || 0}
            <span>/ {server?.maxPlayers || 20}</span>
          </div>
          <div className="metric-subtitle">
            {playersUnavailable
              ? "Player query not connected"
              : server?.mode === "demo"
                ? "Demo player list"
                : "Connected to your world"}
          </div>
        </div>
      </section>
      <div className="console-layout">
        <section className="panel console-panel">
          <div className="panel-heading">
            <div className="panel-title">
              <Terminal size={17} />
              <h2>Server console</h2>
              <span className="live-label">
                <i />
                {server?.mode === "demo" ? "DEMO" : "LIVE"}
              </span>
            </div>
            <div className="console-tools">
              <button
                className={`tool-button ${showSearch ? "selected" : ""}`}
                aria-label="Search console logs"
                title="Search logs"
                onClick={() => setShowSearch((v) => !v)}
              >
                <Search size={16} />
              </button>
              <button
                className="tool-button"
                aria-label="Clear console view"
                title="Clear view"
                onClick={() => setHiddenUntil(lines.at(-1)?.id ?? null)}
              >
                <ListFilter size={16} />
              </button>
              <button
                className="tool-button"
                aria-label="Download console logs"
                title="Download logs"
                onClick={downloadLogs}
              >
                <ArrowDownToLine size={16} />
              </button>
            </div>
          </div>
          {showSearch && (
            <div className="log-search">
              <SearchField
                className="console-log-search-field"
                iconSize={15}
                aria-label="Filter console logs"
                placeholder="Search console output…"
                value={search}
                onValueChange={setSearch}
                autoFocus
              />
              <button
                className="tool-button"
                aria-label="Close log search"
                onClick={() => {
                  setShowSearch(false);
                  setSearch("");
                }}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div
            className="console-output"
            ref={logContainer}
            role="log"
            aria-label="Server console output"
            aria-live="off"
          >
            {logError ? (
              <div className="console-empty">
                Console connection unavailable. Retrying…
              </div>
            ) : visibleLines.length ? (
              visibleLines.map((line, index) => (
                <div
                  className={`log-line log-${line.level}`}
                  key={`${line.id}-${index}`}
                >
                  <time>
                    {/^\d{2}:\d{2}/.test(line.time)
                      ? line.time
                      : new Date(line.time).toLocaleTimeString("en-GB")}
                  </time>
                  <span className="log-level">{line.level.toUpperCase()}</span>
                  <span className="log-message">{line.message}</span>
                </div>
              ))
            ) : (
              <div className="console-empty">
                <Terminal size={24} />
                <p>
                  {search
                    ? "No logs match your search."
                    : "Console is ready. Server output will appear here."}
                </p>
              </div>
            )}
          </div>
          <div className="console-status">
            <span>
              <span className={`status-dot ${logError ? "offline" : ""}`} />
              {logError ? "Reconnecting" : "Console connected"}
              <span className="console-status-separator">•</span>UTF-8
            </span>
            <div className="console-options">
              <button
                type="button"
                role="switch"
                aria-label="Server messaging"
                aria-checked={inputMode === "message"}
                className={`message-toggle ${inputMode === "message" ? "active" : ""}`}
                disabled={busy}
                title="Send messages to every player without typing say"
                onClick={() => {
                  setInputMode((previous) =>
                    previous === "message" ? "command" : "message",
                  );
                  historyIndex.current = -1;
                  commandInput.current?.focus();
                }}
              >
                <MessageSquare size={12} />
                Server messaging
                <span className="message-toggle-track" aria-hidden="true">
                  <span />
                </span>
              </button>
              <button
                onClick={() => setAutoScroll((v) => !v)}
                className={autoScroll ? "autoscroll active" : "autoscroll"}
              >
                {autoScroll ? <Check size={12} /> : <ArrowDown size={12} />}
                Autoscroll
              </button>
            </div>
          </div>
          <form className="command-form" onSubmit={sendCommand}>
            {inputMode === "message" ? (
              <MessageSquare size={18} />
            ) : (
              <ChevronRight size={18} />
            )}
            <input
              ref={commandInput}
              aria-label={
                inputMode === "message" ? "Server message" : "Server command"
              }
              placeholder={
                isRunning
                  ? inputMode === "message"
                    ? "Message all players…"
                    : "Type a command…"
                  : `Start your server to send a ${inputMode}…`
              }
              maxLength={inputMode === "message" ? 2044 : 2048}
              value={command}
              disabled={!isRunning}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  historyIndex.current = Math.min(
                    historyIndex.current + 1,
                    commandHistory.current[inputMode].length - 1,
                  );
                  setCommand(
                    commandHistory.current[inputMode][historyIndex.current] ||
                      "",
                  );
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  historyIndex.current = Math.max(-1, historyIndex.current - 1);
                  setCommand(
                    commandHistory.current[inputMode][historyIndex.current] ||
                      "",
                  );
                }
              }}
            />
            <kbd>Ctrl K</kbd>
            <button
              type="submit"
              aria-label={
                inputMode === "message" ? "Send message" : "Send command"
              }
              disabled={!isRunning || !command.trim() || busy}
            >
              <Send size={16} />
            </button>
          </form>
        </section>
        <aside className="console-side">
          <section className="panel server-details">
            <div className="panel-heading">
              <div className="panel-title">
                <Box size={16} />
                <h2>Server details</h2>
              </div>
            </div>
            <dl>
              <div>
                <dt>Software</dt>
                <dd>
                  <span className="software-dot" />
                  {server?.software || "—"}
                </dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>
                  <span className="version-badge">
                    {server?.version || "—"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>{server?.mode === "live" ? "Local Java" : "Demo"}</dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd className="lime-text" title={server?.addressNote}>
                  {server?.addressSource === "public"
                    ? "Public IP"
                    : server?.addressSource === "custom"
                      ? "Custom address"
                      : "Localhost"}
                </dd>
              </div>
            </dl>
            <button className="card-link" onClick={() => navigate("files")}>
              Manage server files <ArrowRight size={14} />
            </button>
          </section>
          <section className="panel online-players">
            <div className="panel-heading">
              <div className="panel-title">
                <Users size={16} />
                <h2>Players</h2>
                <span className="count-badge">
                  {playersUnavailable ? "—" : server?.players.length || 0}
                </span>
              </div>
              <span className="muted small">Online</span>
            </div>
            <div className="players-list">
              {server?.players.length ? (
                server.players.map((player) => (
                  <div className="player-row" key={player.name}>
                    <PlayerHead name={player.name} uuid={player.uuid} />
                    <div>
                      <strong>{player.name}</strong>
                      <span>Exploring the world</span>
                    </div>
                    {typeof player.latency === "number" &&
                      Number.isFinite(player.latency) &&
                      player.latency >= 0 && (
                        <span className="player-latency">
                          <Activity size={11} />
                          {player.latency} ms
                        </span>
                      )}
                  </div>
                ))
              ) : (
                <div className="players-empty">
                  <Users size={23} />
                  <strong>
                    {playersUnavailable
                      ? "Player query not connected"
                      : "A world of possibilities"}
                  </strong>
                  <p>
                    {playersUnavailable ? (
                      "Live player tracking is not configured yet."
                    ) : (
                      <>
                        Players will appear here
                        <br />
                        when they join your server.
                      </>
                    )}
                  </p>
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
      <div className="console-bottom-note">
        <ShieldCheck size={14} />
        <span>
          {server?.mode === "demo"
            ? "You’re in demo mode. Console activity is simulated; files and backups are real."
            : "Your panel is running locally. Server commands are sent directly to the Java process."}
        </span>
      </div>
      {confirmPower && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="power-title"
          >
            <h2 id="power-title">
              {confirmPower === "stop" ? "Stop" : "Restart"} your server?
            </h2>
            <p>
              Connected players will be disconnected. The server will receive a
              graceful stop command to save its world.
            </p>
            <div className="modal-actions">
              <button
                className="btn"
                autoFocus
                onClick={() => setConfirmPower(null)}
              >
                Cancel
              </button>
              <button
                className={`btn ${confirmPower === "stop" ? "danger" : "restart-button"}`}
                onClick={() => power(confirmPower)}
              >
                {confirmPower === "stop" ? "Stop server" : "Restart server"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
