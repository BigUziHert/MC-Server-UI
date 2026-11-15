import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, LoaderCircle, X } from "lucide-react";
import { usePanelApi } from "./api";
import {
  LaunchMethodFields,
  LaunchAdvancedFields,
  startupDraft,
  startupError,
  startupPayload,
  type LaunchCandidate,
  type LaunchType,
} from "./LaunchSettings";
import type { ServerRecord } from "./ServerManager";

type Candidate = { id: string; name: string; directory: string };
type Inspection = {
  id: string;
  name: string;
  revision: string;
  serverDir: string;
  port: number;
  motd: string;
  memoryLimitMB?: number;
  jar: string | null;
  jars: string[];
  javaPath?: string;
  launchType?: LaunchType;
  launchScript?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  launches?: LaunchCandidate[];
  warnings?: string[];
  accessGrants: { id: string; email: string }[];
};

export default function RecoverServerDialog({
  onBack,
  onClose,
  onSaved,
}: {
  onBack: () => void;
  onClose: () => void;
  onSaved: (server: ServerRecord) => void;
}) {
  const { api } = usePanelApi();
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [name, setName] = useState("");
  const [port, setPort] = useState("25565");
  const [memory, setMemory] = useState("4096");
  const [startup, setStartup] = useState(() => startupDraft());
  const [restoreGrants, setRestoreGrants] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    return () => {
      alive.current = false;
      dialog.current?.close();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<{ candidates: Candidate[]; warnings: string[] }>(
      "/server-recovery",
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setCandidates(result.candidates);
          setWarnings(result.warnings);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, attempt]);
  async function inspect(id: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<Inspection>(
        `/server-recovery/${encodeURIComponent(id)}`,
      );
      if (!alive.current) return;
      setInspection(result);
      setName(result.name);
      setPort(String(result.port));
      setMemory(String(result.memoryLimitMB ?? 4096));
      setStartup(startupDraft({ ...result, jar: result.jar ?? "" }));
      setRestoreGrants([]);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to inspect this saved server.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function recover(event: FormEvent) {
    event.preventDefault();
    if (busy || !inspection) return;
    const invalid = startupError(startup);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ server: ServerRecord }>(
        `/server-recovery/${encodeURIComponent(inspection.id)}`,
        {
          method: "POST",
          body: JSON.stringify({
            confirmed: true,
            revision: inspection.revision,
            restoreGrants,
            name: name.trim(),
            mode: "live",
            port: Number(port),
            motd: inspection.motd,
            memoryLimitMB: Number(memory),
            ...startupPayload(startup),
          }),
        },
      );
      if (alive.current) onSaved(result.server);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to recover this server. Inspect it again before retrying.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="server-dialog server-add-dialog"
      aria-labelledby="recover-server-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={recover}>
        <div className="server-dialog-top">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => (inspection ? setInspection(null) : onBack())}
          >
            <ArrowLeft size={16} /> Back
          </button>
          <button
            type="button"
            className="btn icon"
            disabled={busy}
            aria-label="Close server recovery"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <h2 id="recover-server-title">Recover a removed server</h2>
        <p>
          Find managed server folders retained on this computer. Recovery keeps
          their files, backups and Recycle Bin, and leaves the server stopped.
        </p>
        {loading ? (
          <p role="status">Looking for saved servers...</p>
        ) : !inspection ? (
          <>
            {!candidates.length && !error && (
              <p>
                No removed managed servers were found. Use Import for a server
                in another folder.
              </p>
            )}
            {candidates.map((candidate) => (
              <div className="form-field" key={candidate.id}>
                <strong>{candidate.name}</strong>
                <code>{candidate.directory}</code>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void inspect(candidate.id)}
                >
                  Review {candidate.name}
                </button>
              </div>
            ))}
            {warnings.map((warning) => (
              <p key={warning} role="note">
                {warning}
              </p>
            ))}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Check again
            </button>
          </>
        ) : (
          <fieldset disabled={busy} className="setup-connection-fields">
            <div className="form-field">
              <label htmlFor="recover-name">Server name</label>
              <input
                id="recover-name"
                required
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="recover-folder">Saved server folder</label>
              <input
                id="recover-folder"
                readOnly
                value={inspection.serverDir}
              />
            </div>
            <LaunchMethodFields
              idPrefix="recover"
              value={startup}
              onChange={setStartup}
              jars={inspection.jars}
              candidates={inspection.launches}
            />
            <div className="form-field">
              <label htmlFor="recover-port">Minecraft port</label>
              <input
                id="recover-port"
                type="number"
                min={1024}
                max={65535}
                required
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="recover-memory">Memory limit (MB)</label>
              <input
                id="recover-memory"
                type="number"
                min={128}
                max={262144}
                required
                value={memory}
                onChange={(event) => setMemory(event.target.value)}
              />
            </div>
            <details>
              <summary>Advanced launch options</summary>
              <LaunchAdvancedFields
                idPrefix="recover"
                value={startup}
                onChange={setStartup}
              />
            </details>
            {inspection.warnings?.map((warning) => (
              <p role="note" key={warning}>
                {warning}
              </p>
            ))}
            <fieldset>
              <legend>Restore shared access</legend>
              <p>
                No previous access is restored automatically. Select only people
                who should regain access to this server.
              </p>
              {inspection.accessGrants?.length ? (
                inspection.accessGrants.map((person) => (
                  <label className="subusers-clean-confirm" key={person.id}>
                    <input
                      type="checkbox"
                      checked={restoreGrants.includes(person.id)}
                      onChange={(event) =>
                        setRestoreGrants(
                          event.target.checked
                            ? [...restoreGrants, person.id]
                            : restoreGrants.filter((id) => id !== person.id),
                        )
                      }
                    />
                    {person.email}
                  </label>
                ))
              ) : (
                <p>No saved shared grants were found.</p>
              )}
            </fieldset>
            <button
              type="button"
              className="btn"
              onClick={() => void inspect(inspection.id)}
            >
              Inspect again
            </button>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="server-form-error">
            {error}
          </p>
        )}
        <div className="server-dialog-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          {inspection && (
            <button
              className="btn primary"
              disabled={busy || !!startupError(startup)}
            >
              {busy && <LoaderCircle size={16} className="spin" />}Recover
              server
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
