import { useEffect, useRef, useState, type FormEvent } from "react";
import { Monitor, Settings2, X } from "lucide-react";
import { api, messageOf, type PageProps } from "./api";
import { RemoteAccessSetup } from "./pages/Subusers";
import Switch from "./Switch";
import StatePanel from "./StatePanel";
import "./panel-settings.css";

type DesktopSettings = {
  desktop: boolean;
  startupMode: "off" | "panel" | "server";
  startupServerId: string | null;
  keepInTray: boolean;
  startupSupported: boolean;
  startupReason?: string;
  startupError?: string;
  missingStartupServer?: boolean;
};
type StartupServer = { id: string; name: string; unavailable?: boolean };
const ignoreSettings = () => {};

export default function PanelSettings({ notify }: PageProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="help-button"
        aria-label="Panel Settings"
        title="Panel Settings"
        onClick={() => setOpen(true)}
      >
        <Settings2 size={16} />
        <span>Panel Settings</span>
      </button>
      {open && (
        <SettingsDialog notify={notify} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function SettingsDialog({
  notify,
  onClose,
}: PageProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [draft, setDraft] = useState<DesktopSettings | null>(null);
  const [servers, setServers] = useState<StartupServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void Promise.allSettled([
      api<DesktopSettings>("/desktop/settings", { signal: controller.signal }),
      api<{ servers: StartupServer[] }>("/servers", {
        signal: controller.signal,
      }),
    ]).then(([desktop, roster]) => {
      if (controller.signal.aborted) return;
      if (desktop.status === "fulfilled") {
        setSettings(desktop.value);
        setDraft(desktop.value);
      } else if (desktop.reason?.status === 404) {
        setSettings({ desktop: false } as DesktopSettings);
      } else setError(messageOf(desktop.reason));
      if (roster.status === "fulfilled") setServers(roster.value.servers);
      else if (desktop.status === "fulfilled" && desktop.value.desktop)
        setError(messageOf(roster.reason, "Unable to load startup servers."));
      setLoading(false);
    });
    return () => controller.abort();
  }, [attempt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<DesktopSettings>("/desktop/settings", {
        method: "PUT",
        body: JSON.stringify({
          startupMode: draft.startupMode,
          startupServerId: draft.startupServerId,
          keepInTray: draft.keepInTray,
        }),
      });
      setSettings(next);
      setDraft(next);
      notify("Panel startup and tray settings saved.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  const changed =
    draft &&
    settings &&
    (draft.startupMode !== settings.startupMode ||
      draft.startupServerId !== settings.startupServerId ||
      draft.keepInTray !== settings.keepInTray);
  return (
    <dialog
      ref={dialog}
      className="panel-settings-dialog"
      aria-labelledby="panel-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="panel-settings-heading">
        <div>
          <h2 id="panel-settings-title">Panel Settings</h2>
          <p>Settings for this host and its panel.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Close Panel Settings"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      <section
        className="panel-startup-settings"
        aria-labelledby="panel-startup-title"
      >
        <h3 id="panel-startup-title">
          <Monitor size={19} />
          Startup and system tray
        </h3>
        {loading ? (
          <StatePanel variant="loading" title="Loading panel settings…" />
        ) : settings?.desktop && draft ? (
          <form onSubmit={save}>
            <fieldset disabled={busy}>
              <div className="form-field">
                <label htmlFor="panel-startup-mode">When this PC starts</label>
                <select
                  id="panel-startup-mode"
                  value={draft.startupMode}
                  disabled={!settings.startupSupported}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      startupMode: event.target
                        .value as DesktopSettings["startupMode"],
                    })
                  }
                >
                  <option value="off">Do not start automatically</option>
                  <option value="panel">Start MC Panel</option>
                  <option value="server">Start MC Panel and a server</option>
                </select>
                <small>
                  {settings.startupSupported
                    ? "Runs when you sign in to Windows after startup. Starting a server also starts the panel; opening the panel manually does not start a server."
                    : settings.startupReason}
                </small>
              </div>
              {draft.startupMode === "server" && (
                <div className="form-field">
                  <label htmlFor="panel-startup-server">Server to start</label>
                  <select
                    id="panel-startup-server"
                    required
                    value={draft.startupServerId || ""}
                    disabled={!settings.startupSupported}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        startupServerId: event.target.value || null,
                      })
                    }
                  >
                    <option value="">Choose a local server</option>
                    {draft.startupServerId &&
                      !servers.some(
                        (server) => server.id === draft.startupServerId,
                      ) && (
                        <option value={draft.startupServerId} disabled>
                          Previously selected server is unavailable
                        </option>
                      )}
                    {servers.map((server) => (
                      <option
                        key={server.id}
                        value={server.id}
                        disabled={server.unavailable}
                      >
                        {server.name}
                        {server.unavailable ? " (unavailable)" : ""}
                      </option>
                    ))}
                  </select>
                  <small>
                    The saved server is used even if you last viewed another
                    server. Its launch files and accepted Minecraft EULA must be
                    ready.
                  </small>
                </div>
              )}
              <div className="panel-tray-setting">
                <Switch
                  checked={draft.keepInTray}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, keepInTray: checked })
                  }
                  label="Keep MC Panel in the system tray when its window is closed"
                />
                <p>
                  Keep servers, remote access, and scheduled backups running.
                  When off, closing the window quits the panel and asks before
                  stopping running servers.
                </p>
              </div>
              {settings.startupError && (
                <p className="panel-settings-warning" role="status">
                  Last automatic start: {settings.startupError}
                </p>
              )}
              {settings.missingStartupServer && (
                <p className="panel-settings-warning" role="status">
                  The configured startup server is no longer available. Choose
                  another server or change the startup option.
                </p>
              )}
              <div className="panel-settings-actions">
                <button className="btn primary" disabled={!changed}>
                  {busy ? "Saving…" : "Save startup settings"}
                </button>
              </div>
            </fieldset>
          </form>
        ) : (
          settings && (
            <p className="panel-settings-unavailable">
              Startup and system tray settings are available in the MC Panel
              desktop app on this host.
            </p>
          )
        )}
        {error && (
          <div className="panel-settings-error" role="alert">
            <p>{error}</p>
            {!settings && (
              <button
                className="btn"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            )}
          </div>
        )}
      </section>
      <RemoteAccessSetup notify={notify} onSettings={ignoreSettings} />
    </dialog>
  );
}
