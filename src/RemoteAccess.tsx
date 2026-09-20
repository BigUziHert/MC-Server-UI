import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  Box,
  ChevronRight,
  Cloud,
  FileText,
  FolderOpen,
  Gamepad2,
  Globe2,
  LoaderCircle,
  LogOut,
  LockKeyhole,
  Play,
  RotateCw,
  ShieldCheck,
  Square,
  Terminal,
} from "lucide-react";
import App from "./App";
import AccountMenu from "./AccountMenu";
import { api, post, ServerScope, useServerApi, formatBytes } from "./api";
import FileManager from "./pages/FileManager";
import Backups from "./pages/Backups";
import AuditLogs from "./pages/AuditLogs";
import "./remote-access.css";

type SubuserSession = {
  role: "subuser";
  email: string;
  serverId: string;
  userId: string;
  permissions: string[];
};
type Session = { role: "owner" } | { role: "guest" } | SubuserSession;
type SharedServer = {
  id: string;
  name: string;
  status: string;
  accessPermissions?: string[];
};
type ServerStatus = {
  name: string;
  address: string;
  status: "running" | "offline" | "starting" | "stopping";
  software: string;
  minecraftVersion?: string | null;
  memory: number | null;
  players: { name: string }[];
  maxPlayers: number;
};
type LogLine = {
  id: string | number;
  time: string;
  level: string;
  message: string;
};
const messageOf = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "Unable to connect. Please try again.";
const unauthorized = (cause: unknown) =>
  (cause as { status?: number })?.status === 401;

function invitationToken() {
  return new URLSearchParams(window.location.hash.slice(1)).get("invite") || "";
}

export default function RemoteAccess() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [token, setToken] = useState(invitationToken);
  useEffect(() => {
    const changed = () => setToken(invitationToken());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<Session>("/access/session", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSession(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      });
    return () => controller.abort();
  }, [attempt]);
  if (session?.role === "owner") return <App />;
  if (!session)
    return (
      <main className="remote-access remote-auth">
        <div className="remote-auth-card">
          <Brand />
          {error ? (
            <>
              <h1>Unable to connect</h1>
              <p role="alert">{error}</p>
              <button
                className="btn primary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            </>
          ) : (
            <p className="remote-loading" role="status">
              <LoaderCircle size={20} className="spin" /> Connecting to your
              panel…
            </p>
          )}
        </div>
      </main>
    );
  if (session.role === "guest" || token)
    return (
      <SignIn
        key={token}
        token={token}
        onBackToSignIn={() => setToken("")}
        onSignedIn={(value, acceptedInvitation) => {
          if (acceptedInvitation || invitationToken())
            window.history.replaceState(
              null,
              "",
              `${window.location.pathname}${window.location.search}`,
            );
          setToken("");
          setSession(value);
        }}
      />
    );
  return (
    <SharedPanel
      session={session}
      onSignedOut={() => setSession({ role: "guest" })}
    />
  );
}

function Brand() {
  return (
    <div className="remote-brand">
      <span>
        <Gamepad2 size={25} />
      </span>
      <strong>MC Panel</strong>
      <small>SHARED ACCESS</small>
    </div>
  );
}

function SignIn({
  token,
  onBackToSignIn,
  onSignedIn,
}: {
  token: string;
  onBackToSignIn: () => void;
  onSignedIn: (session: SubuserSession, acceptedInvitation: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalidInvitation, setInvalidInvitation] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    setError("");
    if (token && (password.length < 12 || password.length > 128)) {
      setError("Use between 12 and 128 characters for your password.");
      return;
    }
    if (token && password !== confirmation) {
      setError("Your passwords do not match. Enter the same password twice.");
      return;
    }
    if (!event.currentTarget.reportValidity()) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = await api<SubuserSession>(
        token ? "/access/accept" : "/access/login",
        {
          method: "POST",
          body: JSON.stringify(
            token ? { token, password } : { email: email.trim(), password },
          ),
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted && request.current === controller)
        onSignedIn(result, Boolean(token));
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) {
        setError(messageOf(cause));
        if (token && unauthorized(cause)) setInvalidInvitation(true);
      }
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <main className="remote-access remote-auth">
      <section className="remote-auth-card">
        <Brand />
        <p className="remote-signin-address">
          <Globe2 size={14} /> {window.location.host}
        </p>
        <div className="remote-auth-icon">
          {token ? <ShieldCheck size={30} /> : <LockKeyhole size={30} />}
        </div>
        <h1>
          {invalidInvitation
            ? "This invitation is unavailable"
            : token
              ? "Set up your server access"
              : "Welcome to your server"}
        </h1>
        <p>
          {invalidInvitation
            ? "Ask the server owner for a new invitation link. If you already have a password, you can sign in below."
            : token
              ? "Choose a password to accept this invitation. Next time, sign in with the email address your server owner added and this password."
              : "Sign in with your email address and the password you set when you accepted your invitation."}
        </p>
        {error && (
          <p
            id="remote-auth-error"
            className="remote-notice is-error"
            role="alert"
          >
            {error}
          </p>
        )}
        {!invalidInvitation && (
          <form className="remote-signin-form" onSubmit={signIn} noValidate>
            {!token && (
              <>
                <label htmlFor="remote-email">Email address</label>
                <input
                  id="remote-email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  disabled={busy}
                />
              </>
            )}
            <label htmlFor="remote-password">
              {token ? "New password" : "Password"}
            </label>
            <input
              id="remote-password"
              type="password"
              autoComplete={token ? "new-password" : "current-password"}
              required
              minLength={token ? 12 : undefined}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={token ? "remote-password-hint" : undefined}
              disabled={busy}
            />
            {token && (
              <>
                <p id="remote-password-hint" className="remote-field-hint">
                  Use 12–128 characters. A few memorable words work well.
                </p>
                <label htmlFor="remote-password-confirmation">
                  Confirm password
                </label>
                <input
                  id="remote-password-confirmation"
                  type="password"
                  autoComplete="new-password"
                  required
                  maxLength={128}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={busy}
                />
              </>
            )}
            <button className="btn primary remote-auth-submit" disabled={busy}>
              {busy ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <LockKeyhole size={18} />
              )}{" "}
              {token ? "Set password and continue" : "Sign in"}{" "}
              <ArrowRight size={18} />
            </button>
          </form>
        )}
        {token ? (
          <button
            className="btn remote-auth-back"
            type="button"
            onClick={onBackToSignIn}
          >
            Back to sign in
          </button>
        ) : (
          <p className="remote-signin-help">
            First time here or forgot your password? Ask the server owner for a
            new invitation link.
          </p>
        )}
        <p className="remote-auth-note">
          <ShieldCheck size={15} /> Access is limited to the permissions your
          server owner shares.
        </p>
      </section>
    </main>
  );
}

function SharedPanel({
  session,
  onSignedOut,
}: {
  session: SubuserSession;
  onSignedOut: () => void;
}) {
  const [servers, setServers] = useState<SharedServer[] | null>(null);
  const [selected, setSelected] = useState(session.serverId);
  const [error, setError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState("overview");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<{ servers: SharedServer[] }>("/servers", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setServers(result.servers);
        setError("");
        setSelected((current) =>
          result.servers.some((server) => server.id === current)
            ? current
            : result.servers[0]?.id || "",
        );
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (unauthorized(cause)) {
          onSignedOut();
          return;
        }
        setError(messageOf(cause));
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 15_000);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [attempt, onSignedOut]);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError("");
    try {
      await post("/access/logout");
      onSignedOut();
    } catch (cause) {
      if (unauthorized(cause)) onSignedOut();
      else setLogoutError(messageOf(cause));
    } finally {
      setLoggingOut(false);
    }
  }
  const server = servers?.find((record) => record.id === selected);
  const permissions =
    server?.accessPermissions ??
    (server?.id === session.serverId ? session.permissions : []);
  const pages = [
    { id: "overview", label: "Overview", icon: Terminal },
    ...(permissions.includes("file.read")
      ? [{ id: "files", label: "Files", icon: FolderOpen }]
      : []),
    ...(permissions.includes("backup.read")
      ? [{ id: "backups", label: "Backups", icon: Cloud }]
      : []),
    ...(permissions.includes("audit.read")
      ? [{ id: "audit", label: "Activity", icon: FileText }]
      : []),
  ];
  const currentTab = pages.some((page) => page.id === tab) ? tab : "overview";
  return (
    <div className="remote-access remote-shell">
      <aside className="remote-sidebar">
        <div className="brand remote-sidebar-brand" aria-label="MC Panel">
          <span className="brand-icon">
            <Box size={24} />
          </span>
          <span>
            MC<span className="brand-light">PANEL</span>
            <small>YOUR WORLD. YOUR RULES.</small>
          </span>
        </div>
        <div className="remote-sidebar-info">
          <span>
            <Globe2 size={14} /> Connected panel
          </span>
          <strong title={window.location.host}>{window.location.host}</strong>
        </div>
        <nav className="remote-side-nav" aria-label="Server pages">
          {pages.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${currentTab === item.id ? "active" : ""}`}
              onClick={() => setTab(item.id)}
              aria-current={currentTab === item.id ? "page" : undefined}
            >
              <item.icon size={18} /> <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="remote-profile">
          <AccountMenu
            identity={{ name: session.email, detail: window.location.host }}
            status={{ label: "Signed in · Shared access", tone: "active" }}
            actions={[
              {
                id: "signout",
                label: "Sign out",
                icon: <LogOut size={16} />,
                busy: loggingOut,
                onSelect: () => void logout(),
              },
            ]}
          />
        </div>
      </aside>
      <div className="remote-content">
        <main className="remote-main">
          <div className="remote-account">
            <span>
              Signed in as <strong>{session.email}</strong>
            </span>
            <span>
              <ShieldCheck size={14} /> Subuser
            </span>
          </div>
          {logoutError && (
            <div className="remote-notice is-error" role="alert">
              {logoutError}
              <button
                className="btn"
                onClick={() => void logout()}
                disabled={loggingOut}
              >
                Retry sign out
              </button>
            </div>
          )}
          {error && (
            <div className="remote-notice is-error" role="alert">
              {error}
              <button
                className="btn"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          )}
          {servers && servers.length > 1 && (
            <label className="remote-server-select">
              Your servers
              <select
                aria-label="Select shared server"
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setTab("overview");
                }}
              >
                {servers.map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!servers && !error && (
            <p className="remote-loading" role="status">
              <LoaderCircle size={20} className="spin" /> Loading your servers…
            </p>
          )}
          {servers?.length === 0 && (
            <section className="remote-card">
              <h1>No shared servers</h1>
              <p>
                Your access may have been removed. Ask the server owner for a
                new invitation.
              </p>
            </section>
          )}
          {server && (
            <ServerScope.Provider value={server.id}>
              <SharedWorkspace
                key={`${server.id}:${permissions.join(",")}`}
                record={server}
                permissions={permissions}
                tab={currentTab}
                onSignedOut={onSignedOut}
              />
            </ServerScope.Provider>
          )}
        </main>
      </div>
    </div>
  );
}

function SharedWorkspace({
  record,
  permissions,
  tab,
  onSignedOut,
}: {
  record: SharedServer;
  permissions: string[];
  tab: string;
  onSignedOut: () => void;
}) {
  const { api: serverApi, post: serverPost } = useServerApi();
  const can = (permission: string) => permissions.includes(permission);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState("");
  const [consoleError, setConsoleError] = useState("");
  const [notice, setNotice] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [path, setPath] = useState("");
  const [showingBin, setShowingBin] = useState(false);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<"stop" | "restart" | null>(
    null,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  const following = useRef(true);
  const consoleAllowed = can("control.console");
  const notify = useCallback(
    (message: string, isError?: boolean) =>
      setNotice({ message, error: isError }),
    [],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await serverApi<ServerStatus>("/server", { signal });
        if (signal?.aborted || !active.current) return;
        setServer(result);
        setError("");
      } catch (cause) {
        if (signal?.aborted || !active.current) return;
        if (unauthorized(cause)) onSignedOut();
        else setError(messageOf(cause));
      }
    },
    [serverApi, onSignedOut],
  );
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh(controller.signal);
      if (consoleAllowed && !controller.signal.aborted) {
        try {
          const result = await serverApi<{ lines: LogLine[] }>("/console", {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            setLines(result.lines.slice(-500));
            setConsoleError("");
          }
        } catch (cause) {
          if (!controller.signal.aborted) {
            if (unauthorized(cause)) {
              onSignedOut();
              return;
            }
            setConsoleError(messageOf(cause));
          }
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3_000);
    }
    void poll();
    return () => {
      active.current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, serverApi, consoleAllowed, onSignedOut]);
  useEffect(() => {
    if (following.current && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [lines, tab]);
  useEffect(() => {
    if (confirmation) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation]);
  async function power(action: "start" | "stop" | "restart") {
    if (busy) return;
    setBusy(true);
    setConfirmation(null);
    setNotice(null);
    try {
      await serverPost("/server/power", { action });
      if (!active.current) return;
      notify(`Server ${action} requested.`);
      await refresh();
    } catch (cause) {
      if (active.current) notify(messageOf(cause), true);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function sendCommand(event: FormEvent) {
    event.preventDefault();
    if (busy || !command.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await serverPost("/console/command", { command: command.trim() });
      if (!active.current) return;
      setCommand("");
      notify("Command sent.");
      await refresh();
    } catch (cause) {
      if (active.current) notify(messageOf(cause), true);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const status = server?.status || record.status;
  return (
    <>
      <section className="remote-server-heading">
        <div>
          <p>YOUR SHARED SERVER</p>
          <h1>{server?.name || record.name}</h1>
          <span>
            {[server?.software, server?.minecraftVersion]
              .filter(Boolean)
              .join(" ") || "Minecraft server"}
          </span>
        </div>
        <span className={`remote-status ${status}`}>
          <i />
          {status}
        </span>
      </section>
      {notice && (
        <div
          className={`remote-notice ${notice.error ? "is-error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.message}
          <button
            className="btn"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notification"
          >
            Dismiss
          </button>
        </div>
      )}
      {tab === "overview" && (
        <>
          {error && (
            <div className="remote-notice is-error" role="alert">
              {error}
              <button className="btn" onClick={() => refresh()}>
                Retry
              </button>
            </div>
          )}
          <section className="remote-card remote-controls">
            <div>
              <h2>Server controls</h2>
              <p>
                {status === "running"
                  ? "Your world is online and ready to play."
                  : status === "offline"
                    ? "The server is currently offline."
                    : status === "starting"
                      ? "The server is starting. This may take a moment."
                      : "The server is saving and shutting down."}
              </p>
            </div>
            <div className="remote-power-buttons">
              {can("control.start") && (
                <button
                  className="btn start-button"
                  disabled={busy || !server || status !== "offline"}
                  onClick={() => power("start")}
                >
                  <Play size={17} fill="currentColor" /> Start
                </button>
              )}
              {can("control.restart") && (
                <button
                  className="btn restart-button"
                  disabled={busy || !server || status !== "running"}
                  onClick={() => setConfirmation("restart")}
                >
                  <RotateCw size={17} /> Restart
                </button>
              )}
              {can("control.stop") && (
                <button
                  className="btn stop-button"
                  disabled={
                    busy ||
                    !server ||
                    (status !== "running" && status !== "starting")
                  }
                  onClick={() => setConfirmation("stop")}
                >
                  <Square size={15} fill="currentColor" /> Stop
                </button>
              )}
              {!permissions.some((permission) =>
                ["control.start", "control.stop", "control.restart"].includes(
                  permission,
                ),
              ) && (
                <p className="remote-permission-note">
                  Your access does not include power controls.
                </p>
              )}
            </div>
          </section>
          <div className="remote-stats">
            <section className="remote-card">
              <span>Players online</span>
              <strong>
                {server
                  ? `${server.players.length} / ${server.maxPlayers}`
                  : "—"}
              </strong>
              <small>
                {server?.players.map((player) => player.name).join(", ") ||
                  "No players connected"}
              </small>
            </section>
            <section className="remote-card">
              <span>Memory in use</span>
              <strong>
                {server?.memory == null ? "—" : formatBytes(server.memory)}
              </strong>
              <small>
                {status === "offline"
                  ? "Server offline"
                  : "Updates automatically"}
              </small>
            </section>
          </div>
          {consoleAllowed && (
            <section className="remote-card remote-console">
              <header>
                <Terminal size={18} />
                <h2>Server console</h2>
                <span>Live</span>
              </header>
              {consoleError && (
                <p className="remote-notice is-error" role="alert">
                  {consoleError}
                </p>
              )}
              <div
                ref={output}
                className="remote-console-output"
                role="log"
                aria-live="off"
                aria-label="Server console output"
                tabIndex={0}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  following.current =
                    element.scrollHeight -
                      element.scrollTop -
                      element.clientHeight <
                    50;
                }}
              >
                {lines.length ? (
                  lines.map((line) => (
                    <div key={line.id} className={line.level?.toLowerCase()}>
                      <time>{line.time}</time>
                      <span>{line.message}</span>
                    </div>
                  ))
                ) : (
                  <p>Server output will appear here.</p>
                )}
              </div>
              <form className="remote-command" onSubmit={sendCommand}>
                <ChevronRight size={20} />
                <input
                  aria-label="Console command"
                  placeholder={
                    status === "running"
                      ? "Enter a command…"
                      : "Start the server to send commands"
                  }
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  disabled={busy || status !== "running"}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={2048}
                />
                <button
                  className="btn primary"
                  aria-label="Send command"
                  disabled={busy || status !== "running" || !command.trim()}
                >
                  <ArrowRight size={20} />
                </button>
              </form>
            </section>
          )}
          {!consoleAllowed && (
            <p className="remote-permission-note">
              <ShieldCheck size={16} /> Your owner has shared the controls shown
              above. Console access has not been granted.
            </p>
          )}
        </>
      )}
      {tab === "files" && can("file.read") && (
        <div className="remote-existing-page">
          <FileManager
            notify={notify}
            path={path}
            onPathChange={setPath}
            showingBin={showingBin}
            onBinChange={setShowingBin}
          />
        </div>
      )}
      {tab === "backups" && can("backup.read") && (
        <div className="remote-existing-page">
          <Backups notify={notify} />
        </div>
      )}
      {tab === "audit" && can("audit.read") && (
        <div className="remote-existing-page">
          <AuditLogs notify={notify} serverOnly />
        </div>
      )}
      <dialog
        className="remote-confirm"
        ref={dialog}
        onCancel={() => setConfirmation(null)}
        onClose={() => setConfirmation(null)}
        aria-labelledby="remote-power-title"
      >
        <h2 id="remote-power-title">
          {confirmation === "stop" ? "Stop" : "Restart"} the server?
        </h2>
        <p>
          Connected players will be disconnected while the server saves its
          world
          {confirmation === "restart" ? " and restarts" : " and shuts down"}.
        </p>
        <div>
          <button
            className="btn"
            autoFocus
            onClick={() => setConfirmation(null)}
          >
            Cancel
          </button>
          <button
            className={`btn ${confirmation === "restart" ? "restart-button" : "stop-button"}`}
            disabled={busy}
            onClick={() => confirmation && power(confirmation)}
          >
            {confirmation === "stop" ? "Stop server" : "Restart server"}
          </button>
        </div>
      </dialog>
    </>
  );
}
