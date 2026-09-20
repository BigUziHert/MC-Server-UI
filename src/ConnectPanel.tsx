import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Globe2,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";
import { api } from "./api";
import "./desktop-connections";
import "./connect-panel.css";

export type ConnectionMode = "signin" | "invitation";

export default function ConnectPanel({
  desktop,
  initialMode = "signin",
  onClose,
  onOpened,
}: {
  desktop: boolean;
  initialMode?: ConnectionMode;
  onClose: () => void;
  onOpened: () => void;
}) {
  const inDesktop = desktop || Boolean(window.mcPanelConnections);
  const dialog = useRef<HTMLDialogElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const pending = useRef(false);
  const [mode, setMode] = useState(initialMode);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    active.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    addressInput.current?.focus();
    return () => {
      active.current = false;
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  let destination = "";
  try {
    destination = new URL(normalizePanelConnectionUrl(address)).host;
  } catch {
    // Only preview destinations after the whole address has passed validation.
  }
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    setError("");
    let url: string;
    try {
      url = normalizePanelConnectionUrl(address);
      if (mode === "invitation" && !new URL(url).hash)
        throw new Error(
          "Paste the complete invitation link from the panel owner.",
        );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Enter a valid panel address.",
      );
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      if (window.mcPanelConnections) {
        await window.mcPanelConnections.open(url);
        if (active.current) onOpened();
      } else if (desktop) {
        await api("/desktop/connections/open", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        if (active.current) onOpened();
      } else {
        // Credentials are entered only on the destination panel's own origin.
        // Native desktop connections keep isolated sessions in the same window.
        window.location.assign(url);
      }
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The panel could not be opened. Try again.",
        );
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="connect-panel"
      aria-labelledby="connect-panel-title"
      aria-describedby="connect-panel-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <button
        type="button"
        className="btn icon connect-panel-close"
        aria-label="Close connection dialog"
        disabled={busy}
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <span className="connect-panel-icon">
        <Globe2 size={26} />
      </span>
      <p className="connect-panel-eyebrow">REMOTE PANEL</p>
      <h2 id="connect-panel-title">
        {mode === "invitation" ? "Accept an invitation" : "Connect to a panel"}
      </h2>
      <p id="connect-panel-description">
        {mode === "invitation"
          ? "Use the owner's invitation to create your account and choose a password on their panel."
          : "Enter a panel address, then sign in with the account its owner invited."}
      </p>
      <div
        className="connect-panel-modes"
        role="group"
        aria-label="Connection method"
      >
        <button
          type="button"
          aria-pressed={mode === "signin"}
          disabled={busy}
          onClick={() => {
            setMode("signin");
            setError("");
          }}
        >
          <Globe2 size={15} /> Sign in
        </button>
        <button
          type="button"
          aria-pressed={mode === "invitation"}
          disabled={busy}
          onClick={() => {
            setMode("invitation");
            setError("");
          }}
        >
          <KeyRound size={15} /> Use invitation
        </button>
      </div>
      <form onSubmit={connect}>
        <label htmlFor="connect-panel-address">
          Panel address or invitation link
        </label>
        <input
          ref={addressInput}
          id="connect-panel-address"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          maxLength={2048}
          placeholder={
            mode === "invitation"
              ? "https://panel.example.com/#invite=…"
              : "https://panel.example.com:3002"
          }
          value={address}
          disabled={busy}
          aria-invalid={Boolean(error)}
          aria-describedby={`connect-panel-hint${error ? " connect-panel-error" : ""}`}
          onChange={(event) => {
            setAddress(event.target.value);
            setError("");
          }}
        />
        <p id="connect-panel-hint" className="connect-panel-hint">
          Use the panel's HTTPS address. This is separate from the address used
          to join Minecraft.
        </p>
        {error && (
          <p
            id="connect-panel-error"
            className="connect-panel-error"
            role="alert"
          >
            {error}
          </p>
        )}
        {destination && (
          <p className="connect-panel-destination">
            <ShieldCheck size={15} />
            <span>
              You'll sign in at <strong>{destination}</strong>.
            </span>
          </p>
        )}
        <div className="connect-panel-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <ArrowRight size={17} />
            )}
            {mode === "invitation"
              ? "Continue with invitation"
              : "Continue to sign in"}
          </button>
        </div>
      </form>
      <p className="connect-panel-note">
        {inDesktop
          ? "Switch between this computer and connected panels in the account menu."
          : "The panel opens in this tab."}{" "}
        Your local servers keep running.
      </p>
    </dialog>
  );
}
