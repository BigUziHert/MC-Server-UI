import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Folder, FolderOpen, HardDrive, LoaderCircle, X } from "lucide-react";
import {
  formatBytes,
  messageOf,
  PanelScope,
  useServerApi,
  type PageProps,
} from "./api";
import HostDirectoryPicker from "./HostDirectoryPicker";
import "./backup-location.css";

type LocationJob = {
  id: string;
  status: "running" | "completed" | "failed";
  phase: string;
  processedBytes: number;
  totalBytes: number;
  processedFiles: number;
  totalFiles: number;
  error?: string;
};
type Location = {
  directory: string;
  defaultDirectory: string;
  available: boolean;
  error?: string;
  canChange: boolean;
  job: LocationJob | null;
};
type Preview = {
  directory: string;
  currentDirectory: string;
  backupCount: number;
  totalBytes: number;
  revision: string;
};
export type BackupLocationState = { moving: boolean; available: boolean };

function LocationProgress({
  job,
  starting,
}: {
  job: LocationJob | null;
  starting: boolean;
}) {
  if (!job && !starting) return null;
  const active = starting || job?.status === "running";
  const title = starting
    ? "Starting backup move…"
    : job?.status === "completed"
      ? "Backup location updated"
      : job?.status === "failed"
        ? "Backup move failed"
        : {
            copying: "Copying backups…",
            verifying: "Verifying backups…",
            switching: "Finishing move…",
            committing: "Finishing move…",
            cleaning: "Finishing move…",
            preparing: "Checking backups…",
            scanning: "Checking backups…",
          }[job?.phase || ""] || "Moving backups…";
  // Verification and finalization must finish before the move reaches 100%.
  const percent =
    job?.status === "completed"
      ? 100
      : job && job.totalBytes > 0
        ? Math.min(99, Math.floor((job.processedBytes / job.totalBytes) * 100))
        : undefined;
  return (
    <section
      className="backup-job backup-location-progress"
      aria-label="Backup location progress"
    >
      <div className="backup-job-heading">
        <strong role="status">{title}</strong>
        {active && percent !== undefined && <span>{percent}%</span>}
      </div>
      {active && (
        <progress aria-label="Backup move progress" max={100} value={percent} />
      )}
      {job && job.totalBytes > 0 && (
        <p>
          {formatBytes(job.processedBytes)} of {formatBytes(job.totalBytes)} ·{" "}
          {job.processedFiles} of {job.totalFiles} files
        </p>
      )}
      {active && (
        <p>
          The move keeps running when you close this dialog or leave this page.
          Backups are available again when it finishes.
        </p>
      )}
      {job && (job.status === "failed" || job.error) && (
        <p className="storage-form-error" role="alert">
          {job.error ||
            "The move could not be completed. Your previous backup location is still in use."}
        </p>
      )}
    </section>
  );
}

export default function BackupLocation({
  notify,
  serverBusy,
  onStateChange,
  onSettled,
}: PageProps & {
  serverBusy: boolean;
  onStateChange: (state: BackupLocationState) => void;
  onSettled: () => void;
}) {
  const { api } = useServerApi();
  const panel = useContext(PanelScope);
  const [location, setLocation] = useState<Location | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const requestSequence = useRef(0);
  const dialogVersion = useRef(0);
  const moveDialogVersion = useRef<number | null>(null);
  const locationRef = useRef<Location | null>(null);
  const previousJob = useRef<LocationJob | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ notify, onStateChange, onSettled });
  callbacks.current = { notify, onStateChange, onSettled };
  const moving = starting || location?.job?.status === "running";

  const accept = useCallback((result: Location) => {
    const previous = previousJob.current;
    previousJob.current = result.job;
    locationRef.current = result;
    setLocation(result);
    setError("");
    if (
      previous?.status === "running" &&
      previous.id === result.job?.id &&
      result.job.status !== "running"
    ) {
      callbacks.current.onSettled();
      if (result.job.status === "completed") {
        callbacks.current.notify(
          result.job.error ||
            "Backup location updated. Your backup history and schedule are ready to use.",
          !!result.job.error,
        );
        if (moveDialogVersion.current === dialogVersion.current) {
          dialogVersion.current++;
          setOpen(false);
          setBrowsing(false);
        }
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await api<Location>("/backups/location", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!mounted.current || sequence !== requestSequence.current) return;
      accept(result);
      if (!pending.current) setStarting(false);
    } catch (cause) {
      if (!mounted.current || sequence !== requestSequence.current) return;
      if ([403, 404].includes((cause as { status?: number }).status || 0)) {
        setStarting(false);
        setUnsupported(true);
        return;
      }
      setError(`Backup location could not be checked. ${messageOf(cause)}`);
    }
  }, [api, accept]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestSequence.current++;
      dialogVersion.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (unsupported) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(poll, moving ? 1000 : 5000);
    };
    timer = setTimeout(poll, moving ? 1000 : 5000);
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [moving, unsupported, refresh]);
  useEffect(() => {
    callbacks.current.onStateChange({
      moving: Boolean(moving),
      available: unsupported || location?.available !== false,
    });
  }, [moving, unsupported, location?.available]);
  useEffect(() => {
    if (!open) return;
    const element = dialogRef.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      element?.close();
      if (changeButton.current?.isConnected) changeButton.current.focus();
    };
  }, [open]);

  function close() {
    dialogVersion.current++;
    setOpen(false);
    setBrowsing(false);
  }
  function openEditor() {
    if (!location?.canChange || moving || serverBusy) return;
    dialogVersion.current++;
    setDirectory(location.directory);
    setPreview(null);
    setDialogError("");
    setBrowsing(false);
    setOpen(true);
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    if (
      pending.current ||
      browsing ||
      moving ||
      serverBusy ||
      !directory.trim() ||
      !location?.canChange
    )
      return;
    pending.current = true;
    setReviewing(true);
    setDialogError("");
    const version = dialogVersion.current;
    try {
      const result = await api<Preview>("/backups/location/preview", {
        method: "POST",
        body: JSON.stringify({ directory: directory.trim() }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!mounted.current || version !== dialogVersion.current) return;
      setPreview(result);
    } catch (cause) {
      if (mounted.current && version === dialogVersion.current)
        setDialogError(messageOf(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setReviewing(false);
    }
  }
  async function move(event: FormEvent) {
    event.preventDefault();
    if (
      pending.current ||
      moving ||
      serverBusy ||
      !preview ||
      !location?.canChange
    )
      return;
    pending.current = true;
    setStarting(true);
    setDialogError("");
    requestSequence.current++;
    const version = dialogVersion.current;
    moveDialogVersion.current = version;
    try {
      const result = await api<{ job: LocationJob }>("/backups/location/jobs", {
        method: "POST",
        body: JSON.stringify({
          directory: preview.directory,
          revision: preview.revision,
          confirm: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!mounted.current) return;
      requestSequence.current++;
      if (locationRef.current) {
        previousJob.current = { ...result.job, status: "running" };
        accept({ ...locationRef.current, job: result.job });
      }
      setPreview(null);
    } catch (cause) {
      if (mounted.current && version === dialogVersion.current) {
        setDialogError(`The move could not be confirmed. ${messageOf(cause)}`);
        setPreview(null);
      }
    } finally {
      pending.current = false;
      if (mounted.current) {
        // Reconcile an uncertain POST before re-enabling backup operations.
        await refresh();
      }
    }
  }
  if (unsupported) return null;
  return (
    <section
      className="panel backup-location"
      aria-labelledby="backup-location-title"
    >
      <div className="storage-section-heading">
        <h2 id="backup-location-title">
          <HardDrive size={18} />
          Backup location
        </h2>
      </div>
      <div className="backup-location-body">
        <p>
          Saved on the computer hosting this server. Manual and automatic
          backups use this folder.
        </p>
        {location ? (
          <div className="backup-location-path">
            <Folder size={16} />
            <span>{location.directory}</span>
          </div>
        ) : (
          !error && (
            <p role="status">
              <LoaderCircle size={14} className="spin" /> Checking backup
              folder…
            </p>
          )
        )}
        {location && !location.available && (
          <p className="storage-form-error" role="alert">
            {location.error ||
              "The backup folder is unavailable. Reconnect its drive and try again."}
          </p>
        )}
        {error && (
          <div className="storage-form-error" role="alert">
            <p>{error}</p>
            <button
              className="btn small"
              type="button"
              onClick={() => void refresh()}
            >
              Retry location
            </button>
          </div>
        )}
        <LocationProgress job={location?.job || null} starting={starting} />
        {location?.canChange && (
          <button
            ref={changeButton}
            type="button"
            className="btn backup-location-change"
            disabled={moving || serverBusy}
            onClick={openEditor}
          >
            <FolderOpen size={15} /> Change location
          </button>
        )}
        {serverBusy && !moving && (
          <p className="backup-location-hint">
            Wait for the current backup operation to finish before changing
            folders.
          </p>
        )}
        {location && !location.canChange && (
          <p className="backup-location-hint">
            Your account cannot change this server's backup location.
          </p>
        )}
      </div>
      {open && (
        <dialog
          className="modal storage-modal storage-native-dialog backup-location-dialog"
          ref={dialogRef}
          aria-labelledby="backup-location-dialog-title"
          aria-describedby="backup-location-dialog-description"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              close();
          }}
        >
          <form onSubmit={preview ? move : review}>
            <div className="storage-modal-heading">
              <div>
                <h2 id="backup-location-dialog-title">
                  Change backup location
                </h2>
                <p id="backup-location-dialog-description">
                  Choose a folder on the computer hosting this server for its
                  manual and automatic backups.
                </p>
              </div>
              <button
                type="button"
                className="btn icon"
                aria-label="Close backup location dialog"
                onClick={close}
              >
                <X size={18} />
              </button>
            </div>
            {moving ? (
              <LocationProgress
                job={location?.job || null}
                starting={starting}
              />
            ) : preview ? (
              <>
                <p className="backup-location-summary">
                  Move{" "}
                  <strong>
                    {preview.backupCount}{" "}
                    {preview.backupCount === 1 ? "backup" : "backups"}
                  </strong>{" "}
                  ({formatBytes(preview.totalBytes)}) to the selected folder?
                </p>
                <dl className="backup-location-review">
                  <dt>Current folder</dt>
                  <dd>{preview.currentDirectory}</dd>
                  <dt>Destination folder</dt>
                  <dd>{preview.directory}</dd>
                </dl>
                <p className="backup-location-explanation">
                  Your archives will be copied and verified before switching
                  folders. Backup history and schedules will continue to work.
                  Old copies are removed only after the move succeeds.
                </p>
              </>
            ) : (
              <>
                <label
                  className="form-field"
                  htmlFor="backup-location-directory"
                >
                  Backup folder
                  <input
                    id="backup-location-directory"
                    value={directory}
                    onChange={(event) => {
                      setDirectory(event.target.value);
                      setDialogError("");
                    }}
                    disabled={reviewing}
                    placeholder="Enter a folder path"
                    autoComplete="off"
                  />
                </label>
                <div className="backup-location-choices">
                  <button
                    className="btn"
                    type="button"
                    disabled={reviewing}
                    onClick={() => setBrowsing(true)}
                  >
                    <FolderOpen size={15} /> Browse folders
                  </button>
                  {location && directory !== location.defaultDirectory && (
                    <button
                      className="btn small"
                      type="button"
                      disabled={reviewing}
                      onClick={() => setDirectory(location.defaultDirectory)}
                    >
                      Use default folder
                    </button>
                  )}
                </div>
                {browsing && (
                  <HostDirectoryPicker
                    purpose="backup"
                    initialDirectory={directory}
                    remoteHost={
                      panel && panel.panelId !== "local"
                        ? panel.label || panel.origin
                        : undefined
                    }
                    onSelect={(selected) => {
                      setDirectory(selected);
                      setBrowsing(false);
                      setDialogError("");
                    }}
                    onClose={() => setBrowsing(false)}
                  />
                )}
                <p className="backup-location-explanation">
                  Choose an empty folder outside the Minecraft server folder.
                  You can choose another disk on that computer or create a
                  folder in the browser. Existing backups move with this
                  setting.
                </p>
                {location?.job?.status === "failed" && (
                  <LocationProgress job={location.job} starting={false} />
                )}
              </>
            )}
            {dialogError && (
              <p className="storage-form-error" role="alert">
                {dialogError}
              </p>
            )}
            <div className="storage-modal-footer">
              <button className="btn" type="button" onClick={close}>
                Close
              </button>
              {!moving && (
                <>
                  {preview && (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        setPreview(null);
                        setDialogError("");
                      }}
                    >
                      Choose another folder
                    </button>
                  )}
                  <button
                    className="btn primary"
                    disabled={
                      reviewing || serverBusy || browsing || !directory.trim()
                    }
                  >
                    {reviewing && <LoaderCircle size={15} className="spin" />}
                    {preview
                      ? "Move backups"
                      : reviewing
                        ? "Checking folder…"
                        : "Review move"}
                  </button>
                </>
              )}
            </div>
          </form>
        </dialog>
      )}
    </section>
  );
}
