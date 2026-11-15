import { useSetupDrafts, removeSetupDraft } from "./setup-drafts";
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
import { usePanelApi } from "./api";
import type { ServerRecord } from "./ServerManager";
import NewServerWizard from "./NewServerWizard";
import HostDirectoryPicker from "./HostDirectoryPicker";
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
type Work = "inspect" | "import" | null;

export default function AddServer({
  servers,
  initialStep = "choice",
  remoteHost,
  remoteUnavailable = false,
  onReconnect,
  onChangeHost,
  onRecover,
  onClose,
  onSaved,
}: {
  servers: ServerRecord[];
  initialStep?: "choice" | "create" | "import";
  remoteHost?: string;
  remoteUnavailable?: boolean;
  onReconnect?: () => void;
  onChangeHost?: () => void;
  onRecover?: () => void;
  onClose: () => void;
  onSaved: (server: ServerRecord, outcome?: { incomplete?: boolean }) => void;
}) {
  const { api, post } = usePanelApi();
  const { scope: setupScope, drafts: setupDrafts } = useSetupDrafts();
  const [resumeDraftId, setResumeDraftId] = useState<string>();
  const [discardDraftId, setDiscardDraftId] = useState<string>();
  const [step, setStep] = useState<Step>(initialStep);
  const [wizardLocked, setWizardLocked] = useState(false);
  const [background, setBackground] = useState(false);
  const wizardClose = useRef<(() => void) | null>(null);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [directory, setDirectory] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [acceptedEula, setAcceptedEula] = useState(false);
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
  const browseButton = useRef<HTMLButtonElement>(null);
  const inspectedName = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  const inspectionRequest = useRef<AbortController | null>(null);
  const importRequest = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  const locked = wizardLocked || work === "import";
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
    return () => {
      operation.current++;
      inspectionRequest.current?.abort();
      element?.close();
    };
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (background) element?.close();
    else if (element && !element.open) element.showModal();
  }, [background]);
  useEffect(() => {
    const resume = () => setBackground(false);
    window.addEventListener("mc-panel-resume-setup", resume);
    return () => window.removeEventListener("mc-panel-resume-setup", resume);
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
    if (folderBrowserOpen) {
      setFolderBrowserOpen(false);
      browseButton.current?.focus();
      return;
    }
    cancelInspection();
    onClose();
  }
  function navigate(next: Step) {
    if (locked) return;
    cancelInspection();
    setWork(null);
    setError("");
    setInspection(null);
    setAcceptedEula(false);
    setFolderBrowserOpen(false);
    setStep(next);
  }
  function changeDirectory(value: string) {
    cancelInspection();
    setWork(null);
    setDirectory(value);
    setInspection(null);
    setAcceptedEula(false);
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

  function browse() {
    if (work) return;
    setError("");
    setFolderBrowserOpen(true);
  }

  async function inspect() {
    if (work || folderBrowserOpen || !directory.trim()) return;
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
    setAcceptedEula(false);
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
    if (!inspection || !freshInspection || work || folderBrowserOpen) return;
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
      const settings = {
        directory: inspection.directory,
        acceptedEula,
        name: importName.trim(),
        ...startupPayload(importStartup),
        ...(importStartup.launchType === "jar"
          ? { memoryLimitMB: Number(importMemory) }
          : {}),
        port: Number(importPort),
      };
      const fingerprint = JSON.stringify(settings);
      if (importRequest.current?.fingerprint !== fingerprint)
        importRequest.current = { fingerprint, id: crypto.randomUUID() };
      const result = await post<{ server: ServerRecord }>("/server-import", {
        ...settings,
        ...(acceptedEula ? { acceptedEula: true } : {}),
        requestId: importRequest.current.id,
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
    <>
      {background && (
        <div className="setup-background" role="status">
          <span>
            Server setup {wizardLocked ? "is running" : "needs your attention"}{" "}
            on {remoteHost || "this computer"}.
          </span>
          <button
            className="btn primary"
            type="button"
            onClick={() => setBackground(false)}
          >
            Return to setup
          </button>
        </div>
      )}
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
        {remoteUnavailable && (
          <div className="server-form-error" role="alert">
            <p>
              Connection to {remoteHost} was interrupted. Your setup is kept
              here. Reconnect to check its progress before continuing.
            </p>
            <button type="button" className="btn" onClick={onReconnect}>
              Reconnect
            </button>
          </div>
        )}
        <fieldset
          disabled={remoteUnavailable}
          className="setup-connection-fields"
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
              {
                <p className="setup-host-context">
                  Computer: <strong>{remoteHost || "This computer"}</strong>{" "}
                  {onChangeHost && !locked && (
                    <button
                      className="btn"
                      type="button"
                      onClick={onChangeHost}
                    >
                      Change computer
                    </button>
                  )}
                </p>
              }
              <p className="server-add-intro">
                {step === "choice"
                  ? "Start a fresh world or bring the server you already have."
                  : "Connect the existing server folder on the computer running MC Panel."}
              </p>
            </>
          )}

          {step === "create" && (
            <NewServerWizard
              key={resumeDraftId || "new"}
              resumeDraftId={resumeDraftId}
              servers={servers}
              remoteHost={remoteHost}
              onBack={() => navigate("choice")}
              onClose={close}
              onSaved={onSaved}
              onLockChange={setWizardLocked}
              closeRequest={wizardClose}
              onBackground={() => setBackground(true)}
              onChangeHost={onChangeHost}
            />
          )}

          {step === "choice" && (
            <>
              {setupDrafts.length > 0 && (
                <section
                  aria-label="Unfinished server setups"
                  className="management-notice warning"
                >
                  <div>
                    <strong>Finish setup</strong>
                    <p>
                      Saved on this device for seven days. Resuming uses the
                      same server and original request IDs.
                    </p>
                    {setupDrafts.map((draft) => (
                      <div key={draft.id}>
                        <button
                          className="btn"
                          onClick={() => {
                            setResumeDraftId(draft.id);
                            navigate("create");
                          }}
                        >
                          Resume setup: {draft.name}
                        </button>
                        <button
                          className="btn"
                          aria-label={`Discard setup draft: ${draft.name}`}
                          onClick={() => {
                            if (discardDraftId === draft.id) {
                              removeSetupDraft(setupScope, draft.id);
                              setDiscardDraftId(undefined);
                            } else setDiscardDraftId(draft.id);
                          }}
                        >
                          {discardDraftId === draft.id
                            ? "Confirm discard draft"
                            : "Discard draft"}
                        </button>
                        {discardDraftId === draft.id && (
                          <p>
                            Only the saved instructions will be removed. The
                            server and its files stay available.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <div className="server-add-choices">
                <button
                  ref={choiceButton}
                  className="server-add-choice"
                  type="button"
                  aria-label="Create a new server"
                  onClick={() => {
                    setResumeDraftId(undefined);
                    navigate("create");
                  }}
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

          {step === "choice" && onRecover && (
            <button type="button" className="btn" onClick={onRecover}>
              <RefreshCw size={16} /> Recover a removed server
            </button>
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
                    disabled={locked || folderBrowserOpen}
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
                  <button
                    ref={browseButton}
                    className="btn"
                    type="button"
                    disabled={!!work}
                    onClick={browse}
                  >
                    <FolderOpen size={15} />
                    Browse
                  </button>
                </div>
                {folderBrowserOpen && (
                  <HostDirectoryPicker
                    purpose="import"
                    remoteHost={remoteHost}
                    initialDirectory={directory}
                    onClose={() => {
                      setFolderBrowserOpen(false);
                      browseButton.current?.focus();
                    }}
                    onSelect={(selected) => {
                      changeDirectory(selected);
                      setFolderBrowserOpen(false);
                      browseButton.current?.focus();
                    }}
                  />
                )}
                <small>
                  Choose the folder containing your server launcher and existing
                  world on{" "}
                  {remoteHost
                    ? "the connected server PC"
                    : "the computer running MC Panel"}
                  .
                </small>
              </div>
              <div className="server-import-inspect">
                <button
                  className="btn"
                  type="button"
                  disabled={!!work || folderBrowserOpen || !directory.trim()}
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
                    <span>
                      {detectedLauncher?.software || "Minecraft server"}
                    </span>
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
                  {detectedLauncher &&
                    importStartup.launchType === "java-args" && (
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
                          Its Java arguments are ready in Advanced settings. MC
                          Panel starts Java directly using those arguments.
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
                  {!inspection.eulaAccepted && (
                    <label className="server-import-eula">
                      <input
                        type="checkbox"
                        checked={acceptedEula}
                        disabled={locked}
                        onChange={(event) =>
                          setAcceptedEula(event.target.checked)
                        }
                      />
                      I agree to the{" "}
                      <a
                        href="https://www.minecraft.net/eula"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Minecraft EULA
                      </a>{" "}
                      for this server.
                    </label>
                  )}
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
                          <label htmlFor="import-server-port">
                            Server port
                          </label>
                          <input
                            id="import-server-port"
                            type="number"
                            required
                            min={1024}
                            max={65535}
                            value={importPort}
                            onChange={(event) =>
                              setImportPort(event.target.value)
                            }
                          />
                        </div>
                        {importStartup.launchType === "jar" && (
                          <div className="form-field">
                            <label htmlFor="import-server-memory">
                              Memory (GB)
                            </label>
                            <input
                              id="import-server-memory"
                              type="number"
                              required
                              min={0.25}
                              max={256}
                              step="any"
                              value={Number(importMemory) / 1024}
                              onChange={(event) =>
                                setImportMemory(
                                  String(Number(event.target.value) * 1024),
                                )
                              }
                            />
                          </div>
                        )}
                      </div>
                      <p className="server-advanced-hint">
                        A port change is applied to server.properties when you
                        next start this server.
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
                  original folder. Backups and panel settings are stored
                  separately.
                </p>
              </div>
              <p className="server-import-start-note">
                Stop the server in its current launcher before importing.
                Importing does not start it or change its EULA.
              </p>
              {!inspection && (
                <p className="server-import-hosted-hint">
                  Moving from a hosting provider? Download and extract your
                  server files first, then choose that folder.
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
                    folderBrowserOpen ||
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
        </fieldset>
      </dialog>
    </>
  );
}
