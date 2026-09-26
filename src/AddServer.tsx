import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  FolderOpen,
  Plus,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { api, post } from "./api";
import type { ServerRecord } from "./ServerManager";
import NewServerWizard from "./NewServerWizard";
import {
  LaunchAdvancedFields,
  LaunchMemoryNote,
  LaunchMethodFields,
  startupDraft,
  startupError,
  startupPayload,
  type LaunchCandidate,
  type LaunchType,
} from "./LaunchSettings";

type Inspection = {
  directory: string;
  name: string;
  port: number;
  motd: string;
  maxPlayers: number;
  jars: string[];
  jar: string | null;
  eulaAccepted: boolean;
  warnings: string[];
  world?: string;
  launches?: LaunchCandidate[];
  launchType?: LaunchType;
  launchScript?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  javaPath?: string;
  memoryLimitMB?: number;
};
type Step = "choice" | "create" | "import";
type Work = "browse" | "inspect" | "import" | null;

export default function AddServer({
  servers,
  initialStep = "choice",
  onClose,
  onSaved,
}: {
  servers: ServerRecord[];
  initialStep?: "choice" | "create" | "import";
  onClose: () => void;
  onSaved: (server: ServerRecord) => void;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [wizardLocked, setWizardLocked] = useState(false);
  const wizardClose = useRef<(() => void) | null>(null);
  const [canBrowse, setCanBrowse] = useState(false);
  const [browseUnavailable, setBrowseUnavailable] = useState(false);
  const [directory, setDirectory] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [importName, setImportName] = useState("");
  const [importStartup, setImportStartup] = useState(() =>
    startupDraft({ jar: "" }),
  );
  const [importPort, setImportPort] = useState("25565");
  const [importMemory, setImportMemory] = useState("4096");
  const [importAdvanced, setImportAdvanced] = useState(false);
  const [work, setWork] = useState<Work>(null);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const choiceButton = useRef<HTMLButtonElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const inspectedName = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  const inspectionRequest = useRef<AbortController | null>(null);
  const locked = wizardLocked || work === "import" || work === "browse";
  const freshInspection = inspection?.directory === directory;
  const portConflict = servers.find(
    (server) => server.port === Number(importPort),
  );
  const validImportLaunch =
    !startupError(importStartup) &&
    (importStartup.launchType !== "jar" ||
      !!inspection?.jars.includes(importStartup.jar));
  const detectedLauncher = inspection?.launches?.find(
    (candidate) => candidate.type === importStartup.launchType,
  );

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const capabilities = new AbortController();
    void api<{ canBrowse: boolean }>("/server-import", {
      signal: capabilities.signal,
    }).then(
      (result) => setCanBrowse(result.canBrowse),
      () => {
        if (!capabilities.signal.aborted) setBrowseUnavailable(true);
      },
    );
    return () => {
      operation.current++;
      capabilities.abort();
      inspectionRequest.current?.abort();
      element?.close();
    };
  }, []);
  useEffect(() => {
    if (dialog.current) dialog.current.scrollTop = 0;
    if (step === "choice") choiceButton.current?.focus();
    if (step === "import") directoryInput.current?.focus();
  }, [step]);
  useEffect(() => {
    if (inspection) inspectedName.current?.focus();
  }, [inspection]);

  function cancelInspection() {
    operation.current++;
    inspectionRequest.current?.abort();
    inspectionRequest.current = null;
  }
  function close() {
    if (locked) return;
    cancelInspection();
    onClose();
  }
  function navigate(next: Step) {
    if (locked) return;
    cancelInspection();
    setWork(null);
    setError("");
    setInspection(null);
    setStep(next);
  }
  function changeDirectory(value: string) {
    cancelInspection();
    setWork(null);
    setDirectory(value);
    setInspection(null);
    setImportStartup(startupDraft({ jar: "" }));
    setError("");
  }

  function settingsError(serverPort: string, serverMemory: string | null) {
    const portNumber = Number(serverPort);
    if (
      !Number.isInteger(portNumber) ||
      portNumber < 1024 ||
      portNumber > 65535
    )
      return "Choose a server port between 1024 and 65535.";
    const conflict = servers.find((server) => server.port === portNumber);
    if (conflict)
      return `Port ${portNumber} is already used by ${conflict.name}. Choose another server port.`;
    const memoryNumber = Number(serverMemory);
    if (
      serverMemory !== null &&
      (!Number.isInteger(memoryNumber) ||
        memoryNumber < 256 ||
        memoryNumber > 262144)
    )
      return "Memory must be a whole number from 256 to 262144 MB.";
    return "";
  }

  async function browse() {
    if (work || !canBrowse) return;
    const request = ++operation.current;
    setWork("browse");
    setError("");
    try {
      const result = await post<{ directory: string | null }>(
        "/server-import/browse",
      );
      if (request !== operation.current) return;
      if (result.directory) {
        setDirectory(result.directory);
        setInspection(null);
        setImportStartup(startupDraft({ jar: "" }));
      }
      directoryInput.current?.focus();
    } catch (cause) {
      if (request === operation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to browse. Enter the server folder path instead.",
        );
    } finally {
      if (request === operation.current) setWork(null);
    }
  }

  async function inspect() {
    if (work || !directory.trim()) return;
    const enteredDirectory = directory.trim();
    const inspectedDirectory =
      enteredDirectory.startsWith('"') && enteredDirectory.endsWith('"')
        ? enteredDirectory.slice(1, -1)
        : enteredDirectory;
    cancelInspection();
    const request = ++operation.current;
    const controller = new AbortController();
    inspectionRequest.current = controller;
    setWork("inspect");
    setError("");
    setInspection(null);
    try {
      const result = await api<Inspection>("/server-import/inspect", {
        method: "POST",
        body: JSON.stringify({ directory: inspectedDirectory }),
        signal: controller.signal,
      });
      if (request !== operation.current) return;
      setDirectory(result.directory);
      setInspection(result);
      setImportName(result.name);
      setImportStartup(
        startupDraft({
          ...result,
          jar: result.jar && result.jars.includes(result.jar) ? result.jar : "",
        }),
      );
      setImportMemory(String(result.memoryLimitMB ?? 4096));
      setImportPort(String(result.port));
      setImportAdvanced(servers.some((server) => server.port === result.port));
    } catch (cause) {
      if (request === operation.current && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to inspect this folder. Check its path and try again.",
        );
    } finally {
      if (request === operation.current) setWork(null);
    }
  }

  async function importServer(event: FormEvent) {
    event.preventDefault();
    if (!inspection || !freshInspection || work) return;
    if (!importName.trim()) {
      setError("Give your server a name.");
      inspectedName.current?.focus();
      return;
    }
    if (!validImportLaunch) {
      setError(startupError(importStartup) || "Choose the server JAR to run.");
      setImportAdvanced(true);
      return;
    }
    const invalid = settingsError(
      importPort,
      importStartup.launchType === "jar" ? importMemory : null,
    );
    if (invalid) {
      setError(invalid);
      setImportAdvanced(true);
      return;
    }
    const request = ++operation.current;
    setWork("import");
    setError("");
    try {
      const result = await post<{ server: ServerRecord }>("/server-import", {
        directory: inspection.directory,
        name: importName.trim(),
        ...startupPayload(importStartup),
        ...(importStartup.launchType === "jar"
          ? { memoryLimitMB: Number(importMemory) }
          : {}),
        port: Number(importPort),
      });
      if (request === operation.current) onSaved(result.server);
    } catch (cause) {
      if (request === operation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to import this server. Check the folder and try again.",
        );
    } finally {
      if (request === operation.current) setWork(null);
    }
  }

  const title =
    step === "choice"
      ? "Add a server"
      : step === "create"
        ? "Create a new server"
        : "Import an existing server";
  return (
    <dialog
      ref={dialog}
      className={`server-dialog server-add-dialog ${step === "choice" ? "server-choice-dialog" : ""} ${step === "create" ? "server-wizard-dialog" : ""}`}
      aria-labelledby="add-server-title"
      onCancel={(event) => {
        event.preventDefault();
        if (step === "create") wizardClose.current?.();
        else close();
      }}
    >
      {step !== "create" && (
        <>
          <div className="server-dialog-top">
            {step === "choice" ? (
              <span className="feature-icon">
                <Box size={23} />
              </span>
            ) : (
              <button
                className="btn server-back-button"
                type="button"
                disabled={locked}
                onClick={() => navigate("choice")}
              >
                <ArrowLeft size={16} /> Back
              </button>
            )}
            <button
              type="button"
              className="btn icon"
              aria-label="Close add server"
              disabled={locked}
              onClick={close}
            >
              <X size={17} />
            </button>
          </div>
          <h2 id="add-server-title">{title}</h2>
          <p className="server-add-intro">
            {step === "choice"
              ? "Start a fresh world or bring the server you already have."
              : "Connect the existing server folder on the computer running MC Panel."}
          </p>
        </>
      )}

      {step === "create" && (
        <NewServerWizard
          servers={servers}
          onBack={() => navigate("choice")}
          onClose={close}
          onSaved={onSaved}
          onLockChange={setWizardLocked}
          closeRequest={wizardClose}
        />
      )}

      {step === "choice" && (
        <>
          <div className="server-add-choices">
            <button
              ref={choiceButton}
              className="server-add-choice"
              type="button"
              aria-label="Create a new server"
              onClick={() => navigate("create")}
            >
              <span className="server-choice-icon">
                <Plus size={22} />
              </span>
              <span>
                <strong>Create a new server</strong>
                <span>Choose server software or a modpack to install.</span>
              </span>
              <ArrowRight size={18} />
            </button>
            <button
              className="server-add-choice"
              type="button"
              aria-label="Import an existing server"
              onClick={() => navigate("import")}
            >
              <span className="server-choice-icon">
                <FolderOpen size={22} />
              </span>
              <span>
                <strong>Import an existing server</strong>
                <span>
                  Use your current world, mods, plugins, and settings.
                </span>
              </span>
              <ArrowRight size={18} />
            </button>
          </div>
          <div className="server-dialog-actions">
            <button className="btn" type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === "import" && (
        <form onSubmit={importServer} noValidate>
          <div className="form-field">
            <label htmlFor="import-directory">Server folder</label>
            <div className="server-import-path">
              <input
                ref={directoryInput}
                id="import-directory"
                value={directory}
                onChange={(event) => changeDirectory(event.target.value)}
                disabled={locked}
                placeholder="C:\Minecraft\My server"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void inspect();
                  }
                }}
              />
              {canBrowse && (
                <button
                  className="btn"
                  type="button"
                  disabled={!!work}
                  onClick={() => void browse()}
                >
                  <FolderOpen size={15} />
                  {work === "browse" ? "Choosing…" : "Browse"}
                </button>
              )}
            </div>
            <small>
              {browseUnavailable ? "Folder browsing is unavailable. " : ""}Enter
              the folder containing your server launcher and existing world. For
              a server on another PC, open MC Panel on that PC and select its
              folder there.
            </small>
          </div>
          <div className="server-import-inspect">
            <button
              className="btn"
              type="button"
              disabled={!!work || !directory.trim()}
              onClick={() => void inspect()}
            >
              <RefreshCw
                size={15}
                className={work === "inspect" ? "spin" : ""}
              />
              {work === "inspect" ? "Inspecting folder…" : "Inspect folder"}
            </button>
            <span>
              {work === "inspect"
                ? "Reading your server settings…"
                : "Checks files without changing them."}
            </span>
          </div>
          {freshInspection && inspection && (
            <div className="server-import-review">
              <div className="server-import-reviewed">
                <Check size={15} />
                <strong>Folder inspected</strong>
                <span>{detectedLauncher?.software || "Minecraft server"}</span>
              </div>
              <div className="server-import-location">
                <FolderOpen size={16} />
                <span>{inspection.directory}</span>
              </div>
              <div className="form-field">
                <label htmlFor="import-server-name">Server name</label>
                <input
                  ref={inspectedName}
                  id="import-server-name"
                  required
                  maxLength={64}
                  value={importName}
                  onChange={(event) => setImportName(event.target.value)}
                  disabled={locked}
                />
              </div>
              <fieldset className="server-config-fields" disabled={locked}>
                <LaunchMethodFields
                  idPrefix="import-server"
                  value={importStartup}
                  onChange={(value) => {
                    setImportStartup(value);
                    if (
                      value.launchType === "java-args" &&
                      !value.launchArgs.trim()
                    )
                      setImportAdvanced(true);
                  }}
                  jars={inspection.jars}
                  candidates={inspection.launches}
                />
              </fieldset>
              {detectedLauncher && importStartup.launchType === "java-args" && (
                <div className="form-field">
                  <label htmlFor="import-detected-launcher">
                    Detected launcher
                  </label>
                  <input
                    id="import-detected-launcher"
                    readOnly
                    value={detectedLauncher.path}
                  />
                  <small>
                    Its Java arguments are ready in Advanced settings. MC Panel
                    starts Java directly using those arguments.
                  </small>
                </div>
              )}
              <LaunchMemoryNote
                type={importStartup.launchType}
                detectedMemory={
                  importStartup.launchType === inspection.launchType
                    ? inspection.memoryLimitMB
                    : undefined
                }
              />
              <div className="server-import-facts">
                {inspection.world && (
                  <span>
                    Existing world <strong>{inspection.world}</strong>
                  </span>
                )}
                <span>
                  Detected port <strong>{inspection.port}</strong>
                </span>
                <span>
                  {inspection.eulaAccepted ? (
                    <Check size={13} />
                  ) : (
                    <AlertCircle size={13} />
                  )}
                  {inspection.eulaAccepted
                    ? "EULA already accepted"
                    : "EULA not accepted yet"}
                </span>
              </div>
              {inspection.warnings.length > 0 && (
                <ul className="server-import-warnings">
                  {inspection.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}
              {portConflict && (
                <p className="server-import-port-warning">
                  <AlertCircle size={15} />
                  Port {importPort} is used by {portConflict.name}. Choose
                  another port below.
                </p>
              )}
              <details
                className="server-advanced"
                open={importAdvanced}
                onToggle={(event) =>
                  setImportAdvanced(event.currentTarget.open)
                }
              >
                <summary>
                  <Settings2 size={15} /> Advanced settings{" "}
                  <ChevronDown size={15} />
                </summary>
                <fieldset
                  className="server-config-fields server-advanced-fields"
                  disabled={locked}
                >
                  <div className="server-form-grid">
                    <div className="form-field">
                      <label htmlFor="import-server-port">Server port</label>
                      <input
                        id="import-server-port"
                        type="number"
                        required
                        min={1024}
                        max={65535}
                        value={importPort}
                        onChange={(event) => setImportPort(event.target.value)}
                      />
                    </div>
                    {importStartup.launchType === "jar" && (
                      <div className="form-field">
                        <label htmlFor="import-server-memory">
                          Memory (MB)
                        </label>
                        <input
                          id="import-server-memory"
                          type="number"
                          required
                          min={256}
                          max={262144}
                          value={importMemory}
                          onChange={(event) =>
                            setImportMemory(event.target.value)
                          }
                        />
                      </div>
                    )}
                  </div>
                  <p className="server-advanced-hint">
                    A port change is applied to server.properties when you next
                    start this server.
                  </p>
                  <LaunchAdvancedFields
                    idPrefix="import-server"
                    value={importStartup}
                    onChange={setImportStartup}
                  />
                </fieldset>
              </details>
            </div>
          )}
          <div className="server-setup-note server-import-preservation">
            <FolderOpen size={18} />
            <p>
              Your world, mods, plugins, and configuration stay in their
              original folder. Backups and panel settings are stored separately.
            </p>
          </div>
          <p className="server-import-start-note">
            Stop the server in its current launcher before importing. Importing
            does not start it or change its EULA.
          </p>
          {!inspection && (
            <p className="server-import-hosted-hint">
              Moving from a hosting provider? Download and extract your server
              files first, then choose that folder.
            </p>
          )}
          {error && (
            <div className="server-form-error" role="alert">
              <AlertCircle size={16} />
              {error}
            </div>
          )}
          <div className="server-dialog-actions">
            <button
              type="button"
              className="btn"
              disabled={locked}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={
                !!work ||
                !freshInspection ||
                !validImportLaunch ||
                !importName.trim() ||
                !!portConflict
              }
            >
              <FolderOpen size={15} />
              {work === "import" ? "Importing…" : "Import server"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
