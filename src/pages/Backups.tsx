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
};
type DeleteDialog = { backups: Backup[]; bulk: boolean };
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
  const { api, post, downloadUrl } = useServerApi();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [schedule, setSchedule] = useState<Schedule>(defaults);
  const [savedSchedule, setSavedSchedule] = useState<Schedule>(defaults);
  const [timezone, setTimezone] = useState("server time");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<"create" | DeleteDialog | null>(null);
  const [name, setName] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  busyRef.current = busy;

  const load = useCallback(
    async (initial = false) => {
      if (!canRead) {
        setLoading(false);
        return false;
      }
      const token = generation.current;
      if (initial) setLoading(true);
      setError("");
      try {
        const result = await api<BackupResult>("/backups");
        if (token !== generation.current) return false;
        setBackups(result.backups);
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
    [api, canRead],
  );
  useEffect(() => {
    generation.current++;
    setBackups([]);
    setSelected(new Set());
    setDialog(null);
    setDialogError("");
    setDeleteErrors([]);
    setBusy(false);
    setSchedule(defaults);
    setSavedSchedule(defaults);
    void load(true);
    return () => {
      generation.current++;
    };
  }, [load]);
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
    setSaving(true);
    setSaved(false);
    try {
      const result = await api<Schedule | { schedule: Schedule }>(
        "/backups/schedule",
        { method: "PUT", body: JSON.stringify(schedule) },
      );
      const updated = "schedule" in result ? result.schedule : result;
      setSchedule(updated);
      setSavedSchedule(updated);
      setSaved(true);
      notify("Backup schedule saved.");
    } catch (failure) {
      notify(messageOf(failure), true);
    } finally {
      setSaving(false);
    }
  }
  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (
      !dialog ||
      busyRef.current ||
      (dialog === "create" ? !canCreate : !canDelete)
    )
      return;
    const token = generation.current;
    busyRef.current = true;
    setBusy(true);
    setDialogError("");
    setDeleteErrors([]);
    try {
      if (dialog === "create") {
        await post("/backups", { name: name.trim() || undefined });
        if (token !== generation.current) return;
        notify("Backup created. Your server files are safely archived.");
      } else {
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
    setDialogError("");
    setDeleteErrors([]);
    setDialog({ backups: targets, bulk });
  }

  const selectedBackups = backups.filter((backup) => selected.has(backup.id));
  const allSelected =
    backups.length > 0 && selectedBackups.length === backups.length;
  const someSelected = selectedBackups.length > 0 && !allSelected;

  const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);
  const latest = [...backups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
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
          onClick={() => {
            setName("");
            setDialogError("");
            setDialog("create");
          }}
        >
          <Plus size={17} />
          Create backup
        </button>
      </div>
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
                      onClick={() => {
                        setName("");
                        setDialogError("");
                        setDialog("create");
                      }}
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
            if (!busyRef.current) setDialog(null);
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
              setDialog(null);
          }}
        >
          <form onSubmit={submitDialog}>
            <div className="storage-modal-heading">
              <div>
                <h2 id="backup-dialog-title">
                  {dialog === "create"
                    ? "Create a backup"
                    : dialog.bulk
                      ? "Move selected backups to Recycle Bin?"
                      : "Move this backup to Recycle Bin?"}
                </h2>
                <p id="backup-dialog-description">
                  {dialog === "create"
                    ? "Save a compressed .tar.gz archive of your current server files."
                    : "You can restore these archives from File Manager → Recycle Bin. They use disk space until permanently deleted."}
                </p>
              </div>
              <button
                type="button"
                className="btn icon"
                aria-label="Close dialog"
                onClick={() => setDialog(null)}
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
                    disabled={busy}
                  />
                </label>
                <div className="backup-create-note">
                  <ShieldCheck size={17} />
                  <p>
                    Your server can stay online. Live backups save the world,
                    pause automatic saves while archiving, then resume saving.
                  </p>
                </div>
                {busy && (
                  <p className="backup-create-progress" role="status">
                    <LoaderCircle size={15} className="spin" />
                    Preparing and archiving your files. Large worlds can take a
                    little longer.
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
                onClick={() => setDialog(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className={`btn ${dialog === "create" ? "primary" : "danger"}`}
                disabled={
                  busy || (dialog === "create" ? !canCreate : !canDelete)
                }
              >
                {busy && <LoaderCircle size={15} className="spin" />}
                {dialog === "create"
                  ? busy
                    ? "Creating backup…"
                    : "Create backup"
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
