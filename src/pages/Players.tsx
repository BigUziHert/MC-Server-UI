import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Gamepad2,
  Info,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldMinus,
  ShieldPlus,
  Terminal,
  X,
} from "lucide-react";
import { useServerApi, type PageProps } from "../api";
import "./management.css";
import "./players.css";

type Operator = { name: string; uuid?: string; level?: number };
type PlayersResponse = {
  operators: Operator[];
  mode: "demo" | "live";
  status: "running" | "offline" | "starting" | "stopping";
};
type OperationResponse = { message: string; simulated: boolean };

export default function Players({ notify }: PageProps) {
  const { api, post } = useServerApi();
  const [data, setData] = useState<PlayersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [granting, setGranting] = useState(false);
  const [removing, setRemoving] = useState<Operator | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [result, setResult] = useState<OperationResponse | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const session = useRef(0);

  const refresh = useCallback(
    async (silent = false) => {
      const currentRequest = ++request.current;
      if (!silent) setLoading(true);
      try {
        const response = await api<PlayersResponse>("/players");
        if (currentRequest !== request.current) return;
        setData(response);
        setError("");
      } catch (e) {
        if (currentRequest !== request.current) return;
        setError(e instanceof Error ? e.message : "Unable to load operators.");
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
    setGranting(false);
    setRemoving(null);
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

  const simulated = data?.mode === "demo";
  const canManage = Boolean(data && !error && data.status === "running");
  const operators = data?.operators ?? [];
  const filtered = operators.filter((player) =>
    player.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  function openGrant() {
    setName("");
    setFormError("");
    setGranting(true);
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
        { name: username },
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
          <div className="management-eyebrow">IN-GAME MANAGEMENT</div>
          <h1>Players</h1>
          <p>Manage operator permissions in your Minecraft world.</p>
        </div>
        <button
          className="btn primary"
          onClick={openGrant}
          disabled={!canManage || loading}
        >
          <Plus size={16} /> Grant OP
        </button>
      </div>

      {data && simulated && (
        <div className="management-notice">
          <Info size={18} />
          <div>
            <strong>Demo mode · Simulated operators</strong>
            <p>
              Changes are saved to this server’s demo operator list. No
              permissions are changed in a live Minecraft game.
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
                ? " Start it in Console to try simulated operator commands."
                : " You can view its saved operators now and change permissions once it is running."}
            </p>
            <a href="#console">
              Go to Console <ArrowUpRight size={14} />
            </a>
          </div>
        </div>
      )}

      <div className="players-overview">
        <div className="panel players-summary">
          <span className="management-icon">
            <ShieldCheck size={22} />
          </span>
          <div>
            <span>Server operators</span>
            <strong>
              {data ? operators.length : "—"}
              <small>
                {simulated ? "simulated operators" : "with in-game permissions"}
              </small>
            </strong>
          </div>
        </div>
        <div className="panel players-about">
          <Gamepad2 size={25} />
          <div>
            <strong>A trusted role in your world</strong>
            <p>
              Operators can use powerful game commands. Their permissions follow
              this server’s Minecraft operator level.
            </p>
          </div>
        </div>
      </div>

      {result && (
        <div className="players-result" role="status">
          {result.simulated ? <Check size={17} /> : <Info size={17} />}
          <div>
            <strong>
              {result.simulated
                ? "Demo operator list updated"
                : "Operator command requested"}
            </strong>
            <p>
              {result.message}
              {!result.simulated &&
                " The list refreshes as Minecraft saves its operators. Check Console for the command result."}
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
        className="panel management-list"
        aria-labelledby="operators-title"
      >
        <div className="management-panel-header">
          <div className="management-section-title">
            <ShieldCheck size={18} />
            <h2 id="operators-title">Operators</h2>
            <span className="management-count">{operators.length}</span>
          </div>
          <div className="management-controls">
            <label className="management-search">
              <Search size={16} />
              <input
                aria-label="Search operators"
                placeholder="Search players..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              className="btn icon"
              title="Refresh operators"
              aria-label="Refresh operators"
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
            operators...
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state management-empty">
            <div className="management-empty-icon">
              <ShieldPlus size={27} />
            </div>
            <h3>
              {search.trim()
                ? "No matching players"
                : "Your world, your trusted players"}
            </h3>
            <p>
              {search.trim()
                ? "Try another Minecraft username."
                : "Grant OP to a player who helps run your world. You can remove their operator permissions here at any time."}
            </p>
            {!search.trim() && (
              <button className="btn" onClick={openGrant} disabled={!canManage}>
                <Plus size={15} /> Grant your first OP
              </button>
            )}
          </div>
        ) : (
          <ul className="players-operator-list">
            {filtered.map((player) => (
              <li className="players-operator" key={player.uuid || player.name}>
                <span className="players-game-avatar" aria-hidden="true">
                  {player.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="players-operator-identity">
                  <strong>{player.name}</strong>
                  <span>
                    {simulated ? "Simulated operator" : "Saved in Minecraft"}
                    {player.level !== undefined
                      ? ` · Level ${player.level}`
                      : ""}
                  </span>
                </div>
                <span className="players-op-badge">
                  <ShieldCheck size={13} /> OP
                </span>
                <button
                  className="btn players-remove"
                  aria-label={`Remove OP for ${player.name}`}
                  disabled={!canManage || busy}
                  onClick={() => {
                    setFormError("");
                    setRemoving(player);
                  }}
                >
                  <ShieldMinus size={15} /> Remove OP
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="management-panel-footer players-list-footer">
          <ShieldCheck size={14} />
          <span>
            {simulated
              ? "Showing this server’s simulated operators."
              : "Showing the server’s saved operator list."}{" "}
            Panel access is managed in <a href="#subusers">Subusers</a>.
          </span>
        </div>
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
              "Enter the exact Minecraft Java username of the player you want to make an operator on this server."
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
                onChange={(event) => setName(event.target.value)}
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
    </div>
  );
}
