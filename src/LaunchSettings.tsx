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
    javaPath: value.javaPath.trim() || "java",
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
  const set = (field: keyof StartupDraft, content: string) =>
    onChange({ ...value, [field]: content });
  function changeMethod(type: LaunchType) {
    const candidate = candidates?.find((item) => item.type === type);
    onChange({
      ...value,
      launchType: type,
      launchArgs: candidate?.launchArgs?.join("\n") ?? "",
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
        <div className="form-field">
          <label htmlFor={`${idPrefix}-java`}>Java executable</label>
          <input
            id={`${idPrefix}-java`}
            required
            value={value.javaPath}
            onChange={(event) =>
              onChange({ ...value, javaPath: event.target.value })
            }
          />
          <small>
            Use java from PATH or the full path to the Java version this server
            requires.
          </small>
        </div>
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
