import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, RefreshCw, X } from "lucide-react";
import { api, post } from "./api";
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

export default function DesktopUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<UpdateState>("/desktop/updates")
        .then((next) => {
          if (active && next.desktop) setState(next);
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(refresh, open ? 1000 : 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  async function action(name: "check" | "download" | "install") {
    setBusy(true);
    setError("");
    try {
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
  if (!state) return null;
  const working =
    busy || ["checking", "downloading", "installing"].includes(state.status);
  const ready = ["available", "downloaded"].includes(state.status);
  return (
    <>
      <button
        className={`help-button update-button ${ready ? "update-ready" : ""}`}
        onClick={() => setOpen(true)}
        aria-label="App updates"
      >
        <ArrowDownToLine size={16} />
        <span>{ready ? "Update available" : "Updates"}</span>
      </button>
      <dialog
        className="updates-dialog"
        ref={dialog}
        aria-labelledby="updates-title"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
      >
        <div className="updates-heading">
          <h2 id="updates-title">App updates</h2>
          <button
            className="btn icon"
            aria-label="Close app updates"
            onClick={() => setOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <p>Get the latest tested build from the dev branch.</p>
        <dl className="updates-versions">
          <div>
            <dt>Installed version</dt>
            <dd>{state.version}</dd>
          </div>
          <div>
            <dt>Update channel</dt>
            <dd>Dev</dd>
          </div>
          {state.availableVersion && (
            <div>
              <dt>Available version</dt>
              <dd>{state.availableVersion}</dd>
            </div>
          )}
        </dl>
        <p className="updates-message" role="status">
          {state.message ||
            "Check for a new build. Your server files and settings are kept when you update."}
        </p>
        {state.status === "downloading" && (
          <div className="update-progress">
            <progress
              max={100}
              value={state.progress ?? 0}
              aria-label="Update download progress"
            />
            <span>{Math.round(state.progress ?? 0)}%</span>
          </div>
        )}
        {state.status === "downloaded" && (
          <p>
            Installing restarts MC Panel. Running servers will be stopped after
            active backups finish. Start them again after the update.
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="updates-actions">
          <button className="btn" onClick={() => setOpen(false)}>
            Close
          </button>
          {state.supported &&
            (state.status === "available" ? (
              <button
                className="btn primary"
                disabled={working}
                onClick={() => void action("download")}
              >
                <ArrowDownToLine size={15} />
                Download update
              </button>
            ) : state.status === "downloaded" ? (
              <button
                className="btn primary"
                disabled={working}
                onClick={() => void action("install")}
              >
                <RefreshCw size={15} />
                Restart to update
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
