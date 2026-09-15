import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { useServerApi, type PageProps } from "../api";
import SearchField from "../SearchField";
import "./properties.css";

type Field = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  value: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  secret?: boolean;
};
type Config = {
  path: string;
  revision: string;
  fields: Field[];
  status: string;
};
export default function Properties({ notify }: PageProps) {
  const { api, post } = useServerApi();
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
  const [pending, setPending] = useState<string | null>(null);
  const request = useRef(0),
    session = useRef(0),
    dialog = useRef<HTMLDialogElement>(null);
  const changes = (config?.fields ?? [])
    .filter((field) => values[field.key] !== field.value)
    .map((field) => ({ key: field.key, value: values[field.key] }));
  const dirty = changes.length > 0;
  const load = useCallback(
    async (file: string) => {
      const id = ++request.current;
      setLoading(true);
      setError("");
      setConfig(null);
      setValues({});
      try {
        const data = await api<Config>(
          `/minecraft/properties/file?path=${encodeURIComponent(file)}`,
        );
        if (id !== request.current) return;
        setConfig(data);
        setValues(
          Object.fromEntries(
            data.fields.map((field) => [field.key, field.value]),
          ),
        );
      } catch (cause) {
        if (id === request.current) setError((cause as Error).message);
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [api],
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
    setLoading(true);
    setSaving(false);
    setError("");
    void api<{ files: { path: string; name: string }[] }>(
      "/minecraft/properties",
    )
      .then((data) => {
        if (id !== session.current) return;
        setFiles(data.files);
        if (data.files.length) {
          setSelected(data.files[0].path);
          void load(data.files[0].path);
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
  }, [api, load]);
  useEffect(() => {
    if (pending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pending]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const select = (file: string) => {
    if (saving) return;
    if (dirty) {
      setPending(file);
      return;
    }
    setSelected(file);
    void load(file);
  };
  async function save() {
    if (!config || !dirty || saving) return;
    const id = session.current;
    setSaving(true);
    setError("");
    try {
      const result = await post<Config & { message: string }>(
        "/minecraft/properties/save",
        { path: config.path, revision: config.revision, changes },
      );
      if (id !== session.current) return;
      setConfig(result);
      setValues(
        Object.fromEntries(
          result.fields.map((field) => [field.key, field.value]),
        ),
      );
      notify(result.message);
    } catch (cause) {
      if (id === session.current) setError((cause as Error).message);
    } finally {
      if (id === session.current) setSaving(false);
    }
  }
  const filtered = (config?.fields ?? []).filter((field) =>
    `${field.label} ${field.key}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="properties-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">MINECRAFT</span>
          <h1>Properties</h1>
        </div>
        <button
          className="btn primary"
          onClick={() => void save()}
          disabled={!dirty || saving || loading}
        >
          <Save size={15} />
          {saving ? "Saving…" : "Save changes"}
          {dirty ? ` (${changes.length})` : ""}
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
            disabled={saving}
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
        <button
          className="btn icon"
          aria-label="Reload properties"
          disabled={loading || saving || !selected}
          onClick={() => select(selected)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error && (
        <div className="form-alert error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="panel properties-empty" role="status">
          Loading configuration…
        </div>
      ) : !files.length ? (
        <div className="panel properties-empty">
          <FileCode2 size={30} />
          <h2>No configuration files yet</h2>
          <p>Configuration files appear after Minecraft creates them.</p>
        </div>
      ) : (
        config && (
          <>
            <div className="properties-grid">
              {filtered.map((field) => (
                <label className="panel property-field" key={field.key}>
                  <span>{field.label}</span>
                  {field.type === "boolean" ? (
                    <span className="property-switch">
                      <button
                        type="button"
                        role="switch"
                        className="property-toggle"
                        aria-label={field.label}
                        aria-checked={values[field.key] === true}
                        disabled={saving}
                        onClick={() =>
                          setValues((current) => ({
                            ...current,
                            [field.key]: current[field.key] !== true,
                          }))
                        }
                      >
                        <span aria-hidden="true" />
                      </button>
                      <span
                        className="property-switch-status"
                        aria-hidden="true"
                      >
                        {values[field.key] === true ? "On" : "Off"}
                      </span>
                    </span>
                  ) : field.options ? (
                    <select
                      aria-label={field.label}
                      value={String(values[field.key])}
                      disabled={saving}
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
                      autoComplete="off"
                      spellCheck={false}
                      disabled={saving}
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
                </label>
              ))}
            </div>
            {!filtered.length && (
              <div className="panel properties-empty">
                No matching properties.
              </div>
            )}
            <p className="properties-note">
              <SlidersHorizontal size={15} />
              Changes apply after a server restart. Complex YAML lists can be
              edited in <a href="#files">File Manager</a>.
            </p>
          </>
        )
      )}
      <dialog
        ref={dialog}
        className="modal properties-discard"
        aria-labelledby="discard-properties-title"
        onCancel={() => setPending(null)}
      >
        <h2 id="discard-properties-title">Discard unsaved changes?</h2>
        <p>Your {changes.length} unsaved changes will be discarded.</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => setPending(null)}>
            Keep editing
          </button>
          <button
            className="btn danger"
            onClick={() => {
              const target = pending;
              setPending(null);
              if (target) {
                setSelected(target);
                void load(target);
              }
            }}
          >
            Discard changes
          </button>
        </div>
      </dialog>
    </div>
  );
}
