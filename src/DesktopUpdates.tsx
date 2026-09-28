import { useContext, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, RefreshCw, X } from "lucide-react";
import { api, flushDesktopSelection, post } from "./api";
import { DesktopWorkspaceContext } from "./workspace-target";
import "./updates.css";

type UpdateState = {
  desktop: boolean;
  supported: boolean;
  version: string;
  channel: string;
  status: string;
  availableVersion?: string | null;
  progress?: number;
  message: string;
};

export default function DesktopUpdates({
  remote = false,
}: {
  remote?: boolean;
}) {
  const workspace = useContext(DesktopWorkspaceContext);
  if (window.mcPanelConnections?.runtime === "browser")
    return workspace?.connections?.panels.some((panel) => panel.local) ? (
      <LocalUpdates />
    ) : null;
  // Panel Settings owns the only workspace entry point. Keep the local
  // listener mounted for owner-browser/older-desktop events; remote native
  // workspaces open the isolated local updater through their IPC bridge.
  return remote ? null : <LocalUpdates />;
}

export function DesktopUpdatesOverlay() {
  return <LocalUpdates standalone />;
}

function LocalUpdates({ standalone = false }: { standalone?: boolean }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(standalone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => {
    if (standalone) window.mcPanelUpdates?.close();
    else {
      // Close before an error-only dialog unmounts, restoring keyboard focus
      // to the Updates button that opened it from Panel Settings.
      dialog.current?.close();
      setOpen(false);
    }
  };
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<UpdateState>("/desktop/updates")
        .then((next) => {
          if (!active) return;
          if (next.desktop) {
            setState(next);
            setLoadError("");
          } else if (standalone || open)
            setLoadError("App updates are only available in MC Panel desktop.");
        })
        .catch((cause) => {
          if (active && (standalone || open))
            setLoadError(
              cause instanceof Error
                ? cause.message
                : "Unable to contact the updater.",
            );
        });
    const showUpdates = () => {
      setOpen(true);
    };
    window.addEventListener("mc-panel-updates-open", showUpdates);
    if (open) void refresh();
    const timer = open ? setInterval(refresh, 1000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("mc-panel-updates-open", showUpdates);
    };
  }, [open, standalone]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open, state !== null]);

  async function action(name: "check" | "download" | "install") {
    setBusy(true);
    setError("");
    try {
      if (name === "install") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Native Quit owns the final save barrier and offers an explicit
          // override. An unavailable renderer save must still reach that flow.
          await Promise.race([
            flushDesktopSelection().catch(() => {}),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 4000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      setState(await post<UpdateState>(`/desktop/updates/${name}`));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to contact the updater.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!state && !standalone && !open) return null;
  const working =
    busy ||
    ["checking", "downloading", "installing"].includes(state?.status || "");
  return (
    <>
      <dialog
        className="updates-dialog"
        ref={dialog}
        aria-labelledby="updates-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className="updates-heading">
          <h2 id="updates-title">App updates on this computer</h2>
          <button
            className="btn icon"
            aria-label="Close app updates"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          Update the MC Panel installation on this computer with the latest
          tested build from the dev branch. Connected remote panels are updated
          on their own computers.
        </p>
        {state && (
          <dl className="updates-versions">
            <div>
              <dt>Installed version</dt>
              <dd>{state.version}</dd>
            </div>
            <div>
              <dt>Update channel</dt>
              <dd>{state.channel === "dev" ? "Dev" : state.channel}</dd>
            </div>
            {state.availableVersion && (
              <div>
                <dt>Available version</dt>
                <dd>{state.availableVersion}</dd>
              </div>
            )}
          </dl>
        )}
        <p className="updates-message" role="status">
          {state
            ? state.message ||
              "Check for a new build. Your server files and settings are kept when you update."
            : loadError
              ? "Waiting for the local updater to respond…"
              : "Loading app updates…"}
        </p>
        {state?.status === "downloading" && (
          <div className="update-progress">
            <progress
              max={100}
              value={state.progress ?? 0}
              aria-label="Update download progress"
            />
            <span>{Math.round(state.progress ?? 0)}%</span>
          </div>
        )}
        {state?.status === "downloaded" && (
          <p>
            Installing restarts MC Panel on this computer. Servers hosted on
            this computer will be stopped after active backups finish. Start
            them again after the update. Servers on connected remote panels keep
            running; unfinished transfers to this computer may be interrupted.
          </p>
        )}
        {(error || loadError) && (
          <p role="alert" className="form-error">
            {error || loadError}
          </p>
        )}
        <div className="updates-actions">
          <button className="btn" onClick={close}>
            Close
          </button>
          {state?.supported &&
            (state.status === "available" ? (
              <button
                className="btn primary"
                disabled={working}
                onClick={() => void action("download")}
              >
                <ArrowDownToLine size={15} />
                Download update
              </button>
            ) : ["downloaded", "shutdown-waiting"].includes(state.status) ? (
              <button
                className="btn primary"
                disabled={working}
                onClick={() => void action("install")}
              >
                <RefreshCw size={15} />
                {state.status === "shutdown-waiting"
                  ? "Show shutdown options"
                  : "Restart to update"}
              </button>
            ) : (
              <button
                className="btn primary"
                disabled={working}
                onClick={() => void action("check")}
              >
                <RefreshCw size={15} />
                {state.status === "checking"
                  ? "Checking…"
                  : state.status === "downloading"
                    ? "Downloading…"
                    : state.status === "installing"
                      ? "Restarting…"
                      : "Check for updates"}
              </button>
            ))}
        </div>
      </dialog>
    </>
  );
}
