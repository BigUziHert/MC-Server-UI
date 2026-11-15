import { useRef, useState } from "react";
import { usePanelApi } from "./api";

export type LaunchType = "jar" | "java-args" | "script" | "executable";

export type StartupDraft = {
  launchType: LaunchType;
  jar: string;
  javaPath: string;
  launchScript: string;
  launchExecutable: string;
  launchArgs: string;
};

export type LaunchCandidate = {
  type: LaunchType;
  path: string;
  label: string;
  launchArgs?: string[];
  javaPath?: string;
  software?: string;
};

export function startupDraft(value?: {
  launchType?: LaunchType;
  jar?: string | null;
  javaPath?: string;
  launchScript?: string;
  launchExecutable?: string;
  launchArgs?: string[];
}): StartupDraft {
  return {
    launchType: value?.launchType ?? "jar",
    jar: value?.jar ?? "server.jar",
    javaPath: value?.javaPath || "java",
    launchScript: value?.launchScript || "run.bat",
    launchExecutable: value?.launchExecutable || "",
    launchArgs: value?.launchArgs?.join("\n") ?? "",
  };
}

export function startupPayload(value: StartupDraft) {
  return {
    launchType: value.launchType,
    jar: value.launchType === "jar" ? value.jar.trim() : "",
    javaPath: value.javaPath.trim().replace(/^"(.*)"$/, "$1") || "java",
    launchScript:
      value.launchType === "script" ? value.launchScript.trim() : "",
    launchExecutable:
      value.launchType === "executable" ? value.launchExecutable.trim() : "",
    launchArgs:
      value.launchType === "jar"
        ? []
        : value.launchArgs
            .split(/\r?\n/)
            .map((argument) => argument.trim())
            .filter(Boolean),
  };
}

export function startupError(value: StartupDraft) {
  if (value.launchType === "jar" && !value.jar.trim())
    return "Choose the server JAR to run.";
  if (
    (value.launchType === "jar" || value.launchType === "java-args") &&
    !value.javaPath.trim()
  )
    return "Enter java or the full path to your Java executable.";
  if (value.launchType === "java-args" && !value.launchArgs.trim())
    return "Enter the Java startup arguments or argument files used by this server.";
  if (value.launchType === "script" && !value.launchScript.trim())
    return "Enter the startup script path relative to the server folder.";
  if (value.launchType === "executable" && !value.launchExecutable.trim())
    return "Enter the command or path for the server executable.";
  return "";
}

type FieldsProps = {
  idPrefix: string;
  value: StartupDraft;
  onChange: (value: StartupDraft) => void;
  jars?: string[];
  candidates?: LaunchCandidate[];
};

export function LaunchMethodFields({
  idPrefix,
  value,
  onChange,
  jars,
  candidates,
}: FieldsProps) {
  const argumentDrafts = useRef<Partial<Record<LaunchType, string>>>({});
  argumentDrafts.current[value.launchType] = value.launchArgs;
  const set = (field: keyof StartupDraft, content: string) =>
    onChange({ ...value, [field]: content });
  function changeMethod(type: LaunchType) {
    const candidate = candidates?.find((item) => item.type === type);
    onChange({
      ...value,
      launchType: type,
      launchArgs:
        argumentDrafts.current[type] ?? candidate?.launchArgs?.join("\n") ?? "",
      ...(candidate?.javaPath ? { javaPath: candidate.javaPath } : {}),
      ...(type === "script" && candidate
        ? { launchScript: candidate.path }
        : {}),
      ...(type === "executable" && candidate
        ? { launchExecutable: candidate.path }
        : {}),
    });
  }
  return (
    <>
      <div className="form-field">
        <label htmlFor={`${idPrefix}-launch-type`}>Launch method</label>
        <select
          id={`${idPrefix}-launch-type`}
          value={value.launchType}
          onChange={(event) => changeMethod(event.target.value as LaunchType)}
        >
          <option value="jar">Server JAR</option>
          <option value="java-args">Java arguments / argument files</option>
          <option value="script">Startup script</option>
          <option value="executable">Custom executable</option>
        </select>
        <small>
          Use the startup method that already works for your server.
        </small>
      </div>
      {value.launchType === "jar" && (
        <div className="form-field">
          <label htmlFor={`${idPrefix}-jar`}>Server JAR</label>
          {jars ? (
            <select
              id={`${idPrefix}-jar`}
              value={value.jar}
              onChange={(event) => set("jar", event.target.value)}
              required
              disabled={jars.length === 0}
            >
              <option value="">
                {jars.length
                  ? "Select the JAR that runs this server"
                  : "No server JAR found"}
              </option>
              {jars.map((filename) => (
                <option key={filename} value={filename}>
                  {filename}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`${idPrefix}-jar`}
              required
              placeholder="server.jar"
              value={value.jar}
              onChange={(event) => set("jar", event.target.value)}
            />
          )}
          <small>
            {jars?.length === 0
              ? "Choose another launch method, or add your server JAR and inspect again."
              : "Use the server launcher JAR, not a mod or installer JAR."}
          </small>
        </div>
      )}
      {value.launchType === "script" && (
        <div className="form-field">
          <label htmlFor={`${idPrefix}-script`}>Startup script</label>
          <input
            id={`${idPrefix}-script`}
            required
            placeholder="run.bat"
            value={value.launchScript}
            onChange={(event) => set("launchScript", event.target.value)}
            spellCheck={false}
          />
          <small>
            A path relative to the server folder. The script must keep the
            server in the foreground so the panel can read its console and stop
            it.
          </small>
        </div>
      )}
      {value.launchType === "executable" && (
        <div className="form-field">
          <label htmlFor={`${idPrefix}-executable`}>Server executable</label>
          <input
            id={`${idPrefix}-executable`}
            required
            placeholder="bedrock_server.exe"
            value={value.launchExecutable}
            onChange={(event) => set("launchExecutable", event.target.value)}
            spellCheck={false}
          />
          <small>
            Enter the executable only. Put its arguments in Startup arguments.
          </small>
        </div>
      )}
    </>
  );
}

export function LaunchAdvancedFields({
  idPrefix,
  value,
  onChange,
}: FieldsProps) {
  return (
    <>
      {(value.launchType === "jar" || value.launchType === "java-args") && (
        <JavaExecutableField
          id={`${idPrefix}-java`}
          value={value.javaPath}
          onChange={(javaPath) => onChange({ ...value, javaPath })}
        />
      )}
      {value.launchType !== "jar" && (
        <div className="form-field">
          <label htmlFor={`${idPrefix}-arguments`}>Startup arguments</label>
          <textarea
            id={`${idPrefix}-arguments`}
            rows={4}
            value={value.launchArgs}
            onChange={(event) =>
              onChange({ ...value, launchArgs: event.target.value })
            }
            required={value.launchType === "java-args"}
            placeholder={
              value.launchType === "java-args"
                ? "@user_jvm_args.txt\n@libraries/path/to/args.txt\nnogui"
                : "Optional arguments, one per line"
            }
            spellCheck={false}
          />
          <small>
            One argument per line. Keep paths with spaces on one line without
            surrounding quotes.
            {value.launchType === "java-args"
              ? " Use @filename for a Java argument file."
              : ""}
          </small>
        </div>
      )}
    </>
  );
}

export function JavaExecutableField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { api } = usePanelApi();
  const [choices, setChoices] = useState<
    { path: string; majorVersion: number; version: string; vendor?: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    path: string;
    message: string;
    error?: boolean;
  } | null>(null);
  async function check(discover = false) {
    setBusy(true);
    try {
      if (discover) {
        const result = await api<{ installations: typeof choices }>(
          "/server-setup/java?refresh=1",
          { signal: AbortSignal.timeout(30_000) },
        );
        setChoices(result.installations);
        setFeedback({
          path: value,
          message: result.installations.length
            ? "Choose a detected installation, or keep a custom path."
            : "No Java installations were found. Install Java on this computer or enter its full path.",
        });
      } else {
        const result = await api<{
          java: {
            available: boolean;
            version?: string;
            majorVersion?: number;
            error?: string;
          };
        }>("/server-setup/java/probe", {
          method: "POST",
          body: JSON.stringify({
            javaPath: value.trim().replace(/^"(.*)"$/, "$1"),
          }),
          signal: AbortSignal.timeout(30_000),
        });
        setFeedback({
          path: value,
          error: !result.java.available,
          message: result.java.available
            ? `Detected Java ${result.java.majorVersion ?? result.java.version}. Check that it supports this server's Minecraft and loader versions.`
            : result.java.error || "Java could not be started at this path.",
        });
      }
    } catch (cause) {
      setFeedback({
        path: value,
        error: true,
        message:
          cause instanceof Error ? cause.message : "Java could not be checked.",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-field">
      <label htmlFor={id}>Java executable</label>
      <input
        id={id}
        value={value}
        required
        onChange={(event) => onChange(event.target.value)}
      />
      {choices.length > 0 && (
        <select
          aria-label="Detected Java installations"
          value={choices.some((item) => item.path === value) ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" disabled>
            Choose a detected installation
          </option>
          {choices.map((item) => (
            <option key={item.path} value={item.path}>
              Java {item.majorVersion} · {item.vendor || item.version} ·{" "}
              {item.path}
            </option>
          ))}
        </select>
      )}
      <div className="server-dialog-actions">
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => void check(true)}
        >
          Find Java installations
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => void check()}
        >
          {busy ? "Checking Java…" : "Check Java"}
        </button>
      </div>
      <small>
        Use java from PATH or a full path. An existing server may need an older
        Java runtime.
      </small>
      {feedback?.path === value && (
        <p
          className={feedback.error ? "form-error" : "muted"}
          role={feedback.error ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      )}
    </div>
  );
}

export function LaunchMemoryNote({
  type,
  detectedMemory,
}: {
  type: LaunchType;
  detectedMemory?: number;
}) {
  if (type === "jar") return null;
  return (
    <p className="server-launch-memory">
      <strong>Memory is managed by your launcher.</strong>{" "}
      {type === "java-args"
        ? "Keep your existing -Xms and -Xmx settings in the startup arguments or user_jvm_args.txt."
        : "Change memory in your startup script or server configuration."}
      {detectedMemory != null && (
        <span>Detected maximum: {detectedMemory.toLocaleString()} MB.</span>
      )}
    </p>
  );
}
