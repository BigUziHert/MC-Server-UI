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

export default function PanelConnections({
  onClose,
  onSignIn,
}: {
  onClose: () => void;
  onSignIn?: () => void;
}) {
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
  function cancelSignIn() {
    setSigningIn(null);
  }
  const [signingOut, setSigningOut] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const unified = window.mcPanelConnections?.unified === true;
  const [forget, setForget] = useState<{
    id: string;
    label: string;
    mode: "account" | "saved";
    sessionEpoch?: string;
    accountId?: string;
    email?: string;
  } | null>(null);
  const panels =
    connections?.panels.filter((panel) => !panel.local && !panel.temporary) ??
    [];
  const forgettingPanel = panels.find((panel) => panel.id === forget?.id);
  const removingSaved = unified && forget?.mode === "saved";
  const pendingLeave =
    unified && !removingSaved && forgettingPanel?.pendingLeave === true;
  const sameAccount =
    !unified ||
    Boolean(
      forgettingPanel &&
      forget?.accountId &&
      forget?.accountId ===
        (forgettingPanel.session?.accountId ?? forgettingPanel.session?.userId),
    );
  const canForget = removingSaved
    ? Boolean(
        forgettingPanel &&
        !forgettingPanel.signedIn &&
        !forgettingPanel.pendingLeave &&
        forget?.sessionEpoch &&
        forget.sessionEpoch === forgettingPanel.sessionEpoch,
      )
    : sameAccount &&
      (!unified || forgettingPanel?.signedIn === true || pendingLeave);
  useEffect(() => {
    if (!unified) return;
    if (
      signingIn &&
      panels.find((panel) => panel.id === signingIn)?.pendingLeave
    )
      setSigningIn(null);
    if (
      signingOut &&
      panels.find((panel) => panel.id === signingOut.id)?.pendingLeave
    )
      setSigningOut(null);
  }, [connections, unified, signingIn, signingOut]);
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
    if (action === "forget" && !canForget) return;
    pending.current = true;
    setBusy(id);
    setError("");
    try {
      const bridge = window.mcPanelConnections!;
      if (unified) {
        if (action === "forget") {
          if (removingSaved)
            await bridge.removeSavedConnection!(id, forget!.sessionEpoch!);
          else await bridge.forget!(id, forget?.accountId);
        } else if (action === "signOut") await bridge.signOut!(id);
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
      window.dispatchEvent(new Event("mc-panel-connections-changed"));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="panel-connections-dialog"
      aria-labelledby="panel-connections-title"
      onCancel={(event) => {
        event.preventDefault();
        if (busy && !signingIn) return;
        if (forget) setForget(null);
        else if (signingOut) setSigningOut(null);
        else if (signingIn) cancelSignIn();
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
          disabled={Boolean(busy) && !signingIn}
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
          <h3>
            {removingSaved ? "Remove saved connection to" : "Forget"}{" "}
            {forget.label}?
          </h3>
          {removingSaved ? (
            <>
              <p>
                This removes this computer's saved connection and certificate
                trust for <strong>{forget.label}</strong>. Accounts,
                permissions, and Minecraft servers on the host stay unchanged.
                Other saved panels remain connected.
              </p>
              <p>
                To connect again, enter the panel address and sign in, or accept
                a new invitation if your access was revoked.
              </p>
              {!canForget && (
                <p role="alert">
                  {forgettingPanel?.pendingLeave
                    ? "Account removal is pending. Return to Manage Connections and use Retry Forget."
                    : "This connection changed. Return to Manage Connections and confirm removal again."}
                </p>
              )}
            </>
          ) : unified ? (
            <>
              <p>
                This permanently removes your account
                {forget.email ? ` (${forget.email})` : ""} from{" "}
                <strong>{forget.label}</strong>, including access to every
                shared server and all computer permissions. This account will be
                signed out on all devices.
              </p>
              <p>
                After the host confirms removal, this computer's saved
                connection and certificate trust are removed. You will need a
                new invitation to connect again.
              </p>
              <p>
                Minecraft servers keep running and their files stay on the host.
                Unsaved edits will be lost and unfinished transfers may be
                interrupted. Other panel accounts are unaffected.
              </p>
              {pendingLeave && (
                <p role="status">
                  Forget is not complete. Retry Forget finishes the same request
                  and removes the saved connection. Closing this dialog does not
                  cancel it; sign-in and sign-out stay unavailable until it is
                  resolved.
                </p>
              )}
              {!canForget && (
                <p role="alert">
                  {sameAccount
                    ? "Sign in to this saved panel from Manage Connections before forgetting it."
                    : "The signed-in account has changed. Return to Manage Connections and confirm Forget for the intended account."}
                </p>
              )}
            </>
          ) : (
            <>
              <p>
                This removes this computer's saved sign-in and certificate trust
                for <strong>{forget.label}</strong>. Files and Minecraft servers
                on that panel stay on their host and keep running.
              </p>
              <p>
                Unsaved edits in that panel will be lost and unfinished
                transfers from this connection will be interrupted. Connecting
                again requires signing in. A self-signed certificate must be
                verified again.
              </p>
            </>
          )}
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
              {pendingLeave ? "Back to connections" : "Cancel"}
            </button>
            <button
              className="btn danger"
              disabled={Boolean(busy) || !canForget}
              onClick={() => void perform(forget.id, "forget")}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Trash2 size={16} />
              )}{" "}
              {removingSaved
                ? "Remove saved connection"
                : pendingLeave
                  ? "Retry Forget"
                  : "Forget connection"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            {unified
              ? "Manage your saved panels and sign in to another panel."
              : "Open a saved panel or forget its sign-in on this computer. Unavailable and signed-out panels remain here for retry."}
          </p>
          {!connections ? (
            <p role="status">Loading connections…</p>
          ) : !panels.length ? (
            <div className="panel-connections-empty">
              <Globe2 size={26} aria-hidden="true" />
              <strong>No saved panel connections.</strong>
              <p>Sign in with a panel address and your account to connect.</p>
            </div>
          ) : (
            <ul className="panel-connections-list">
              {panels.map((panel) => {
                const unavailable = panel.connectionState === "unavailable";
                const removeSaved =
                  unified && !panel.signedIn && !panel.pendingLeave;
                const status =
                  unified && panel.pendingLeave
                    ? "Forget incomplete — Retry Forget"
                    : panel.connectionState === "connecting"
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
                        {unified &&
                          panel.signedIn === true &&
                          panel.connectionState === "connected" &&
                          !panel.pendingLeave &&
                          panel.servers?.length === 0 && (
                            <p className="panel-connections-access-hint">
                              No servers have been shared with this account. Ask
                              the panel owner to add you as a subuser on a
                              server.
                            </p>
                          )}
                        {unified && panel.error && (
                          <small className="form-error" role="alert">
                            {panel.error}
                          </small>
                        )}
                        {unified &&
                        unavailable &&
                        !panel.pendingLeave &&
                        panel.servers?.length ? (
                          <small>
                            Saved server information only. Reconnect to verify
                            access.
                          </small>
                        ) : null}
                      </div>
                    </div>
                    <div className="panel-connections-row-actions">
                      {(!unified ||
                        (!panel.pendingLeave &&
                          (unavailable ||
                            panel.connectionState === "connecting" ||
                            panel.signedIn === undefined))) && (
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
                      {unified && !panel.pendingLeave && !panel.signedIn && (
                        <button
                          className="btn"
                          disabled={Boolean(busy)}
                          aria-label={`Sign in to ${panel.label}`}
                          onClick={() => {
                            cancelSignIn();
                            setSigningIn(panel.id);

                            setError("");
                          }}
                        >
                          <LogIn size={15} />
                          Sign in
                        </button>
                      )}
                      {unified &&
                        !panel.pendingLeave &&
                        panel.signedIn === true && (
                          <button
                            className="btn"
                            disabled={Boolean(busy)}
                            aria-label={`Sign out of ${panel.label}`}
                            onClick={() => {
                              cancelSignIn();
                              setSigningOut({
                                id: panel.id,
                                label: panel.label,
                              });
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
                        aria-label={`${removeSaved ? "Remove saved connection to" : unified && panel.pendingLeave ? "Retry Forget" : "Forget"} ${panel.label}`}
                        onClick={() => {
                          cancelSignIn();
                          setForget({
                            id: panel.id,
                            label: panel.label,
                            mode: removeSaved ? "saved" : "account",
                            sessionEpoch: panel.sessionEpoch,
                            accountId:
                              panel.session?.accountId ?? panel.session?.userId,
                            email: panel.session?.email,
                          });
                          setError("");
                        }}
                      >
                        <Trash2 size={15} />{" "}
                        {removeSaved
                          ? "Remove saved connection"
                          : unified && panel.pendingLeave
                            ? "Retry Forget"
                            : "Forget"}
                      </button>
                    </div>
                    {unified &&
                      !panel.pendingLeave &&
                      signingIn === panel.id && (
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
                          <button className="btn" onClick={cancelSignIn}>
                            Cancel sign-in
                          </button>
                        </div>
                      )}
                  </li>
                );
              })}
            </ul>
          )}
          {unified && onSignIn && !signingIn && (
            <div className="panel-connections-entry">
              <button
                className="btn primary"
                type="button"
                disabled={Boolean(busy)}
                onClick={onSignIn}
              >
                <LogIn size={16} /> Sign in
              </button>
            </div>
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
