import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  Database,
  Download,
  HardDrive,
  Info,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api, formatBytes, post, relativeTime, type PageProps } from "../api";
import "./management.css";

type DatabaseRecord = {
  id: string;
  name: string;
  type: "SQLite";
  size: number;
  createdAt: string;
};

export default function Databases({ notify }: PageProps) {
  const [databases, setDatabases] = useState<DatabaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<DatabaseRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDatabases(
        (await api<{ databases: DatabaseRecord[] }>("/databases")).databases,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load databases.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (creating || deleting) dialog.current?.showModal();
    else dialog.current?.close();
  }, [creating, deleting]);
  function closeDialog() {
    if (busy) return;
    setCreating(false);
    setDeleting(null);
    setFormError("");
  }
  function openCreate() {
    setName("");
    setFormError("");
    setCreating(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      if (deleting) {
        await api(`/databases/${encodeURIComponent(deleting.id)}`, {
          method: "DELETE",
        });
        notify("Database deleted.");
      } else {
        await post("/databases", { name: name.trim() });
        notify("SQLite database created.");
      }
      setCreating(false);
      setDeleting(null);
      await refresh();
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : "Unable to save this change.",
      );
    } finally {
      setBusy(false);
    }
  }
  const filtered = databases.filter((database) =>
    database.name.toLowerCase().includes(search.toLowerCase()),
  );
  const totalSize = databases.reduce((sum, database) => sum + database.size, 0);

  return (
    <div className="management-page">
      <div className="page-heading management-heading">
        <div>
          <div className="management-eyebrow">SERVER MANAGEMENT</div>
          <h1>Databases</h1>
          <p>A home for your server's persistent data.</p>
        </div>
        <button className="btn primary" onClick={openCreate}>
          <Plus size={16} /> Create database
        </button>
      </div>

      <div className="management-database-summary panel">
        <div className="management-summary-item">
          <span className="management-icon">
            <Database size={21} />
          </span>
          <div>
            <span>Databases</span>
            <strong>{loading ? "—" : databases.length}</strong>
          </div>
        </div>
        <div className="management-summary-item">
          <span className="management-icon">
            <HardDrive size={21} />
          </span>
          <div>
            <span>Total storage</span>
            <strong>{loading ? "—" : formatBytes(totalSize)}</strong>
          </div>
        </div>
        <div className="management-engine">
          <span className="management-sqlite-mark">S</span>
          <div>
            <strong>SQLite</strong>
            <span>Local database engine</span>
          </div>
          <span className="badge">File based</span>
        </div>
      </div>

      <div className="management-notice">
        <Info size={18} />
        <div>
          <strong>Local SQLite databases</strong>
          <p>
            Create and download real SQLite database files on this host. Hosted
            MySQL provisioning and automatic plugin configuration are not
            connected.
          </p>
        </div>
      </div>

      <section
        className="panel management-list"
        aria-labelledby="databases-list-title"
      >
        <div className="management-panel-header">
          <div className="management-section-title">
            <Database size={18} />
            <h2 id="databases-list-title">Your databases</h2>
            <span className="management-count">{databases.length}</span>
          </div>
          <div className="management-controls">
            <label className="management-search">
              <Search size={16} />
              <input
                aria-label="Search databases"
                placeholder="Search databases..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              className="btn icon"
              aria-label="Refresh databases"
              title="Refresh databases"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw
                size={16}
                className={loading ? "management-spinning" : ""}
              />
            </button>
          </div>
        </div>
        {error ? (
          <div className="management-error" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <button className="btn" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className="management-loading" role="status">
            <RefreshCw size={20} className="management-spinning" /> Loading
            databases...
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state management-empty">
            <div className="management-empty-icon">
              <Database size={28} />
            </div>
            <h3>
              {search ? "No matching databases" : "Your data belongs here"}
            </h3>
            <p>
              {search
                ? "Try a different database name."
                : "Create a SQLite database to get started with local data storage."}
            </p>
            {!search && (
              <button className="btn" onClick={openCreate}>
                <Plus size={15} /> Create your first database
              </button>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table management-table">
              <thead>
                <tr>
                  <th>Database</th>
                  <th>Engine</th>
                  <th>Size</th>
                  <th>Created</th>
                  <th>
                    <span className="management-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((database) => (
                  <tr key={database.id}>
                    <td>
                      <div className="management-person">
                        <span className="management-file-icon">
                          <Database size={20} />
                        </span>
                        <div>
                          <strong>{database.name}</strong>
                          <span>Local database</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="management-engine-label">
                        <span />
                        {database.type}
                      </span>
                    </td>
                    <td className="management-mono">
                      {formatBytes(database.size)}
                    </td>
                    <td className="muted">
                      <time
                        dateTime={database.createdAt}
                        title={new Date(database.createdAt).toLocaleString()}
                      >
                        {relativeTime(database.createdAt)}
                      </time>
                    </td>
                    <td className="management-actions">
                      <div>
                        <a
                          className="btn icon"
                          href={`/api/databases/${encodeURIComponent(database.id)}/download`}
                          download
                          title="Download SQLite file"
                          aria-label={`Download ${database.name}`}
                        >
                          <Download size={16} />
                        </a>
                        <button
                          className="btn icon management-delete"
                          aria-label={`Delete database ${database.name}`}
                          title="Delete database"
                          onClick={() => {
                            setFormError("");
                            setDeleting(database);
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="management-panel-footer">
          <HardDrive size={14} />
          <span>
            Stored on your panel host. Download a copy before making destructive
            changes.
          </span>
        </div>
      </section>

      <dialog
        ref={dialog}
        className="modal management-dialog"
        aria-labelledby="database-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
      >
        <form onSubmit={submit}>
          <div className="management-dialog-heading">
            <span className="management-icon">
              {deleting ? <Trash2 size={21} /> : <Database size={21} />}
            </span>
            <button
              type="button"
              className="btn icon"
              aria-label="Close dialog"
              disabled={busy}
              onClick={closeDialog}
            >
              <X size={18} />
            </button>
          </div>
          <h2 id="database-dialog-title">
            {deleting ? "Delete database?" : "Create a database"}
          </h2>
          <p className="management-dialog-description">
            {deleting ? (
              <>
                Permanently delete <strong>{deleting.name}</strong> and its
                stored data? Download a copy first if you need to keep it.
              </>
            ) : (
              "Create a local SQLite file for your server data."
            )}
          </p>
          {!deleting && (
            <>
              <div className="form-field">
                <label htmlFor="database-name">Database name</label>
                <input
                  id="database-name"
                  autoFocus
                  required
                  maxLength={48}
                  pattern="[A-Za-z][A-Za-z0-9_\-]{0,47}"
                  placeholder="survival_stats"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                  aria-describedby="database-name-help"
                />
                <small
                  id="database-name-help"
                  className="management-input-hint"
                >
                  Start with a letter. Letters, numbers, hyphens, and
                  underscores only.
                </small>
              </div>
              <div className="management-create-engine">
                <Database size={22} />
                <div>
                  <strong>SQLite</strong>
                  <span>Local file · No username or password required</span>
                </div>
                <span className="badge">Included</span>
              </div>
            </>
          )}
          {deleting && (
            <a
              className="btn management-download-before-delete"
              href={`/api/databases/${encodeURIComponent(deleting.id)}/download`}
              download
            >
              <Download size={15} /> Download database
            </a>
          )}
          {formError && (
            <p className="management-form-error" role="alert">
              <AlertCircle size={15} />
              {formError}
            </p>
          )}
          <div className="management-dialog-actions">
            <button
              type="button"
              className="btn"
              onClick={closeDialog}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`btn ${deleting ? "danger" : "primary"}`}
              disabled={busy}
            >
              {busy
                ? "Saving..."
                : deleting
                  ? "Delete database"
                  : "Create database"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
