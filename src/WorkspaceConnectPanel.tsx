import { useEffect, useRef, useState, type FormEvent } from "react";
import { Globe2, LoaderCircle, X } from "lucide-react";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";
import type { PanelConnections } from "./desktop-connections";
import PanelSignInForm from "./PanelSignInForm";
import type { ConnectionMode } from "./ConnectPanel";

type Target = {
  panel: PanelConnections["panels"][number];
  token: string;
  email?: string;
  error?: string;
};

export default function WorkspaceConnectPanel({
  initialMode = "signin",
  initialUrl = "",
  onClose,
  onOpened,
}: {
  initialMode?: ConnectionMode;
  initialUrl?: string;
  onClose: () => void;
  onOpened: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const revision = useRef(0);
  const pending = useRef(false);
  const temporary = useRef<string | null>(null);
  const mode = initialMode;
  const [address, setAddress] = useState(initialUrl);
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function discard() {
    revision.current++;
    pending.current = false;
    const id = temporary.current;
    temporary.current = null;
    if (id) void window.mcPanelConnections?.cancelSignIn?.(id).catch(() => {});
  }
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    // Native modal opening chooses its own focus target after React's
    // autoFocus. Put keyboard users in the form once the dialog is open.
    element?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      alive.current = false;
      discard();
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    setError("");
    let url: URL;
    try {
      url = new URL(normalizePanelConnectionUrl(address));
      if (!url.hash)
        throw new Error(
          "Paste the complete invitation link from the panel owner.",
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Enter a valid invitation link.",
      );
      return;
    }
    const current = ++revision.current;
    pending.current = true;
    setBusy(true);
    const active = () => alive.current && revision.current === current;
    try {
      const bridge = window.mcPanelConnections!;
      const result = await bridge.open(url.href);
      const panel = result.panels.find(
        (item) =>
          !item.local &&
          (result.openedPanelId
            ? item.id === result.openedPanelId
            : item.origin === url.origin),
      );
      if (!active()) {
        if (panel?.temporary) await bridge.cancelSignIn?.(panel.id);
        return;
      }
      if (!panel)
        throw new Error(
          "The panel could not be verified. Check the invitation address and try again.",
        );
      temporary.current = panel.id;
      const token = url.hash.slice("#invite=".length);
      if (!bridge.invitation)
        throw new Error(
          "Update MC Panel to accept invitations from this workspace.",
        );
      try {
        const invitation = await bridge.invitation(panel.id, { token });
        if (
          panel.signedIn &&
          panel.session?.email?.toLowerCase() !== invitation.email.toLowerCase()
        )
          throw new Error(
            `Already signed in to ${panel.origin}${panel.session?.email ? ` as ${panel.session.email}` : ""}. This invitation is for ${invitation.email}. Use Manage Connections to sign out before accepting it.`,
          );
        if (active()) setTarget({ panel, token, email: invitation.email });
      } catch (cause) {
        if (active())
          setTarget({
            panel,
            token,
            error:
              cause instanceof Error
                ? cause.message
                : "This invitation could not be checked. Try again.",
          });
      }
    } catch (cause) {
      if (active())
        setError(
          cause instanceof Error
            ? cause.message
            : "The panel could not be opened. Try again.",
        );
    } finally {
      if (active()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  function back() {
    discard();
    setTarget(null);
    setError("");
    setBusy(false);
  }
  return (
    <dialog
      ref={dialog}
      className="connect-panel"
      aria-labelledby="workspace-connect-title"
      aria-describedby="workspace-connect-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        className="btn icon connect-panel-close"
        aria-label="Close connection dialog"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <span className="connect-panel-icon">
        <Globe2 size={26} />
      </span>
      <p className="connect-panel-eyebrow">REMOTE PANEL</p>
      <h2 id="workspace-connect-title">
        {mode === "invitation" ? "Accept invitation" : "Sign in"}
      </h2>
      <p id="workspace-connect-description">
        {mode === "invitation"
          ? "Use the owner's invitation to set a password for your account. Your other panels stay signed in."
          : "Enter your panel address and account details. The panel is saved after sign-in succeeds."}
      </p>
      {mode === "signin" ? (
        <>
          <PanelSignInForm
            initialAddress={
              address ||
              (window.mcPanelConnections?.runtime === "browser"
                ? window.location.origin
                : "")
            }
            onComplete={onOpened}
            onBusyChange={setBusy}
          />
          <div className="connect-panel-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : target ? (
        <>
          {target.error ? (
            <>
              <p role="alert" className="form-error">
                {target.error}
              </p>
              <p>
                Ask the owner to create a new invitation link for your existing
                account if this link expired. Your existing server permissions
                are preserved. If you already saved a password, close this
                invitation and choose Sign in in Manage Connections.
              </p>
            </>
          ) : (
            <PanelSignInForm
              key={`${target.panel.id}:${target.token}`}
              panel={target.panel}
              token={target.token}
              initialEmail={target.email}
              onComplete={() => {
                temporary.current = null;
                onOpened();
              }}
              onBusyChange={setBusy}
            />
          )}
          <div className="connect-panel-actions">
            <button className="btn" onClick={back}>
              Back to invitation link
            </button>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={preview}>
          <label htmlFor="workspace-invitation">Invitation link</label>
          <input
            id="workspace-invitation"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={2048}
            placeholder="https://panel.example.com/#invite=…"
            autoFocus
            value={address}
            disabled={busy}
            onChange={(event) => {
              setAddress(event.target.value);
              setError("");
            }}
          />
          <p className="connect-panel-hint">
            The complete invitation identifies the panel and your account. You
            do not need to enter a separate panel address.
          </p>
          {error && (
            <p role="alert" className="connect-panel-error">
              {error}
            </p>
          )}
          <div className="connect-panel-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy && <LoaderCircle size={17} className="spin" />}Continue with
              invitation
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
