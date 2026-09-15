import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  Check,
  Clock3,
  Database,
  FileText,
  ListFilter,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useServerApi, relativeTime, type PageProps } from "../api";
import SearchField from "../SearchField";
import "./management.css";

type Category = "server" | "file" | "backup" | "user" | "database" | "player";
type AuditEntry = {
  id: string;
  action: string;
  detail: string;
  actor: string;
  createdAt: string;
  category: Category;
};
const categories = [
  { value: "server" as Category, label: "Server", icon: Server },
  { value: "file" as Category, label: "Files", icon: FileText },
  { value: "backup" as Category, label: "Backups", icon: Archive },
  { value: "user" as Category, label: "Subusers", icon: Users },
  { value: "player" as Category, label: "Players", icon: ShieldCheck },
  { value: "database" as Category, label: "Databases", icon: Database },
];
function actionLabel(action: string) {
  const words = action.replace(/[._-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default function AuditLogs({ notify }: PageProps) {
  const { api } = useServerApi();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(
    async (manual = false) => {
      setLoading(true);
      setError("");
      try {
        const data = await api<{ entries: AuditEntry[] }>("/audit");
        setEntries(
          [...data.entries].sort(
            (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
          ),
        );
        setUpdatedAt(new Date());
        if (manual) notify("Audit log refreshed.");
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Unable to load the audit log.",
        );
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const query = search.toLowerCase();
  const filtered = entries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      `${entry.action} ${actionLabel(entry.action)} ${entry.detail} ${entry.actor}`
        .toLowerCase()
        .includes(query),
  );
  const hasFilters = category !== "all" || Boolean(search);
  const today = new Date().toDateString();
  const todayCount = entries.filter(
    (entry) => new Date(entry.createdAt).toDateString() === today,
  ).length;

  return (
    <div className="management-page">
      <div className="page-heading management-heading">
        <div>
          <div className="management-eyebrow">ACTIVITY & OVERSIGHT</div>
          <h1>Audit logs</h1>
          <p>Every action has a story. Keep track of yours.</p>
        </div>
        <button
          className="btn"
          disabled={loading}
          onClick={() => void refresh(true)}
        >
          <RefreshCw
            size={16}
            className={loading ? "management-spinning" : ""}
          />{" "}
          Refresh activity
        </button>
      </div>

      <div className="management-audit-overview panel">
        <span className="management-audit-shield">
          <ShieldCheck size={25} />
        </span>
        <div className="management-audit-summary">
          <strong>Your server's activity, in one place</strong>
          <p>
            Panel actions are recorded locally so you can review what changed
            and when.
          </p>
        </div>
        <div className="management-audit-stat">
          <strong>{loading ? "—" : todayCount}</strong>
          <span>Events today</span>
        </div>
        <div className="management-audit-stat">
          <strong>{loading ? "—" : entries.length}</strong>
          <span>Loaded events</span>
        </div>
      </div>

      <section
        className="panel management-list"
        aria-labelledby="audit-list-title"
      >
        <div className="management-panel-header">
          <div className="management-section-title">
            <Activity size={18} />
            <h2 id="audit-list-title">Activity log</h2>
            <span className="management-count">{filtered.length}</span>
          </div>
          <SearchField
            className="management-search management-audit-search"
            aria-label="Search audit logs"
            placeholder="Search actions, details, or actors..."
            value={search}
            onValueChange={setSearch}
          />
        </div>
        <div className="management-audit-filters">
          <ListFilter size={16} />
          <div
            className="management-filter-buttons"
            role="group"
            aria-label="Filter by activity category"
          >
            <button
              className={category === "all" ? "active" : ""}
              aria-pressed={category === "all"}
              onClick={() => setCategory("all")}
            >
              All activity
            </button>
            {categories.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                className={category === value ? "active" : ""}
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
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
            server activity...
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state management-empty">
            <div className="management-empty-icon">
              {hasFilters ? <Search size={27} /> : <Activity size={27} />}
            </div>
            <h3>
              {hasFilters
                ? "No activity matches your filters"
                : "A fresh start"}
            </h3>
            <p>
              {hasFilters
                ? "Try another search or include a different category."
                : "Actions you take in this panel will appear here."}
            </p>
            {hasFilters && (
              <button
                className="btn"
                onClick={() => {
                  setSearch("");
                  setCategory("all");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table management-table management-audit-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Category</th>
                  <th>Actor</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => {
                  const item = categories.find(
                    (value) => value.value === entry.category,
                  );
                  const Icon = item?.icon || Activity;
                  return (
                    <tr key={entry.id}>
                      <td>
                        <div className="management-audit-event">
                          <span
                            className={`management-event-icon category-${entry.category}`}
                          >
                            <Icon size={17} />
                          </span>
                          <div>
                            <strong>{actionLabel(entry.action)}</strong>
                            <span className="management-event-detail">
                              {entry.detail || "No additional details"}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`management-category category-${entry.category}`}
                        >
                          {item?.label || entry.category}
                        </span>
                      </td>
                      <td>
                        <span className="management-actor">
                          <span className="management-actor-dot" />
                          {entry.actor}
                        </span>
                      </td>
                      <td>
                        <div className="management-event-time">
                          <time
                            dateTime={entry.createdAt}
                            title={new Date(entry.createdAt).toLocaleString()}
                          >
                            {relativeTime(entry.createdAt)}
                          </time>
                          <span>
                            {new Date(entry.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="management-panel-footer management-audit-footer">
          <span>
            <Check size={14} />
            {filtered.length} {filtered.length === 1 ? "event" : "events"}
            {hasFilters ? " matching your filters" : " in the current log"}
          </span>
          <span>
            <Clock3 size={14} />
            {updatedAt
              ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Waiting for activity"}
          </span>
        </div>
      </section>
      <p className="management-audit-note">
        This log contains panel activity. Minecraft chat and game output are
        available in the console.
      </p>
    </div>
  );
}
