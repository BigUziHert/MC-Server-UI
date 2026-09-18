import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, Save, SlidersHorizontal } from "lucide-react";
import { useServerApi, type PageProps } from "../api";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Switch from "../Switch";
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
  const debouncedSearch = useDebouncedValue(search);
  const [catalogReload, setCatalogReload] = useState(0);
  const [pendingReload, setPendingReload] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const request = useRef(0),
    session = useRef(0),
    dialog = useRef<HTMLDialogElement>(null);
  const changes = (config?.fields ?? [])
    .filter((field) => values[field.key] !== field.value)
    .map((field) => ({ key: field.key, value: values[field.key] }));
  const dirty = changes.length > 0;
  const load = useCallback(
    async (file: string, preserve = false) => {
      const id = ++request.current;
      setLoading(true);
      setError("");
      if (!preserve) {
        setConfig(null);
        setValues({});
      }
      try {
        const data = await api<Config>(
          `/minecraft/properties/file?path=${encodeURIComponent(file)}`,
        );
        if (id !== request.current) return false;
        setConfig(data);
        setValues(
          Object.fromEntries(
            data.fields.map((field) => [field.key, field.value]),
          ),
        );
        return true;
      } catch (cause) {
        if (id === request.current) setError((cause as Error).message);
        return false;
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
  }, [api, load, catalogReload]);
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
    if (saving || loading) return;
    if (dirty) {
      setPendingReload(false);
      setPending(file);
      return;
    }
    setSearch("");
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
    `${field.label} ${field.key}`
      .toLowerCase()
      .includes(debouncedSearch.toLowerCase()),
  );
  return (
    <div className="properties-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">MINECRAFT</p>
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
          disabled={loading || saving || !selected}
          onRefresh={async () => {
            if (dirty) {
              setPendingReload(true);
              setPending(selected);
              return false;
            }
            return load(selected, true);
          }}
          notify={notify}
          successMessage="Properties refreshed."
        />
      </div>
      {error && (
        <StatePanel
          variant="error"
          title="Unable to load properties"
          message={error}
          onRetry={() => {
            if (selected) select(selected);
            else setCatalogReload((v) => v + 1);
          }}
        />
      )}
      {loading && !config ? (
        <StatePanel
          className="panel"
          variant="loading"
          title="Loading configuration…"
        />
      ) : !files.length ? (
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
                      disabled={saving || loading}
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
                      disabled={saving || loading}
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
                      disabled={saving || loading}
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
              <StatePanel
                className="panel"
                variant="empty"
                title="No matching properties"
                message="Try another search."
              />
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
        <h2 id="discard-properties-title">
          {pendingReload
            ? `Reload and discard ${changes.length} unsaved changes?`
            : "Discard unsaved changes?"}
        </h2>
        <p>
          {pendingReload
            ? "Reloading replaces your edits with the saved file."
            : `Your ${changes.length} unsaved changes will be discarded.`}
        </p>
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
                if (!pendingReload) setSearch("");
                setSelected(target);
                void load(target, pendingReload).then((ok) => {
                  if (ok && pendingReload) notify("Properties refreshed.");
                });
              }
            }}
          >
            {pendingReload ? "Reload properties" : "Discard changes"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
