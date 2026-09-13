import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Camera, Upload, X } from "lucide-react";
import { useServerApi } from "./api";
import "./server-icon.css";

export function ServerIconImage({
  version,
  name,
  className = "",
}: {
  version?: string | null;
  name: string;
  className?: string;
}) {
  const { downloadUrl } = useServerApi();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [version, name]);
  return version && !failed ? (
    <img
      className={`server-icon-image ${className}`}
      src={downloadUrl(`/server/icon?v=${encodeURIComponent(version)}`)}
      alt={`${name} server icon`}
      onError={() => setFailed(true)}
    />
  ) : (
    <span className={`pixel-world ${className}`} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} />
      ))}
    </span>
  );
}

export default function ServerIcon({
  version,
  serverVersion,
  name,
  onSaved,
}: {
  version?: string | null;
  serverVersion?: string | null;
  name: string;
  onSaved: () => Promise<void>;
}) {
  const { api, post, downloadUrl } = useServerApi();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [preference, setPreference] = useState<"default" | "server" | null>(
    null,
  );
  const availableVersion = serverVersion ?? version;
  const previewVersion =
    preference === "default"
      ? null
      : preference === "server"
        ? availableVersion
        : version;
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  function close() {
    if (!busy && !reading) setOpen(false);
  }
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (
      !/^image\/(png|jpeg|webp)$/.test(file.type) ||
      file.size > 10 * 1024 ** 2
    ) {
      setError("Choose a PNG, JPEG, or WebP image under 10 MB.");
      return;
    }
    const id = ++request.current;
    setReading(true);
    setError("");
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not prepare this image.");
        const size = Math.min(bitmap.width, bitmap.height);
        context.drawImage(
          bitmap,
          (bitmap.width - size) / 2,
          (bitmap.height - size) / 2,
          size,
          size,
          0,
          0,
          64,
          64,
        );
        if (id === request.current) {
          setDraft(canvas.toDataURL("image/png"));
          setPreference(null);
        }
      } finally {
        bitmap.close();
      }
    } catch {
      if (id === request.current)
        setError("This image could not be opened. Try another image.");
    } finally {
      if (id === request.current) setReading(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (preference === "default")
        await api("/server/icon", { method: "DELETE" });
      else if (draft) await post("/server/icon", { image: draft });
      else if (preference === "server")
        await api("/server/icon", {
          method: "PUT",
          body: JSON.stringify({ preference: "server" }),
        });
      await onSaved();
      setOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save the icon.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="world-icon editable-server-icon"
        aria-label="Edit server icon"
        title="Edit server icon"
        onClick={() => {
          setDraft(null);
          setError("");
          setPreference(null);
          setOpen(true);
        }}
      >
        <ServerIconImage version={version} name={name} />
        <Camera className="server-icon-camera" size={14} />
      </button>
      <dialog
        ref={dialog}
        className="icon-dialog"
        aria-labelledby="icon-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className="icon-dialog-heading">
          <h2 id="icon-dialog-title">Server icon</h2>
          <button
            className="btn icon"
            aria-label="Close server icon"
            disabled={busy || reading}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          Choose the icon for {name}. Your image is cropped to a square and
          resized to 64 × 64.
        </p>
        <div className="icon-editor-preview">
          {draft || previewVersion ? (
            <img
              src={
                draft ||
                downloadUrl(
                  `/server/icon?v=${encodeURIComponent(previewVersion!)}`,
                )
              }
              alt="Server icon preview"
            />
          ) : (
            <ServerIconImage name={name} />
          )}
        </div>
        <label className="btn icon-upload">
          <Upload size={16} />
          Choose image
          <input
            aria-label="Choose server icon image"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy || reading}
            onChange={(event) => void choose(event)}
          />
        </label>
        {reading && <p role="status">Preparing image…</p>}
        <p className="icon-save-note">
          Uploaded images replace server-icon.png in this server’s folder.
          Minecraft’s server list uses an uploaded icon after a server restart.
        </p>
        {preference === "default" && (
          <p className="icon-save-note">
            Saving changes only the panel display. Your server-icon.png file is
            kept, and Minecraft continues using it.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="icon-dialog-actions">
          {(availableVersion || draft) && (
            <button
              className="btn"
              disabled={busy || reading}
              onClick={() => {
                setPreference("default");
                setDraft(null);
              }}
            >
              Use default icon
            </button>
          )}
          {availableVersion &&
            (!version || preference === "default" || draft) && (
              <button
                className="btn"
                disabled={busy || reading}
                onClick={() => {
                  setPreference("server");
                  setDraft(null);
                }}
              >
                Use server icon
              </button>
            )}
          <button
            className="btn primary"
            disabled={busy || reading || (!draft && !preference)}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save icon"}
          </button>
        </div>
      </dialog>
    </>
  );
}
