import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Archive,
  CalendarClock,
  Check,
  Clock3,
  Download,
  HardDrive,
  History,
  LoaderCircle,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  useServerApi,
  formatBytes,
  relativeTime,
  messageOf,
  type PageProps,
} from "../api";
import "./storage.css";
import "./storage-dialog.css";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Switch from "../Switch";

type Backup = {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  status: "completed";
  trigger: "manual" | "scheduled";
  compression?: "gzip";
  compressionLevel?: number;
  originalSize?: number;
};
type Schedule = {
  enabled: boolean;
  type: "interval" | "daily" | "weekly";
  intervalHours: number;
  time: string;
  dayOfWeek: number;
  retention: number;
  nextRun: string | null;
};
type BackupResult = {
  backups: Backup[];
  schedule: Schedule;
  timezone?: string;
  job?: BackupJob | null;
};
type BackupJob = {
  id: string;
  name: string;
  trigger: "manual" | "scheduled";
  status: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  phase: "scanning" | "saving" | "archiving" | "finalizing" | "resuming";
  totalBytes: number;
  processedBytes: number;
  totalFiles: number;
  processedFiles: number;
  currentFile: string | null;
  compressedBytes: number;
  startedAt: string;
  updatedAt: string;
  error?: string;
  cancellable: boolean;
};
const isActiveJob = (job: BackupJob | null) =>
  job?.status === "running" || job?.status === "cancelling";

function BackupProgress({
  job,
  starting,
  error,
  cancelling,
  canCancel,
  onCancel,
  onRetry,
}: {
  job: BackupJob | null;
  starting: boolean;
  error: string;
  cancelling: boolean;
  canCancel: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const active = isActiveJob(job);
  const measured =
    job && ["archiving", "finalizing", "resuming"].includes(job.phase);
  const percent =
    job?.status === "completed"
      ? 100
      : measured && job.totalBytes > 0
        ? Math.min(
            99,
            Math.max(
              0,
              Math.floor((job.processedBytes / job.totalBytes) * 100),
            ),
          )
        : undefined;
  const title = !job
    ? starting
      ? "Starting backup…"
      : "Backup status unavailable"
    : job.status === "cancelling"
      ? "Cancelling backup…"
      : job.status === "completed"
        ? "Backup completed"
        : job.status === "cancelled"
          ? "Backup cancelled"
          : job.status === "failed"
            ? "Backup failed"
            : {
                scanning: "Scanning server files…",
                saving: "Saving the world…",
                archiving: "Compressing server files…",
                finalizing: "Finishing the archive…",
                resuming: "Resuming world saves…",
              }[job.phase];
  return (
    <section className="backup-job" aria-label="Backup progress">
      <div className="backup-job-heading">
        <strong role="status">{title}</strong>
        {active && !error && percent !== undefined && <span>{percent}%</span>}
      </div>
      {job && <p>{job.name}</p>}
      {(active || starting) && (
        <progress
          aria-label="Backup progress"
          max={100}
          value={error ? undefined : percent}
        />
      )}
      {job && measured && (
        <p>
          {formatBytes(job.processedBytes)} of {formatBytes(job.totalBytes)} ·{" "}
          {job.processedFiles} of {job.totalFiles} files ·{" "}
          {formatBytes(job.compressedBytes)} compressed
        </p>
      )}
      {job?.currentFile && active && (
        <p className="backup-job-file" title={job.currentFile}>
          {job.currentFile}
        </p>
      )}
      {active && (
        <p>
          {job?.status === "cancelling"
            ? "Waiting for the server to stop the backup and resume world saves."
            : "The backup keeps running when you close its dialog or leave this page."}
        </p>
      )}
      {(error || (job?.status === "failed" && job.error)) && (
        <p className="storage-form-error" role="alert">
          {error || job?.error}
        </p>
      )}
      <div className="backup-job-actions">
        {error && (
          <button type="button" className="btn small" onClick={onRetry}>
            Retry status
          </button>
        )}
        {active && canCancel && (
          <button
            type="button"
            className="btn small danger"
            disabled={
              cancelling || job?.status === "cancelling" || !job?.cancellable
            }
            onClick={onCancel}
          >
            {cancelling || job?.status === "cancelling"
              ? "Cancelling…"
              : "Cancel backup"}
          </button>
        )}
      </div>
    </section>
  );
}
type DeleteDialog = { backups: Backup[]; bulk: boolean };
type RestoreDialog = { restore: Backup };
const defaults: Schedule = {
  enabled: false,
  type: "interval",
  intervalHours: 6,
  time: "03:00",
  dayOfWeek: 0,
  retention: 7,
  nextRun: null,
};
const fullDate = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export default function Backups({
  notify,
  permissions,
}: PageProps & { permissions?: string[] }) {
  const canRead =
    permissions === undefined || permissions.includes("backup.read");
  const canCreate =
    permissions === undefined || permissions.includes("backup.create");
  const canDelete =
    permissions === undefined || permissions.includes("backup.delete");
  const canSchedule =
    permissions === undefined || permissions.includes("backup.update");
  const canDownload =
    permissions === undefined || permissions.includes("backup.download");
  const canRestore =
    permissions === undefined || permissions.includes("backup.restore");
  const { api, downloadUrl } = useServerApi();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [schedule, setSchedule] = useState<Schedule>(defaults);
  const [savedSchedule, setSavedSchedule] = useState<Schedule>(defaults);
  const [timezone, setTimezone] = useState("server time");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<BackupJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [jobError, setJobError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<
    "create" | DeleteDialog | RestoreDialog | null
  >(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreServerStatus, setRestoreServerStatus] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const jobRef = useRef<BackupJob | null>(null);
  const startingRef = useRef(false);
  const jobRevision = useRef(0);
  const dialogVersion = useRef(0);
  const createDialogVersion = useRef<number | null>(null);
  const currentDialog = useRef(dialog);
  currentDialog.current = dialog;
  const reloadRef = useRef<() => Promise<boolean>>(async () => false);
  busyRef.current = busy;

  const acceptJob = useCallback(
    (updated: BackupJob | null, startedHere = false) => {
      const previous = jobRef.current;
      if (
        updated &&
        previous?.id === updated.id &&
        (updated.updatedAt < previous.updatedAt ||
          (previous.status === "cancelling" && updated.status === "running") ||
          (!isActiveJob(previous) && isActiveJob(updated)))
      )
        return;
      jobRef.current = updated;
      setJob(updated);
      setJobError("");
      if (
        updated &&
        (startedHere ||
          (previous?.id === updated.id && isActiveJob(previous))) &&
        !isActiveJob(updated)
      ) {
        if (updated.status === "completed") {
          notify("Backup created. Your server files are safely archived.");
          if (
            currentDialog.current === "create" &&
            createDialogVersion.current === dialogVersion.current
          ) {
            dialogVersion.current++;
            setDialog(null);
          }
        }
        void reloadRef.current();
      }
    },
    [notify],
  );

  const load = useCallback(
    async (initial = false) => {
      if (!canRead) {
        setLoading(false);
        return false;
      }
      const token = generation.current;
      const revision = jobRevision.current;
      if (initial) setLoading(true);
      setError("");
      try {
        const result = await api<BackupResult>("/backups", {
          signal: AbortSignal.timeout(10_000),
        });
        if (token !== generation.current) return false;
        setBackups(result.backups);
        if (revision === jobRevision.current && !startingRef.current)
          acceptJob(result.job || null);
        const available = new Set(result.backups.map((backup) => backup.id));
        setSelected(
          (current) => new Set([...current].filter((id) => available.has(id))),
        );
        setSavedSchedule(result.schedule);
        setTimezone(result.timezone || "server time");
        if (initial) setSchedule(result.schedule);
        return true;
      } catch (failure) {
        if (token === generation.current) setError(messageOf(failure));
        return false;
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    [api, canRead, acceptJob],
  );
  reloadRef.current = () => load();
  useEffect(() => {
    generation.current++;
    setBackups([]);
    setSelected(new Set());
    setDialog(null);
    setDialogError("");
    setDeleteErrors([]);
    setBusy(false);
    setSaving(false);
    setSaved(false);
    setJob(null);
    jobRef.current = null;
    jobRevision.current++;
    setStarting(false);
    startingRef.current = false;
    setCancelling(false);
    setJobError("");
    dialogVersion.current++;
    setSchedule(defaults);
    setSavedSchedule(defaults);
    void load(true);
    return () => {
      generation.current++;
    };
  }, [load]);
  const refreshJob = useCallback(async () => {
    const pending = jobRef.current;
    if (!pending) return load();
    const token = generation.current;
    const revision = jobRevision.current;
    try {
      const result = await api<{ job: BackupJob }>(
        `/backups/jobs/${encodeURIComponent(pending.id)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (token !== generation.current || revision !== jobRevision.current)
        return false;
      acceptJob(result.job);
      return true;
    } catch (failure) {
      if (token === generation.current && revision === jobRevision.current) {
        setJobError(`Progress unavailable. ${messageOf(failure)}`);
        if ((failure as { status?: number }).status === 404) return load();
      }
      return false;
    }
  }, [api, acceptJob, load]);
  useEffect(() => {
    if (!isActiveJob(job)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refreshJob();
      if (!stopped) timer = setTimeout(poll, 1000);
    }
    timer = setTimeout(poll, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status, refreshJob]);

  function closeDialog() {
    dialogVersion.current++;
    setDialog(null);
  }
  function openCreate() {
    dialogVersion.current++;
    createDialogVersion.current =
      isActiveJob(jobRef.current) || startingRef.current
        ? dialogVersion.current
        : null;
    setName("");
    setDialogError("");
    setDialog("create");
  }
  async function cancelBackup() {
    const pending = jobRef.current;
    if (
      !canCreate ||
      !pending?.cancellable ||
      cancelling ||
      !isActiveJob(pending)
    )
      return;
    const token = generation.current;
    jobRevision.current++;
    setCancelling(true);
    setJobError("");
    try {
      const result = await api<{ job: BackupJob }>(
        `/backups/jobs/${encodeURIComponent(pending.id)}/cancel`,
        { method: "POST", body: "{}", signal: AbortSignal.timeout(10_000) },
      );
      if (token === generation.current) {
        jobRevision.current++;
        acceptJob(result.job);
      }
    } catch (failure) {
      if (token === generation.current)
        setJobError(`Could not confirm cancellation. ${messageOf(failure)}`);
    } finally {
      if (token === generation.current) setCancelling(false);
    }
  }
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialogRef.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected) previous.focus();
      if (document.activeElement !== previous) headingRef.current?.focus();
    };
  }, [dialog !== null]);

  function updateSchedule(patch: Partial<Schedule>) {
    if (!canSchedule) return;
    setSaved(false);
    setSchedule((current) => ({ ...current, ...patch }));
  }
  async function saveSchedule(event: FormEvent) {
    event.preventDefault();
    if (!canSchedule) return;
    const token = generation.current;
    setSaving(true);
    setSaved(false);
    try {
      const result = await api<Schedule | { schedule: Schedule }>(
        "/backups/schedule",
        { method: "PUT", body: JSON.stringify(schedule) },
      );
      if (token !== generation.current) return;
      const updated = "schedule" in result ? result.schedule : result;
      setSchedule(updated);
      setSavedSchedule(updated);
      setSaved(true);
      notify("Backup schedule saved.");
    } catch (failure) {
      if (token === generation.current) notify(messageOf(failure), true);
    } finally {
      if (token === generation.current) setSaving(false);
    }
  }
  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (
      !dialog ||
      busyRef.current ||
      (dialog === "create"
        ? !canCreate
        : "restore" in dialog
          ? !canRestore
          : !canDelete)
    )
      return;
    const token = generation.current;
    if (dialog === "create") {
      if (
        startingRef.current ||
        isActiveJob(jobRef.current) ||
        (jobError && !jobRef.current)
      )
        return;
      startingRef.current = true;
      setStarting(true);
      jobRef.current = null;
      setJob(null);
      setJobError("");
      setDialogError("");
      jobRevision.current++;
      createDialogVersion.current = dialogVersion.current;
      let reconcile = false;
      try {
        const result = await api<{ job: BackupJob }>("/backups/jobs", {
          method: "POST",
          body: JSON.stringify({ name: name.trim() || undefined }),
          signal: AbortSignal.timeout(10_000),
        });
        if (token !== generation.current) return;
        jobRevision.current++;
        acceptJob(result.job, true);
      } catch (failure) {
        if (token === generation.current) {
          setJobError(
            `Backup start could not be confirmed. ${messageOf(failure)}`,
          );
          reconcile = true;
        }
      } finally {
        if (token === generation.current) {
          startingRef.current = false;
          setStarting(false);
          if (reconcile) void load();
        }
      }
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setDialogError("");
    setDeleteErrors([]);
    try {
      if ("restore" in dialog) {
        if (!restoreConfirmed || restoreServerStatus !== "offline") return;
        const result = await api<{ warning?: string | null }>(
          `/backups/${encodeURIComponent(dialog.restore.id)}/restore`,
          { method: "POST", body: JSON.stringify({ confirm: true }) },
        );
        if (token !== generation.current) return;
        notify(
          result.warning ||
            `Restored ${dialog.restore.name}. Your server remains stopped.`,
          !!result.warning,
        );
        await load();
        if (token === generation.current) setDialog(null);
        return;
      }
      {
        const deleted = new Set<string>();
        const failed: Backup[] = [];
        const failures: string[] = [];
        for (const backup of dialog.backups) {
          if (token !== generation.current) return;
          try {
            await api(`/backups/${encodeURIComponent(backup.id)}`, {
              method: "DELETE",
            });
            deleted.add(backup.id);
          } catch (failure) {
            failed.push(backup);
            failures.push(`${backup.name}: ${messageOf(failure)}`);
          }
        }
        if (token !== generation.current) return;
        setBackups((current) =>
          current.filter((backup) => !deleted.has(backup.id)),
        );
        setSelected((current) => {
          const remaining = new Set(
            [...current].filter((id) => !deleted.has(id)),
          );
          if (dialog.bulk) failed.forEach((backup) => remaining.add(backup.id));
          return remaining;
        });
        if (failed.length) {
          setDialog({ ...dialog, backups: failed });
          setDialogError(
            `${deleted.size} ${deleted.size === 1 ? "backup" : "backups"} moved to Recycle Bin. ${failed.length} ${failed.length === 1 ? "backup could" : "backups could"} not be moved${dialog.bulk ? (failed.length === 1 ? " and remains selected" : " and remain selected") : ""}.`,
          );
          setDeleteErrors(failures);
          await load();
          return;
        }
        notify(
          deleted.size === 1
            ? "Backup moved to Recycle Bin."
            : `${deleted.size} backups moved to Recycle Bin.`,
        );
      }
      await load();
      if (token === generation.current) setDialog(null);
    } catch (failure) {
      if (token === generation.current) setDialogError(messageOf(failure));
    } finally {
      if (token === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function confirmDelete(targets: Backup[], bulk = false) {
    if (!canDelete) return;
    dialogVersion.current++;
    setDialogError("");
    setDeleteErrors([]);
    setDialog({ backups: targets, bulk });
  }

  async function confirmRestore(backup: Backup) {
    if (!canRestore || busyRef.current) return;
    const token = generation.current;
    const version = ++dialogVersion.current;
    setDialogError("");
    setDeleteErrors([]);
    setRestoreConfirmed(false);
    setRestoreServerStatus(null);
    setDialog({ restore: backup });
    try {
      const server = await api<{ status: string }>("/server", {
        signal: AbortSignal.timeout(10_000),
      });
      if (token === generation.current && version === dialogVersion.current)
        setRestoreServerStatus(server.status);
    } catch (failure) {
      if (token === generation.current && version === dialogVersion.current)
        setDialogError(messageOf(failure));
    }
  }

  const selectedBackups = backups.filter((backup) => selected.has(backup.id));
  const allSelected =
    backups.length > 0 && selectedBackups.length === backups.length;
  const someSelected = selectedBackups.length > 0 && !allSelected;

  const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);
  const latest = [...backups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
  const activeJob = isActiveJob(job);
  const showProgress = !!job || starting || !!jobError;
  const progressPanel = (
    <BackupProgress
      job={job}
      starting={starting}
      error={jobError}
      cancelling={cancelling}
      canCancel={canCreate}
      onCancel={() => void cancelBackup()}
      onRetry={() => void refreshJob()}
    />
  );
  if (!canRead)
    return (
      <StatePanel
        variant="empty"
        title="Backups unavailable"
        message="You do not have permission to view backups."
      />
    );
  return (
    <div className="storage-page">
      <div className="page-heading">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            Backups
          </h1>
        </div>
        <button
          className="btn primary"
          disabled={!canCreate || loading || !!error || busy}
          onClick={openCreate}
        >
          <Plus size={17} />
          {activeJob || starting ? "View backup progress" : "Create backup"}
        </button>
      </div>
      {showProgress && dialog !== "create" && progressPanel}
      {error && (
        <StatePanel
          className="panel"
          variant="error"
          title="Unable to load backups"
          message={error}
          onRetry={() => void load()}
        />
      )}
      {loading ? (
        <StatePanel
          className="panel"
          variant="loading"
          title="Loading your backups…"
        />
      ) : (
        <>
          <div className="backup-stats">
            <div className="panel backup-stat">
              <span className="backup-stat-icon">
                <Archive size={20} />
              </span>
              <div>
                <span className="backup-stat-label">Total backups</span>
                <strong>
                  {backups.length}
                  <small>saved archives</small>
                </strong>
              </div>
            </div>
            <div className="panel backup-stat">
              <span className="backup-stat-icon">
                <HardDrive size={20} />
              </span>
              <div>
                <span className="backup-stat-label">Storage used</span>
                <strong>
                  {formatBytes(totalSize)}
                  <small>in backup history</small>
                </strong>
              </div>
            </div>
            <div className="panel backup-stat">
              <span className="backup-stat-icon">
                <ShieldCheck size={20} />
              </span>
              <div>
                <span className="backup-stat-label">Last backup</span>
                <strong className="backup-last-value">
                  {latest ? relativeTime(latest.createdAt) : "No backups yet"}
                  <small>
                    {latest
                      ? "Your world, preserved"
                      : "Create your first snapshot"}
                  </small>
                </strong>
              </div>
            </div>
          </div>
          <div className="backups-layout">
            <section className="panel backup-history">
              <div className="storage-section-heading">
                <div>
                  <h2>
                    <History size={17} />
                    Backup history
                  </h2>
                  <p>
                    New backups are automatically compressed as .tar.gz
                    archives.
                  </p>
                </div>
                <span className="badge">{backups.length} total</span>
                <RefreshButton
                  label="Refresh backups"
                  disabled={busy || saving}
                  onRefresh={() => load()}
                  notify={notify}
                  successMessage="Backups refreshed."
                />
              </div>
              {backups.length > 0 && (
                <div
                  className="backup-selection"
                  role="region"
                  aria-label="Backup selection"
                >
                  <label className="backup-select-all">
                    <input
                      type="checkbox"
                      className="backup-checkbox"
                      aria-label="Select all backups"
                      aria-checked={someSelected ? "mixed" : allSelected}
                      checked={allSelected}
                      ref={(element) => {
                        if (element) element.indeterminate = someSelected;
                      }}
                      disabled={!canDelete || busy}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? new Set(backups.map((backup) => backup.id))
                            : new Set(),
                        )
                      }
                    />
                    Select all
                  </label>
                  <span className="backup-selection-count" aria-live="polite">
                    {selectedBackups.length} selected
                  </span>
                  <button
                    className="btn small danger"
                    disabled={
                      !canDelete || busy || selectedBackups.length === 0
                    }
                    onClick={() => confirmDelete(selectedBackups, true)}
                  >
                    <Trash2 size={14} />
                    Delete selected
                  </button>
                </div>
              )}
              {!backups.length ? (
                <StatePanel
                  variant="empty"
                  icon={<Archive size={29} />}
                  title="Your next adventure deserves a backup"
                  message="Save a snapshot of your server files before making changes."
                  action={
                    <button
                      className="btn"
                      disabled={!canCreate}
                      onClick={openCreate}
                    >
                      <Plus size={15} />
                      Create your first backup
                    </button>
                  }
                />
              ) : (
                <div className="backup-list">
                  {[...backups]
                    .sort(
                      (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                    )
                    .map((backup) => (
                      <article
                        className={`backup-item${selected.has(backup.id) ? " selected" : ""}`}
                        key={backup.id}
                      >
                        <input
                          type="checkbox"
                          className="backup-checkbox"
                          aria-label={`Select backup ${backup.name}`}
                          checked={selected.has(backup.id)}
                          disabled={!canDelete || busy}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked) next.add(backup.id);
                              else next.delete(backup.id);
                              return next;
                            });
                          }}
                        />
                        <div className="backup-item-icon">
                          <Archive size={20} />
                        </div>
                        <div className="backup-item-info">
                          <h3 title={backup.name}>{backup.name}</h3>
                          <p>
                            <span>{fullDate(backup.createdAt)}</span>
                            <span className="backup-meta-separator">·</span>
                            <span>{formatBytes(backup.size)} compressed</span>
                            <span className="backup-meta-separator">·</span>
                            <span
                              title={
                                backup.compression === "gzip" &&
                                backup.compressionLevel === 9
                                  ? "Maximum gzip compression (level 9)"
                                  : "Gzip compressed archive"
                              }
                            >
                              .tar.gz
                            </span>
                            {typeof backup.originalSize === "number" &&
                              Number.isFinite(backup.originalSize) &&
                              backup.originalSize > backup.size && (
                                <>
                                  <span className="backup-meta-separator">
                                    ·
                                  </span>
                                  <span>
                                    {formatBytes(
                                      backup.originalSize - backup.size,
                                    )}{" "}
                                    saved
                                  </span>
                                </>
                              )}
                          </p>
                          <div className="backup-tags">
                            <span className="backup-complete">
                              <Check size={11} />
                              Completed
                            </span>
                            <span className="backup-trigger">
                              {backup.trigger === "scheduled" ? (
                                <Clock3 size={11} />
                              ) : (
                                <Archive size={11} />
                              )}
                              {backup.trigger === "scheduled"
                                ? "Scheduled"
                                : "Manual"}
                            </span>
                          </div>
                        </div>
                        <div className="backup-item-actions">
                          {canRestore && (
                            <button
                              className="btn icon"
                              type="button"
                              aria-label={`Restore backup ${backup.name}`}
                              title="Restore server to this backup"
                              disabled={busy || starting || activeJob}
                              onClick={() => void confirmRestore(backup)}
                            >
                              <RotateCcw size={16} />
                            </button>
                          )}
                          {canDownload && (
                            <a
                              className="btn icon"
                              href={downloadUrl(
                                `/backups/${encodeURIComponent(backup.id)}/download`,
                              )}
                              download
                              aria-label={`Download backup ${backup.name}`}
                              title="Download backup"
                            >
                              <Download size={16} />
                            </a>
                          )}
                          <button
                            className="btn icon delete-action"
                            aria-label={`Delete backup ${backup.name}`}
                            title="Move backup to Recycle Bin"
                            disabled={!canDelete || busy}
                            onClick={() => confirmDelete([backup])}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
              )}
              <div className="backup-history-footer">
                <ShieldCheck size={14} />
                <span>
                  Archives contain your server files, excluding symbolic links
                  and temporary Minecraft session.lock files.
                </span>
              </div>
            </section>

            <aside className="backup-schedule-column">
              <section className="panel backup-schedule">
                <div className="storage-section-heading">
                  <div>
                    <h2>
                      <CalendarClock size={18} />
                      Automatic backups
                    </h2>
                    <p>Set it once. Keep your world protected.</p>
                  </div>
                </div>
                <form onSubmit={saveSchedule}>
                  <div className="schedule-toggle-row">
                    <div>
                      <strong>Enable schedule</strong>
                      <span>Run backups automatically</span>
                    </div>
                    <Switch
                      aria-label="Enable automatic backups"
                      label=""
                      checked={schedule.enabled}
                      onCheckedChange={(enabled) => updateSchedule({ enabled })}
                      disabled={!canSchedule || saving}
                    />
                  </div>
                  <div className="schedule-fields">
                    <label className="form-field">
                      Frequency
                      <select
                        value={schedule.type}
                        onChange={(event) =>
                          updateSchedule({
                            type: event.target.value as Schedule["type"],
                          })
                        }
                        disabled={!canSchedule || saving}
                      >
                        <option value="interval">At an interval</option>
                        <option value="daily">Every day</option>
                        <option value="weekly">Every week</option>
                      </select>
                    </label>
                    {schedule.type === "interval" ? (
                      <label className="form-field">
                        Back up every
                        <div className="input-with-unit">
                          <input
                            type="number"
                            min={1}
                            max={720}
                            required
                            value={schedule.intervalHours}
                            onChange={(event) =>
                              updateSchedule({
                                intervalHours: Number(event.target.value),
                              })
                            }
                            disabled={!canSchedule || saving}
                          />
                          <span>hours</span>
                        </div>
                      </label>
                    ) : (
                      <>
                        <div
                          className={`schedule-time-fields ${schedule.type === "weekly" ? "weekly" : ""}`}
                        >
                          {schedule.type === "weekly" && (
                            <label className="form-field">
                              Day
                              <select
                                value={schedule.dayOfWeek}
                                onChange={(event) =>
                                  updateSchedule({
                                    dayOfWeek: Number(event.target.value),
                                  })
                                }
                                disabled={!canSchedule || saving}
                              >
                                {[
                                  "Sunday",
                                  "Monday",
                                  "Tuesday",
                                  "Wednesday",
                                  "Thursday",
                                  "Friday",
                                  "Saturday",
                                ].map((day, index) => (
                                  <option key={day} value={index}>
                                    {day}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label className="form-field">
                            Time
                            <input
                              type="time"
                              required
                              value={schedule.time}
                              onChange={(event) =>
                                updateSchedule({ time: event.target.value })
                              }
                              disabled={!canSchedule || saving}
                            />
                          </label>
                        </div>
                        <p className="schedule-retention-hint">
                          Timezone: {timezone}
                        </p>
                      </>
                    )}
                    <label className="form-field">
                      Scheduled backups to keep
                      <div className="input-with-unit">
                        <input
                          type="number"
                          min={1}
                          max={100}
                          required
                          value={schedule.retention}
                          onChange={(event) =>
                            updateSchedule({
                              retention: Number(event.target.value),
                            })
                          }
                          disabled={!canSchedule || saving}
                        />
                        <span>backups</span>
                      </div>
                    </label>
                    <p className="schedule-retention-hint">
                      Older scheduled backups move to Recycle Bin when this
                      limit is reached. They use disk space until permanently
                      deleted. Manual backups stay until you delete them.
                    </p>
                    <button
                      className="btn primary schedule-save"
                      type="submit"
                      disabled={!canSchedule || saving}
                    >
                      {saving ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : saved ? (
                        <Check size={15} />
                      ) : (
                        <CalendarClock size={15} />
                      )}
                      {saving
                        ? "Saving…"
                        : saved
                          ? "Schedule saved"
                          : "Save schedule"}
                    </button>
                  </div>
                </form>
              </section>
              <div
                className={`backup-next-run ${savedSchedule.enabled ? "active" : ""}`}
              >
                <span className="next-run-icon">
                  <Clock3 size={19} />
                </span>
                <div>
                  <span>
                    {savedSchedule.enabled
                      ? "Next scheduled backup"
                      : "Automatic backups are off"}
                  </span>
                  <strong>
                    {savedSchedule.enabled && savedSchedule.nextRun
                      ? fullDate(savedSchedule.nextRun)
                      : savedSchedule.enabled
                        ? "Waiting for the next interval"
                        : "Enable a schedule to get started"}
                  </strong>
                </div>
              </div>
              <div className="backup-schedule-note">
                <ShieldCheck size={15} />
                <p>
                  Scheduled backups can run while your server is online. Keep
                  the panel service running so jobs can run on time.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}

      {dialog && (
        <dialog
          className="modal storage-modal storage-native-dialog"
          ref={dialogRef}
          aria-labelledby="backup-dialog-title"
          aria-describedby="backup-dialog-description"
          onCancel={(event) => {
            event.preventDefault();
            if (!busyRef.current) closeDialog();
          }}
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget || busyRef.current) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              closeDialog();
          }}
        >
          <form onSubmit={submitDialog}>
            <div className="storage-modal-heading">
              <div>
                <h2 id="backup-dialog-title">
                  {dialog === "create"
                    ? "Create a backup"
                    : "restore" in dialog
                      ? "Restore this backup?"
                      : dialog.bulk
                        ? "Move selected backups to Recycle Bin?"
                        : "Move this backup to Recycle Bin?"}
                </h2>
                <p id="backup-dialog-description">
                  {dialog === "create"
                    ? "Save a compressed .tar.gz archive of your current server files."
                    : "restore" in dialog
                      ? "Replace your server files with this saved backup point."
                      : "You can restore these archives from File Manager → Recycle Bin. They use disk space until permanently deleted."}
                </p>
              </div>
              <button
                type="button"
                className="btn icon"
                aria-label="Close dialog"
                onClick={closeDialog}
                disabled={busy}
              >
                <X size={18} />
              </button>
            </div>
            {dialog === "create" ? (
              <>
                <label className="form-field">
                  Backup name <span className="muted">(optional)</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Before the next big adventure"
                    maxLength={100}
                    disabled={starting || activeJob}
                  />
                </label>
                <div className="backup-create-note">
                  <ShieldCheck size={17} />
                  <p>
                    Your server can stay online. Live backups save the world,
                    pause automatic saves while archiving, then resume saving.
                  </p>
                </div>
                {showProgress && progressPanel}
              </>
            ) : "restore" in dialog ? (
              <>
                <p className="delete-description">
                  Restore <strong>{dialog.restore.name}</strong> from{" "}
                  {fullDate(dialog.restore.createdAt)}? Your current world,
                  mods, plugins, and server files will be replaced. Files added
                  after this backup will be removed. Create a fresh backup first
                  if you want to keep your current progress.
                </p>
                <div className="backup-create-note">
                  <ShieldCheck size={17} />
                  <p>
                    The saved archive stays in your backup history. The server
                    remains stopped after restoring. Panel access and launch
                    settings stay as they are.
                  </p>
                </div>
                {restoreServerStatus !== "offline" && !dialogError && (
                  <p className="storage-form-error" role="status">
                    {restoreServerStatus === null
                      ? "Checking server status…"
                      : "Stop the server from Console, then return here to restore this backup."}
                  </p>
                )}
                <label className="backup-select-all">
                  <input
                    type="checkbox"
                    className="backup-checkbox"
                    checked={restoreConfirmed}
                    disabled={busy || restoreServerStatus !== "offline"}
                    onChange={(event) =>
                      setRestoreConfirmed(event.target.checked)
                    }
                  />
                  I understand this will replace my current server files.
                </label>
                {busy && (
                  <p role="status">
                    Restoring server files… Large backups can take several
                    minutes.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="delete-description">
                  {dialog.bulk ? (
                    <>
                      Move{" "}
                      <strong>
                        {dialog.backups.length} selected{" "}
                        {dialog.backups.length === 1 ? "backup" : "backups"}
                      </strong>{" "}
                      to Recycle Bin?
                    </>
                  ) : (
                    <>
                      Move <strong>{dialog.backups[0].name}</strong> to Recycle
                      Bin?
                    </>
                  )}{" "}
                  Your current server files will stay as they are.
                </p>
                {dialog.bulk && (
                  <ul
                    className="backup-delete-targets"
                    aria-label="Backups to recycle"
                  >
                    {dialog.backups.map((backup) => (
                      <li key={backup.id}>
                        <strong>{backup.name}</strong>
                        <span>
                          {fullDate(backup.createdAt)} ·{" "}
                          {formatBytes(backup.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {dialog !== "create" && deleteErrors.length > 0 && (
              <ul className="backup-delete-errors" aria-label="Move errors">
                {deleteErrors.map((failure, index) => (
                  <li key={index}>{failure}</li>
                ))}
              </ul>
            )}
            {dialogError && (
              <p className="storage-form-error" role="alert">
                {dialogError}
              </p>
            )}
            <div className="storage-modal-footer">
              <button
                type="button"
                className="btn"
                onClick={closeDialog}
                disabled={busy}
              >
                {dialog === "create" ? "Close" : "Cancel"}
              </button>
              <button
                className={`btn ${dialog === "create" ? "primary" : "danger"}`}
                disabled={
                  busy ||
                  (dialog === "create"
                    ? !canCreate ||
                      starting ||
                      activeJob ||
                      (!!jobError && !job)
                    : "restore" in dialog
                      ? !canRestore ||
                        !restoreConfirmed ||
                        restoreServerStatus !== "offline"
                      : !canDelete)
                }
              >
                {busy && <LoaderCircle size={15} className="spin" />}
                {dialog === "create"
                  ? starting
                    ? "Starting backup…"
                    : activeJob
                      ? "Backup running…"
                      : "Create backup"
                  : "restore" in dialog
                    ? busy
                      ? "Restoring backup…"
                      : "Restore backup"
                    : busy
                      ? "Moving backups…"
                      : deleteErrors.length > 0
                        ? "Retry failed moves"
                        : "Move to Recycle Bin"}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
