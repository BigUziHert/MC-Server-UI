import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import type { PanelConnections } from "./desktop-connections";

export default function PanelSignInForm({
  panel,
  token,
  onComplete,
  onBusyChange,
}: {
  panel: Pick<PanelConnections["panels"][number], "id" | "label" | "origin">;
  token?: string;
  onComplete: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  const busyChanged = useRef(onBusyChange);
  busyChanged.current = onBusyChange;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current) busyChanged.current?.(false);
    };
  }, []);
  const [email, setEmail] = useState("");
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
    if (!event.currentTarget.reportValidity()) return;
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    try {
      const bridge = window.mcPanelConnections;
      if (!bridge?.signIn || !bridge.acceptInvitation)
        throw new Error("Update MC Panel to sign in from this workspace.");
      if (token) await bridge.acceptInvitation(panel.id, { token, password });
      else await bridge.signIn(panel.id, { email: email.trim(), password });
      if (!mounted.current) return;
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
      aria-label={`${token ? "Accept invitation" : "Sign in"} on ${panel.label}`}
    >
      <p>
        {token ? "Accepting an invitation on" : "Signing in to"}{" "}
        <strong>{panel.origin}</strong>. Other connections stay signed in.
      </p>
      {!token && (
        <>
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
            autoFocus
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
      {token && (
        <>
          <small>
            Use 12–128 characters. The owner shares servers after your panel
            account is ready.
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
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
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
