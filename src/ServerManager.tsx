import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Box,
  ChevronDown,
  Plus,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { api, post } from "./api";
import "./servers.css";

export type ServerRecord = {
  id: string;
  name: string;
  status: "running" | "offline" | "starting" | "stopping";
  mode: "demo" | "live";
  address: string;
  port: number;
  memoryLimitMB: number;
  jar: string;
  javaPath: string;
  motd?: string;
  version?: string;
  software?: string;
};

export function ServerSwitcher({
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
  onSettings: () => void;
}) {
  return (
    <div className="fleet-switcher">
      <div className="fleet-label">
        <span>YOUR SERVERS</span>
        <span>{servers.length.toString().padStart(2, "0")}</span>
      </div>
      <div className="fleet-select-wrap">
        <span className="server-mini">
          <Box size={19} />
        </span>
        <div className="fleet-selection">
          <select
            aria-label="Switch server"
            value={selected.id}
            onChange={(e) => onSelect(e.target.value)}
          >
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
          <span>
            <i
              className={`status-dot ${selected.status === "running" ? "" : "offline"}`}
            />
            {selected.status}{" "}
            <span className="fleet-mode">
              · {selected.mode === "demo" ? "Demo" : "Java"}
            </span>
          </span>
        </div>
        <ChevronDown className="fleet-chevron" size={13} />
      </div>
      <div className="fleet-actions">
        <button onClick={onAdd}>
          <Plus size={13} />
          Add server
        </button>
        <button
          aria-label="Server settings"
          title="Server settings"
          onClick={onSettings}
        >
          <Settings2 size={14} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}

export default function ServerManager({
  editing,
  servers,
  onClose,
  onSaved,
  onRemoved,
}: {
  editing: ServerRecord | null;
  servers: ServerRecord[];
  onClose: () => void;
  onSaved: (server: ServerRecord) => void;
  onRemoved: (serverId: string) => void;
}) {
  let nextPort = 25565;
  while (servers.some((server) => server.port === nextPort)) nextPort++;
  const [name, setName] = useState(editing?.name ?? "");
  const [mode, setMode] = useState<"demo" | "live">(editing?.mode ?? "live");
  const [port, setPort] = useState(String(editing?.port ?? nextPort));
  const [memory, setMemory] = useState(String(editing?.memoryLimitMB ?? 4096));
  const [jar, setJar] = useState(editing?.jar || "server.jar");
  const [javaPath, setJavaPath] = useState(editing?.javaPath || "java");
  const [motd, setMotd] = useState(
    editing?.motd ?? "Welcome to our Minecraft server",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const removalCancel = useRef<HTMLButtonElement>(null);
  const running = !!editing && editing.status !== "offline";
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (confirmingRemoval) removalCancel.current?.focus();
  }, [confirmingRemoval]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (confirmingRemoval || busy) return;
    setBusy(true);
    setError("");
    const settings = {
      name: name.trim(),
      mode,
      port: Number(port),
      memoryLimitMB: Number(memory),
      jar: jar.trim() || "server.jar",
      javaPath: javaPath.trim() || "java",
      motd,
    };
    try {
      const result = editing
        ? await api<{ server: ServerRecord }>(
            `/servers/${encodeURIComponent(editing.id)}`,
            {
              method: "PATCH",
              body: JSON.stringify(running ? { name: name.trim() } : settings),
            },
          )
        : await post<{ server: ServerRecord }>("/servers", settings);
      onSaved(result.server);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeDemo() {
    if (!editing || editing.mode !== "demo" || busy) return;
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
          : "Unable to remove this demo server.",
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
        <h2 id="server-dialog-title">
          {editing ? "Server settings" : "Add a server"}
        </h2>
        <p>
          {editing
            ? "Give your world a name and configure how it runs."
            : servers.length === 0
              ? "Set up your first world. Your server gets its own files, console, and backups."
              : "Another world, one familiar panel. Each server gets its own files, console, and backups."}
        </p>
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
        {running && (
          <div className="server-form-note">
            <AlertCircle size={16} />
            <span>
              You can rename this server now. Stop it from the console to change
              its mode, connection settings, or in-game message.
            </span>
          </div>
        )}
        <fieldset disabled={busy || running} className="server-config-fields">
          <div className="server-form-grid">
            <div className="form-field">
              <label htmlFor="server-mode">Mode</label>
              <select
                id="server-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as "demo" | "live")}
              >
                <option value="live">Minecraft Java</option>
                <option value="demo">Demo server</option>
              </select>
            </div>
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
          {mode === "live" && (
            <>
              <div className="server-form-grid">
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
                <div className="form-field">
                  <label htmlFor="server-jar">Server JAR</label>
                  <input
                    id="server-jar"
                    required
                    placeholder="server.jar"
                    value={jar}
                    onChange={(e) => setJar(e.target.value)}
                  />
                </div>
              </div>
              <div className="form-field">
                <label htmlFor="server-java">Java executable</label>
                <input
                  id="server-java"
                  required
                  placeholder="java"
                  value={javaPath}
                  onChange={(e) => setJavaPath(e.target.value)}
                />
                <small>
                  Use java from PATH or the full path to your Java executable.
                </small>
              </div>
            </>
          )}
        </fieldset>
        <div className="server-setup-note">
          <Box size={17} />
          <p>
            {mode === "demo"
              ? "Console and player actions are simulated in demo mode. File operations and backups use real local files."
              : "Upload your server JAR in File Manager, review the Minecraft EULA, and set eula=true yourself before starting. This panel won’t download or accept anything for you."}
          </p>
        </div>
        {error && (
          <div className="server-form-error" role="alert">
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
            {editing ? <Save size={15} /> : <Plus size={15} />}{" "}
            {busy ? "Saving…" : editing ? "Save changes" : "Create server"}
          </button>
        </div>
        {editing?.mode === "demo" && (
          <div className="server-remove-demo">
            {confirmingRemoval ? (
              <div role="group" aria-labelledby="remove-demo-title">
                <h3 id="remove-demo-title">Remove this demo server?</h3>
                <p>
                  <strong>{editing.name}</strong> and its backup schedule will
                  stop, and the demo will disappear from your server list. Its
                  files and backups will stay on your computer.
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
                    disabled={busy}
                    onClick={() => void removeDemo()}
                  >
                    <Trash2 size={15} />
                    {busy ? "Removing…" : "Remove demo server"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="server-remove-link"
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmingRemoval(true);
                  setError("");
                }}
              >
                <Trash2 size={14} /> Remove demo server
              </button>
            )}
          </div>
        )}
      </form>
    </dialog>
  );
}
