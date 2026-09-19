import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Archive,
  Check,
  Clock3,
  FileText,
  Gamepad2,
  ListFilter,
  Search,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  api as panelApi,
  useServerApi,
  relativeTime,
  type PageProps,
} from "../api";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Pagination from "../Pagination";
import "./management.css";

type Category = "server" | "file" | "backup" | "user" | "player";
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
  { value: "player" as Category, label: "Players", icon: Gamepad2 },
  { value: "backup" as Category, label: "Backups", icon: Archive },
  { value: "user" as Category, label: "Subusers", icon: Users },
];
function actionLabel(action: string) {
  const words = action.replace(/[._-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default function AuditLogs({
  notify,
  scope = "server",
}: PageProps & { scope?: "server" | "panel" }) {
  const { api: serverApi } = useServerApi();
  const [activityScope, setActivityScope] = useState(scope);
  const api = activityScope === "panel" ? panelApi : serverApi;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25);
  const [, tick] = useState(0);
  const generation = useRef(0),
    loaded = useRef(false),
    inFlight = useRef<Promise<boolean> | null>(null);
  const refresh = useCallback(
    async (manual = false) => {
      if (manual) setRefreshing(true);
      if (inFlight.current) return inFlight.current;
      const token = generation.current;
      if (!loaded.current) setLoading(true);
      setError("");
      const pending = (async () => {
        try {
          const data = await api<{ entries: AuditEntry[] }>(
            activityScope === "panel" ? "/panel/audit" : "/audit",
          );
          if (token !== generation.current) return false;
          setEntries(
            data.entries.sort(
              (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
            ),
          );
          loaded.current = true;
          setUpdatedAt(new Date());
          return true;
        } catch (cause) {
          if (token === generation.current)
            setError(
              cause instanceof Error
                ? cause.message
                : "Unable to load the audit log.",
            );
          return false;
        } finally {
          if (token === generation.current) {
            inFlight.current = null;
            setLoading(false);
            setRefreshing(false);
          }
        }
      })();
      inFlight.current = pending;
      return pending;
    },
    [api, activityScope],
  );
  useEffect(() => {
    generation.current++;
    loaded.current = false;
    inFlight.current = null;
    setRefreshing(false);
    setEntries([]);
    setUpdatedAt(null);
    setSearch("");
    setCategory("all");
    setPage(1);
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10000);
    const clock = window.setInterval(() => tick((value) => value + 1), 30000);
    return () => {
      generation.current++;
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [refresh]);
  const debouncedSearch = useDebouncedValue(search);
  useEffect(() => setPage(1), [debouncedSearch, category, pageSize]);
  const query = debouncedSearch.toLowerCase();
  const filtered = entries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      `${entry.action} ${actionLabel(entry.action)} ${entry.detail} ${entry.actor}`
        .toLowerCase()
        .includes(query),
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
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
          <h1>Audit logs</h1>
        </div>
      </div>

      <div className="management-audit-overview panel">
        <span className="management-audit-shield">
          <ShieldCheck size={25} />
        </span>
        <div className="management-audit-summary">
          <strong>
            {activityScope === "panel"
              ? "Panel activity, including removed servers"
              : "Your server's activity, in one place"}
          </strong>
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
          <div className="management-controls">
            {scope !== "panel" && (
              <select
                aria-label="Audit scope"
                value={activityScope}
                onChange={(event) =>
                  setActivityScope(event.target.value as "server" | "panel")
                }
              >
                <option value="server">This server</option>
                <option value="panel">Panel activity</option>
              </select>
            )}
            <SearchField
              className="management-search"
              grow
              aria-label="Search audit logs"
              placeholder="Search audit logs…"
              value={search}
              onValueChange={setSearch}
            />
            <RefreshButton
              key={activityScope}
              label="Refresh audit logs"
              refreshing={refreshing}
              onRefresh={() => refresh(true)}
              notify={notify}
              successMessage="Audit logs refreshed."
            />
          </div>
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
        {error && (
          <StatePanel
            variant="error"
            title="Unable to refresh activity"
            message={error}
            onRetry={() => void refresh(true)}
          />
        )}
        {loading ? (
          <StatePanel variant="loading" title="Loading server activity…" />
        ) : filtered.length === 0 ? (
          <StatePanel
            variant="empty"
            icon={hasFilters ? <Search size={27} /> : <Activity size={27} />}
            title={
              hasFilters ? "No activity matches your filters" : "A fresh start"
            }
            message={
              hasFilters
                ? "Try another search or include a different category."
                : "Actions you take in this panel will appear here."
            }
            action={
              hasFilters && (
                <button
                  className="btn"
                  onClick={() => {
                    setSearch("");
                    setCategory("all");
                  }}
                >
                  Clear filters
                </button>
              )
            }
          />
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
                {visible.map((entry) => {
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
        {filtered.length > 0 && (
          <Pagination
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            label="audit events"
          />
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
