import { useContext, useEffect, useRef, useState } from "react";
import {
  Globe2,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useDesktopConnections } from "./desktop-connections";
import PanelSignInForm from "./PanelSignInForm";
import { DesktopWorkspaceContext } from "./workspace-target";
import "./panel-connections.css";

export default function PanelConnections({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const cancelForget = useRef<HTMLButtonElement>(null);
  const workspace = useContext(DesktopWorkspaceContext);
  const legacyConnections = useDesktopConnections(!workspace);
  const connections = workspace?.connections ?? legacyConnections;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const unified = window.mcPanelConnections?.unified === true;
  const [forget, setForget] = useState<{ id: string; label: string } | null>(
    null,
  );
  useEffect(() => {
    if (forget || signingOut) cancelForget.current?.focus();
  }, [forget, signingOut]);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      mounted.current = false;
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function perform(id: string, action: "open" | "forget" | "signOut") {
    if (pending.current) return;
    pending.current = true;
    setBusy(id);
    setError("");
    try {
      const bridge = window.mcPanelConnections!;
      if (unified) {
        if (action === "forget") await bridge.forget!(id);
        else if (action === "signOut") await bridge.signOut!(id);
        else await bridge.retry!(id);
      } else if (action === "forget") await bridge.disconnect(id);
      else await bridge.activate(id);
      if (!mounted.current) return;
      setForget(null);
      setSigningOut(null);
      if (signingIn === id) setSigningIn(null);
      if (action === "open" && !unified) onClose();
      // Refresh immediately after forgetting; the same event also refreshes
      // selectors and account menus in the other isolated panel renderers.
      else window.dispatchEvent(new Event("mc-panel-connections-changed"));
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The connection could not be changed. Try again.",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  const panels = connections?.panels.filter((panel) => !panel.local) ?? [];
  return createPortal(
    <dialog
      ref={dialog}
      className="panel-connections-dialog"
      aria-labelledby="panel-connections-title"
      onCancel={(event) => {
        event.preventDefault();
        if (busy) return;
        if (forget) setForget(null);
        else if (signingOut) setSigningOut(null);
        else if (signingIn) setSigningIn(null);
        else onClose();
      }}
    >
      <div className="panel-connections-heading">
        <h2 id="panel-connections-title">
          {unified ? "Manage Connections" : "Panel connections"}
        </h2>
        <button
          className="btn icon"
          aria-label="Close panel connections"
          disabled={Boolean(busy)}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {signingOut ? (
        <>
          <h3>Sign out of {signingOut.label}?</h3>
          <p>
            This ends this computer's sign-in to{" "}
            <strong>{signingOut.label}</strong>. Its unsaved edits will be
            discarded and unfinished client transfers may be interrupted.
            Minecraft servers on that host keep running. Other panels stay
            signed in.
          </p>
          <div className="panel-connections-actions">
            <button
              ref={cancelForget}
              className="btn"
              disabled={Boolean(busy)}
              onClick={() => {
                setSigningOut(null);
                setError("");
              }}
            >
              Cancel
            </button>
            <button
              className="btn danger"
              disabled={Boolean(busy)}
              onClick={() => void perform(signingOut.id, "signOut")}
            >
              {busy && <LoaderCircle size={16} className="spin" />}Sign out of
              this panel
            </button>
          </div>
        </>
      ) : forget ? (
        <>
          <h3>Forget {forget.label}?</h3>
          <p>
            This removes this computer's saved sign-in and certificate trust for{" "}
            <strong>{forget.label}</strong>. Files and Minecraft servers on that
            panel stay on their host and keep running.
          </p>
          <p>
            Unsaved edits in that panel will be lost and unfinished transfers
            from this connection will be interrupted. Connecting again requires
            signing in. A self-signed certificate must be verified again.
          </p>
          <div className="panel-connections-actions">
            <button
              ref={cancelForget}
              className="btn"
              disabled={Boolean(busy)}
              onClick={() => {
                setForget(null);
                setError("");
              }}
            >
              Cancel
            </button>
            <button
              className="btn danger"
              disabled={Boolean(busy)}
              onClick={() => void perform(forget.id, "forget")}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Trash2 size={16} />
              )}{" "}
              Forget connection
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            {unified
              ? "Manage each panel's sign-in independently. Local servers and other connections stay available in this workspace."
              : "Open a saved panel or forget its sign-in on this computer. Unavailable and signed-out panels remain here for retry."}
          </p>
          {!connections ? (
            <p role="status">Loading connections…</p>
          ) : !panels.length ? (
            <p>No saved panel connections.</p>
          ) : (
            <ul className="panel-connections-list">
              {panels.map((panel) => {
                const unavailable = panel.connectionState === "unavailable";
                const status =
                  panel.connectionState === "connecting"
                    ? "Connecting…"
                    : unavailable
                      ? "Unavailable — retry to connect"
                      : panel.signedIn === true
                        ? "Signed in"
                        : panel.signedIn === false
                          ? "Signed out"
                          : "Sign-in not verified";
                return (
                  <li key={panel.id}>
                    <div className="panel-connections-identity">
                      <Globe2 size={18} />
                      <div>
                        <strong>{panel.label}</strong>
                        <small>
                          {status}
                          {(!unified && connections.activeId === panel.id) ||
                          (unified &&
                            connections.selectedServer?.panelId === panel.id)
                            ? " · Current panel"
                            : ""}
                        </small>
                        {unified && panel.session?.email && (
                          <small>{panel.session.email}</small>
                        )}
                        {unified && panel.error && (
                          <small className="form-error" role="alert">
                            {panel.error}
                          </small>
                        )}
                        {unified && unavailable && panel.servers?.length ? (
                          <small>
                            Saved server information only. Reconnect to verify
                            access.
                          </small>
                        ) : null}
                      </div>
                    </div>
                    <div className="panel-connections-row-actions">
                      {(!unified ||
                        unavailable ||
                        panel.connectionState === "connecting" ||
                        panel.signedIn === undefined) && (
                        <button
                          className="btn"
                          disabled={Boolean(busy)}
                          aria-label={`${unified || unavailable ? "Retry" : "Open"} ${panel.label}`}
                          onClick={() => void perform(panel.id, "open")}
                        >
                          {busy === panel.id ? (
                            <LoaderCircle size={15} className="spin" />
                          ) : (
                            <RefreshCw size={15} />
                          )}{" "}
                          {unified || unavailable ? "Retry" : "Open"}
                        </button>
                      )}
                      {unified &&
                        !panel.signedIn &&
                        panel.connectionState === "connected" && (
                          <button
                            className="btn"
                            disabled={Boolean(busy)}
                            aria-label={`Sign in to ${panel.label}`}
                            onClick={() => {
                              setSigningIn(panel.id);
                              setError("");
                            }}
                          >
                            <LogIn size={15} />
                            Sign in
                          </button>
                        )}
                      {unified && panel.signedIn === true && (
                        <button
                          className="btn"
                          disabled={Boolean(busy)}
                          aria-label={`Sign out of ${panel.label}`}
                          onClick={() => {
                            setSigningOut({ id: panel.id, label: panel.label });
                            setError("");
                          }}
                        >
                          <LogOut size={15} />
                          Sign out
                        </button>
                      )}
                      <button
                        className="btn"
                        disabled={Boolean(busy)}
                        aria-label={`Forget ${panel.label}`}
                        onClick={() => {
                          setForget({ id: panel.id, label: panel.label });
                          setError("");
                        }}
                      >
                        <Trash2 size={15} /> Forget
                      </button>
                    </div>
                    {unified && signingIn === panel.id && (
                      <div className="panel-connections-signin">
                        <PanelSignInForm
                          key={panel.id}
                          panel={panel}
                          onComplete={() => setSigningIn(null)}
                          onBusyChange={(value) => {
                            pending.current = value;
                            setBusy(value ? panel.id : null);
                          }}
                        />
                        <button
                          className="btn"
                          disabled={Boolean(busy)}
                          onClick={() => setSigningIn(null)}
                        >
                          Cancel sign-in
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </dialog>,
    document.body,
  );
}
