import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Eye,
  Info,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  UserRound,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { api, post, relativeTime, type PageProps } from "../api";
import "./management.css";

type Role = "admin" | "operator" | "viewer";
type Subuser = { id: string; email: string; role: Role; createdAt: string };
const roles = [
  {
    value: "admin" as Role,
    label: "Administrator",
    icon: Shield,
    detail: "Full server management",
    description: "Intended for trusted people who manage your server.",
  },
  {
    value: "operator" as Role,
    label: "Operator",
    icon: Wrench,
    detail: "Day-to-day operations",
    description: "Intended for people helping with server operations.",
  },
  {
    value: "viewer" as Role,
    label: "Viewer",
    icon: Eye,
    detail: "Observe server activity",
    description: "Intended for people who only need to view activity.",
  },
];

export default function Subusers({ notify }: PageProps) {
  const [users, setUsers] = useState<Subuser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [deleting, setDeleting] = useState<Subuser | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setUsers((await api<{ users: Subuser[] }>("/subusers")).users);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load access records.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (editing || deleting) dialog.current?.showModal();
    else dialog.current?.close();
  }, [editing, deleting]);

  function closeDialog() {
    if (busy) return;
    setEditing(false);
    setDeleting(null);
    setFormError("");
  }
  function openCreate() {
    setEmail("");
    setRole("operator");
    setFormError("");
    setEditing(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      if (deleting) {
        await api(`/subusers/${encodeURIComponent(deleting.id)}`, {
          method: "DELETE",
        });
        notify("Access record removed.");
      } else {
        await post("/subusers", { email: email.trim(), role });
        notify("Local access record added.");
      }
      setEditing(false);
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
  const filtered = users.filter((user) =>
    `${user.email} ${user.role}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="management-page">
      <div className="page-heading management-heading">
        <div>
          <div className="management-eyebrow">SERVER MANAGEMENT</div>
          <h1>Subusers</h1>
          <p>Keep the people behind your server organized.</p>
        </div>
        <button className="btn primary" onClick={openCreate}>
          <Plus size={16} /> Add access record
        </button>
      </div>

      <div className="management-notice">
        <Info size={18} />
        <div>
          <strong>Local access records</strong>
          <p>
            These records describe your team. Authentication, permission
            enforcement, and email invitations are not configured yet. Adding a
            record does not grant access.
          </p>
        </div>
      </div>

      <div className="role-overview">
        {roles.map(({ value, label, icon: Icon, detail }) => (
          <div className="role-overview-item" key={value}>
            <span className={`management-icon role-${value}`}>
              <Icon size={19} />
            </span>
            <div>
              <strong>{label}</strong>
              <span>{detail}</span>
            </div>
            <span className="role-count">
              {users.filter((user) => user.role === value).length}
            </span>
          </div>
        ))}
      </div>

      <section
        className="panel management-list"
        aria-labelledby="access-records-title"
      >
        <div className="management-panel-header">
          <div className="management-section-title">
            <Users size={18} />
            <h2 id="access-records-title">Access records</h2>
            <span className="management-count">{users.length}</span>
          </div>
          <div className="management-controls">
            <label className="management-search">
              <Search size={16} />
              <input
                aria-label="Search access records"
                placeholder="Search people..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              className="btn icon"
              title="Refresh access records"
              aria-label="Refresh access records"
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
            access records...
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state management-empty">
            <div className="management-empty-icon">
              <Users size={26} />
            </div>
            <h3>
              {search
                ? "No matching people"
                : "A great server starts with a team"}
            </h3>
            <p>
              {search
                ? "Try another email address or role."
                : "Add a local record for each person who helps manage your server."}
            </p>
            {!search && (
              <button className="btn" onClick={openCreate}>
                <Plus size={15} /> Add your first record
              </button>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table management-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Added</th>
                  <th>Status</th>
                  <th>
                    <span className="management-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="management-person">
                        <span className="management-avatar">
                          {user.email.slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <strong>{user.email}</strong>
                          <span>Local access record</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`management-role-badge role-${user.role}`}
                      >
                        {roles.find((item) => item.value === user.role)
                          ?.label || user.role}
                      </span>
                    </td>
                    <td className="muted">
                      <time
                        dateTime={user.createdAt}
                        title={new Date(user.createdAt).toLocaleString()}
                      >
                        {relativeTime(user.createdAt)}
                      </time>
                    </td>
                    <td>
                      <span className="management-record-status">
                        <span /> Recorded
                      </span>
                    </td>
                    <td className="management-actions">
                      <button
                        className="btn icon management-delete"
                        aria-label={`Remove access record for ${user.email}`}
                        title="Remove access record"
                        onClick={() => {
                          setFormError("");
                          setDeleting(user);
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="management-panel-footer">
          <Shield size={14} />
          <span>
            Roles are descriptive records until authentication is connected.
          </span>
        </div>
      </section>

      <dialog
        ref={dialog}
        className="modal management-dialog"
        aria-labelledby="subuser-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
      >
        <form onSubmit={submit}>
          <div className="management-dialog-heading">
            <span className="management-icon">
              {deleting ? <Trash2 size={21} /> : <UserRound size={21} />}
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
          <h2 id="subuser-dialog-title">
            {deleting ? "Remove access record?" : "Add someone to your team"}
          </h2>
          <p className="management-dialog-description">
            {deleting ? (
              <>
                Remove the local record for <strong>{deleting.email}</strong>?
                You can add it again later.
              </>
            ) : (
              "Create a local access record. No invitation will be sent."
            )}
          </p>
          {!deleting && (
            <>
              <div className="form-field">
                <label htmlFor="subuser-email">Email address</label>
                <input
                  id="subuser-email"
                  type="email"
                  autoFocus
                  required
                  maxLength={254}
                  placeholder="alex@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy}
                />
              </div>
              <fieldset className="management-role-options">
                <legend>
                  Intended role <span>Descriptive only</span>
                </legend>
                {roles.map(({ value, label, icon: Icon, description }) => (
                  <label
                    className={`management-role-option ${role === value ? "selected" : ""}`}
                    key={value}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={value}
                      checked={role === value}
                      onChange={() => setRole(value)}
                      disabled={busy}
                    />
                    <Icon size={19} />
                    <div>
                      <strong>{label}</strong>
                      <span>{description}</span>
                    </div>
                    <span className="management-radio-indicator">
                      {role === value && <Check size={12} />}
                    </span>
                  </label>
                ))}
              </fieldset>
            </>
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
                  ? "Remove record"
                  : "Add access record"}
              {!busy && !deleting && (
                <ChevronDown size={14} className="management-arrow" />
              )}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
