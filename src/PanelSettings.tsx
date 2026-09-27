import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  Globe,
  Monitor,
  Settings2,
  X,
} from "lucide-react";
import {
  api,
  messageOf,
  PanelScope,
  ServerScope,
  SessionActiveContext,
  SessionExpiredContext,
  type PageProps,
} from "./api";
import { PanelUsers, RemoteAccessSetup } from "./pages/Subusers";
import Switch from "./Switch";
import StatePanel from "./StatePanel";
import "./panel-settings.css";

type DesktopSettings = {
  desktop: boolean;
  startAtLogin: boolean;
  autoStartServerIds: string[];
  keepInTray: boolean;
  startupSupported: boolean;
  startupReason?: string;
  startupError?: string;
  missingAutoStartServerIds?: string[];
};
type StartupServer = { id: string; name: string; unavailable?: boolean };
const ignoreSettings = () => {};
const localSessionActive = () => true;

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
        // Startup, panel accounts and Remote Access all belong to this local
        // installation, including when opened above a remote server workspace.
        <PanelScope.Provider value={null}>
          <ServerScope.Provider value={null}>
            <SessionActiveContext.Provider value={localSessionActive}>
              <SessionExpiredContext.Provider value={null}>
                <SettingsDialog
                  notify={notify}
                  onClose={() => setOpen(false)}
                />
              </SessionExpiredContext.Provider>
            </SessionActiveContext.Provider>
          </ServerScope.Provider>
        </PanelScope.Provider>
      )}
    </>
  );
}

function SettingsDialog({
  notify,
  onClose,
}: PageProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState("general");
  const [remoteOpened, setRemoteOpened] = useState(false);
  function selectTab(next: string) {
    if (next === "remote") setRemoteOpened(true);
    setTab(next);
  }
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
          startAtLogin: draft.startAtLogin,
          autoStartServerIds: draft.autoStartServerIds,
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
    (draft.startAtLogin !== settings.startAtLogin ||
      JSON.stringify(draft.autoStartServerIds) !==
        JSON.stringify(settings.autoStartServerIds) ||
      draft.keepInTray !== settings.keepInTray);
  return (
    <dialog
      ref={dialog}
      className="panel-settings-dialog"
      aria-labelledby="panel-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (event.target !== event.currentTarget) return;
        if (!busy) onClose();
      }}
    >
      <div className="panel-settings-heading">
        <div>
          <h2 id="panel-settings-title">Panel Settings</h2>
          <p>Make MC Panel work the way you want on this computer.</p>
        </div>
        <button
          className="btn icon"
          aria-label="Close Panel Settings"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      <div
        className="panel-settings-tabs"
        role="tablist"
        aria-label="Panel settings sections"
      >
        {[
          { id: "general", label: "General", Icon: Monitor },
          { id: "remote", label: "Remote Access", Icon: Globe },
        ].map(({ id, label, Icon }) => (
          <button
            key={id}
            id={`panel-settings-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-settings-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => selectTab(id)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "general"
                  : event.key === "End"
                    ? "remote"
                    : tab === "general"
                      ? "remote"
                      : "general";
              selectTab(next);
              document.getElementById(`panel-settings-tab-${next}`)?.focus();
            }}
          >
            <Icon size={17} /> {label}
          </button>
        ))}
      </div>
      <div
        id="panel-settings-general"
        role="tabpanel"
        aria-labelledby="panel-settings-tab-general"
        hidden={tab !== "general"}
      >
        <section
          className="panel-startup-settings"
          aria-labelledby="panel-startup-title"
        >
          <h3 id="panel-startup-title">
            <Monitor size={19} />
            Startup & window behavior
          </h3>
          {loading ? (
            <StatePanel variant="loading" title="Loading panel settings…" />
          ) : settings?.desktop && draft ? (
            <form onSubmit={save}>
              <fieldset disabled={busy}>
                <div className="panel-setting-row">
                  <Switch
                    checked={draft.startAtLogin}
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, startAtLogin: checked })
                    }
                    disabled={!settings.startupSupported}
                    label="Start MC Panel when I sign in"
                  />
                  <p>
                    {settings.startupSupported
                      ? "Open the panel automatically when you sign in to Windows after starting this PC."
                      : settings.startupReason}
                  </p>
                </div>
                <div className="panel-setting-row">
                  <ServerChecklist
                    servers={servers}
                    selected={draft.autoStartServerIds}
                    onChange={(autoStartServerIds) =>
                      setDraft({ ...draft, autoStartServerIds })
                    }
                  />
                  <p>
                    Choose one or more servers on this computer. They start when
                    the panel launches, including at sign-in if enabled above.
                    Leave the list unchecked to start servers yourself.
                  </p>
                  <p>
                    Servers must be ready to run with the Minecraft EULA
                    accepted. Returning from the tray does not start them again;
                    an app update leaves them stopped.
                  </p>
                </div>
                <div className="panel-setting-row">
                  <Switch
                    checked={draft.keepInTray}
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, keepInTray: checked })
                    }
                    label="Keep MC Panel in the system tray"
                  />
                  <p>
                    Closing the window keeps servers and remote access running.
                    Turn this off to quit when you close the window. The panel
                    asks before stopping running servers.
                  </p>
                </div>
                {settings.startupError && (
                  <p className="panel-settings-warning" role="status">
                    Last automatic start: {settings.startupError}
                  </p>
                )}
                {!!settings.missingAutoStartServerIds?.length && (
                  <p className="panel-settings-warning" role="status">
                    A selected server is unavailable. Restore its files or
                    uncheck it in the list above.
                  </p>
                )}
                <div className="panel-settings-actions">
                  <button className="btn primary" disabled={!changed}>
                    {busy ? "Saving…" : "Save settings"}
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
        {settings?.desktop && (
          <section
            className="panel-updates-settings"
            aria-labelledby="panel-updates-title"
          >
            <div>
              <h3 id="panel-updates-title">
                <ArrowDownToLine size={19} /> App updates
              </h3>
              <p>
                Check for the latest MC Panel build and install updates on this
                computer.
              </p>
            </div>
            <button
              className="btn"
              aria-label="App updates"
              onClick={() => {
                const bridge = window.mcPanelConnections;
                if (bridge?.unified) {
                  if (!bridge.openUpdates) {
                    setError("App updates are unavailable on this computer.");
                    return;
                  }
                  void bridge
                    .openUpdates()
                    .catch((cause) =>
                      setError(messageOf(cause, "Unable to open app updates.")),
                    );
                } else window.dispatchEvent(new Event("mc-panel-updates-open"));
              }}
            >
              <ArrowDownToLine size={16} /> Updates
            </button>
          </section>
        )}
      </div>
      {remoteOpened && (
        <div
          id="panel-settings-remote"
          role="tabpanel"
          aria-labelledby="panel-settings-tab-remote"
          className="panel-remote-settings"
          hidden={tab !== "remote"}
        >
          <RemoteAccessSetup notify={notify} onSettings={ignoreSettings} />
          <PanelUsers notify={notify} />
        </div>
      )}
    </dialog>
  );
}

function ServerChecklist({
  servers,
  selected,
  onChange,
}: {
  servers: StartupServer[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choices = [
    ...servers,
    ...selected
      .filter((value) => !servers.some((server) => server.id === value))
      .map((value) => ({
        id: value,
        name: `Unavailable server (${value})`,
        unavailable: true,
      })),
  ];
  const summary =
    selected.length === 0
      ? "None — start servers myself"
      : selected.length === 1
        ? choices.find((server) => server.id === selected[0])?.name
        : `${selected.length} servers selected`;
  return (
    <div
      className="panel-server-checklist"
      ref={root}
      onKeyDown={(event) => {
        // Labels briefly move focus to the enclosing dialog before activating
        // their checkbox. Close for keyboard navigation after focus settles;
        // the outside pointer listener handles mouse/touch navigation.
        if (event.key === "Tab" && open) {
          requestAnimationFrame(() => {
            if (root.current && !root.current.contains(document.activeElement))
              setOpen(false);
          });
        }
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <label id={`${id}-label`}>Servers to start when the panel opens</label>
      <button
        type="button"
        className="panel-server-trigger"
        ref={trigger}
        aria-labelledby={`${id}-label`}
        aria-expanded={open}
        aria-controls={`${id}-choices`}
        onClick={() => setOpen(!open)}
      >
        <span>{summary}</span>
        <ChevronDown size={17} />
      </button>
      {open && (
        <div
          className="panel-server-choices"
          id={`${id}-choices`}
          role="group"
          aria-labelledby={`${id}-label`}
        >
          {!choices.length && (
            <p>Add a server on this computer to select it here.</p>
          )}
          {choices.map((server) => (
            <label key={server.id}>
              <input
                type="checkbox"
                checked={selected.includes(server.id)}
                disabled={server.unavailable && !selected.includes(server.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, server.id]
                      : selected.filter((value) => value !== server.id),
                  )
                }
              />
              <span>
                {server.name}
                {server.unavailable && <small>Unavailable</small>}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
