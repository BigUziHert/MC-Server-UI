import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
} from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  Gamepad2,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import App from "./App";
import { DesktopPanelReturn } from "./PanelAccount";
import { api, messageOf } from "./api";
import { reportDesktopServers } from "./desktop-connections";
import "./remote-access.css";

type SubuserSession = {
  role: "subuser";
  email: string;
  serverId: string;
  userId: string;
  permissions: string[];
};
type Session = { role: "owner" } | { role: "guest" } | SubuserSession;
const unauthorized = (cause: unknown) =>
  (cause as { status?: number })?.status === 401;

function invitationToken() {
  return new URLSearchParams(window.location.hash.slice(1)).get("invite") || "";
}

export default function RemoteAccess() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [token, setToken] = useState(invitationToken);
  const [requestedRemoteServer, setRequestedRemoteServer] = useState<{
    serverId: string;
    sequence: number;
  } | null>(null);
  const signedOut = useCallback(() => {
    setRequestedRemoteServer(null);
    setSession({ role: "guest" });
  }, []);
  useEffect(() => {
    if (session?.role === "guest")
      void reportDesktopServers(null).catch(() => {});
  }, [session]);
  useEffect(() => {
    if (!window.mcPanelConnections || session?.role === "owner") return;
    const selectedRemotely = (event: Event) => {
      const serverId = (event as CustomEvent<{ serverId?: unknown }>).detail
        ?.serverId;
      if (typeof serverId !== "string" || !serverId.trim()) return;
      setRequestedRemoteServer((previous) => ({
        serverId,
        sequence: (previous?.sequence ?? 0) + 1,
      }));
      setToken("");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#console`,
      );
    };
    window.addEventListener(
      "mc-panel-remote-server-selected",
      selectedRemotely,
    );
    return () =>
      window.removeEventListener(
        "mc-panel-remote-server-selected",
        selectedRemotely,
      );
  }, [session]);
  useEffect(() => {
    const changed = () => setToken(invitationToken());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<Session>("/access/session", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSession(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          if (unauthorized(cause)) setSession({ role: "guest" });
          else setError(messageOf(cause));
        }
      });
    return () => controller.abort();
  }, [attempt]);
  if (session?.role === "owner") return <App />;
  if (!session)
    return (
      <main className="remote-access remote-auth">
        <div className="remote-auth-card">
          <Brand />
          {error ? (
            <>
              <h1>Unable to connect</h1>
              <p role="alert">{error}</p>
              <button
                className="btn primary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            </>
          ) : (
            <p className="remote-loading" role="status">
              <LoaderCircle size={20} className="spin" /> Connecting to your
              panel…
            </p>
          )}
          <DesktopPanelReturn />
        </div>
      </main>
    );
  if (session.role === "guest" || token)
    return (
      <SignIn
        key={token}
        token={token}
        onBackToSignIn={() => setToken("")}
        onSignedIn={(value, acceptedInvitation) => {
          if (acceptedInvitation || invitationToken())
            window.history.replaceState(
              null,
              "",
              `${window.location.pathname}${window.location.search}`,
            );
          setToken("");
          setSession(value);
        }}
      />
    );
  return (
    <App
      key={session.userId}
      session={session}
      onSignedOut={signedOut}
      requestedRemoteServer={requestedRemoteServer}
    />
  );
}

function Brand() {
  return (
    <div className="remote-brand">
      <span>
        <Gamepad2 size={25} />
      </span>
      <strong>MC Panel</strong>
      <small>SHARED ACCESS</small>
    </div>
  );
}

function PasswordInput({
  visibilityLabel = "password",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  visibilityLabel?: string;
}) {
  const [visible, setVisible] = useState(false);
  const toggleLabel = `${visible ? "Hide" : "Show"} ${visibilityLabel}`;
  return (
    <div className="remote-password-field">
      <input
        {...props}
        type={visible ? "text" : "password"}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <button
        className="remote-password-toggle"
        type="button"
        aria-label={toggleLabel}
        aria-controls={props.id}
        aria-pressed={visible}
        title={toggleLabel}
        disabled={props.disabled}
        onClick={() => setVisible((value) => !value)}
      >
        {visible ? (
          <EyeOff size={18} aria-hidden="true" />
        ) : (
          <Eye size={18} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

function SignIn({
  token,
  onBackToSignIn,
  onSignedIn,
}: {
  token: string;
  onBackToSignIn: () => void;
  onSignedIn: (session: SubuserSession, acceptedInvitation: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalidInvitation, setInvalidInvitation] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    setError("");
    if (token && (password.length < 12 || password.length > 128)) {
      setError("Use between 12 and 128 characters for your password.");
      return;
    }
    if (token && password !== confirmation) {
      setError("Your passwords do not match. Enter the same password twice.");
      return;
    }
    if (!event.currentTarget.reportValidity()) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = await api<SubuserSession>(
        token ? "/access/accept" : "/access/login",
        {
          method: "POST",
          body: JSON.stringify(
            token ? { token, password } : { email: email.trim(), password },
          ),
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted && request.current === controller)
        onSignedIn(result, Boolean(token));
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) {
        setError(messageOf(cause));
        if (token && unauthorized(cause)) setInvalidInvitation(true);
      }
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <main className="remote-access remote-auth">
      <section className="remote-auth-card">
        <Brand />
        <p className="remote-signin-address">
          <Globe2 size={14} /> {window.location.host}
        </p>
        <div className="remote-auth-icon">
          {token ? <ShieldCheck size={30} /> : <LockKeyhole size={30} />}
        </div>
        <h1>
          {invalidInvitation
            ? "This invitation is unavailable"
            : token
              ? "Set up your server access"
              : "Welcome to your server"}
        </h1>
        <p>
          {invalidInvitation
            ? "Ask the server owner for a new invitation link. If you already have a password, you can sign in below."
            : token
              ? "Choose a password to accept this invitation. Next time, sign in with the email address your server owner added and this password."
              : "Sign in with your email address and the password you set when you accepted your invitation."}
        </p>
        {error && (
          <p
            id="remote-auth-error"
            className="remote-notice is-error"
            role="alert"
          >
            {error}
          </p>
        )}
        {!invalidInvitation && (
          <form className="remote-signin-form" onSubmit={signIn} noValidate>
            {!token && (
              <>
                <label htmlFor="remote-email">Email address</label>
                <input
                  id="remote-email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  disabled={busy}
                />
              </>
            )}
            <label htmlFor="remote-password">
              {token ? "New password" : "Password"}
            </label>
            <PasswordInput
              id="remote-password"
              autoComplete={token ? "new-password" : "current-password"}
              required
              minLength={token ? 12 : undefined}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={token ? "remote-password-hint" : undefined}
              disabled={busy}
            />
            {token && (
              <>
                <p id="remote-password-hint" className="remote-field-hint">
                  Use 12–128 characters. For multiple servers on this panel, use
                  the same password for each invitation to sign in to them
                  together.
                </p>
                <label htmlFor="remote-password-confirmation">
                  Confirm password
                </label>
                <PasswordInput
                  id="remote-password-confirmation"
                  visibilityLabel="confirm password"
                  autoComplete="new-password"
                  required
                  maxLength={128}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={busy}
                />
              </>
            )}
            <button className="btn primary remote-auth-submit" disabled={busy}>
              {busy ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <LockKeyhole size={18} />
              )}{" "}
              {token ? "Set password and continue" : "Sign in"}{" "}
              <ArrowRight size={18} />
            </button>
          </form>
        )}
        {token ? (
          <button
            className="btn remote-auth-back"
            type="button"
            onClick={onBackToSignIn}
          >
            Back to sign in
          </button>
        ) : (
          <p className="remote-signin-help">
            First time here or forgot your password? Ask the server owner for a
            new invitation link.
          </p>
        )}
        <p className="remote-auth-note">
          <ShieldCheck size={15} /> Access is limited to the permissions your
          server owner shares.
        </p>
        <DesktopPanelReturn />
      </section>
    </main>
  );
}
