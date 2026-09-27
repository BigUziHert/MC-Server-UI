import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";
import type { PanelConnections } from "./desktop-connections";

type Panel = Pick<
  PanelConnections["panels"][number],
  "id" | "label" | "origin"
>;

export default function PanelSignInForm({
  panel,
  token,
  initialAddress,
  initialEmail = "",
  onComplete,
  onBusyChange,
}: {
  panel?: Panel;
  token?: string;
  initialAddress?: string;
  initialEmail?: string;
  onComplete: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  const attemptedPanel = useRef<string | null>(null);
  const busyChanged = useRef(onBusyChange);
  busyChanged.current = onBusyChange;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (attemptedPanel.current)
        void window.mcPanelConnections
          ?.cancelSignIn?.(attemptedPanel.current)
          .catch(() => {});
      if (pending.current) busyChanged.current?.(false);
    };
  }, []);
  const [address, setAddress] = useState(initialAddress ?? panel?.origin ?? "");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    setError("");
    if (token && (password.length < 12 || password.length > 128)) {
      setError("Use between 12 and 128 characters for your password.");
      return;
    }
    if (token && password !== confirmation) {
      setError("Your passwords do not match. Enter the same password twice.");
      return;
    }
    let url = "";
    if (!token) {
      try {
        // Browser home may be a development loopback HTTP origin. The runtime
        // accepts only that exact home origin; other panels always need HTTPS.
        url =
          window.mcPanelConnections?.runtime === "browser" &&
          address.trim().replace(/\/$/, "") === window.location.origin
            ? `${window.location.origin}/`
            : normalizePanelConnectionUrl(address);
        if (new URL(url).hash)
          throw new Error(
            "Use Accept invitation for an invitation link. Enter the panel address here.",
          );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Enter a valid panel address.",
        );
        return;
      }
    }
    if (!event.currentTarget.reportValidity()) return;
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    try {
      const bridge = window.mcPanelConnections;
      if (!bridge?.signIn || !bridge.acceptInvitation)
        throw new Error("Update MC Panel to sign in from this workspace.");
      let target = panel;
      if (!token) {
        if (attemptedPanel.current)
          await bridge.cancelSignIn?.(attemptedPanel.current);
        attemptedPanel.current = null;
        // open performs certificate validation without credentials. Never move
        // the password submission ahead of this awaited validation boundary.
        const result = await bridge.open(url);
        target = result.panels.find(
          (item) => !item.local && item.origin === new URL(url).origin,
        );
        if (!mounted.current) {
          if (target) await bridge.cancelSignIn?.(target.id);
          return;
        }
        const existing = result.panels.find((item) => item.id === target?.id);
        if (existing?.signedIn) {
          if (
            existing.session?.email?.toLowerCase() ===
            email.trim().toLowerCase()
          ) {
            onComplete();
            return;
          }
          throw new Error(
            `Already signed in to ${existing.origin}${existing.session?.email ? ` as ${existing.session.email}` : ""}. Use Manage Connections to sign out before changing accounts.`,
          );
        }
      }
      if (!target)
        throw new Error(
          "The panel could not be verified. Check its address and try again.",
        );
      attemptedPanel.current = target.id;
      if (token) await bridge.acceptInvitation(target.id, { token, password });
      else await bridge.signIn(target.id, { email: email.trim(), password });
      if (!mounted.current) return;
      attemptedPanel.current = null;
      setPassword("");
      setConfirmation("");
      window.dispatchEvent(new Event("mc-panel-connections-changed"));
      onComplete();
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof Error ? cause.message : "Sign-in failed. Try again.",
      );
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  return (
    <form
      className="panel-signin-form"
      onSubmit={submit}
      noValidate
      aria-label={`${token ? "Accept invitation" : "Sign in"}${panel ? ` on ${panel.label}` : " to panel"}`}
    >
      {token ? (
        <p>
          Set a password for <strong>{initialEmail}</strong> on{" "}
          <strong>{panel?.origin}</strong>. Joining this panel grants no
          additional server access. The owner manages server permissions
          separately.
        </p>
      ) : (
        <>
          <label htmlFor={`${id}-address`}>Panel address</label>
          <input
            id={`${id}-address`}
            type="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={2048}
            placeholder="https://panel.example.com:3002"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={busy}
            autoFocus={!address}
          />
          <label htmlFor={`${id}-email`}>Email address</label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            autoFocus={Boolean(address)}
          />
        </>
      )}
      <label htmlFor={`${id}-password`}>
        {token ? "New password" : "Password"}
      </label>
      <div className="panel-signin-password">
        <input
          id={`${id}-password`}
          type={visible ? "text" : "password"}
          autoComplete={token ? "new-password" : "current-password"}
          required
          minLength={token ? 12 : undefined}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
          autoFocus={Boolean(token)}
        />
        <button
          className="btn icon"
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-controls={`${id}-password`}
          aria-pressed={visible}
          disabled={busy}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {token ? (
        <>
          <small>
            Use 12–128 characters. Cancelling keeps your invitation and existing
            server permissions so you can finish later.
          </small>
          <label htmlFor={`${id}-confirmation`}>Confirm password</label>
          <input
            id={`${id}-confirmation`}
            type={visible ? "text" : "password"}
            autoComplete="new-password"
            required
            maxLength={128}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
          />
        </>
      ) : (
        <small>
          Sign in verifies the panel’s certificate before sending your
          credentials. Your other panels stay signed in.
        </small>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {token && error && (
        <p>
          If your password was saved but the connection was interrupted, use
          Sign in with that password. If the invitation expired, ask the owner
          to create a new link for your existing account; your server
          permissions stay in place.
        </p>
      )}
      <div className="panel-connections-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy && <LoaderCircle size={16} className="spin" />}
          {token ? "Set password and continue" : "Sign in"}
        </button>
      </div>
    </form>
  );
}
