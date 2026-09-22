import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Box,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { api, post, ServerScope } from "./api";
import AddServer from "./AddServer";
import { CachedServerIconImage, ServerIconImage } from "./ServerIcon";
import { useDesktopConnections } from "./desktop-connections";
import {
  LaunchAdvancedFields,
  LaunchMemoryNote,
  LaunchMethodFields,
  startupDraft,
  startupError,
  startupPayload,
  type LaunchCandidate,
  type LaunchType,
} from "./LaunchSettings";
import "./servers.css";

export type ServerRecord = {
  id: string;
  accessPermissions?: string[];
  name: string;
  status: "running" | "offline" | "starting" | "stopping";
  mode: "live";
  address: string;
  connectionHost?: string;
  iconVersion?: string | null;
  serverIconVersion?: string | null;
  iconPreference?: "server" | "default";
  port: number;
  memoryLimitMB: number;
  jar: string;
  javaPath: string;
  launchType?: LaunchType;
  launchScript?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  motd?: string;
  version?: string;
  minecraftVersion?: string | null;
  software?: string;
  source?: "imported" | "managed";
  serverDir?: string;
  unavailable?: boolean;
  sourceError?: string;
};

export function ServerSwitcher({
  servers,
  selected,
  onSelect,
  onAdd,
  onSettings,
  remoteHost,
}: {
  servers: ServerRecord[];
  selected?: ServerRecord;
  onSelect: (id: string) => void;
  onAdd?: () => void;
  onSettings?: () => void;
  remoteHost?: string;
}) {
  const connections = useDesktopConnections();
  const grouped = Boolean(window.mcPanelConnections);
  const cachedPanels = (connections?.panels ?? []).filter(
    (panel) =>
      !panel.local &&
      panel.servers?.length &&
      !(
        remoteHost &&
        servers.length &&
        panel.origin === window.location.origin
      ),
  );
  const showCurrentRoster = !(
    remoteHost &&
    !servers.length &&
    cachedPanels.some((panel) => panel.origin === window.location.origin)
  );
  const [openingLocal, setOpeningLocal] = useState<string | null>(null);
  const [openingRemote, setOpeningRemote] = useState<{
    panelId: string;
    serverId: string;
  } | null>(null);
  const [remoteError, setRemoteError] = useState<{
    panelId: string;
    message: string;
  } | null>(null);
  const [localError, setLocalError] = useState("");
  const localRequest = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function openLocal(serverId: string) {
    if (localRequest.current) return;
    localRequest.current = true;
    setOpeningLocal(serverId);
    setLocalError("");
    setRemoteError(null);
    try {
      const bridge = window.mcPanelConnections;
      if (!bridge?.selectLocalServer)
        throw new Error(
          "Update the desktop app to open a local server from this panel.",
        );
      await bridge.selectLocalServer(serverId);
    } catch (cause) {
      if (mounted.current)
        setLocalError(
          cause instanceof Error
            ? cause.message
            : "Could not open the local server. Try again.",
        );
    } finally {
      localRequest.current = false;
      if (mounted.current) setOpeningLocal(null);
    }
  }
  async function openRemote(panelId: string, serverId: string) {
    if (localRequest.current) return;
    localRequest.current = true;
    setOpeningRemote({ panelId, serverId });
    setRemoteError(null);
    setLocalError("");
    try {
      const bridge = window.mcPanelConnections;
      if (!bridge?.selectRemoteServer)
        throw new Error(
          "Update the desktop app to open a saved remote server.",
        );
      await bridge.selectRemoteServer(panelId, serverId);
    } catch (cause) {
      if (mounted.current)
        setRemoteError({
          panelId,
          message:
            cause instanceof Error
              ? cause.message
              : "Could not open the remote server. Try again.",
        });
    } finally {
      localRequest.current = false;
      if (mounted.current) setOpeningRemote(null);
    }
  }
  return (
    <div className="fleet-switcher">
      {grouped && remoteHost && (
        <div className="fleet-server-group">
          <h3 className="fleet-server-group-heading">This computer</h3>
          <ul
            className="fleet-server-list"
            aria-label="Servers on this computer"
          >
            {(connections?.localServers ?? []).map((server) => {
              const software = [
                server.software || "Java",
                server.minecraftVersion,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={`local:${server.id}`}>
                  <button
                    type="button"
                    className="fleet-server-button"
                    aria-label={`Open local server ${server.name}`}
                    data-local-server-id={server.id}
                    data-server-scope="local"
                    disabled={openingLocal !== null || openingRemote !== null}
                    aria-busy={openingLocal === server.id || undefined}
                    onClick={() => void openLocal(server.id)}
                  >
                    <span className="server-mini">
                      {openingLocal === server.id ? (
                        <LoaderCircle size={18} className="spin" />
                      ) : (
                        <CachedServerIconImage
                          name={server.name}
                          dataUrl={server.iconDataUrl}
                        />
                      )}
                    </span>
                    <span className="fleet-selection">
                      <strong title={server.name}>{server.name}</strong>
                      <span>
                        <i
                          className={`status-dot ${server.status === "running" ? "" : "offline"}`}
                        />
                        {server.status}
                        <span className="fleet-mode" title={software}>
                          · {software}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!connections ? (
            <p className="fleet-server-group-note">Loading local servers…</p>
          ) : (
            !connections.localServers?.length && (
              <p className="fleet-server-group-note">
                No servers on this computer.
              </p>
            )
          )}
          {localError && (
            <p className="fleet-server-group-error" role="alert">
              {localError}
            </p>
          )}
        </div>
      )}
      {showCurrentRoster && (
        <>
          {grouped && (
            <h3 className="fleet-server-group-heading" title={remoteHost}>
              {remoteHost || "This computer"}
            </h3>
          )}
          <ul
            className="fleet-server-list"
            aria-label={
              grouped
                ? remoteHost
                  ? `Servers on ${remoteHost}`
                  : "Servers on this computer"
                : "Your servers"
            }
          >
            {servers.map((record) => {
              const active = record.id === selected?.id;
              const server = active && selected ? selected : record;
              const software = [
                server.software || "Java",
                server.minecraftVersion,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={server.id}>
                  <button
                    className="fleet-server-button"
                    aria-label={`Select server ${server.name}`}
                    data-server-id={server.id}
                    data-server-scope={remoteHost ? "panel" : "local"}
                    aria-pressed={active}
                    onClick={() => onSelect(server.id)}
                  >
                    <span className="server-mini">
                      <ServerScope.Provider value={server.id}>
                        <ServerIconImage
                          name={server.name}
                          version={server.iconVersion}
                        />
                      </ServerScope.Provider>
                    </span>
                    <span className="fleet-selection">
                      <strong title={server.name}>{server.name}</strong>
                      <span>
                        <i
                          className={`status-dot ${server.status === "running" ? "" : "offline"}`}
                        />
                        {server.status}
                        <span className="fleet-mode" title={software}>
                          · {software}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {grouped && !servers.length && (
            <p className="fleet-server-group-note">
              {remoteHost
                ? "No shared servers on this panel."
                : "No servers on this computer."}
            </p>
          )}
        </>
      )}
      {cachedPanels.map((panel) => (
        <div
          className="fleet-server-group fleet-cached-server-group"
          key={panel.id}
        >
          <h3 className="fleet-server-group-heading" title={panel.label}>
            {panel.label}
          </h3>
          <ul
            className="fleet-server-list"
            aria-label={`Servers on ${panel.label}`}
          >
            {panel.servers!.map((server) => {
              const software = [
                server.software || "Java",
                server.minecraftVersion,
              ]
                .filter(Boolean)
                .join(" ");
              const opening =
                openingRemote?.panelId === panel.id &&
                openingRemote.serverId === server.id;
              return (
                <li key={server.id}>
                  <button
                    type="button"
                    className="fleet-server-button"
                    aria-label={`Open remote server ${server.name} on ${panel.label}`}
                    data-remote-panel-id={panel.id}
                    data-remote-server-id={server.id}
                    data-server-scope="remote"
                    disabled={openingLocal !== null || openingRemote !== null}
                    aria-busy={opening || undefined}
                    onClick={() => void openRemote(panel.id, server.id)}
                  >
                    <span className="server-mini">
                      {opening ? (
                        <LoaderCircle size={18} className="spin" />
                      ) : (
                        <CachedServerIconImage
                          name={server.name}
                          dataUrl={server.iconDataUrl}
                        />
                      )}
                    </span>
                    <span className="fleet-selection">
                      <strong title={server.name}>{server.name}</strong>
                      <span>
                        <i
                          className={`status-dot ${server.status === "running" ? "" : "offline"}`}
                        />
                        {server.status}
                        <span className="fleet-mode" title={software}>
                          · {software}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {remoteError?.panelId === panel.id && (
            <p className="fleet-server-group-error" role="alert">
              {remoteError.message}
            </p>
          )}
        </div>
      ))}
      {(onAdd || onSettings) && (
        <div className="fleet-actions">
          {onAdd && (
            <button className="nav-item" onClick={onAdd}>
              <Plus size={19} />
              Add server
            </button>
          )}
          {onSettings && (
            <button
              className="nav-item"
              aria-label="Server settings"
              title="Server settings"
              onClick={onSettings}
            >
              <Settings2 size={19} />
              <span>Settings</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type ServerManagerProps = {
  editing: ServerRecord | null;
  initialStep?: "choice" | "create" | "import" | "recover";
  servers: ServerRecord[];
  onClose: () => void;
  onSaved: (server: ServerRecord) => void;
  onRemoved: (serverId: string) => void;
};

export default function ServerManager(props: ServerManagerProps) {
  const [recovering, setRecovering] = useState(props.initialStep === "recover");
  return props.editing ? (
    <ServerSettings {...props} editing={props.editing} />
  ) : recovering ? (
    <RecoverServer
      servers={props.servers}
      onBack={() => setRecovering(false)}
      onClose={props.onClose}
      onSaved={props.onSaved}
    />
  ) : (
    <AddServer
      initialStep={
        props.initialStep === "recover" ? "choice" : props.initialStep
      }
      servers={props.servers}
      onClose={props.onClose}
      onSaved={props.onSaved}
      onRecover={() => setRecovering(true)}
    />
  );
}

type RecoveryCandidate = { id: string; name: string; directory: string };
type RecoveryInspection = RecoveryCandidate & {
  revision: string;
  port: number;
  memoryLimitMB?: number;
  jars: string[];
  jar: string | null;
  launchType?: LaunchType;
  launchScript?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  javaPath?: string;
  launches?: LaunchCandidate[];
  warnings: string[];
};

function RecoverServer({
  servers,
  onBack,
  onClose,
  onSaved,
}: {
  servers: ServerRecord[];
  onBack: () => void;
  onClose: () => void;
  onSaved: (server: ServerRecord) => void;
}) {
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [inspection, setInspection] = useState<RecoveryInspection | null>(null);
  const [name, setName] = useState("");
  const [port, setPort] = useState("25565");
  const [memory, setMemory] = useState("4096");
  const [startup, setStartup] = useState(() => startupDraft({ jar: "" }));
  const [confirmed, setConfirmed] = useState(false);
  const [work, setWork] = useState<"list" | "inspect" | "recover" | null>(
    "list",
  );
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const busy = work === "recover";
  const conflict = servers.find((server) => server.port === Number(port));
  const validStartup =
    !startupError(startup) &&
    (startup.launchType !== "jar" ||
      Boolean(inspection?.jars.includes(startup.jar)));

  async function load(id?: string) {
    const current = ++operation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setWork(id ? "inspect" : "list");
    setInspection(null);
    setConfirmed(false);
    setError("");
    try {
      if (id) {
        const value = await api<RecoveryInspection>(
          `/server-recovery/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );
        if (current !== operation.current) return;
        setInspection(value);
        setName(value.name);
        setPort(String(value.port));
        setMemory(String(value.memoryLimitMB ?? 4096));
        setStartup(startupDraft(value));
      } else {
        const value = await api<{
          candidates: RecoveryCandidate[];
          warnings: string[];
        }>("/server-recovery", { signal: controller.signal });
        if (current !== operation.current) return;
        setCandidates(value.candidates);
        setWarnings(value.warnings);
      }
    } catch (cause) {
      if (current === operation.current && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not inspect saved servers. Try again.",
        );
    } finally {
      if (current === operation.current) setWork(null);
    }
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    void load();
    return () => {
      operation.current++;
      request.current?.abort();
      element?.close();
    };
  }, []);

  async function recover(event: FormEvent) {
    event.preventDefault();
    if (work || !inspection || !confirmed) return;
    const selectedPort = Number(port),
      selectedMemory = Number(memory);
    if (
      !name.trim() ||
      !validStartup ||
      !Number.isInteger(selectedPort) ||
      selectedPort < 1024 ||
      selectedPort > 65535 ||
      conflict ||
      (startup.launchType === "jar" &&
        (!Number.isInteger(selectedMemory) ||
          selectedMemory < 256 ||
          selectedMemory > 262144))
    ) {
      setError(
        startupError(startup) ||
          "Choose a name, available port, and valid startup settings before recovering this server.",
      );
      return;
    }
    const current = ++operation.current;
    setWork("recover");
    setError("");
    try {
      const value = await post<{ server: ServerRecord }>(
        `/server-recovery/${encodeURIComponent(inspection.id)}`,
        {
          confirmed: true,
          revision: inspection.revision,
          name: name.trim(),
          port: selectedPort,
          ...(startup.launchType === "jar"
            ? { memoryLimitMB: selectedMemory }
            : {}),
          ...startupPayload(startup),
        },
      );
      if (current === operation.current) onSaved(value.server);
    } catch (cause) {
      if (current === operation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not recover this server. Inspect it again and retry.",
        );
    } finally {
      if (current === operation.current) setWork(null);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="server-dialog server-add-dialog"
      aria-labelledby="recover-server-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="server-dialog-top">
        <button
          type="button"
          className="btn server-back-button"
          disabled={busy}
          onClick={() => (inspection ? void load() : onBack())}
        >
          <ArrowLeft size={16} /> Back
        </button>
        <button
          type="button"
          className="btn icon"
          aria-label="Close server recovery"
          disabled={busy}
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <h2 id="recover-server-title">Recover a saved server</h2>
      <p>
        Choose a server previously stored by this panel. Recovery keeps its
        files, worlds, backups, and Recycle Bin, and leaves the server stopped.
      </p>
      {work === "list" || work === "inspect" ? (
        <p role="status">
          <LoaderCircle size={16} className="spin" />{" "}
          {work === "list"
            ? "Looking for saved servers…"
            : "Inspecting the saved server…"}
        </p>
      ) : inspection ? (
        <form onSubmit={recover}>
          <fieldset disabled={busy} className="server-config-fields">
            <div className="form-field">
              <label htmlFor="recover-directory">Saved server folder</label>
              <input
                id="recover-directory"
                value={inspection.directory}
                readOnly
              />
            </div>
            <div className="form-field">
              <label htmlFor="recover-name">Server name</label>
              <input
                id="recover-name"
                value={name}
                maxLength={64}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <LaunchMethodFields
              idPrefix="recover"
              value={startup}
              onChange={setStartup}
              jars={inspection.jars}
              candidates={inspection.launches}
            />
            <div className="server-form-grid">
              <div className="form-field">
                <label htmlFor="recover-port">Server port</label>
                <input
                  id="recover-port"
                  type="number"
                  min={1024}
                  max={65535}
                  required
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </div>
              {startup.launchType === "jar" && (
                <div className="form-field">
                  <label htmlFor="recover-memory">Memory (MB)</label>
                  <input
                    id="recover-memory"
                    type="number"
                    min={256}
                    max={262144}
                    required
                    value={memory}
                    onChange={(event) => setMemory(event.target.value)}
                  />
                </div>
              )}
            </div>
            {conflict && (
              <p className="server-import-port-warning">
                Port {port} is used by {conflict.name}. Choose another port.
              </p>
            )}
            <LaunchMemoryNote type={startup.launchType} />
            <LaunchAdvancedFields
              idPrefix="recover"
              value={startup}
              onChange={setStartup}
            />
            {inspection.warnings.length > 0 && (
              <ul className="server-import-warnings">
                {inspection.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            <label className="setup-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              Add this saved server back to the panel.
            </label>
          </fieldset>
          <div className="server-dialog-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void load(inspection.id)}
            >
              Inspect again
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={
                busy ||
                !confirmed ||
                !name.trim() ||
                !validStartup ||
                Boolean(conflict)
              }
            >
              <RefreshCw size={15} /> {busy ? "Recovering…" : "Recover server"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div
            className="server-add-choices"
            aria-label="Saved servers available for recovery"
          >
            {candidates.map((candidate) => (
              <button
                type="button"
                className="server-add-choice"
                key={candidate.id}
                aria-label={`Review saved server ${candidate.name}`}
                onClick={() => void load(candidate.id)}
              >
                <span className="server-choice-icon">
                  <Box size={20} />
                </span>
                <span>
                  <strong>{candidate.name}</strong>
                  <span style={{ overflowWrap: "anywhere" }}>
                    {candidate.directory}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {!candidates.length && !error && (
            <p>No saved servers are waiting to be recovered.</p>
          )}
          {warnings.length > 0 && (
            <ul className="server-import-warnings">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="server-dialog-actions">
            <button type="button" className="btn" onClick={() => void load()}>
              <RefreshCw size={15} /> Check again
            </button>
          </div>
        </>
      )}
      {error && (
        <div className="server-form-error" role="alert">
          <AlertCircle size={16} />
          {error}
        </div>
      )}
    </dialog>
  );
}

function ServerSettings({
  editing,
  onClose,
  onSaved,
  onRemoved,
}: Pick<ServerManagerProps, "onClose" | "onSaved" | "onRemoved"> & {
  editing: ServerRecord;
}) {
  const [name, setName] = useState(editing.name);
  const [connectionHost, setConnectionHost] = useState(
    editing.connectionHost ?? "",
  );
  const [port, setPort] = useState(String(editing.port));
  const [memory, setMemory] = useState(String(editing.memoryLimitMB));
  const [startup, setStartup] = useState(() => startupDraft(editing));
  const [motd, setMotd] = useState(
    editing.motd ?? "Welcome to our Minecraft server",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const removalCancel = useRef<HTMLButtonElement>(null);
  const errorMessage = useRef<HTMLDivElement>(null);
  const running = editing.status !== "offline";
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (confirmingRemoval) removalCancel.current?.focus();
  }, [confirmingRemoval]);
  useEffect(() => {
    if (error) errorMessage.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (confirmingRemoval || busy) return;
    setBusy(true);
    setError("");
    const settings = {
      name: name.trim(),
      connectionHost: connectionHost.trim(),
      mode: "live",
      port: Number(port),
      ...(startup.launchType === "jar"
        ? { memoryLimitMB: Number(memory) }
        : {}),
      ...startupPayload(startup),
      motd,
    };
    try {
      const result = await api<{ server: ServerRecord }>(
        `/servers/${encodeURIComponent(editing.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            running
              ? { name: name.trim(), connectionHost: connectionHost.trim() }
              : settings,
          ),
        },
      );
      onSaved(result.server);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeServer() {
    if (running || busy || !confirmingRemoval) return;
    setBusy(true);
    setError("");
    try {
      await api(`/servers/${encodeURIComponent(editing.id)}`, {
        method: "DELETE",
      });
      onRemoved(editing.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to remove this server from the panel.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="server-dialog"
      aria-labelledby="server-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="server-dialog-top">
          <span className="feature-icon">
            <Box size={23} />
          </span>
          <button
            type="button"
            className="btn icon"
            aria-label="Close server settings"
            disabled={busy}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <h2 id="server-dialog-title">Server settings</h2>
        <p>Give your world a name and configure how it runs.</p>
        <div className="form-field">
          <label htmlFor="server-name">Server name</label>
          <input
            id="server-name"
            autoFocus
            required
            maxLength={64}
            placeholder="Survival with friends"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <small>The name shown throughout this panel.</small>
        </div>
        <div className="form-field">
          <label htmlFor="server-connection-host">
            Player connection address
          </label>
          <input
            id="server-connection-host"
            value={connectionHost}
            onChange={(event) => setConnectionHost(event.target.value)}
            disabled={busy}
            maxLength={253}
            placeholder="Automatic public IP, or play.example.com"
            spellCheck={false}
          />
          <small>
            Leave blank to detect the server PC’s public IP. Enter a hostname or
            IP without a port to override it. This does not change server-ip or
            set up port forwarding.
          </small>
        </div>
        {editing.source === "imported" && editing.serverDir && (
          <div className="form-field">
            <label htmlFor="saved-server-directory">Server folder</label>
            <input
              id="saved-server-directory"
              value={editing.serverDir}
              readOnly
              spellCheck={false}
            />
            <small>
              This server uses the original folder. Worlds, mods, plugins, and
              configuration stay here.
            </small>
          </div>
        )}
        {editing.sourceError && (
          <div className="server-form-error server-source-error" role="alert">
            <AlertCircle size={17} />
            <span>{editing.sourceError}</span>
          </div>
        )}
        {running && (
          <div className="server-form-note">
            <AlertCircle size={16} />
            <span>
              You can rename this server or change its displayed address now.
              Stop it from the console to change its port or in-game message.
            </span>
          </div>
        )}
        <fieldset disabled={busy || running} className="server-config-fields">
          <div className="server-form-grid">
            <div className="form-field">
              <label htmlFor="server-port">Server port</label>
              <input
                id="server-port"
                type="number"
                min={1024}
                max={65535}
                required
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="server-motd">Server list message (MOTD)</label>
            <input
              id="server-motd"
              maxLength={160}
              value={motd}
              onChange={(e) => setMotd(e.target.value)}
            />
            <small>
              Shown in Minecraft’s multiplayer server list after the next start.
            </small>
          </div>
          <LaunchMethodFields
            idPrefix="server"
            value={startup}
            onChange={setStartup}
          />
          {startup.launchType === "jar" && (
            <div className="form-field">
              <label htmlFor="server-memory">Memory (MB)</label>
              <input
                id="server-memory"
                type="number"
                min={256}
                max={262144}
                step={1}
                required
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
              />
            </div>
          )}
          <LaunchMemoryNote type={startup.launchType} />
          <LaunchAdvancedFields
            idPrefix="server"
            value={startup}
            onChange={setStartup}
          />
        </fieldset>
        <div className="server-setup-note">
          <Box size={17} />
          <p>
            Startup changes take effect the next time you start this server. Its
            existing files and EULA remain in place.
          </p>
        </div>
        {error && (
          <div ref={errorMessage} className="server-form-error" role="alert">
            <AlertCircle size={16} />
            {error}
          </div>
        )}
        <div className="server-dialog-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || confirmingRemoval || !name.trim()}
            type="submit"
          >
            <Save size={15} /> {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
        <div className="server-remove">
          {confirmingRemoval ? (
            <div role="group" aria-labelledby="remove-server-title">
              <h3 id="remove-server-title">
                Remove this server from the panel?
              </h3>
              <p>
                <strong>{editing.name}</strong> will disappear from your server
                list, and its scheduled backups will stop. Its Minecraft server
                files, worlds, backups, and Recycle Bin data will stay on your
                computer.{" "}
                {editing.source === "imported"
                  ? "You can import the server folder again later."
                  : "Use Recover a saved server to add it back later."}
              </p>
              <div className="server-remove-actions">
                <button
                  ref={removalCancel}
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmingRemoval(false);
                    setError("");
                  }}
                >
                  Cancel removal
                </button>
                <button
                  className="btn danger"
                  type="button"
                  disabled={busy || running}
                  onClick={() => void removeServer()}
                >
                  <Trash2 size={15} />
                  {busy ? "Removing…" : "Remove server"}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                className="server-remove-link"
                type="button"
                disabled={busy || running}
                onClick={() => {
                  setConfirmingRemoval(true);
                  setError("");
                }}
              >
                <Trash2 size={14} /> Remove server
              </button>
              {running && (
                <p>Stop this server from Console before removing it.</p>
              )}
            </div>
          )}
        </div>
      </form>
    </dialog>
  );
}
