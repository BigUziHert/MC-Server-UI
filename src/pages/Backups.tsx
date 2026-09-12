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
import { api, post, formatBytes, relativeTime, type PageProps } from "../api";
import "./storage.css";

type Backup = {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  status: "completed";
  trigger: "manual" | "scheduled";
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
const defaults: Schedule = {
  enabled: false,
  type: "interval",
  intervalHours: 6,
  time: "03:00",
  dayOfWeek: 0,
  retention: 7,
  nextRun: null,
};
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
const fullDate = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export default function Backups({ notify }: PageProps) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [schedule, setSchedule] = useState<Schedule>(defaults);
  const [savedSchedule, setSavedSchedule] = useState<Schedule>(defaults);
  const [timezone, setTimezone] = useState("server time");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"create" | Backup | null>(null);
  const [name, setName] = useState("");
  const [dialogError, setDialogError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setError("");
    try {
      const result = await api<BackupResult>("/backups");
      setBackups(result.backups);
      setSavedSchedule(result.schedule);
      setTimezone(result.timezone || "server time");
      if (initial) setSchedule(result.schedule);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(true);
  }, [load]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled)",
        ) || [],
      );
    const items = focusable();
    (items.find((element) => element.tagName === "INPUT") || items[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        setDialog(null);
      }
      if (event.key === "Tab") {
        const current = focusable();
        const first = current[0];
        const last = current[current.length - 1];
        if (!current.length) {
          event.preventDefault();
          dialogRef.current?.focus();
        } else if (!dialogRef.current?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [dialog]);

  function updateSchedule(patch: Partial<Schedule>) {
    setSaved(false);
    setSchedule((current) => ({ ...current, ...patch }));
  }
  async function saveSchedule(event: FormEvent) {
    event.preventDefault();
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
    if (!dialog) return;
    setBusy(true);
    setDialogError("");
    try {
      if (dialog === "create") {
        await post("/backups", { name: name.trim() || undefined });
        notify("Backup created. Your server files are safely archived.");
      } else {
        await api(`/backups/${encodeURIComponent(dialog.id)}`, {
          method: "DELETE",
        });
        notify("Backup deleted.");
      }
      setDialog(null);
      await load();
    } catch (failure) {
      setDialogError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);
  const latest = [...backups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
  return (
    <div className="storage-page">
      <div className="page-heading">
        <div>
          <h1>Backups</h1>
          <p>A little peace of mind for everything you've built.</p>
        </div>
        <button
          className="btn primary"
          disabled={loading || !!error || busy}
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
      {loading ? (
        <div className="panel empty-state">
          <LoaderCircle size={24} className="spin" />
          <p>Loading your backups…</p>
        </div>
      ) : error ? (
        <div className="panel empty-state">
          <strong>Unable to load backups</strong>
          <p>{error}</p>
          <button className="btn" onClick={() => void load(true)}>
            Try again
          </button>
        </div>
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
                  <small>across all backups</small>
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
                  <p>Download an archive whenever you need it.</p>
                </div>
                <span className="badge">{backups.length} total</span>
              </div>
              {!backups.length ? (
                <div className="empty-state backup-empty">
                  <div className="backup-empty-icon">
                    <Archive size={29} />
                  </div>
                  <strong>Your next adventure deserves a backup</strong>
                  <p>
                    Save a snapshot of your server files before making changes.
                  </p>
                  <button
                    className="btn"
                    onClick={() => {
                      setName("");
                      setDialogError("");
                      setDialog("create");
                    }}
                  >
                    <Plus size={15} />
                    Create your first backup
                  </button>
                </div>
              ) : (
                <div className="backup-list">
                  {[...backups]
                    .sort(
                      (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                    )
                    .map((backup) => (
                      <article className="backup-item" key={backup.id}>
                        <div className="backup-item-icon">
                          <Archive size={20} />
                        </div>
                        <div className="backup-item-info">
                          <h3 title={backup.name}>{backup.name}</h3>
                          <p>
                            <span>{fullDate(backup.createdAt)}</span>
                            <span className="backup-meta-separator">·</span>
                            <span>{formatBytes(backup.size)}</span>
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
                          <a
                            className="btn icon"
                            href={`/api/backups/${encodeURIComponent(backup.id)}/download`}
                            download
                            aria-label={`Download backup ${backup.name}`}
                            title="Download backup"
                          >
                            <Download size={16} />
                          </a>
                          <button
                            className="btn icon delete-action"
                            aria-label={`Delete backup ${backup.name}`}
                            title="Delete backup"
                            onClick={() => {
                              setDialogError("");
                              setDialog(backup);
                            }}
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
                  Archives contain the files in your server directory.
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
                    <button
                      type="button"
                      className={`storage-switch ${schedule.enabled ? "enabled" : ""}`}
                      role="switch"
                      aria-checked={schedule.enabled}
                      aria-label="Enable automatic backups"
                      onClick={() =>
                        updateSchedule({ enabled: !schedule.enabled })
                      }
                      disabled={saving}
                    >
                      <span />
                    </button>
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
                        disabled={saving}
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
                            disabled={saving}
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
                                disabled={saving}
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
                              disabled={saving}
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
                          disabled={saving}
                        />
                        <span>backups</span>
                      </div>
                    </label>
                    <p className="schedule-retention-hint">
                      The oldest scheduled backups are removed when this limit
                      is reached. Manual backups stay until you delete them.
                    </p>
                    <button
                      className="btn primary schedule-save"
                      type="submit"
                      disabled={saving}
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
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setDialog(null);
          }}
        >
          <div
            className="modal storage-modal"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="backup-dialog-title"
          >
            <form onSubmit={submitDialog}>
              <div className="storage-modal-heading">
                <div>
                  <h2 id="backup-dialog-title">
                    {dialog === "create"
                      ? "Create a backup"
                      : "Delete this backup?"}
                  </h2>
                  <p>
                    {dialog === "create"
                      ? "Save an archive of your current server files."
                      : "This action cannot be undone."}
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
                      Preparing and archiving your files. Large worlds can take
                      a little longer.
                    </p>
                  )}
                </>
              ) : (
                <p className="delete-description">
                  Permanently delete <strong>{dialog.name}</strong>? Your
                  current server files will stay as they are.
                </p>
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
                  disabled={busy}
                >
                  {busy && <LoaderCircle size={15} className="spin" />}
                  {dialog === "create"
                    ? busy
                      ? "Creating backup…"
                      : "Create backup"
                    : "Delete backup"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
