import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Info,
  ShieldCheck,
  ShieldMinus,
  ShieldPlus,
  Terminal,
  X,
  Users,
  LogOut,
  Ban,
  Undo2,
  Plus,
  UserCheck,
  UserMinus,
} from "lucide-react";
import { ServerScope, useServerApi, type PageProps } from "../api";
import PlayerHead from "../PlayerHead";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import SharedPagination from "../Pagination";
import Switch from "../Switch";
import "./management.css";
import "./players.css";

type Operator = { name: string; uuid?: string; level?: number };
type KnownPlayer = {
  name: string;
  uuid?: string;
  online: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
  source: "observed" | "cache" | "banned" | "operator" | "whitelist";
  banned: boolean | null;
  banReason?: string;
};
type Moderation = { action: "kick" | "ban" | "unban"; player: KnownPlayer };
type PlayersResponse = {
  operators: Operator[];
  mode: "demo" | "live";
  status: "running" | "offline" | "starting" | "stopping";
  history?: KnownPlayer[];
  warnings?: string[];
  bansAvailable?: boolean;
  online?: KnownPlayer[];
  banned?: KnownPlayer[];
  maxPlayers?: number;
  whitelist?: Operator[];
  whitelistEnabled?: boolean | null;
  whitelistAvailable?: boolean;
  whitelistSettingsAvailable?: boolean;
};
type OperationResponse = { message: string; simulated: boolean };
type WhitelistAction =
  | { kind: "add" | "remove"; player?: Operator }
  | { kind: "state"; enabled: boolean };

const pageSizes = [5, 10, 25, 50, 75, 100];

function usePlayerPagination<T>(id: string, players: T[], filter = "") {
  const serverId = useContext(ServerScope);
  const resetKey = `${serverId ?? ""}\0${filter}`;
  const storageKey = `mc-panel.players.rows.${id}`;
  const [pageSize, setPageSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return pageSizes.includes(saved) ? saved : 5;
    } catch {
      return 5;
    }
  });
  const [position, setPosition] = useState({ resetKey, page: 0 });
  const pages = Math.max(1, Math.ceil(players.length / pageSize));
  const page =
    position.resetKey === resetKey ? Math.min(position.page, pages - 1) : 0;

  useEffect(() => {
    setPosition((current) =>
      current.resetKey === resetKey && current.page === page
        ? current
        : { resetKey, page },
    );
  }, [resetKey, page]);

  function changeSize(value: number) {
    if (!pageSizes.includes(value)) return;
    setPageSize(value);
    setPosition({ resetKey, page: 0 });
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      // Pagination still works when browser storage is unavailable.
    }
  }

  return {
    total: players.length,
    rows: players.slice(page * pageSize, (page + 1) * pageSize),
    page,
    pages,
    pageSize,
    changeSize,
    changePage: (value: number) =>
      setPosition({ resetKey, page: Math.max(0, Math.min(value, pages - 1)) }),
    scrollKey: `${resetKey}\0${pageSize}\0${page}`,
  };
}

function Pagination({
  title,
  paging,
  disabled,
}: {
  title: string;
  paging: ReturnType<typeof usePlayerPagination>;
  disabled: boolean;
}) {
  return (
    <SharedPagination
      page={paging.page + 1}
      pageSize={paging.pageSize}
      total={paging.total}
      onPageChange={(page) => paging.changePage(page - 1)}
      onPageSizeChange={paging.changeSize}
      pageSizes={pageSizes}
      label={title.toLowerCase()}
      disabled={disabled}
      ariaLabels={{
        pageSize: title + " rows per page",
        page: title + " page",
        previous: title + " previous page",
        next: title + " next page",
      }}
    />
  );
}

function Roster({
  id,
  title,
  players,
  empty,
  loading,
  actions,
  tools,
  children,
  filter,
}: {
  id: string;
  title: string;
  players: Operator[];
  empty: string;
  loading: boolean;
  actions: (player: Operator) => ReactNode;
  tools?: ReactNode;
  children?: ReactNode;
  filter?: string;
}) {
  const paging = usePlayerPagination(id, players, filter);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [paging.scrollKey]);
  return (
    <section className="players-roster" aria-labelledby={`${id}-title`}>
      <header className="players-roster-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <span className="management-count">{players.length}</span>
        <div className="players-roster-tools">{tools}</div>
      </header>
      <div className="panel players-roster-body">
        {children}
        {loading ? (
          <StatePanel variant="loading" title="Loading players…" />
        ) : players.length === 0 ? (
          <StatePanel variant="empty" title={empty} />
        ) : (
          <ul ref={list} aria-label={`${title} list`} tabIndex={0}>
            {paging.rows.map((player) => (
              <li
                className={`players-roster-row ${id === "operators" ? "players-operator" : ""}`}
                aria-label={`${title} ${player.name}`}
                key={player.uuid || player.name}
              >
                <PlayerHead name={player.name} uuid={player.uuid} size={30} />
                <strong title={player.name}>{player.name}</strong>
                <div className="players-roster-actions">{actions(player)}</div>
              </li>
            ))}
          </ul>
        )}
        <Pagination title={title} paging={paging} disabled={loading} />
      </div>
    </section>
  );
}

export default function Players({ notify }: PageProps) {
  const { api, post } = useServerApi();
  const [data, setData] = useState<PlayersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const query = useDebouncedValue(search),
    historyQuery = useDebouncedValue(historySearch);
  const [moderating, setModerating] = useState<Moderation | null>(null);
  const [reason, setReason] = useState("");
  const [granting, setGranting] = useState(false);
  const [removing, setRemoving] = useState<Operator | null>(null);
  const [name, setName] = useState("");
  const [grantUuid, setGrantUuid] = useState<string | undefined>();
  const [whitelistAction, setWhitelistAction] =
    useState<WhitelistAction | null>(null);
  const [whitelistName, setWhitelistName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [result, setResult] = useState<OperationResponse | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const moderationDialog = useRef<HTMLDialogElement>(null);
  const whitelistDialog = useRef<HTMLDialogElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const session = useRef(0);
  const historyList = useRef<HTMLUListElement>(null);

  const refresh = useCallback(
    async (silent = false) => {
      const currentRequest = ++request.current;
      if (!silent) setLoading(true);
      try {
        const response = await api<PlayersResponse>("/players");
        if (currentRequest !== request.current) return false;
        setData(response);
        setError("");
        return true;
      } catch (e) {
        if (currentRequest !== request.current) return false;
        setError(e instanceof Error ? e.message : "Unable to load operators.");
        return false;
      } finally {
        if (currentRequest === request.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    session.current += 1;
    setData(null);
    setResult(null);
    setBusy(false);
    setFormError("");
    setSearch("");
    setHistorySearch("");
    setModerating(null);
    setGranting(false);
    setRemoving(null);
    setWhitelistAction(null);
    void refresh();
    const interval = window.setInterval(() => void refresh(true), 5000);
    return () => {
      window.clearInterval(interval);
      request.current += 1;
      session.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (granting || removing) {
      dialog.current?.showModal();
      if (granting) usernameInput.current?.focus();
    } else dialog.current?.close();
  }, [granting, removing]);
  useEffect(() => {
    if (moderating) moderationDialog.current?.showModal();
    else moderationDialog.current?.close();
  }, [moderating]);
  useEffect(() => {
    if (whitelistAction) whitelistDialog.current?.showModal();
    else whitelistDialog.current?.close();
  }, [whitelistAction]);

  const simulated = data?.mode === "demo";
  const canManage = Boolean(data && !error && data.status === "running");
  const operators = data?.operators ?? [];
  const filtered = operators.filter((player) =>
    player.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const history = data?.history ?? [];
  const online = data?.online ?? history.filter((player) => player.online);
  const banned = data?.banned ?? history.filter((player) => player.banned);
  const whitelist = data?.whitelist ?? [];
  const samePlayer = (left: Operator, right: Operator) =>
    left.uuid && right.uuid
      ? left.uuid.toLowerCase() === right.uuid.toLowerCase()
      : left.name.toLowerCase() === right.name.toLowerCase();
  const isWhitelisted = (player: Operator) =>
    whitelist.some((entry) => samePlayer(entry, player));
  const known = (player: Operator): KnownPlayer =>
    history.find((entry) => samePlayer(entry, player)) ?? {
      ...player,
      online: online.some((entry) => samePlayer(entry, player)),
      banned: banned.some((entry) => samePlayer(entry, player)),
      firstSeen: null,
      lastSeen: null,
      source: "cache",
    };
  const isOperator = (player: KnownPlayer) =>
    operators.some((operator) =>
      player.uuid && operator.uuid
        ? player.uuid.toLowerCase() === operator.uuid.toLowerCase()
        : player.name.toLowerCase() === operator.name.toLowerCase(),
    );
  const filteredHistory = history.filter((player) =>
    player.name.toLowerCase().includes(historyQuery.trim().toLowerCase()),
  );
  const historyPaging = usePlayerPagination(
    "history",
    filteredHistory,
    historySearch,
  );
  useEffect(() => {
    if (historyList.current) historyList.current.scrollTop = 0;
  }, [historyPaging.scrollKey]);
  const actionLabel =
    moderating?.action === "kick"
      ? "Kick player"
      : moderating?.action === "ban"
        ? "Ban player"
        : "Unban player";

  function openModeration(action: Moderation["action"], player: KnownPlayer) {
    setReason("");
    setFormError("");
    setModerating({ action, player });
  }
  function closeModeration() {
    if (!busy) {
      setModerating(null);
      setFormError("");
    }
  }
  async function submitModeration(event: FormEvent) {
    event.preventDefault();
    if (!moderating || busy) return;
    if (!canManage) {
      setFormError("Start the server in Console before managing players.");
      return;
    }
    if (
      reason.length > 200 ||
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(reason)
    ) {
      setFormError("Use a single-line reason of at most 200 characters.");
      return;
    }
    const currentSession = session.current;
    setBusy(true);
    setFormError("");
    try {
      const response = await post<OperationResponse>(
        `/players/${moderating.action}`,
        {
          name: moderating.player.name,
          ...(moderating.player.uuid ? { uuid: moderating.player.uuid } : {}),
          ...(moderating.action !== "unban" ? { reason: reason.trim() } : {}),
        },
      );
      if (currentSession !== session.current) return;
      setResult(response);
      notify(response.message);
      setModerating(null);
      await refresh(true);
    } catch (cause) {
      if (currentSession === session.current)
        setFormError(
          cause instanceof Error
            ? cause.message
            : "Unable to manage this player.",
        );
    } finally {
      if (currentSession === session.current) setBusy(false);
    }
  }

  function openGrant(player: KnownPlayer) {
    setName(player.name);
    setGrantUuid(player.uuid);
    setFormError("");
    setGranting(true);
  }
  function openRemove(player: Operator) {
    setFormError("");
    setRemoving(player);
  }
  function openWhitelist(action: WhitelistAction) {
    setFormError("");
    setWhitelistName(
      action.kind === "state" ? "" : (action.player?.name ?? ""),
    );
    setWhitelistAction(action);
  }
  function closeWhitelist() {
    if (!busy) {
      setWhitelistAction(null);
      setFormError("");
    }
  }
  const whitelistTitle =
    whitelistAction?.kind === "state"
      ? `${whitelistAction.enabled ? "Enable" : "Disable"} whitelist?`
      : whitelistAction?.kind === "remove"
        ? "Remove player from whitelist?"
        : "Add player to whitelist";
  async function submitWhitelist(event: FormEvent) {
    event.preventDefault();
    if (!whitelistAction || busy) return;
    if (!canManage) {
      setFormError(
        "Start the server in Console before changing the whitelist.",
      );
      return;
    }
    if (
      whitelistAction.kind !== "state" &&
      !/^[A-Za-z0-9_]{3,16}$/.test(whitelistName)
    ) {
      setFormError(
        "Use a Minecraft username with 3–16 letters, numbers, or underscores.",
      );
      return;
    }
    const currentSession = session.current;
    setBusy(true);
    setFormError("");
    try {
      const response = await post<OperationResponse>(
        `/players/whitelist/${whitelistAction.kind}`,
        whitelistAction.kind === "state"
          ? { enabled: whitelistAction.enabled }
          : {
              name: whitelistName,
              ...(whitelistAction.player?.uuid
                ? { uuid: whitelistAction.player.uuid }
                : {}),
            },
      );
      if (currentSession !== session.current) return;
      setResult(response);
      notify(response.message);
      setWhitelistAction(null);
      await refresh(true);
    } catch (cause) {
      if (currentSession === session.current)
        setFormError(
          cause instanceof Error
            ? cause.message
            : "Unable to update the whitelist.",
        );
    } finally {
      if (currentSession === session.current) setBusy(false);
    }
  }

  function closeDialog() {
    if (busy) return;
    setGranting(false);
    setRemoving(null);
    setFormError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const currentSession = session.current;
    const username = removing?.name ?? name.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
      setFormError(
        "Use a Minecraft username with 3–16 letters, numbers, or underscores.",
      );
      return;
    }
    if (!canManage) {
      setFormError(
        "Start the server in Console before changing operator permissions.",
      );
      return;
    }
    if (
      !removing &&
      operators.some(
        (player) => player.name.toLowerCase() === username.toLowerCase(),
      )
    ) {
      setFormError("This player is already an operator.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const response = await post<OperationResponse>(
        removing ? "/players/deop" : "/players/op",
        {
          name: username,
          ...(removing?.uuid
            ? { uuid: removing.uuid }
            : !removing && grantUuid
              ? { uuid: grantUuid }
              : {}),
        },
      );
      if (currentSession !== session.current) return;
      setResult(response);
      notify(response.message);
      setGranting(false);
      setRemoving(null);
      await refresh(true);
    } catch (e) {
      if (currentSession !== session.current) return;
      setFormError(
        e instanceof Error
          ? e.message
          : "Unable to change operator permissions.",
      );
    } finally {
      if (currentSession === session.current) setBusy(false);
    }
  }

  return (
    <div className="management-page players-page">
      <div className="page-heading management-heading">
        <div>
          <p className="eyebrow">IN-GAME MANAGEMENT</p>
          <h1>Players</h1>
        </div>
      </div>

      {data && simulated && (
        <div className="management-notice">
          <Info size={18} />
          <div>
            <strong>Demo mode · Simulated operators</strong>
            <p>
              Operator and moderation actions are simulated in this workspace.
              No live players or Minecraft ban files are changed.
            </p>
          </div>
        </div>
      )}
      {data && data.status !== "running" && (
        <div className="management-notice players-offline-notice">
          <Terminal size={18} />
          <div>
            <strong>Start the server to manage operators</strong>
            <p>
              {simulated ? "The demo server" : "The server"} is {data.status}.
              {simulated
                ? " Start it in Console to try simulated player commands."
                : " You can view saved players and operators now. Start it before changing permissions, kicking, or managing bans."}
            </p>
            <a href="#console">
              Go to Console <ArrowUpRight size={14} />
            </a>
          </div>
        </div>
      )}

      <div className="panel players-online-banner">
        <Users size={19} />
        <strong>
          {data ? online.length : "—"}{" "}
          <span>/ {data?.maxPlayers ?? "—"} players online</span>
        </strong>
        <RefreshButton
          label="Refresh players"
          disabled={busy}
          onRefresh={() => refresh(true)}
          notify={notify}
          successMessage="Players refreshed."
        />
      </div>
      {error && (
        <StatePanel
          variant="error"
          title="Unable to refresh players"
          message={error}
          onRetry={() => void refresh(true)}
        />
      )}

      <div className="players-rosters">
        <Roster
          id="online-players"
          title="Online Players"
          players={online}
          empty="No players online."
          loading={loading && !data}
          actions={(player) => (
            <>
              <button
                className="btn icon"
                aria-label={`Kick online player ${player.name}`}
                title="Kick player"
                disabled={!canManage || busy}
                onClick={() => openModeration("kick", known(player))}
              >
                <LogOut size={14} />
              </button>
              <button
                className="btn icon"
                aria-label={`Ban online player ${player.name}`}
                title="Ban player"
                disabled={!canManage || busy || data?.bansAvailable === false}
                onClick={() => openModeration("ban", known(player))}
              >
                <Ban size={14} />
              </button>
              <button
                className="btn icon"
                aria-label={`${isOperator(known(player)) ? "Remove" : "Grant"} OP for online player ${player.name}`}
                title={isOperator(known(player)) ? "Remove OP" : "Grant OP"}
                disabled={!canManage || busy}
                onClick={() =>
                  isOperator(known(player))
                    ? openRemove(
                        operators.find((entry) => samePlayer(entry, player)) ??
                          player,
                      )
                    : openGrant(known(player))
                }
              >
                {isOperator(known(player)) ? (
                  <ShieldMinus size={14} />
                ) : (
                  <ShieldPlus size={14} />
                )}
              </button>
              <button
                className="btn icon"
                aria-label={`${isWhitelisted(player) ? "Remove" : "Add"} online player ${player.name} ${isWhitelisted(player) ? "from" : "to"} whitelist`}
                title={
                  isWhitelisted(player)
                    ? "Remove from whitelist"
                    : "Add to whitelist"
                }
                disabled={
                  !canManage || busy || data?.whitelistAvailable === false
                }
                onClick={() =>
                  openWhitelist({
                    kind: isWhitelisted(player) ? "remove" : "add",
                    player,
                  })
                }
              >
                {isWhitelisted(player) ? (
                  <UserMinus size={14} />
                ) : (
                  <UserCheck size={14} />
                )}
              </button>
            </>
          )}
        />
        <Roster
          id="banned-players"
          title="Banned Players"
          players={banned}
          empty={
            data?.bansAvailable === false
              ? "Ban list unavailable."
              : "No banned players."
          }
          loading={loading && !data}
          actions={(player) => (
            <button
              className="btn icon"
              aria-label={`Unban saved player ${player.name}`}
              title="Unban player"
              disabled={!canManage || busy || data?.bansAvailable === false}
              onClick={() => openModeration("unban", known(player))}
            >
              <Undo2 size={14} />
            </button>
          )}
        />
        <Roster
          id="operators"
          title="Operators"
          players={filtered}
          filter={search}
          empty={search ? "No matching players" : "No operators."}
          loading={loading && !data}
          actions={(player) => (
            <button
              className="btn icon"
              aria-label={`Remove OP for ${player.name}`}
              title="Remove OP"
              disabled={!canManage || busy}
              onClick={() => openRemove(player)}
            >
              <ShieldMinus size={14} />
            </button>
          )}
        >
          {operators.length > 0 && (
            <SearchField
              className="players-roster-search"
              iconSize={13}
              aria-label="Search operators"
              clearLabel="Clear operator search"
              placeholder="Search operators…"
              value={search}
              onValueChange={setSearch}
            />
          )}
        </Roster>
        <Roster
          id="whitelist"
          title="Whitelist"
          players={whitelist}
          empty={
            data?.whitelistAvailable === false
              ? "Whitelist unavailable."
              : "No whitelisted players."
          }
          loading={loading && !data}
          tools={
            <>
              <button
                className="btn icon"
                aria-label="Add player to whitelist"
                title="Add player"
                disabled={
                  !canManage || busy || data?.whitelistAvailable === false
                }
                onClick={() => openWhitelist({ kind: "add" })}
              >
                <Plus size={14} />
              </button>
              <Switch
                aria-label="Enable whitelist"
                title={
                  data?.whitelistEnabled == null
                    ? "Whitelist setting unavailable"
                    : data.whitelistEnabled
                      ? "Whitelist enabled"
                      : "Whitelist disabled"
                }
                label=""
                checked={data?.whitelistEnabled ?? false}
                disabled={
                  !canManage ||
                  busy ||
                  data?.whitelistSettingsAvailable === false ||
                  (!data?.whitelistEnabled &&
                    data?.whitelistAvailable === false) ||
                  data?.whitelistEnabled == null
                }
                onCheckedChange={(enabled) =>
                  openWhitelist({ kind: "state", enabled })
                }
              />
            </>
          }
          actions={(player) => (
            <button
              className="btn icon"
              aria-label={`Remove saved whitelist player ${player.name}`}
              title="Remove from whitelist"
              disabled={
                !canManage || busy || data?.whitelistAvailable === false
              }
              onClick={() => openWhitelist({ kind: "remove", player })}
            >
              <UserMinus size={14} />
            </button>
          )}
        />
      </div>

      {result && (
        <div className="players-result" role="status">
          {result.simulated ? <Check size={17} /> : <Info size={17} />}
          <div>
            <strong>
              {result.simulated
                ? "Demo player action completed"
                : "Player command requested"}
            </strong>
            <p>
              {result.message}
              {!result.simulated &&
                " Check Console for the command result. The list refreshes as Minecraft saves its player files."}
            </p>
          </div>
          <button
            className="btn icon"
            aria-label="Dismiss operator result"
            onClick={() => setResult(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      <section
        className="panel management-list players-history-panel"
        aria-labelledby="history-title"
      >
        <div className="management-panel-header">
          <div className="management-section-title">
            <Users size={18} />
            <h2 id="history-title">Player history</h2>
            <span className="management-count">{history.length}</span>
          </div>
          <div className="management-controls">
            <SearchField
              className="management-search"
              aria-label="Search player history"
              clearLabel="Clear player history search"
              placeholder="Search players…"
              value={historySearch}
              onValueChange={setHistorySearch}
            />
          </div>
        </div>
        <p className="players-history-help">
          Players seen by this panel and profiles saved by the server. Login
          times are shown only when observed.
        </p>
        {data?.warnings?.map((warning) => (
          <p className="players-history-warning" role="status" key={warning}>
            <AlertCircle size={16} />
            {warning}
          </p>
        ))}
        {loading && !data ? (
          <StatePanel variant="loading" title="Loading player history…" />
        ) : filteredHistory.length === 0 ? (
          <StatePanel
            variant="empty"
            icon={<Users size={27} />}
            title={
              historySearch ? "No matching history" : "No known players yet"
            }
            message={
              historySearch
                ? "Try another Minecraft username."
                : "Players will appear when they join while this panel is running, or when their profiles are available in the server’s saved files."
            }
          />
        ) : (
          <ul
            className="players-history-list"
            ref={historyList}
            aria-label="Player history list"
            tabIndex={0}
          >
            {historyPaging.rows.map((player) => (
              <li
                aria-label={`Player ${player.name}`}
                className="players-history-row"
                key={player.uuid || player.name}
              >
                <PlayerHead name={player.name} uuid={player.uuid} size={40} />
                <div className="players-history-identity">
                  <strong>{player.name}</strong>
                  <span>
                    {player.online ? "Online" : "Offline"}
                    {player.banned
                      ? " · Banned"
                      : player.banned === null
                        ? " · Ban status unavailable"
                        : ""}
                    {simulated && player.banned ? " (simulated)" : ""}
                  </span>
                  {player.banReason && (
                    <span className="players-ban-reason">
                      Reason: {player.banReason}
                    </span>
                  )}
                </div>
                <div className="players-history-time">
                  <span>
                    {player.lastSeen ? "Last observed" : "Login time unknown"}
                  </span>
                  {player.lastSeen ? (
                    <time
                      dateTime={player.lastSeen}
                      title={`First observed: ${player.firstSeen ? new Date(player.firstSeen).toLocaleString() : "unknown"}`}
                    >
                      {new Date(player.lastSeen).toLocaleString()}
                    </time>
                  ) : (
                    <small>
                      {player.source === "banned"
                        ? "From saved ban list"
                        : player.source === "whitelist"
                          ? "From saved whitelist"
                          : player.source === "operator"
                            ? "From saved operator list"
                            : "From server profile cache"}
                    </small>
                  )}
                </div>
                <div className="players-history-actions">
                  <button
                    className="btn"
                    aria-label={`${isWhitelisted(player) ? "Remove" : "Add"} ${player.name} ${isWhitelisted(player) ? "from" : "to"} whitelist`}
                    disabled={
                      !canManage || busy || data?.whitelistAvailable === false
                    }
                    onClick={() =>
                      openWhitelist({
                        kind: isWhitelisted(player) ? "remove" : "add",
                        player,
                      })
                    }
                  >
                    {isWhitelisted(player) ? (
                      <UserMinus size={14} />
                    ) : (
                      <UserCheck size={14} />
                    )}
                    {isWhitelisted(player) ? "Remove whitelist" : "Whitelist"}
                  </button>
                  <button
                    className="btn"
                    aria-label={`Grant OP for ${player.name}`}
                    disabled={!canManage || busy || isOperator(player)}
                    title={
                      isOperator(player)
                        ? "This player is already an operator"
                        : "Grant operator permissions"
                    }
                    onClick={() => openGrant(player)}
                  >
                    <ShieldPlus size={14} />
                    {isOperator(player) ? "Already OP" : "Grant OP"}
                  </button>
                  <button
                    className="btn"
                    aria-label={`Kick ${player.name}`}
                    disabled={!canManage || !player.online || busy}
                    title={
                      !player.online
                        ? "Only online players can be kicked"
                        : "Disconnect this player"
                    }
                    onClick={() => openModeration("kick", player)}
                  >
                    <LogOut size={14} />
                    Kick
                  </button>
                  <button
                    className="btn players-remove"
                    aria-label={`${player.banned ? "Unban" : "Ban"} ${player.name}`}
                    disabled={!canManage || player.banned === null || busy}
                    onClick={() =>
                      openModeration(player.banned ? "unban" : "ban", player)
                    }
                  >
                    {player.banned ? <Undo2 size={14} /> : <Ban size={14} />}
                    {player.banned ? "Unban" : "Ban"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Pagination
          title="Player history"
          paging={historyPaging}
          disabled={loading || Boolean(error)}
        />
      </section>

      <dialog
        ref={dialog}
        className="modal management-dialog players-dialog"
        aria-labelledby="players-dialog-title"
        aria-describedby="players-dialog-description"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
      >
        <form onSubmit={submit}>
          <div className="management-dialog-heading">
            <span className="management-icon">
              {removing ? <ShieldMinus size={22} /> : <ShieldPlus size={22} />}
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
          <h2 id="players-dialog-title">
            {removing
              ? "Remove operator permissions?"
              : "Grant operator permissions"}
          </h2>
          <p
            id="players-dialog-description"
            className="management-dialog-description"
          >
            {removing ? (
              <>
                Remove OP for <strong>{removing.name}</strong> on this server?
                They can continue playing with normal player permissions.
              </>
            ) : (
              <>
                Grant OP to <strong>{name}</strong> on this server?
              </>
            )}
          </p>
          {!removing && (
            <div className="form-field">
              <label htmlFor="operator-username">Minecraft username</label>
              <input
                id="operator-username"
                ref={usernameInput}
                autoFocus
                required
                minLength={3}
                maxLength={16}
                pattern="[A-Za-z0-9_]{3,16}"
                title="3–16 letters, numbers, or underscores"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Player_username"
                value={name}
                readOnly
                disabled={busy}
                aria-describedby="operator-username-hint"
              />
              <small id="operator-username-hint">
                3–16 letters, numbers, or underscores.
              </small>
            </div>
          )}
          <div className="players-permission-note">
            {simulated ? <Info size={18} /> : <ShieldCheck size={18} />}
            <p>
              {simulated
                ? "This is a simulated change for this demo server. No live player permissions will change."
                : removing
                  ? "Minecraft will process a deop command. Check Console for confirmation."
                  : "OP grants powerful in-game commands, including changes to the world and player management, according to your server’s operator level. Only grant it to someone you trust."}
            </p>
          </div>
          {!canManage && (
            <p className="management-form-error" role="alert">
              <AlertCircle size={15} /> The server must be running and connected
              to change permissions.
            </p>
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
              className={`btn ${removing ? "danger" : "primary"}`}
              disabled={busy || !canManage}
            >
              {busy ? "Sending..." : removing ? "Remove OP" : "Grant OP"}
            </button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={whitelistDialog}
        className="modal management-dialog players-dialog"
        aria-labelledby="whitelist-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeWhitelist();
        }}
      >
        <form onSubmit={submitWhitelist}>
          <div className="management-dialog-heading">
            <span className="management-icon">
              <UserCheck size={22} />
            </span>
            <button
              className="btn icon"
              type="button"
              aria-label="Close whitelist dialog"
              disabled={busy}
              onClick={closeWhitelist}
            >
              <X size={18} />
            </button>
          </div>
          <h2 id="whitelist-dialog-title">{whitelistTitle}</h2>
          <p className="management-dialog-description">
            {whitelistAction?.kind === "state" ? (
              whitelistAction.enabled ? (
                "Only whitelisted players will be allowed to join this server."
              ) : (
                "Players will be able to join without being on the whitelist. Player and IP bans still apply."
              )
            ) : whitelistAction?.kind === "remove" ? (
              <>
                Remove <strong>{whitelistName}</strong> from the whitelist? They
                will need to be added again to join while the whitelist is
                enabled.
              </>
            ) : (
              "Add the Minecraft Java username of a player who should be allowed to join when the whitelist is enabled."
            )}
          </p>
          {whitelistAction?.kind === "add" && (
            <div className="form-field">
              <label htmlFor="whitelist-name">Minecraft username</label>
              <input
                id="whitelist-name"
                value={whitelistName}
                onChange={(event) => setWhitelistName(event.target.value)}
                readOnly={Boolean(whitelistAction.player)}
                required
                minLength={3}
                maxLength={16}
                pattern="[A-Za-z0-9_]{3,16}"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                autoFocus
              />
              <small>3–16 letters, numbers, or underscores.</small>
            </div>
          )}
          <div className="players-permission-note">
            <Info size={18} />
            <p>
              {simulated
                ? "This change is simulated. Minecraft’s whitelist and server settings files will not change."
                : "The panel sends a Minecraft console command. The roster and switch update when the server saves the result."}
            </p>
          </div>
          {(!canManage || formError) && (
            <p className="management-form-error" role="alert">
              <AlertCircle size={15} />
              {formError ||
                "Start the server in Console before changing the whitelist."}
            </p>
          )}
          <div className="management-dialog-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={closeWhitelist}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`btn ${whitelistAction?.kind === "remove" ? "danger" : "primary"}`}
              disabled={
                busy ||
                !canManage ||
                (whitelistAction?.kind === "state"
                  ? data?.whitelistSettingsAvailable === false ||
                    (whitelistAction.enabled &&
                      data?.whitelistAvailable === false)
                  : data?.whitelistAvailable === false)
              }
            >
              {busy
                ? "Sending..."
                : whitelistAction?.kind === "state"
                  ? `${whitelistAction.enabled ? "Enable" : "Disable"} whitelist`
                  : whitelistAction?.kind === "remove"
                    ? "Remove from whitelist"
                    : "Add to whitelist"}
            </button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={moderationDialog}
        className="modal management-dialog players-dialog"
        aria-labelledby="moderation-title"
        onCancel={(event) => {
          event.preventDefault();
          closeModeration();
        }}
      >
        <form onSubmit={submitModeration}>
          <div className="management-dialog-heading">
            <span className="management-icon">
              {moderating?.action === "kick" ? (
                <LogOut size={22} />
              ) : (
                <Ban size={22} />
              )}
            </span>
            <button
              type="button"
              className="btn icon"
              aria-label="Close player action"
              disabled={busy}
              onClick={closeModeration}
            >
              <X size={18} />
            </button>
          </div>
          <h2 id="moderation-title">{actionLabel}?</h2>
          <p className="management-dialog-description">
            {moderating?.action === "kick" ? (
              <>
                Disconnect <strong>{moderating.player.name}</strong> now? They
                can reconnect unless banned.
              </>
            ) : moderating?.action === "ban" ? (
              <>
                Ban <strong>{moderating.player.name}</strong> from this server?
                Minecraft will disconnect them and prevent them from joining
                until unbanned.
              </>
            ) : (
              <>
                Allow <strong>{moderating?.player.name}</strong> to join again?
                This removes their player ban; IP bans are separate.
              </>
            )}
          </p>
          {moderating?.action !== "unban" && (
            <div className="form-field">
              <label htmlFor="moderation-reason">Reason (optional)</label>
              <input
                id="moderation-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                disabled={busy}
                autoComplete="off"
                placeholder="A short explanation for the player"
              />
              <small>
                Up to 200 characters on one line. The player can see this
                reason.
              </small>
            </div>
          )}
          <div className="players-permission-note">
            <Info size={18} />
            <p>
              {simulated
                ? "This action is simulated. No live player or Minecraft ban file will change."
                : "The panel sends a Minecraft console command. Check Console for confirmation; plugins may handle commands differently."}
            </p>
          </div>
          {(!canManage || formError) && (
            <p className="management-form-error" role="alert">
              <AlertCircle size={15} />
              {formError ||
                "Start the server in Console before managing players."}
            </p>
          )}
          <div className="management-dialog-actions">
            <button
              type="button"
              className="btn"
              onClick={closeModeration}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`btn ${moderating?.action === "unban" ? "primary" : "danger"}`}
              disabled={busy || !canManage}
            >
              {busy ? "Sending..." : actionLabel}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
