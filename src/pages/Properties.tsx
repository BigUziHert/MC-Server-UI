import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { FileCode2, Save, SlidersHorizontal } from "lucide-react";
import { ServerScope, useServerApi, type PageProps } from "../api";
import {
  PropertyDraftsContext,
  type PropertyDraft,
  type PropertyField as Field,
  type PropertyConfig as Config,
} from "../property-drafts";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Switch from "../Switch";
import "./properties.css";

function numberError(field: Field, value: string | number | boolean) {
  if (field.type !== "number") return "";
  if (typeof value !== "number" || !Number.isFinite(value))
    return "Enter a number.";
  if ((field.min != null || field.max != null) && !Number.isInteger(value))
    return "Enter a whole number.";
  if (field.min != null && value < field.min)
    return `Enter a number of at least ${field.min}.`;
  if (field.max != null && value > field.max)
    return `Enter a number no greater than ${field.max}.`;
  return "";
}
export default function Properties({
  notify,
  permissions,
}: PageProps & { permissions?: string[] }) {
  const canRead =
    permissions === undefined || permissions.includes("file.read-content");
  const canWrite =
    permissions === undefined || permissions.includes("file.update");
  const { api, post } = useServerApi();
  const drafts = useContext(PropertyDraftsContext);
  const draftKey = useContext(ServerScope) ?? "default";
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]),
    [selected, setSelected] = useState("");
  const [config, setConfig] = useState<Config | null>(null),
    [values, setValues] = useState<Record<string, string | number | boolean>>(
      {},
    );
  const [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [search, setSearch] = useState("");
  const [errorKind, setErrorKind] = useState<"load" | "save" | "conflict">(
    "load",
  );
  const debouncedSearch = useDebouncedValue(search);
  const [catalogReload, setCatalogReload] = useState(0);
  const [pendingReload, setPendingReload] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [missingDraft, setMissingDraft] = useState(false);
  const [discardMissingDraft, setDiscardMissingDraft] = useState(false);
  const request = useRef(0),
    session = useRef(0),
    dialog = useRef<HTMLDialogElement>(null);
  const edited = (config?.fields ?? []).filter(
    (field) => values[field.key] !== field.value,
  );
  const invalid = Object.fromEntries(
    edited.flatMap((field) => {
      const message = numberError(field, values[field.key]);
      return message ? [[field.key, message]] : [];
    }),
  );
  const invalidCount = Object.keys(invalid).length;
  const changes = edited
    .filter((field) => !invalid[field.key])
    .map((field) => ({ key: field.key, value: values[field.key] }));
  const dirty = edited.length > 0;
  const currentDraft = useRef({ config, values });
  currentDraft.current = { config, values };
  useEffect(() => {
    if (!config || loading) return;
    if (!dirty) {
      drafts.delete(draftKey);
      return;
    }
    const draft: PropertyDraft = {
      config,
      values,
      onSaved: (saved) => {
        if (
          currentDraft.current.config !== config ||
          currentDraft.current.values !== values
        )
          return;
        setConfig(saved);
        setValues(
          Object.fromEntries(
            saved.fields.map((field) => [field.key, field.value]),
          ),
        );
        setMissingDraft(false);
        setError("");
      },
    };
    drafts.set(draftKey, draft);
    return () => {
      // Retain data across navigation without retaining an unmounted page.
      delete draft.onSaved;
    };
  }, [config, values, dirty, loading, drafts, draftKey]);
  const load = useCallback(
    async (file: string, preserve = false) => {
      if (!canRead) return false;
      const id = ++request.current;
      setLoading(true);
      setError("");
      setErrorKind("load");
      if (!preserve) {
        setConfig(null);
        setValues({});
      }
      try {
        const data = await api<Config>(
          `/minecraft/properties/file?path=${encodeURIComponent(file)}`,
        );
        if (id !== request.current) return false;
        setMissingDraft(false);
        const draft = drafts.get(draftKey);
        if (draft?.config.path === file) {
          setConfig(draft.config);
          setValues(draft.values);
          if (draft.config.revision !== data.revision) {
            setErrorKind("conflict");
            setError(
              "This file changed on the host while you were away. Your unsaved edits are kept. Copy any edits you want to keep, then refresh to review the latest file.",
            );
          }
        } else {
          setConfig(data);
          setValues(
            Object.fromEntries(
              data.fields.map((field) => [field.key, field.value]),
            ),
          );
        }
        return true;
      } catch (cause) {
        if (id === request.current) setError((cause as Error).message);
        return false;
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [api, canRead, drafts, draftKey],
  );
  useEffect(() => {
    const id = ++session.current;
    ++request.current;
    setFiles([]);
    setSelected("");
    setConfig(null);
    setValues({});
    setSearch("");
    setPending(null);
    setMissingDraft(false);
    setDiscardMissingDraft(false);
    setLoading(true);
    setSaving(false);
    setError("");
    if (!canRead) {
      setLoading(false);
      return;
    }
    void api<{ files: { path: string; name: string }[] }>(
      "/minecraft/properties",
    )
      .then((data) => {
        if (id !== session.current) return;
        setFiles(data.files);
        const draft = drafts.get(draftKey);
        if (
          draft &&
          !data.files.some((file) => file.path === draft.config.path)
        ) {
          setSelected(draft.config.path);
          setConfig(draft.config);
          setValues(draft.values);
          setMissingDraft(true);
          setLoading(false);
          return;
        }
        if (data.files.length) {
          const file =
            data.files.find((file) => file.path === draft?.config.path)?.path ??
            data.files[0].path;
          setSelected(file);
          void load(file);
        } else setLoading(false);
      })
      .catch((cause) => {
        if (id === session.current) {
          setError(cause.message);
          setLoading(false);
        }
      });
    return () => {
      session.current++;
      request.current++;
    };
  }, [api, load, catalogReload, canRead, drafts, draftKey]);
  useEffect(() => {
    if (pending || discardMissingDraft) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pending, discardMissingDraft]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const select = (file: string) => {
    if (saving || loading) return;
    if (dirty) {
      setPendingReload(false);
      setPending(file);
      return;
    }
    setSearch("");
    setMissingDraft(false);
    setSelected(file);
    void load(file);
  };
  const reload = async () => {
    if (loading || saving || !selected) return false;
    if (dirty) {
      setPendingReload(true);
      setPending(selected);
      return false;
    }
    return load(selected, true);
  };
  async function save() {
    if (
      !canWrite ||
      !config ||
      !dirty ||
      invalidCount > 0 ||
      saving ||
      missingDraft
    )
      return;
    const id = session.current;
    setSaving(true);
    setError("");
    setErrorKind("save");
    try {
      const result = await post<Config & { message: string }>(
        "/minecraft/properties/save",
        { path: config.path, revision: config.revision, changes },
      );
      // Navigation may unmount this page while the host saves successfully.
      // Release only the submitted snapshot, never a newer page's edits.
      const stored = drafts.get(draftKey);
      if (stored?.config === config && stored.values === values) {
        drafts.delete(draftKey);
        stored.onSaved?.(result);
      }
      if (id !== session.current) return;
      setConfig(result);
      setValues(
        Object.fromEntries(
          result.fields.map((field) => [field.key, field.value]),
        ),
      );
      notify(result.message);
    } catch (cause) {
      if (id === session.current) {
        setError((cause as Error).message);
        setErrorKind(
          (cause as { status?: number }).status === 409 ? "conflict" : "save",
        );
      }
    } finally {
      if (id === session.current) setSaving(false);
    }
  }
  const filtered = (config?.fields ?? []).filter((field) =>
    `${field.label} ${field.key}`
      .toLowerCase()
      .includes(debouncedSearch.toLowerCase()),
  );
  if (!canRead)
    return (
      <StatePanel
        variant="empty"
        title="Properties unavailable"
        message="You do not have permission to read configuration files."
      />
    );
  return (
    <div className="properties-page">
      <div className="page-heading">
        <div>
          <h1>Properties</h1>
        </div>
        <button
          className="btn primary"
          onClick={() => void save()}
          disabled={
            !canWrite ||
            !dirty ||
            invalidCount > 0 ||
            saving ||
            loading ||
            missingDraft
          }
        >
          <Save size={15} />
          {saving ? "Saving…" : "Save changes"}
          {dirty ? ` (${edited.length})` : ""}
        </button>
      </div>
      <div
        className="properties-tabs"
        role="tablist"
        aria-label="Configuration files"
      >
        {files.map((file) => (
          <button
            role="tab"
            aria-selected={selected === file.path}
            className={selected === file.path ? "selected" : ""}
            key={file.path}
            onClick={() => select(file.path)}
            disabled={saving || loading}
          >
            {file.name}
          </button>
        ))}
      </div>
      <div className="properties-toolbar">
        <SearchField
          className="storage-search"
          aria-label="Search properties"
          placeholder="Search properties…"
          value={search}
          onValueChange={setSearch}
        />
        <span>{filtered.length} properties</span>
        <RefreshButton
          label="Refresh properties"
          disabled={loading || saving || !selected || missingDraft}
          onRefresh={reload}
          notify={notify}
          successMessage="Properties refreshed."
        />
      </div>
      {missingDraft && config && (
        <StatePanel
          variant="error"
          title="Draft file is missing on the host"
          message={`Your unsaved edits for ${config.path} are kept below. Copy anything you need before discarding this draft, or restore the file on the host and check again.`}
          action={
            <div className="modal-actions">
              <button
                className="btn"
                disabled={loading}
                onClick={() => void load(selected, true)}
              >
                Check for file
              </button>
              <button
                className="btn danger"
                disabled={loading}
                onClick={() => setDiscardMissingDraft(true)}
              >
                Discard missing-file draft
              </button>
            </div>
          }
        />
      )}
      {error && (
        <StatePanel
          variant="error"
          title={
            errorKind === "load"
              ? "Unable to load properties"
              : errorKind === "conflict"
                ? "Properties changed on the host"
                : "Unable to save properties"
          }
          message={error}
          onRetry={() => {
            if (missingDraft) void load(selected, true);
            else if (errorKind === "save") void save();
            else if (selected) void reload();
            else setCatalogReload((v) => v + 1);
          }}
        />
      )}
      {invalidCount > 0 && (
        <p className="property-error">
          Correct {invalidCount} invalid{" "}
          {invalidCount === 1 ? "number" : "numbers"} before saving.
        </p>
      )}
      {loading && !config ? (
        <StatePanel
          className="panel"
          variant="loading"
          title="Loading configuration…"
        />
      ) : !files.length && !config ? (
        <StatePanel
          className="panel"
          variant="empty"
          icon={<FileCode2 size={30} />}
          title="No configuration files yet"
          message="Configuration files appear after Minecraft creates them."
        />
      ) : (
        config && (
          <>
            <div className="properties-grid">
              {filtered.map((field) => (
                <label className="panel property-field" key={field.key}>
                  <span>{field.label}</span>
                  {field.type === "boolean" ? (
                    <Switch
                      aria-label={field.label}
                      label={values[field.key] === true ? "On" : "Off"}
                      checked={values[field.key] === true}
                      disabled={!canWrite || saving || loading || missingDraft}
                      onCheckedChange={(checked) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: checked,
                        }))
                      }
                    />
                  ) : field.options ? (
                    <select
                      aria-label={field.label}
                      value={String(values[field.key])}
                      disabled={!canWrite || saving || loading || missingDraft}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    >
                      {field.options.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={field.label}
                      type={
                        field.type === "number"
                          ? "number"
                          : field.secret
                            ? "password"
                            : "text"
                      }
                      min={field.min}
                      max={field.max}
                      step={field.min != null || field.max != null ? 1 : "any"}
                      aria-invalid={invalid[field.key] ? true : undefined}
                      aria-describedby={
                        invalid[field.key]
                          ? `property-error-${encodeURIComponent(field.key)}`
                          : undefined
                      }
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canWrite || saving || loading}
                      readOnly={missingDraft}
                      value={String(values[field.key])}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.key]:
                            field.type === "number"
                              ? event.target.value === ""
                                ? ""
                                : Number(event.target.value)
                              : event.target.value,
                        }))
                      }
                    />
                  )}
                  {invalid[field.key] && (
                    <small
                      className="property-error"
                      role="alert"
                      id={`property-error-${encodeURIComponent(field.key)}`}
                    >
                      {invalid[field.key]}
                    </small>
                  )}
                </label>
              ))}
            </div>
            {!filtered.length && (
              <StatePanel
                className="panel"
                variant="empty"
                title="No matching properties"
                message="Try another search."
              />
            )}
            <p className="properties-note">
              <SlidersHorizontal size={15} />
              {canWrite ? (
                <span>
                  Changes apply after a server restart.
                  {dirty &&
                    " Unsaved edits are kept while you navigate this panel."}
                  {(permissions === undefined ||
                    permissions.includes("file.read")) && (
                    <>
                      {" "}
                      Complex YAML lists can be edited in{" "}
                      <a href="#files">File Manager</a>.
                    </>
                  )}
                </span>
              ) : (
                "You have read-only access to these configuration files."
              )}
            </p>
          </>
        )
      )}
      <dialog
        ref={dialog}
        className="modal properties-discard"
        aria-labelledby="discard-properties-title"
        onCancel={() => {
          setPending(null);
          setDiscardMissingDraft(false);
        }}
      >
        <h2 id="discard-properties-title">
          {discardMissingDraft
            ? `Discard unsaved changes for ${selected}?`
            : pendingReload
              ? `Reload and discard ${edited.length} unsaved changes?`
              : "Discard unsaved changes?"}
        </h2>
        <p>
          {!discardMissingDraft && pendingReload
            ? "Reloading replaces your edits with the saved file."
            : `Your ${edited.length} unsaved changes will be discarded.`}
        </p>
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => {
              setPending(null);
              setDiscardMissingDraft(false);
            }}
          >
            Keep editing
          </button>
          <button
            className="btn danger"
            onClick={() => {
              if (discardMissingDraft) {
                setDiscardMissingDraft(false);
                drafts.delete(draftKey);
                setMissingDraft(false);
                setConfig(null);
                setValues({});
                setError("");
                const first = files[0]?.path ?? "";
                setSelected(first);
                if (first) void load(first);
                return;
              }
              const target = pending;
              setPending(null);
              if (target) {
                drafts.delete(draftKey);
                setMissingDraft(false);
                if (!pendingReload) setSearch("");
                setSelected(target);
                void load(target, pendingReload).then((ok) => {
                  if (ok && pendingReload) notify("Properties refreshed.");
                });
              }
            }}
          >
            {!discardMissingDraft && pendingReload
              ? "Reload properties"
              : "Discard changes"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
