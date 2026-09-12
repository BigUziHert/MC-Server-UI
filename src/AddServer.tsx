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
};
type Step = "choice" | "create" | "import";
type Work = "browse" | "inspect" | "create" | "import" | null;

export default function AddServer({
  servers,
  onClose,
  onSaved,
}: {
  servers: ServerRecord[];
  onClose: () => void;
  onSaved: (server: ServerRecord) => void;
}) {
  let nextPort = 25565;
  while (servers.some((server) => server.port === nextPort)) nextPort++;
  const [step, setStep] = useState<Step>("choice");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"live" | "demo">("live");
  const [port, setPort] = useState(String(nextPort));
  const [memory, setMemory] = useState("4096");
  const [jar, setJar] = useState("server.jar");
  const [javaPath, setJavaPath] = useState("java");
  const [motd, setMotd] = useState("Welcome to our Minecraft server");
  const [advanced, setAdvanced] = useState(false);
  const [canBrowse, setCanBrowse] = useState(false);
  const [browseUnavailable, setBrowseUnavailable] = useState(false);
  const [directory, setDirectory] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [importName, setImportName] = useState("");
  const [importJar, setImportJar] = useState("");
  const [importPort, setImportPort] = useState("25565");
  const [importMemory, setImportMemory] = useState("4096");
  const [importJava, setImportJava] = useState("java");
  const [importAdvanced, setImportAdvanced] = useState(false);
  const [work, setWork] = useState<Work>(null);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const choiceButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const inspectedName = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  const inspectionRequest = useRef<AbortController | null>(null);
  const locked = work === "create" || work === "import" || work === "browse";
  const freshInspection = inspection?.directory === directory;
  const portConflict = servers.find(
    (server) => server.port === Number(importPort),
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
    if (step === "create") nameInput.current?.focus();
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
    setImportJar("");
    setError("");
  }

  function settingsError(
    serverPort: string,
    serverMemory: string,
    executable: string,
  ) {
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
      !Number.isInteger(memoryNumber) ||
      memoryNumber < 256 ||
      memoryNumber > 262144
    )
      return "Memory must be a whole number from 256 to 262144 MB.";
    if (!executable.trim())
      return "Enter java or the full path to your Java executable.";
    return "";
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (work) return;
    const invalid = settingsError(
      port,
      memory,
      mode === "live" ? javaPath : "java",
    );
    if (!name.trim()) {
      setError("Give your server a name.");
      nameInput.current?.focus();
      return;
    }
    if (invalid || (mode === "live" && !jar.trim())) {
      setError(
        invalid || "Enter the filename of the server JAR you will upload.",
      );
      setAdvanced(true);
      return;
    }
    const request = ++operation.current;
    setWork("create");
    setError("");
    try {
      const result = await post<{ server: ServerRecord }>("/servers", {
        name: name.trim(),
        mode,
        port: Number(port),
        memoryLimitMB: Number(memory),
        jar: jar.trim() || "server.jar",
        javaPath: javaPath.trim(),
        motd,
      });
      if (request === operation.current) onSaved(result.server);
    } catch (cause) {
      if (request === operation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to create the server.",
        );
    } finally {
      if (request === operation.current) setWork(null);
    }
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
        setImportJar("");
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
      setImportJar(
        result.jar && result.jars.includes(result.jar) ? result.jar : "",
      );
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
    if (!importJar || !inspection.jars.includes(importJar)) {
      setError("Choose the server JAR to run.");
      return;
    }
    const invalid = settingsError(importPort, importMemory, importJava);
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
        jar: importJar,
        javaPath: importJava.trim(),
        memoryLimitMB: Number(importMemory),
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
      className={`server-dialog server-add-dialog ${step === "choice" ? "server-choice-dialog" : ""}`}
      aria-labelledby="add-server-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
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
          : step === "create"
            ? "Give your server a name. You can add its files next."
            : "Connect a server folder on this computer, right where it is."}
      </p>

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
                <span>A fresh folder for a new Minecraft world.</span>
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
                <span>Use your current world, plugins, and settings.</span>
              </span>
              <ArrowRight size={18} />
            </button>
          </div>
          <p className="server-choice-hint">
            Your servers stay on your computer. Manage them together in one
            panel.
          </p>
          <div className="server-dialog-actions">
            <button className="btn" type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === "create" && (
        <form onSubmit={create} noValidate>
          <div className="form-field">
            <label htmlFor="new-server-name">Server name</label>
            <input
              ref={nameInput}
              id="new-server-name"
              required
              maxLength={64}
              placeholder="Survival with friends"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={locked}
            />
          </div>
          <div className="form-field">
            <label htmlFor="new-server-mode">Mode</label>
            <select
              id="new-server-mode"
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as "live" | "demo")
              }
              disabled={locked}
            >
              <option value="live">Minecraft Java</option>
              <option value="demo">Demo server</option>
            </select>
          </div>
          <div className="server-create-defaults">
            <Box size={16} />
            <span>
              {mode === "live"
                ? `${Number(memory) / 1024} GB memory`
                : "Simulated console"}
              <span>·</span>Port {port || "—"}
            </span>
          </div>
          <details
            className="server-advanced"
            open={advanced}
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
          >
            <summary>
              <Settings2 size={15} /> Advanced settings{" "}
              <ChevronDown size={15} />
            </summary>
            <fieldset
              disabled={locked}
              className="server-config-fields server-advanced-fields"
            >
              <div className="server-form-grid">
                <div className="form-field">
                  <label htmlFor="new-server-port">Server port</label>
                  <input
                    id="new-server-port"
                    type="number"
                    required
                    min={1024}
                    max={65535}
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="new-server-memory">Memory (MB)</label>
                  <input
                    id="new-server-memory"
                    type="number"
                    required
                    min={256}
                    max={262144}
                    value={memory}
                    onChange={(event) => setMemory(event.target.value)}
                  />
                </div>
              </div>
              {mode === "live" && (
                <>
                  <div className="form-field">
                    <label htmlFor="new-server-jar">Server JAR</label>
                    <input
                      id="new-server-jar"
                      required
                      value={jar}
                      onChange={(event) => setJar(event.target.value)}
                    />
                    <small>The filename you will upload in File Manager.</small>
                  </div>
                  <div className="form-field">
                    <label htmlFor="new-server-java">Java executable</label>
                    <input
                      id="new-server-java"
                      required
                      value={javaPath}
                      onChange={(event) => setJavaPath(event.target.value)}
                    />
                    <small>
                      Use java from PATH or the full path to your Java
                      executable.
                    </small>
                  </div>
                </>
              )}
              <div className="form-field">
                <label htmlFor="new-server-motd">
                  Server list message (MOTD)
                </label>
                <input
                  id="new-server-motd"
                  maxLength={160}
                  value={motd}
                  onChange={(event) => setMotd(event.target.value)}
                />
              </div>
            </fieldset>
          </details>
          <div className="server-setup-note">
            <Box size={17} />
            <p>
              {mode === "demo"
                ? "Console and player actions are simulated. Files and backups use real local storage."
                : "After creating, upload your server JAR and accept the Minecraft EULA before starting. Java must be installed on this computer."}
            </p>
          </div>
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
              disabled={!!work || !name.trim()}
            >
              <Plus size={15} />
              {work === "create" ? "Creating…" : "Create server"}
            </button>
          </div>
        </form>
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
              a folder on the computer running MC Panel, containing your server
              JAR.
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
                className={work === "inspect" ? "server-import-spinning" : ""}
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
                <span>Minecraft Java</span>
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
              <div className="form-field">
                <label htmlFor="import-server-jar">Server JAR</label>
                <select
                  id="import-server-jar"
                  value={importJar}
                  onChange={(event) => setImportJar(event.target.value)}
                  disabled={locked || inspection.jars.length === 0}
                  required
                >
                  <option value="">
                    {inspection.jars.length
                      ? "Select the JAR that runs this server"
                      : "No server JAR found"}
                  </option>
                  {inspection.jars.map((filename) => (
                    <option key={filename} value={filename}>
                      {filename}
                    </option>
                  ))}
                </select>
                <small>
                  {inspection.jars.length === 0
                    ? "Add your server JAR to this folder, then inspect it again."
                    : !importJar
                      ? "Choose the server JAR you normally launch."
                      : "MC Panel will use this JAR when you choose Start."}
                </small>
              </div>
              <div className="server-import-facts">
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
                    <div className="form-field">
                      <label htmlFor="import-server-memory">Memory (MB)</label>
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
                  </div>
                  <p className="server-advanced-hint">
                    A port change is applied to server.properties when you next
                    start this server.
                  </p>
                  <div className="form-field">
                    <label htmlFor="import-server-java">Java executable</label>
                    <input
                      id="import-server-java"
                      required
                      value={importJava}
                      onChange={(event) => setImportJava(event.target.value)}
                    />
                    <small>
                      Use the Java version required by this server's JAR.
                    </small>
                  </div>
                </fieldset>
              </details>
            </div>
          )}
          <div className="server-setup-note server-import-preservation">
            <FolderOpen size={18} />
            <p>
              Your world, plugins, and configuration stay in their original
              folder. Backups and panel settings are stored separately.
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
                !importJar ||
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
